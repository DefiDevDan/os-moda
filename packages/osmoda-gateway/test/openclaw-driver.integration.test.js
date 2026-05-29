import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openClawDriver } from "../dist/drivers/openclaw.js";

/**
 * Integration test of the OpenClaw driver's STREAMING path end-to-end, with a
 * SIMULATED openclaw binary — no model credits needed. This exercises the real
 * driver: trajectory tail loop → openclaw-trajectory mapper → final --json →
 * text_bulk + interim_commit_final + done. It is the strongest verification of
 * the streaming machinery achievable without a funded LLM credential.
 *
 * The fake binary, given `--session-id <id>`, writes the session trajectory
 * jsonl incrementally (session.started → model.completed with text+toolCall →
 * context.compiled with the toolResult → model.completed with the final text),
 * then prints the final answer as JSON on stdout and exits — exactly the shape
 * the real `openclaw agent --local --json` produces.
 */

function makeFakeOpenclaw(agentsDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bin-"));
  const bin = path.join(dir, "openclaw");
  // The script branches on argv: `--help` (healthCheck), `agents list/add`
  // (registration), and the `agent` run (writes trajectory + final json).
  const script = `#!/usr/bin/env node
const fs = require("fs"); const path = require("path");
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

if (has("--help")) { console.log("🦞 OpenClaw 2026.5.20 (test)\\nCommands:\\n  agent   Run an agent turn\\n"); process.exit(0); }
if (args[0] === "agents" && args[1] === "list") { console.log("Agents:\\n- osmoda (default)"); process.exit(0); }
if (args[0] === "agents" && args[1] === "add") { process.exit(0); }

if (args[0] === "agent") {
  const sid = val("--session-id") || "s";
  const agentId = val("--agent") || "osmoda";
  const base = process.env.OPENCLAW_AGENTS_DIR || "/root/.openclaw/agents";
  const sdir = path.join(base, agentId, "sessions");
  fs.mkdirSync(sdir, { recursive: true });
  const tf = path.join(sdir, sid + ".trajectory.jsonl");
  const w = (o) => fs.appendFileSync(tf, JSON.stringify(o) + "\\n");
  // Write incrementally with small delays so the driver's poll loop sees growth.
  w({ type: "session.started", seq: 1, data: { agentId } });
  setTimeout(() => {
    w({ type: "model.completed", seq: 2, data: { message: { role: "assistant", content: [
      { type: "text", text: "Let me check disk usage." },
      { type: "toolCall", id: "tc1", name: "shell_exec", input: { command: "df -h /" } },
    ] } } });
  }, 250);
  setTimeout(() => {
    w({ type: "context.compiled", seq: 3, data: { messages: [
      { role: "toolResult", content: [{ type: "toolResult", id: "tc1", name: "shell_exec", output: "/dev/sda1 40G 12G 28G 30%" }] },
    ] } });
    w({ type: "model.completed", seq: 4, data: { message: { role: "assistant", content: [
      { type: "text", text: "Disk is 30% used." },
    ] } } });
    w({ type: "session.ended", seq: 5, data: { status: "ok" } });
    // Final --json result on stdout (authoritative answer), then exit.
    process.stdout.write(JSON.stringify({ text: "Disk is 30% used — 12G of 40G." }));
    process.exit(0);
  }, 600);
  return;
}
process.exit(0);
`;
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return bin;
}

test("openclaw driver streams the contract from a simulated run (no credits)", async () => {
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-agents-"));
  process.env.OPENCLAW_AGENTS_DIR = agentsDir;
  const bin = makeFakeOpenclaw(agentsDir);
  process.env.OPENCLAW_PATH = bin;

  const opts = {
    agent: { id: "osmoda", display_name: "t", runtime: "openclaw", credential_id: "c", model: "claude-opus-4-7", channels: [], enabled: true, updated_at: "" },
    credential: { id: "c", label: "k", provider: "anthropic", type: "api_key", secret: "sk-ant-api-XXXX", created_at: "" },
    model: "claude-opus-4-7",
    systemPrompt: "you are test",
    mcpConfigPath: "/dev/null",
    message: "how much disk is used?",
    sessionId: "itest-session-1",
    workingDir: agentsDir, // any readable dir
  };

  const got = [];
  for await (const ev of openClawDriver.startSession(opts)) {
    got.push(ev);
  }
  const types = got.map((e) => e.type);

  // Session id echoed first (continuity).
  assert.equal(got[0].type, "session");
  // A tool call streamed mid-run.
  const tu = got.find((e) => e.type === "tool_use");
  assert.ok(tu, "streamed a tool_use");
  assert.equal(tu.name, "shell_exec");
  assert.equal(tu.target, "df -h /");
  // The tool result surfaced.
  assert.ok(got.some((e) => e.type === "tool_result"), "streamed a tool_result");
  // Interim/thinking text streamed (round text).
  assert.ok(got.some((e) => e.type === "interim_text"), "streamed interim_text");
  // The authoritative final answer arrived as text_bulk + a de-dup commit.
  const bulk = got.find((e) => e.type === "text_bulk");
  assert.ok(bulk, "emitted text_bulk");
  assert.match(bulk.text, /12G of 40G/);
  assert.ok(got.some((e) => e.type === "interim_commit_final"), "emitted interim_commit_final");
  // Terminated cleanly.
  assert.equal(types[types.length - 1], "done");

  // Ordering: tool_use before its text_bulk (live stream precedes final answer).
  assert.ok(types.indexOf("tool_use") < types.indexOf("text_bulk"), "tools stream before the final answer");
});
