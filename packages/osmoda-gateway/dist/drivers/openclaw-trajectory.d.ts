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
    round: number;
    emittedInterim: number;
    seenToolCallIds: Set<string>;
    seenToolResultIds: Set<string>;
}
export declare function newTrajectoryState(): TrajectoryState;
/**
 * Map ONE parsed trajectory event into zero+ contract AgentEvents, mutating
 * `state`. Pure aside from the state mutation — easy to unit test.
 */
export declare function mapTrajectoryEvent(ev: any, state: TrajectoryState): AgentEvent[];
