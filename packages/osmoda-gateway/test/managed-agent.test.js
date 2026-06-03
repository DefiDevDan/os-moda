import { test } from "node:test";
import assert from "node:assert/strict";
import { mapAntStreamEvent, newAntMapState, managedAgentDriver } from "../dist/drivers/managed-agent.js";

// Synthetic Managed-Agent stream events (the beta schema is mapped permissively;
// these lock the two-channel contract the dashboard renders).
function run(events) {
  const st = newAntMapState();
  const out = [];
  for (const e of events) out.push(...mapAntStreamEvent(e, st));
  return { out, st };
}
const types = (evs) => evs.map((e) => e.type);

test("driver shape: name + auth + cloud-not-local description", () => {
  assert.equal(managedAgentDriver.name, "managed-agent");
  assert.deepEqual(managedAgentDriver.supportedAuthTypes, ["api_key"]);
  assert.match(managedAgentDriver.description, /CLOUD|cloud/);
});

test("assistant text streams on the INTERIM channel (never `text`)", () => {
  const { out, st } = run([{ type: "assistant.message", content: [{ type: "text", text: "Let me check." }] }]);
  assert.deepEqual(types(out), ["interim_text"]);
  assert.equal(out[0].text, "Let me check.");
  assert.equal(st.lastText, "Let me check.");
});

test("tool_use + tool_result blocks map to the timeline", () => {
  const { out } = run([
    { type: "assistant.message", content: [{ type: "tool_use", name: "bash", input: { command: "ls /" } }] },
    { type: "tool.result", content: [{ type: "tool_result", text: "bin etc usr" }] },
  ]);
  const tu = out.find((e) => e.type === "tool_use");
  assert.equal(tu.name, "bash");
  assert.equal(tu.target, "ls /");
  const tr = out.find((e) => e.type === "tool_result");
  assert.equal(tr.outcome, "success");
  assert.match(tr.summary, /bin etc usr/);
});

test("terminal event promotes the final answer as text_bulk (+ commit + phase + done), no `text`", () => {
  const { out } = run([
    { type: "assistant.message", content: [{ type: "text", text: "Disk is 30% used." }] },
    { type: "message.completed", stop_reason: "end_turn" },
  ]);
  assert.equal(types(out).includes("text"), false, "never the final-channel `text` event");
  const bulk = out.find((e) => e.type === "text_bulk");
  assert.ok(bulk && /30% used/.test(bulk.text), "final answer promoted to text_bulk");
  assert.ok(out.some((e) => e.type === "interim_commit_final"), "trims the promoted interim");
  assert.ok(out.some((e) => e.type === "phase" && e.phase === "answering"));
  assert.equal(types(out)[types(out).length - 1], "done");
});

test("terminal `result` string wins over accumulated text", () => {
  const { out } = run([
    { type: "assistant.message", content: [{ type: "text", text: "thinking…" }] },
    { type: "turn.end", result: "Final clean answer." },
  ]);
  assert.equal(out.find((e) => e.type === "text_bulk").text, "Final clean answer.");
});

test("noise / garbage is ignored safely", () => {
  assert.deepEqual(mapAntStreamEvent(null, newAntMapState()), []);
  assert.deepEqual(mapAntStreamEvent({ type: "trace.metadata" }, newAntMapState()), []);
});
