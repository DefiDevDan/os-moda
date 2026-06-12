/**
 * Agent loop engine (V2 — the autonomy substrate).
 *
 * osModa's pitch is "a Jarvis that runs 24/7 and keeps working between your
 * messages". Before this, nothing fired an LLM turn on its own: osmoda-routines
 * runs only DETERMINISTIC actions (health checks, log scans) — none invoke the
 * model — and the gateway only ran a turn in direct response to a WS/Telegram
 * message. This module is the missing piece: a scheduler that fires real agent
 * turns toward a standing GOAL, on a cadence, until a STOP CONDITION is met or an
 * ITERATION CAP is hit — every tick gated by the V1 spend kill-switch so an
 * unattended loop can never outrun its budget.
 *
 * A loop IS a named chat: it owns a sessionKey, resumes the same runtime session
 * each tick (so the agent remembers what it did last iteration), and writes to
 * the canonical transcript — so its progress is visible in the dashboard and to
 * other chats via cross-chat awareness.
 *
 * Everything is dependency-injected (driver, spend meter, session/transcript
 * stores, and crucially the SCHEDULER) so the whole engine is unit-testable with
 * a fake driver and a manual clock — no real timers, no real API calls.
 */
import fs from "fs";
import type { AgentProfile, Credential, RuntimeDriver, AgentEvent } from "./drivers/types.js";

// ── Headless single turn ────────────────────────────────────────────────────

export interface TurnResult {
  text: string;
  usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
  sessionId?: string;
  toolCount: number;
  hadOutput: boolean;
  error?: string;
}

export interface RunTurnOpts {
  agent: AgentProfile;
  credential: Credential;
  driver: RuntimeDriver;
  systemPrompt: string;
  mcpConfigPath: string;
  message: string;
  sessionId?: string;
  workingDir?: string;
  abortSignal?: AbortSignal;
  /** Side-effect sink for every event (transcript writes, live streaming). */
  onEvent?: (e: AgentEvent) => void;
}

/**
 * Drive ONE agent turn to completion and collapse its event stream into a
 * result. Headless — no WebSocket, no transcript writes of its own (the caller
 * does those via onEvent). Shared by the loop engine and the POST /agent/turn
 * endpoint, so both honour the exact same two-channel contract as interactive
 * chat (final answer = text_bulk/text; usage on the terminal `done`).
 */
export async function runAgentTurn(opts: RunTurnOpts): Promise<TurnResult> {
  let text = "";
  let sessionId = opts.sessionId;
  let usage: TurnResult["usage"];
  let toolCount = 0;
  let hadOutput = false;
  let error: string | undefined;
  try {
    for await (const event of opts.driver.startSession({
      agent: opts.agent,
      credential: opts.credential,
      model: opts.agent.model,
      systemPrompt: opts.systemPrompt,
      mcpConfigPath: opts.mcpConfigPath,
      message: opts.message,
      sessionId: opts.sessionId,
      abortSignal: opts.abortSignal,
      workingDir: opts.workingDir,
    })) {
      opts.onEvent?.(event);
      if (event.type === "text_bulk" && event.text) { text = event.text; hadOutput = true; }
      else if (event.type === "text" && event.text) { text += event.text; hadOutput = true; }
      else if (event.type === "interim_text") { hadOutput = true; }
      else if (event.type === "tool_use") { toolCount++; hadOutput = true; }
      else if (event.type === "session" && event.sessionId) { sessionId = event.sessionId; }
      else if (event.type === "done") {
        if (event.sessionId) sessionId = event.sessionId;
        if (event.usage) usage = event.usage;
      } else if (event.type === "error") {
        error = event.text || "agent error";
      }
    }
  } catch (e: any) {
    error = e?.message || String(e);
  }
  return { text, usage, sessionId, toolCount, hadOutput, error };
}

// ── Loop manager ─────────────────────────────────────────────────────────────

export type LoopStatus = "running" | "paused" | "completed" | "stopped";

export interface LoopHistoryEntry {
  iteration: number;
  at: string;            // ISO
  ok: boolean;
  toolCount: number;
  chars: number;
  note?: string;         // error / skip reason / stop reason
}

export interface Loop {
  id: string;
  name: string;
  agentId: string;
  goal: string;
  intervalSeconds: number;
  maxIterations: number;
  stopSentinel: string;
  sessionKey: string;
  status: LoopStatus;
  iteration: number;        // completed iterations
  createdAt: string;
  updatedAt: string;
  lastResult?: string;
  lastError?: string;
  /** Why a non-running loop stopped: max_iterations | goal_met | stopped | agent_missing | … */
  finishedReason?: string;
  /** Transient: running but last tick was skipped (e.g. spend_capped). Cleared on a real tick. */
  blocked?: string | null;
  consecutiveErrors: number;
  history: LoopHistoryEntry[];
}

