import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeCodeDriver } from "../dist/drivers/claude-code.js";

/**
 * Integration test of the claude-code driver's TWO-CHANNEL streaming, with a
 * SIMULATED `claude` binary (no model credits). This is the regression guard for
 * the fragmentation bug: claude-code emits a text block BEFORE each tool call
 * (a planning preamble) and one for the final answer. The driver MUST stream the
 * preambles on the INTERIM channel and promote only the authoritative final
 * answer as text_bulk — otherwise each preamble becomes its own persisted
 * "assistant" row and renders as a stack of "Task completed" stubs on replay.
 *
 * The fake binary emits the real `claude -p --output-format stream-json --verbose`
 * shape: system/init → assistant(text preamble) → assistant(tool_use) →
 * user(tool_result) → assistant(final text) → result(is_error:false, result:"…").
 */
function makeFakeClaude() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-bin-"));
  const bin = path.join(dir, "claude");
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.118 (Claude Code)"); process.exit(0); }
// The -p run: stream JSONL events to stdout, then exit.
const sid = "sess-itest-1";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "system", subtype: "init", session_id: sid });
setTimeout(() => {
  // Planning preamble (BEFORE a tool) — must become interim_text, NOT the answer.
  emit({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Let me check the services:" }] } });
  emit({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", name: "Bash", input: { command: "systemctl list-units" } }] } });
  emit({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });
}, 60);
setTimeout(() => {
  // Final answer (no tool follows) — the authoritative reply.
  emit({ type: "assistant", message: { id: "m3", content: [{ type: "text", text: "Done — 12 services are running." }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: "Done — 12 services are running.", session_id: sid });
  process.exit(0);
}, 160);
`;
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return bin;
}

function makeOpts(workdir) {
  return {
    agent: { id: "osmoda", display_name: "t", runtime: "claude-code", credential_id: "c", model: "claude-opus-4-6", channels: [], enabled: true, updated_at: "" },
    credential: { id: "c", label: "k", provider: "anthropic", type: "api_key", secret: "sk-ant-api-XXXXXXXXXXXXXXXXXXXX", created_at: "" },
    model: "claude-opus-4-6",
    systemPrompt: "you are test",
    mcpConfigPath: "/dev/null",
    message: "what services are running?",
    sessionId: undefined,
    workingDir: workdir,
  };
}

test("claude-code driver: preambles stream as interim_text, final answer as text_bulk (no fragmentation)", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cc-work-"));
  process.env.CLAUDE_PATH = makeFakeClaude();

  const got = [];
  for await (const ev of claudeCodeDriver.startSession(makeOpts(work))) got.push(ev);
  const types = got.map((e) => e.type);

  // Session echoed first.
  assert.equal(got[0].type, "session");

  // The planning preamble streamed on the INTERIM channel — never as `text`.
  assert.equal(types.includes("text"), false, "must NOT emit any final-channel `text` events");
  const interim = got.filter((e) => e.type === "interim_text").map((e) => e.text).join("");
  assert.match(interim, /Let me check the services:/, "preamble streamed as interim_text");

  // Tool call + result surfaced live, BEFORE the final answer.
  const tu = got.find((e) => e.type === "tool_use");
  assert.ok(tu && tu.name === "Bash", "streamed the tool_use");
  assert.ok(got.some((e) => e.type === "tool_result"), "streamed the tool_result");

  // The authoritative final answer is ONE text_bulk + interim_commit_final + phase.
  const bulk = got.find((e) => e.type === "text_bulk");
  assert.ok(bulk, "emitted text_bulk for the final answer");
  assert.match(bulk.text, /12 services are running/);
  assert.ok(got.some((e) => e.type === "interim_commit_final"), "emitted interim_commit_final to trim the thinking channel");
  assert.ok(got.some((e) => e.type === "phase" && e.phase === "answering"), "flipped to answering phase");

  // Ordering + clean termination.
  assert.ok(types.indexOf("tool_use") < types.indexOf("text_bulk"), "tools stream before the final answer");
  assert.equal(types[types.length - 1], "done");
});

test("claude-code driver: turn ending on a tool (no final text block) still yields the answer from result.result", async () => {
  // Fake binary whose LAST assistant message is a tool_use, but result.result
  // carries the CLI's assembled final answer — driver must promote it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-bin2-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const emit=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");
emit({type:"system",subtype:"init",session_id:"s2"});
setTimeout(()=>{
  emit({type:"assistant",message:{id:"a1",content:[{type:"text",text:"Running it now:"}]}});
  emit({type:"assistant",message:{id:"a2",content:[{type:"tool_use",name:"Bash",input:{command:"echo done"}}]}});
  emit({type:"user",message:{content:[{type:"tool_result",content:"done"}]}});
  emit({type:"result",subtype:"success",is_error:false,result:"All set — the command ran.",session_id:"s2"});
  process.exit(0);
},60);
`, { mode: 0o755 });
  process.env.CLAUDE_PATH = bin;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cc-work2-"));

  const got = [];
  for await (const ev of claudeCodeDriver.startSession(makeOpts(work))) got.push(ev);
  const bulk = got.find((e) => e.type === "text_bulk");
  assert.ok(bulk, "promoted result.result as text_bulk even though the turn ended on a tool");
  assert.match(bulk.text, /All set/);
  assert.equal(got.map((e) => e.type).includes("text"), false, "still no final-channel text events");
});
