import { test } from "node:test";
import assert from "node:assert/strict";
import { mapTrajectoryEvent, newTrajectoryState } from "../dist/drivers/openclaw-trajectory.js";

// Helper: feed a sequence of trajectory event objects through the mapper with
// one shared state, return the flattened AgentEvent[].
function run(events) {
  const st = newTrajectoryState();
  const out = [];
  for (const e of events) out.push(...mapTrajectoryEvent(e, st));
  return { out, st };
}
const types = (evs) => evs.map((e) => e.type);

test("session.started → status 'Starting'", () => {
  const { out } = run([{ type: "session.started", data: {} }]);
  assert.deepEqual(out, [{ type: "status", step: "Starting" }]);
});

test("model.completed with text + a tool call → status, tool_use, interim_text", () => {
  const { out, st } = run([{
    type: "model.completed",
    data: { message: { role: "assistant", content: [
      { type: "text", text: "Let me check the disk." },
      { type: "toolCall", id: "tc1", name: "shell_exec", input: { command: "df -h /" } },
    ] } },
  }]);
  assert.deepEqual(types(out), ["status", "tool_use", "interim_text"]);
  const tu = out.find((e) => e.type === "tool_use");
  assert.equal(tu.name, "shell_exec");
  assert.equal(tu.target, "df -h /");
  assert.equal(tu.round, 0);
  const it = out.find((e) => e.type === "interim_text");
  assert.equal(it.text, "Let me check the disk.");
  assert.equal(st.emittedInterim, "Let me check the disk.".length);
});

test("tool_use is de-duped across repeated lines (same id)", () => {
  const st = newTrajectoryState();
  const ev = { type: "model.completed", data: { message: { content: [
    { type: "toolCall", id: "tcX", name: "system_query", input: {} },
  ] } } };
  const a = mapTrajectoryEvent(ev, st);
  const b = mapTrajectoryEvent(ev, st); // same id again
  assert.equal(a.filter((e) => e.type === "tool_use").length, 1);
  assert.equal(b.filter((e) => e.type === "tool_use").length, 0, "second occurrence suppressed");
});

test("context.compiled tool results → tool_result with summary + outcome", () => {
  const { out } = run([{
    type: "context.compiled",
    data: { messages: [
      { role: "toolResult", content: [{ type: "toolResult", id: "tc1", name: "shell_exec", output: "Filesystem  Size  Used  Avail\n/dev/sda1  40G  12G  28G" }] },
    ] },
  }]);
  const tr = out.find((e) => e.type === "tool_result");
  assert.ok(tr, "emitted a tool_result");
  assert.equal(tr.outcome, "success");
  assert.ok(tr.summary.includes("Filesystem"));
  assert.ok(tr.summary.length <= 120);
});

test("toolResult with error flag → outcome 'error'", () => {
  const { out } = run([{
    type: "context.compiled",
    data: { messages: [{ role: "toolResult", content: [{ type: "toolResult", id: "z", name: "file_read", isError: true, output: "ENOENT" }] }] },
  }]);
  assert.equal(out.find((e) => e.type === "tool_result").outcome, "error");
});

test("multi-round: round counter increments + status reflects it", () => {
  const round = (txt) => ({ type: "model.completed", data: { message: { content: [{ type: "text", text: txt }] } } });
  const { out } = run([round("first"), round("second")]);
  const statuses = out.filter((e) => e.type === "status").map((e) => e.step);
  assert.equal(statuses[0], "Thinking");
  assert.equal(statuses[1], "Working · round 2");
});

test("alternate shape: data.output as a string array of content blocks", () => {
  const { out } = run([{
    type: "model.completed",
    data: { output: [{ type: "text", text: "hi" }, { type: "tool_use", name: "memory_recall", input: { query: "prefs" } }] },
  }]);
  assert.deepEqual(types(out).sort(), ["interim_text", "status", "tool_use"].sort());
  assert.equal(out.find((e) => e.type === "tool_use").target, "prefs");
});

test("noise events (prompt.submitted / trace.* / session.ended) emit nothing", () => {
  const { out } = run([
    { type: "prompt.submitted", data: { messages: [] } },
    { type: "trace.metadata", data: {} },
    { type: "trace.artifacts", data: {} },
    { type: "session.ended", data: { status: "ok" } },
  ]);
  assert.deepEqual(out, []);
});

test("garbage / empty input is ignored safely", () => {
  const st = newTrajectoryState();
  assert.deepEqual(mapTrajectoryEvent(null, st), []);
  assert.deepEqual(mapTrajectoryEvent({}, st), []);
  assert.deepEqual(mapTrajectoryEvent({ type: "model.completed" }, st), [{ type: "status", step: "Thinking" }]);
});