export interface CreateLoopInput {
  agentId: string;
  goal: string;
  intervalSeconds: number;
  maxIterations: number;
  stopSentinel?: string;
  name?: string;
}

export interface LoopManagerDeps {
  getAgent: (id: string) => AgentProfile | undefined;
  getCredential: (id: string) => Credential | undefined;
  getDriver: (name: string) => RuntimeDriver | undefined;
  loadSystemPrompt: (agent: AgentProfile) => string;
  mcpConfigPath: string;
  /** V1 spend kill-switch — checked BEFORE every tick fires the model. */
  spendCheck: (agent: AgentProfile) => { allowed: boolean; reason?: string };
  /** V1 spend meter — bill each tick's usage. */
  spendRecord: (agent: AgentProfile, usage: any) => void;
  getSessionId: (sessionKey: string, agentId: string, runtime: string) => string | undefined;
  saveSessionId: (sessionKey: string, sessionId: string, runtime: string) => void;
  appendTranscript: (agentId: string, sessionKey: string, row: any) => void;
  registerChat: (sessionKey: string, opts: { agentId: string; name: string }) => void;
  /** Injectable scheduler (defaults to setTimeout/clearTimeout). Tests pass a manual one. */
  schedule?: (fn: () => void, ms: number) => any;
  cancel?: (handle: any) => void;
  now?: () => number;
  /** newId is injectable because Math.random/Date.now are unavailable in some sandboxes. */
  newId?: () => string;
  file?: string;
  log?: (msg: string) => void;
  maxLoops?: number;
}

const MAX_HISTORY = 20;
const MAX_CONSECUTIVE_ERRORS = 3;
const MIN_INTERVAL = 10;       // seconds — don't let a loop hammer the API
const MAX_INTERVAL = 86_400;   // 24h
const MAX_ITER_CAP = 1000;     // hard ceiling on maxIterations
const DEFAULT_MAX_LOOPS = 50;

export class LoopManager {
  private d: LoopManagerDeps;
  private loops = new Map<string, Loop>();
  private timers = new Map<string, any>();
  private aborts = new Map<string, AbortController>();
  private seq = 0;

  constructor(deps: LoopManagerDeps) {
    this.d = deps;
    this.load();
  }

  private now(): number { return (this.d.now || (() => Date.now()))(); }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private schedule(fn: () => void, ms: number): any { return (this.d.schedule || setTimeout)(fn, ms); }
  private cancel(h: any): void { (this.d.cancel || clearTimeout)(h); }
  private log(m: string): void { (this.d.log || (() => {}))(m); }

  private mkId(): string {
    if (this.d.newId) return this.d.newId();
    return `loop-${(++this.seq).toString(36)}-${this.now().toString(36)}`;
  }

  list(): Loop[] {
    return [...this.loops.values()].sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
  }
  get(id: string): Loop | undefined { return this.loops.get(id); }

  /** Create a loop and kick off its first tick (immediately, then on cadence). */
  create(input: CreateLoopInput): Loop {
    const activeCount = [...this.loops.values()].filter((l) => l.status === "running").length;
    if (activeCount >= (this.d.maxLoops ?? DEFAULT_MAX_LOOPS)) {
      throw new Error(`loop limit reached (${this.d.maxLoops ?? DEFAULT_MAX_LOOPS} active)`);
    }
    const agent = this.d.getAgent(input.agentId);
    if (!agent) throw new Error(`unknown agent ${input.agentId}`);
    if (!input.goal || !input.goal.trim()) throw new Error("goal is required");
    const interval = clampInt(input.intervalSeconds, MIN_INTERVAL, MAX_INTERVAL, "intervalSeconds");
    const maxIter = clampInt(input.maxIterations, 1, MAX_ITER_CAP, "maxIterations");

    const id = this.mkId();
    const loop: Loop = {
      id,
      name: input.name?.trim() || `Loop ${id}`,
      agentId: input.agentId,
      goal: input.goal.trim(),
      intervalSeconds: interval,
      maxIterations: maxIter,
      stopSentinel: (input.stopSentinel || "GOAL_COMPLETE").trim().toUpperCase(),
      sessionKey: `loop-${id}`,
      status: "running",
      iteration: 0,
      createdAt: this.iso(),
      updatedAt: this.iso(),
      consecutiveErrors: 0,
      blocked: null,
      history: [],
    };
    this.loops.set(id, loop);
    this.d.registerChat(loop.sessionKey, { agentId: agent.id, name: loop.name });
    this.persist();
    this.log(`[loop] created ${id} "${loop.name}" → agent=${agent.id} every ${interval}s, ≤${maxIter} iters`);
    // First tick fires immediately so the user sees progress; the tick reschedules.
    this.timers.set(id, this.schedule(() => { void this.tick(id); }, 0));
    return loop;
  }

