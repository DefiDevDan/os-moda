/**
 * OpenClaw trajectory → osModa event-contract mapper.
 *
 * WHY THIS EXISTS: `openclaw agent --local --json` returns ONE final blob — it
 * has no streaming flag (verified on OpenClaw 2026.5.20). But the embedded run
 * writes an append-only trajectory JSONL at
 *   /root/.openclaw/agents/<id>/sessions/<session-id>.trajectory.jsonl
 * as it executes. Tailing that file is the only way to surface live progress.
 *
 * GRANULARITY (honest): the trajectory is flushed PER ROUND, not per token. Top
 * level events per round: session.started → trace.metadata → context.compiled →
 * prompt.submitted → model.completed → trace.artifacts → session.ended. The
 * assistant's text + tool calls for a round live nested in `model.completed.data`
 * (and tool RESULTS surface in the next round's `context.compiled.data.messages`
 * as role:"toolResult"). So we get round-granularity: tool calls + text appear
 * as each model round completes. The front-end's rAF reveal makes per-round text
 * feel streamed; the final clean answer comes from the driver's --json result as
 * `text_bulk` + `interim_commit_final` (skill §1 de-dup).
 *
 * ⚠ The exact shape of a SUCCESSFUL `model.completed.data` (which field holds the
 * assistant message / content blocks) is not yet confirmed on a funded run — our
 * sample trajectories were all usage-capped. So the extractor is deliberately
 * PERMISSIVE: it probes every plausible location for assistant text + tool calls.
 * Confirm field names with one funded run and tighten if needed.
 *
 * This module is a PURE function (event object + state → AgentEvent[]) so it is
 * fully unit-testable with synthetic trajectory lines, no process spawn.
 */

import type { AgentEvent } from "./types.js";

export interface TrajectoryState {
  round: number;          // model rounds seen so far
  emittedInterim: number; // chars of interim_text emitted (for commit-final de-dup)
  seenToolCallIds: Set<string>;
  seenToolResultIds: Set<string>;
}

export function newTrajectoryState(): TrajectoryState {
  return { round: 0, emittedInterim: 0, seenToolCallIds: new Set(), seenToolResultIds: new Set() };
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Distill a tool input object into a one-line target hint (matches claude-code). */
function toolTargetHint(input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const clip = (s: any, n = 80) => { const str = String(s).replace(/\s+/g, " ").trim(); return str.length > n ? str.slice(0, n - 1) + "…" : str; };
  return input.command ? clip(input.command)
    : input.file_path ? clip(input.file_path, 120)
    : input.path ? clip(input.path, 120)
    : input.url ? clip(input.url, 120)
    : input.pattern ? clip(input.pattern)
    : input.query ? clip(input.query)
    : input.prompt ? clip(input.prompt)
    : undefined;
}

/**
 * Pull this round's assistant text out of a model.completed event's data.
 * CONFIRMED on a funded run: OpenClaw 2026.5.20 puts the round's assistant text
 * in `data.assistantTexts` (string[]). Falls back to older probed shapes.
 */
function extractRoundText(data: any): string {
  if (!data || typeof data !== "object") return "";
  if (Array.isArray(data.assistantTexts) && data.assistantTexts.length) {
    return data.assistantTexts.filter((s: any) => typeof s === "string").join("\n");
  }
  // Fallbacks (defensive — older/alternate builds).
  for (const c of [data.message, data.assistant, data.output, data.content]) {
    for (const m of asArray(c)) {
      if (typeof m === "string") return m;
      const content = m && (m.content != null ? m.content : m);
      const joined = asArray(content).filter((b: any) => b && b.type === "text" && b.text).map((b: any) => b.text).join("");
      if (joined) return joined;
    }
  }
  return "";
}

/**
 * Walk a model.completed event's `messagesSnapshot` (the cumulative conversation)
 * and emit tool calls + results with their POSITIONAL index as the de-dup key
 * (the snapshot has no per-block ids and is re-sent in full each round).
 * CONFIRMED shape: messages = [{role:"assistant", content:[{type:"toolCall",
 * name, input}|{type:"text"}]}, {role:"toolResult", content:[{type:"text"}]}].
 */
function extractSnapshotTools(data: any): Array<
  | { kind: "use"; idx: number; name: string; input?: any }
  | { kind: "result"; idx: number; name?: string; outcome: string; summary: string }
> {
  const out: any[] = [];
  const msgs = asArray(data && data.messagesSnapshot);
  msgs.forEach((m: any, i: number) => {
    if (!m || typeof m !== "object") return;
    const role = m.role;
    for (const b of asArray(m.content)) {
      if (!b || typeof b !== "object") continue;
      const bt = b.type;
      if (role === "assistant" && (bt === "toolCall" || bt === "tool_use") && (b.name || b.toolName)) {
        out.push({ kind: "use", idx: i, name: b.name || b.toolName, input: b.input || b.args || b.arguments });
      } else if (role === "toolResult") {
        const raw = typeof b.text === "string" ? b.text
          : typeof b.output === "string" ? b.output
          : typeof b.result === "string" ? b.result
          : JSON.stringify(b.output || b.result || "");
        out.push({ kind: "result", idx: i, name: b.name || b.toolName, outcome: (b.isError || b.error) ? "error" : "success", summary: String(raw || "").replace(/\s+/g, " ").trim().slice(0, 120) });
      }
    }
  });
  return out;
}

/**
 * Map ONE parsed trajectory event into zero+ contract AgentEvents, mutating
 * `state`. Pure aside from the state mutation — easy to unit test.
 */
export function mapTrajectoryEvent(ev: any, state: TrajectoryState): AgentEvent[] {
  if (!ev || typeof ev !== "object") return [];
  const out: AgentEvent[] = [];
  const type = ev.type;

  if (type === "session.started") {
    out.push({ type: "status", step: "Starting" });
    return out;
  }

  if (type === "model.completed") {
    state.round += 1;
    out.push({ type: "status", step: state.round > 1 ? `Working · round ${state.round}` : "Thinking" });
    // Tool calls + results live in the cumulative messagesSnapshot; de-dup by
    // positional index so re-sent snapshots don't re-emit earlier steps.
    for (const t of extractSnapshotTools(ev.data)) {
      if (t.kind === "use") {
        const key = "tc:" + t.idx;
        if (state.seenToolCallIds.has(key)) continue;
        state.seenToolCallIds.add(key);
        out.push({ type: "tool_use", name: t.name, target: toolTargetHint(t.input), round: state.round - 1 });
      } else {
        const key = "tr:" + t.idx;
        if (state.seenToolResultIds.has(key)) continue;
        state.seenToolResultIds.add(key);
        out.push({ type: "tool_result", name: t.name, outcome: t.outcome, summary: t.summary });
      }
    }
    // Round assistant text → the collapsible thinking panel. The authoritative
    // final answer is emitted separately by the driver as text_bulk. Only emit
    // the DELTA beyond what we've already streamed (assistantTexts is cumulative).
    const text = extractRoundText(ev.data);
    if (text && text.length > state.emittedInterim) {
      const delta = text.slice(state.emittedInterim);
      out.push({ type: "interim_text", text: delta });
      state.emittedInterim = text.length;
    }
    return out;
  }

  // session.ended / trace.* / prompt.submitted → no contract event (the driver
  // emits the final text_bulk + done from the --json result after the process
  // exits, so we don't double-emit here).
  return out;
}
