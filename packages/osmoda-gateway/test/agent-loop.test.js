import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgentTurn, LoopManager } from "../dist/agent-loop.js";

// ── fakes ─────────────────────────────────────────────────────────────────────

/** A RuntimeDriver whose startSession yields a scripted event list.
 *  `script` may be an array (same every call) or (callIndex, opts) => events. */
function fakeDriver(script) {
  let calls = 0;
  return {
    name: "fake", displayName: "Fake", description: "", supportedProviders: [],
    supportedAuthTypes: [], defaultModels: [],
    callCount: () => calls,
    lastOpts: null,
    async testCredential() { return { ok: true }; },
    async healthCheck() { return { available: true }; },
    async *startSession(opts) {
      this.lastOpts = opts;
      const events = typeof script === "function" ? script(calls, opts) : script;
      calls++;
      for (const e of events) yield e;
    },
  };
}

/** Recorder scheduler — records schedule() calls but never auto-fires them, so
 *  tests drive ticks deterministically by calling manager.tick() directly. */
function recorderScheduler() {
  let h = 0;
  const scheduled = [];
  return {
    schedule: (_fn, ms) => { scheduled.push(ms); return ++h; },
    cancel: () => {},
    count: () => scheduled.length,
    lastMs: () => scheduled[scheduled.length - 1],
  };
}

function makeManager(over = {}) {
  const driver = over.driver || fakeDriver([{ type: "text_bulk", text: "did work" }, { type: "done", sessionId: "s1", usage: { input_tokens: 10, output_tokens: 5 } }]);
  const sched = recorderScheduler();
  const sessions = new Map();
  const transcript = [];
  const recorded = [];
  const spend = { allowed: true, reason: undefined };
  const agent = { id: "osmoda", display_name: "osmoda", model: "claude-opus-4-8", runtime: "fake", credential_id: "c1", channels: [], enabled: true, updated_at: "" };
  let idc = 0;
  const deps = {
    getAgent: (id) => (id === "osmoda" ? agent : undefined),
    getCredential: (id) => (id === "c1" ? { id: "c1", label: "k", provider: "anthropic", type: "api_key", secret: "x", created_at: "" } : undefined),
    getDriver: (n) => (n === "fake" ? driver : undefined),
    loadSystemPrompt: () => "sys",
    mcpConfigPath: "/tmp/mcp.json",
    spendCheck: () => ({ allowed: spend.allowed, reason: spend.reason }),
    spendRecord: (_a, u) => recorded.push(u),
    getSessionId: (k) => sessions.get(k),
    saveSessionId: (k, sid) => sessions.set(k, sid),
    appendTranscript: (_aid, k, row) => transcript.push({ k, role: row.role, kind: row.kind, text: row.text }),
    registerChat: () => {},
    schedule: sched.schedule,
    cancel: sched.cancel,
    now: () => 1_700_000_000_000,
    newId: () => `L${++idc}`,
    log: () => {},
    ...over,
  };
  const m = new LoopManager(deps);
  return { m, driver, sched, sessions, transcript, recorded, spend, agent };
}

// ── runAgentTurn ───────────────────────────────────────────────────────────────

test("runAgentTurn: collapses text_bulk + usage + tools + session", async () => {
  const driver = fakeDriver([
    { type: "tool_use", name: "Bash" },
    { type: "text_bulk", text: "final answer" },
    { type: "done", sessionId: "sess-9", usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.42 } },
  ]);
  const seen = [];
  const r = await runAgentTurn({
    agent: { id: "a", model: "m" }, credential: { id: "c" }, driver,
    systemPrompt: "s", mcpConfigPath: "/x", message: "go", onEvent: (e) => seen.push(e.type),
  });
  assert.equal(r.text, "final answer");
  assert.equal(r.toolCount, 1);
  assert.equal(r.sessionId, "sess-9");
  assert.equal(r.usage.cost_usd, 0.42);
  assert.equal(r.hadOutput, true);
  assert.equal(r.error, undefined);
  assert.deepEqual(seen, ["tool_use", "text_bulk", "done"]);
});

test("runAgentTurn: captures an error frame", async () => {
  const driver = fakeDriver([{ type: "error", text: "rate limited" }, { type: "done" }]);
  const r = await runAgentTurn({ agent: { id: "a", model: "m" }, credential: { id: "c" }, driver, systemPrompt: "s", mcpConfigPath: "/x", message: "go" });
  assert.equal(r.error, "rate limited");
  assert.equal(r.hadOutput, false);
});

// ── LoopManager ──────────────────────────────────────────────────────────────

test("create schedules the first tick but fires nothing until it runs", () => {
  const { m, driver, sched } = makeManager();
  const loop = m.create({ agentId: "osmoda", goal: "tidy logs", intervalSeconds: 60, maxIterations: 5 });
  assert.equal(loop.status, "running");
  assert.equal(loop.iteration, 0);
  assert.equal(driver.callCount(), 0);        // no turn yet
  assert.equal(sched.count(), 1);              // first tick scheduled
  assert.equal(sched.lastMs(), 0);             // immediately
});