  stop(id: string): Loop | undefined {
    const loop = this.loops.get(id);
    if (!loop) return undefined;
    this.clearTimer(id);
    this.aborts.get(id)?.abort();
    loop.status = "stopped";
    loop.finishedReason = "stopped";
    loop.blocked = null;
    loop.updatedAt = this.iso();
    this.persist();
    this.log(`[loop] stopped ${id}`);
    return loop;
  }

  pause(id: string, reason = "paused"): Loop | undefined {
    const loop = this.loops.get(id);
    if (!loop) return undefined;
    this.clearTimer(id);
    this.aborts.get(id)?.abort();
    loop.status = "paused";
    loop.finishedReason = reason;
    loop.updatedAt = this.iso();
    this.persist();
    this.log(`[loop] paused ${id} (${reason})`);
    return loop;
  }

  resume(id: string): Loop | undefined {
    const loop = this.loops.get(id);
    if (!loop) return undefined;
    if (loop.status !== "paused") return loop;
    loop.status = "running";
    loop.finishedReason = undefined;
    loop.consecutiveErrors = 0;
    loop.updatedAt = this.iso();
    this.persist();
    this.clearTimer(id);
    this.timers.set(id, this.schedule(() => { void this.tick(id); }, 0));
    this.log(`[loop] resumed ${id}`);
    return loop;
  }

  /** Reschedule any persisted `running` loops after a restart — on cadence, NOT
   * immediately, so a reboot doesn't fire every loop at once. */
  resumeAll(): void {
    for (const loop of this.loops.values()) {
      if (loop.status === "running") {
        this.clearTimer(loop.id);
        this.timers.set(loop.id, this.schedule(() => { void this.tick(loop.id); }, loop.intervalSeconds * 1000));
        this.log(`[loop] rescheduled ${loop.id} after restart (next in ${loop.intervalSeconds}s)`);
      }
    }
  }

  /** Cancel all timers + abort in-flight turns (graceful shutdown). */
  shutdown(): void {
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
    for (const ac of this.aborts.values()) ac.abort();
  }

  private clearTimer(id: string): void {
    const h = this.timers.get(id);
    if (h !== undefined) { this.cancel(h); this.timers.delete(id); }
  }

  private finish(loop: Loop, reason: string): void {
    loop.status = "completed";
    loop.finishedReason = reason;
    loop.blocked = null;
    loop.updatedAt = this.iso();
    this.clearTimer(loop.id);
    this.pushHistory(loop, { ok: true, toolCount: 0, chars: 0, note: `done: ${reason}` });
    this.persist();
    this.log(`[loop] completed ${loop.id} (${reason}) after ${loop.iteration} iter`);
  }

  private reschedule(loop: Loop): void {
    this.clearTimer(loop.id);
    this.timers.set(loop.id, this.schedule(() => { void this.tick(loop.id); }, loop.intervalSeconds * 1000));
  }

  private pushHistory(loop: Loop, e: Omit<LoopHistoryEntry, "iteration" | "at">): void {
    loop.history.push({ iteration: loop.iteration, at: this.iso(), ...e });
    if (loop.history.length > MAX_HISTORY) loop.history.splice(0, loop.history.length - MAX_HISTORY);
  }

  private buildMessage(loop: Loop): string {
    const n = loop.iteration + 1;
    const stop = `Reply with the single line "${loop.stopSentinel}" (on its own line) ONLY when the goal is fully achieved and nothing remains.`;
    if (loop.iteration === 0) {
      return (
        `[Autonomous loop — iteration ${n} of up to ${loop.maxIterations}. You are running unattended on a ${loop.intervalSeconds}s schedule with full system tools.]\n\n` +
        `Goal: ${loop.goal}\n\n` +
        `Begin working toward this goal now. Make concrete progress this iteration, then end with a short status of what you did and what remains. The next iteration resumes automatically.\n` +
        stop
      );
    }
    return (
      `[Autonomous loop — iteration ${n} of up to ${loop.maxIterations}. Continuing the same goal; you have your prior context.]\n\n` +
      `Continue making concrete progress toward the goal, then end with a short status.\n` +
      stop
    );
  }

  private sentinelHit(text: string, sentinel: string): boolean {
    return text.split("\n").some((line) => line.trim().toUpperCase() === sentinel);
  }

