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
export function newTrajectoryState() {
    return { round: 0, emittedInterim: 0, seenToolCallIds: new Set(), seenToolResultIds: new Set() };
}
function asArray(v) {
    if (v == null)
        return [];
    return Array.isArray(v) ? v : [v];
}
/** Distill a tool input object into a one-line target hint (matches claude-code). */
function toolTargetHint(input) {
    if (!input || typeof input !== "object")
        return undefined;
    const clip = (s, n = 80) => { const str = String(s).replace(/\s+/g, " ").trim(); return str.length > n ? str.slice(0, n - 1) + "…" : str; };
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
 * Pull assistant content blocks out of a model.completed event's data, probing
 * the plausible locations. Returns { text, toolCalls[] }.
 */
function extractRound(data) {
    let text = "";
    const toolCalls = [];
    if (!data || typeof data !== "object")
        return { text, toolCalls };
    // Candidate containers for the assistant message / content blocks.
    const candidates = [
        data.message, data.assistant, data.response, data.output, data.result,
        data.messages, data.content,
    ].filter(Boolean);
    const blocks = [];
    for (const c of candidates) {
        for (const m of asArray(c)) {
            if (typeof m === "string") {
                text += m;
                continue;
            }
            if (!m || typeof m !== "object")
                continue;
            // a message with role:assistant + content[]; or a raw content block
            if (m.role && m.role !== "assistant")
                continue;
            const content = m.content != null ? m.content : m;
            for (const b of asArray(content))
                blocks.push(b);
        }
    }
    for (const b of blocks) {
        if (typeof b === "string") {
            text += b;
            continue;
        }
        if (!b || typeof b !== "object")
            continue;
        const bt = b.type || b.kind || (b.role === "toolResult" ? "toolResult" : "");
        if (bt === "text" && typeof b.text === "string")
            text += b.text;
        else if ((bt === "toolCall" || bt === "tool_use") && (b.name || b.toolName)) {
            toolCalls.push({ id: b.id || b.toolCallId, name: b.name || b.toolName, input: b.input || b.args || b.arguments });
        }
        else if (typeof b.text === "string") {
            text += b.text;
        }
    }
    return { text, toolCalls };
}
/** Pull tool RESULTS out of a context.compiled event's messages array. */
function extractToolResults(data) {
    const out = [];
    const msgs = asArray(data && data.messages);
    for (const m of msgs) {
        if (!m || typeof m !== "object")
            continue;
        const role = m.role || m.type;
        const content = m.content != null ? m.content : m;
        for (const b of asArray(content)) {
            if (!b || typeof b !== "object")
                continue;
            const bt = b.type || b.role || b.kind;
            if (role === "toolResult" || bt === "toolResult" || bt === "tool_result") {
                const raw = typeof b.output === "string" ? b.output
                    : typeof b.result === "string" ? b.result
                        : typeof b.text === "string" ? b.text
                            : JSON.stringify(b.output || b.result || "");
                const summary = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 120);
                out.push({ id: b.id || b.toolCallId, name: b.name || b.toolName, outcome: b.isError || b.error ? "error" : "success", summary });
            }
        }
    }
    return out;
}
/**
 * Map ONE parsed trajectory event into zero+ contract AgentEvents, mutating
 * `state`. Pure aside from the state mutation — easy to unit test.
 */
export function mapTrajectoryEvent(ev, state) {
    if (!ev || typeof ev !== "object")
        return [];
    const out = [];
    const type = ev.type;
    if (type === "session.started") {
        out.push({ type: "status", step: "Starting" });
        return out;
    }
    if (type === "context.compiled") {
        // Tool results from the prior round surface here.
        for (const r of extractToolResults(ev.data)) {
            const key = r.id || `${r.name}:${state.seenToolResultIds.size}`;
            if (state.seenToolResultIds.has(key))
                continue;
            state.seenToolResultIds.add(key);
            out.push({ type: "tool_result", name: r.name, outcome: r.outcome, summary: r.summary });
        }
        return out;
    }
    if (type === "model.completed") {
        state.round += 1;
        out.push({ type: "status", step: state.round > 1 ? `Working · round ${state.round}` : "Thinking" });
        const { text, toolCalls } = extractRound(ev.data);
        for (const tc of toolCalls) {
            const key = tc.id || `${tc.name}:${state.seenToolCallIds.size}`;
            if (state.seenToolCallIds.has(key))
                continue;
            state.seenToolCallIds.add(key);
            out.push({ type: "tool_use", name: tc.name, target: toolTargetHint(tc.input), round: state.round - 1 });
        }
        // Round text is reasoning-between-tools → the collapsible thinking panel.
        // The authoritative final answer is emitted by the driver as text_bulk.
        if (text) {
            out.push({ type: "interim_text", text });
            state.emittedInterim += text.length;
        }
        return out;
    }
    // session.ended / trace.* / prompt.submitted → no contract event (the driver
    // emits the final text_bulk + done from the --json result after the process
    // exits, so we don't double-emit here).
    return out;
}