test("a tick fires one turn, advances iteration, persists session + transcript + usage", async () => {
  const { m, driver, sessions, transcript, recorded } = makeManager();
  const loop = m.create({ agentId: "osmoda", goal: "tidy logs", intervalSeconds: 60, maxIterations: 5 });
  await m.tick(loop.id);
  const after = m.get(loop.id);
  assert.equal(driver.callCount(), 1);
  assert.equal(after.iteration, 1);
  assert.equal(sessions.get(loop.sessionKey), "s1");          // session saved for --resume
  assert.deepEqual(recorded, [{ input_tokens: 10, output_tokens: 5 }]); // usage billed
  // transcript: a user (loop prompt) row + an assistant row
  const roles = transcript.filter((t) => t.k === loop.sessionKey).map((t) => t.role);
  assert.ok(roles.includes("user") && roles.includes("assistant"));
});

test("maxIterations halts the loop as completed", async () => {
  const { m } = makeManager();
  const loop = m.create({ agentId: "osmoda", goal: "g", intervalSeconds: 60, maxIterations: 2 });
  await m.tick(loop.id);  // iter 1
  await m.tick(loop.id);  // iter 2 → hits cap
  const after = m.get(loop.id);
  assert.equal(after.iteration, 2);
  assert.equal(after.status, "completed");
  assert.equal(after.finishedReason, "max_iterations");
  // a further tick is a no-op
  await m.tick(loop.id);
  assert.equal(m.get(loop.id).iteration, 2);
});

test("stop sentinel completes the loop early (goal_met)", async () => {
  const driver = fakeDriver([{ type: "text_bulk", text: "all done here\nGOAL_COMPLETE" }, { type: "done", sessionId: "s1" }]);
  const { m } = makeManager({ driver });
  const loop = m.create({ agentId: "osmoda", goal: "g", intervalSeconds: 60, maxIterations: 10, stopSentinel: "GOAL_COMPLETE" });
  await m.tick(loop.id);
  const after = m.get(loop.id);
  assert.equal(after.status, "completed");
  assert.equal(after.finishedReason, "goal_met");
  assert.equal(after.iteration, 1);
});

test("spend cap blocks a tick WITHOUT firing the model; loop stays running and reschedules", async () => {
  const { m, driver, sched, spend } = makeManager();
  const loop = m.create({ agentId: "osmoda", goal: "g", intervalSeconds: 60, maxIterations: 10 });
  spend.allowed = false; spend.reason = "daily token cap reached";
  const before = sched.count();
  await m.tick(loop.id);
  const after = m.get(loop.id);
  assert.equal(driver.callCount(), 0);          // model NOT invoked
  assert.equal(after.status, "running");        // not paused — auto-resumes at UTC reset
  assert.equal(after.blocked, "spend_capped");
  assert.equal(after.iteration, 0);
  assert.ok(sched.count() > before);            // rescheduled
});

test("three consecutive errors pause the loop", async () => {
  const driver = fakeDriver([{ type: "error", text: "boom" }, { type: "done" }]);
  const { m } = makeManager({ driver });
  const loop = m.create({ agentId: "osmoda", goal: "g", intervalSeconds: 60, maxIterations: 10 });
  await m.tick(loop.id);
  await m.tick(loop.id);
  assert.equal(m.get(loop.id).status, "running"); // still trying after 2
  await m.tick(loop.id);
  const after = m.get(loop.id);
  assert.equal(after.status, "paused");
  assert.equal(after.finishedReason, "repeated_errors");
});

test("stop() halts the loop and further ticks no-op", async () => {
  const { m, driver } = makeManager();
  const loop = m.create({ agentId: "osmoda", goal: "g", intervalSeconds: 60, maxIterations: 10 });
  m.stop(loop.id);
  assert.equal(m.get(loop.id).status, "stopped");
  await m.tick(loop.id);
  assert.equal(driver.callCount(), 0);
});

test("create rejects an unknown agent and a blank goal", () => {
  const { m } = makeManager();
  assert.throws(() => m.create({ agentId: "ghost", goal: "g", intervalSeconds: 60, maxIterations: 5 }), /unknown agent/);
  assert.throws(() => m.create({ agentId: "osmoda", goal: "   ", intervalSeconds: 60, maxIterations: 5 }), /goal is required/);
});

test("interval + iteration bounds are clamped/validated", () => {
  const { m } = makeManager();
  assert.throws(() => m.create({ agentId: "osmoda", goal: "g", intervalSeconds: 1, maxIterations: 5 }), /intervalSeconds/);
  assert.throws(() => m.create({ agentId: "osmoda", goal: "g", intervalSeconds: 60, maxIterations: 0 }), /maxIterations/);
});

test("persistence: a loop survives a new manager from the same file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loops-"));
  const file = path.join(dir, "loops.json");
  const h1 = makeManager({ file });
  const loop = h1.m.create({ agentId: "osmoda", goal: "persist me", intervalSeconds: 60, maxIterations: 5 });
  await h1.m.tick(loop.id);
  // fresh manager, same file
  const h2 = makeManager({ file });
  const restored = h2.m.get(loop.id);
  assert.ok(restored, "loop reloaded");
  assert.equal(restored.goal, "persist me");
  assert.equal(restored.iteration, 1);
  assert.equal(restored.status, "running");
  fs.rmSync(dir, { recursive: true, force: true });
});