  /** One scheduled iteration. Public for tests (drive ticks manually with a fake scheduler). */
  async tick(id: string): Promise<void> {
    const loop = this.loops.get(id);
    if (!loop || loop.status !== "running") return;
    this.timers.delete(id); // this firing consumed its timer

    if (loop.iteration >= loop.maxIterations) { this.finish(loop, "max_iterations"); return; }

    const agent = this.d.getAgent(loop.agentId);
    if (!agent) { this.pause(id, "agent_missing"); return; }

    // V1 spend gate — do NOT fire the model if the agent is over budget. Stay
    // `running` + mark blocked, and reschedule: the cap resets at 00:00 UTC, so
    // the loop auto-resumes on the first tick of the new day. No tokens burned.
    const gate = this.d.spendCheck(agent);
    if (!gate.allowed) {
      loop.blocked = "spend_capped";
      loop.lastError = gate.reason;
      loop.updatedAt = this.iso();
      this.pushHistory(loop, { ok: false, toolCount: 0, chars: 0, note: `skipped: ${gate.reason || "spend_capped"}` });
      this.persist();
      this.log(`[loop] ${id} skipped — spend cap (${gate.reason || ""}); will retry after reset`);
      this.reschedule(loop);
      return;
    }

    const cred = this.d.getCredential(agent.credential_id);
    if (!cred) { this.pause(id, "credential_missing"); return; }
    const driver = this.d.getDriver(agent.runtime);
    if (!driver) { this.pause(id, "runtime_unavailable"); return; }

    loop.blocked = null;
    const message = this.buildMessage(loop);
    this.d.appendTranscript(agent.id, loop.sessionKey, { role: "user", text: message, source: "loop" });

    const ac = new AbortController();
    this.aborts.set(id, ac);
    const sessionId = this.d.getSessionId(loop.sessionKey, agent.id, agent.runtime);
    const result = await runAgentTurn({
      agent, credential: cred, driver,
      systemPrompt: this.d.loadSystemPrompt(agent),
      mcpConfigPath: this.d.mcpConfigPath,
      message,
      sessionId,
      workingDir: agent.profile_dir,
      abortSignal: ac.signal,
      onEvent: (e) => {
        if (e.type === "tool_use") {
          this.d.appendTranscript(agent.id, loop.sessionKey, { role: "tool", kind: "use", name: e.name, target: e.target });
        } else if (e.type === "tool_result") {
          this.d.appendTranscript(agent.id, loop.sessionKey, { role: "tool", kind: "result", outcome: e.outcome });
        }
      },
    });
    this.aborts.delete(id);

    // A loop can be stopped/paused mid-turn; if so, don't resurrect it.
    if (loop.status !== "running") return;

    if (result.error && !result.hadOutput) {
      loop.consecutiveErrors++;
      loop.lastError = result.error;
      loop.updatedAt = this.iso();
      this.pushHistory(loop, { ok: false, toolCount: result.toolCount, chars: 0, note: `error: ${result.error}` });
      if (loop.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) { this.pause(id, "repeated_errors"); return; }
      this.persist();
      this.reschedule(loop);
      return;
    }

    // Success: bill usage, persist session + transcript, advance.
    loop.consecutiveErrors = 0;
    if (result.usage) this.d.spendRecord(agent, result.usage);
    if (result.sessionId) this.d.saveSessionId(loop.sessionKey, result.sessionId, agent.runtime);
    if (result.text.trim()) this.d.appendTranscript(agent.id, loop.sessionKey, { role: "assistant", text: result.text });
    loop.iteration++;
    loop.lastResult = result.text.slice(0, 2000);
    loop.lastError = undefined;
    loop.updatedAt = this.iso();
    this.pushHistory(loop, { ok: true, toolCount: result.toolCount, chars: result.text.length });

    if (this.sentinelHit(result.text, loop.stopSentinel)) { this.finish(loop, "goal_met"); return; }
    if (loop.iteration >= loop.maxIterations) { this.finish(loop, "max_iterations"); return; }
    this.persist();
    this.reschedule(loop);
  }

  // ── persistence ────────────────────────────────────────────────────────────

  private persist(): void {
    if (!this.d.file) return;
    try {
      const obj = [...this.loops.values()];
      const tmp = `${this.d.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
      fs.renameSync(tmp, this.d.file);
    } catch { /* best-effort; loop defs are reconstructible, a missed write loses at most the latest state */ }
  }

  private load(): void {
    if (!this.d.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.file, "utf8"));
      if (Array.isArray(raw)) {
        for (const l of raw) {
          if (l && typeof l.id === "string") {
            // A loop that was mid-tick when the process died is restored as
            // running; resumeAll() reschedules it on cadence. Clear any
            // transient blocked flag — it'll be re-evaluated on the next tick.
            this.loops.set(l.id, { ...l, blocked: null, history: Array.isArray(l.history) ? l.history : [] });
          }
        }
      }
    } catch { /* missing/corrupt → no loops */ }
  }
}

function clampInt(v: any, min: number, max: number, name: string): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  if (n < min) throw new Error(`${name} must be ≥ ${min}`);
  if (n > max) throw new Error(`${name} must be ≤ ${max}`);
  return n;
}
