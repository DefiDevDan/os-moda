import { test } from "node:test";
import assert from "node:assert/strict";
import { mapTrajectoryEvent, newTrajectoryState } from "../dist/drivers/openclaw-trajectory.js";

// Shapes below are the CONFIRMED OpenClaw 2026.5.20 trajectory (captured from a
// funded run): model.completed.data has assistantTexts:[string] + a cumulative
// messagesSnapshot:[{role, content:[{type:"toolCall"|"text"}]}, {role:"toolResult",...}].
function run(events) {
  const st = newTrajectoryState();
  const out = [];
  for (const e of events) out.push(...mapTrajectoryEvent(e, st));
  return { out, st };
}
const types = (evs) => evs.map((e) => e.type);

// A model.completed event with a snapshot of [user, assistant(toolCall), toolResult, assistant(text)].
function modelCompleted(snapshot, assistantTexts) {
  return { type: "model.completed", data: { assistantTexts: assistantTexts || [], messagesSnapshot: snapshot } };
}

test("session.started → status 'Starting'", () => {
  const { out } = run([{ type: "session.started", data: {} }]);
  assert.deepEqual(out, [{ type: "status", step: "Starting" }]);
});

test("model.completed: snapshot toolCall→tool_use, toolResult→tool_result, assistantTexts→interim_text", () => {
  const { out, st } = run([modelCompleted([
    { role: "user", content: [{ type: "text", text: "disk?" }] },
    { role: "assistant", content: [{ type: "toolCall", name: "shell_exec", input: { command: "df -h /" } }] },
    { role: "toolResult", content: [{ type: "text", text: "/dev/sda1 40G 12G 28G 30%" }] },
    { role: "assistant", content: [{ type: "text", text: "Disk is 30% used." }] },
  ], ["Disk is 30% used."]) ]);
  assert.deepEqual(types(out), ["status", "tool_use", "tool_result", "interim_text"]);
  const tu = out.find((e) => e.type === "tool_use");
  assert.equal(tu.name, "shell_exec");
  assert.equal(tu.target, "df -h /");
  const tr = out.find((e) => e.type === "tool_result");
  assert.equal(tr.outcome, "success");
  assert.ok(tr.summary.includes("/dev/sda1"));
  assert.equal(out.find((e) => e.type === "interim_text").text, "Disk is 30% used.");
  assert.equal(st.emittedInterim, "Disk is 30% used.".length);
});

test("cumulative snapshot re-sent next round does NOT re-emit earlier tool steps", () => {
  const st = newTrajectoryState();
  const snap1 = [
    { role: "assistant", content: [{ type: "toolCall", name: "system_query", input: {} }] },
    { role: "toolResult", content: [{ type: "text", text: "ok" }] },
  ];
  const a = mapTrajectoryEvent(modelCompleted(snap1, []), st);
  // round 2: snapshot grows; the first toolCall (idx 0) + result (idx 1) repeat.
  const snap2 = snap1.concat([
    { role: "assistant", content: [{ type: "toolCall", name: "service_status", input: {} }] },
    { role: "toolResult", content: [{ type: "text", text: "running" }] },
  ]);
  const b = mapTrajectoryEvent(modelCompleted(snap2, []), st);
  assert.equal(a.filter((e) => e.type === "tool_use").length, 1);
  assert.equal(b.filter((e) => e.type === "tool_use").length, 1, "only the NEW tool call emits in round 2");
  assert.equal(b.find((e) => e.type === "tool_use").name, "service_status");
});

test("toolResult error flag → outcome 'error'", () => {
  const { out } = run([modelCompleted([
    { role: "toolResult", content: [{ type: "text", text: "ENOENT", isError: true }] },
  ], [])]);
  assert.equal(out.find((e) => e.type === "tool_result").outcome, "error");
});

test("interim_text is delta-only across rounds (assistantTexts is cumulative)", () => {
  const st = newTrajectoryState();
  const r1 = mapTrajectoryEvent(modelCompleted([], ["Thinking about it."]), st);
  const r2 = mapTrajectoryEvent(modelCompleted([], ["Thinking about it. Here is the answer."]), st);
  assert.equal(r1.find((e) => e.type === "interim_text").text, "Thinking about it.");
  assert.equal(r2.find((e) => e.type === "interim_text").text, " Here is the answer.");
});

test("multi-round status reflects the round number", () => {
  const { out } = run([modelCompleted([], ["a"]), modelCompleted([], ["a b"])]);
  const statuses = out.filter((e) => e.type === "status").map((e) => e.step);
  assert.equal(statuses[0], "Thinking");
  assert.equal(statuses[1], "Working · round 2");
});

test("noise events emit nothing", () => {
  const { out } = run([
    { type: "prompt.submitted", data: { messages: [] } },
    { type: "trace.metadata", data: {} },
    { type: "context.compiled", data: { messages: [] } },
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
