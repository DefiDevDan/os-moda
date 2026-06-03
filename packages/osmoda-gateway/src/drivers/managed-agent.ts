/**
 * managed-agent runtime driver — Anthropic **Managed Agents** via the `ant` CLI
 * (`ant beta:agents | beta:environments | beta:sessions`).
 *
 * KEY DIFFERENCE from claude-code / openclaw: those run the agent LOCALLY on this
 * box with root (the agent IS the system). A Managed Agent runs in Anthropic's
 * CLOUD sandbox — it has NO access to this box's filesystem/daemons. So this
 * runtime is for the SANDBOXED / app / workload tier (untrusted tools, scale-out
 * workers, the deploy-ai-agent use case) — NOT the tier-0 system agent.
 *
 * Per turn: ensure a managed agent + cloud environment exist (created once,
 * cached), create/resume a session, send the user message as a `user.message`
 * event, stream the session events, and map them to the osModa event contract —
 * so the SAME relay + dashboard render a Managed Agent exactly like a local one.
 *
 * ⚠ Managed Agents is a BETA API. The exact stream-event field names are mapped
 * PERMISSIVELY here (probe the plausible locations) and should be tightened
 * against one real run — the same honest approach we used for the openclaw
 * trajectory mapper. `mapAntStreamEvent` is a pure function so it's unit-tested.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type {
  RuntimeDriver, DriverSessionOpts, AgentEvent, Credential,
  DriverHealthResult, CredentialTestResult,
} from "./types.js";

function findAnt(): string {
  for (const p of [process.env.ANT_PATH, "/usr/local/bin/ant", "/run/current-system/sw/bin/ant"].filter(Boolean) as string[]) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return "ant";
}

function antEnv(cred: Credential): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  // Managed Agents IS the Claude API — an API key with managed-agents beta
  // access. (OAuth subscription tokens are entitled to the CLI, not necessarily
  // the API, so api_key is the supported auth type here; OAuth would need an
  // interactive `ant auth login`, which a daemon can't do.)
  if (cred.secret) env.ANTHROPIC_API_KEY = cred.secret;
  if (cred.base_url) env.ANTHROPIC_BASE_URL = cred.base_url;
  return env;
}

/** Run a one-shot `ant` command and JSON-parse stdout. */
function antJson(bin: string, env: NodeJS.ProcessEnv, args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, [...args, "--format", "json"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => {
      if (c === 0) { try { resolve(JSON.parse(out)); } catch { resolve(out.trim()); } }
      else reject(new Error(err.trim().split("\n").pop() || `ant exited ${c}`));
    });
    p.on("error", reject);
  });
}

const STATE_FILE = process.env.OSMODA_MANAGED_AGENT_STATE || "/var/lib/osmoda/state/managed-agent.json";

/** Ensure a managed agent + cloud environment exist (created once, cached to
 * disk). Pre-provisioned ids can be supplied via env to skip creation. */
async function ensureAgentEnv(bin: string, env: NodeJS.ProcessEnv, model: string, systemPrompt: string): Promise<{ agentId: string; environmentId: string }> {
  if (process.env.OSMODA_MANAGED_AGENT_ID && process.env.OSMODA_MANAGED_ENV_ID) {
    return { agentId: process.env.OSMODA_MANAGED_AGENT_ID, environmentId: process.env.OSMODA_MANAGED_ENV_ID };
  }
  try {
    const cached = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (cached?.agentId && cached?.environmentId) return cached;
  } catch { /* not provisioned yet */ }
  const agent = await antJson(bin, env, ["beta:agents", "create", "--name", "osmoda-managed", "--model", JSON.stringify({ id: model }), "--system", systemPrompt.slice(0, 8000)]);
  const environment = await antJson(bin, env, ["beta:environments", "create", "--name", "osmoda-env", "--config", JSON.stringify({ type: "cloud", networking: { type: "unrestricted" } })]);
  const ids = { agentId: agent.id, environmentId: environment.id };
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(ids, null, 2), { mode: 0o600 }); } catch { /* cache best-effort */ }
  return ids;
}

// ── Pure event mapper (unit-tested) ──────────────────────────────────────────

export interface AntMapState { emittedInterim: number; lastText: string; }
export function newAntMapState(): AntMapState { return { emittedInterim: 0, lastText: "" }; }

function blocks(ev: any): any[] {
  const c = ev?.content ?? ev?.message?.content ?? ev?.delta;
  return Array.isArray(c) ? c : c ? [c] : [];
}

/**
 * Map ONE managed-session stream event → zero+ AgentEvents. PERMISSIVE for the
 * beta schema: it surfaces assistant text on the interim (thinking) channel
 * while streaming, tool calls/results as they appear, and promotes the final
 * answer as text_bulk on a terminal event — exactly the two-channel contract the
 * dashboard already renders. Tighten the field probes against one real run.
 */
export function mapAntStreamEvent(ev: any, state: AntMapState): AgentEvent[] {
  if (!ev || typeof ev !== "object") return [];
  const out: AgentEvent[] = [];
  const type = String(ev.type || "");

  for (const b of blocks(ev)) {
    if (!b || typeof b !== "object") continue;
    const bt = String(b.type || "");
    if ((bt === "tool_use" || bt === "tool_call") && (b.name || b.tool)) {
      const input = b.input || b.args || b.arguments;
      const target = input?.command || input?.path || input?.url || input?.query;
      out.push({ type: "tool_use", name: b.name || b.tool, target: target ? String(target).slice(0, 80) : undefined });
    } else if (bt === "tool_result") {
      const raw = typeof b.text === "string" ? b.text : typeof b.content === "string" ? b.content : "";
      out.push({ type: "tool_result", outcome: b.is_error ? "error" : "success", summary: String(raw).replace(/\s+/g, " ").trim().slice(0, 120) });
    } else if ((bt === "text" || bt === "text_delta") && (b.text || b.delta)) {
      const t = b.text || b.delta || "";
      out.push({ type: "interim_text", text: t });
      state.emittedInterim += t.length;
      state.lastText += t;
    }
  }

  // Terminal: assistant turn / session completed → promote the final answer.
  if (/(completed|\.end$|turn\.end|message\.stop|stop$)/.test(type) || ev.stop_reason) {
    const finalText = (typeof ev.result === "string" && ev.result.trim()) ? ev.result : state.lastText;
    if (finalText && finalText.trim()) {
      if (state.emittedInterim > 0) out.push({ type: "interim_commit_final", length: state.emittedInterim });
      out.push({ type: "text_bulk", text: finalText });
      out.push({ type: "phase", phase: "answering" });
    }
    out.push({ type: "done" });
  }
  return out;
}

// ── Driver ────────────────────────────────────────────────────────────────

export const managedAgentDriver: RuntimeDriver = {
  name: "managed-agent",
  displayName: "Managed Agent (Anthropic cloud)",
  description:
    "Anthropic Managed Agents via the `ant` CLI — the agent runs in Anthropic's CLOUD sandbox, not on this box. For sandboxed/app/workload agents, NOT the tier-0 system agent (which needs local root).",
  supportedProviders: ["anthropic"],
  supportedAuthTypes: ["api_key"],
  defaultModels: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],

  async testCredential(cred: Credential): Promise<CredentialTestResult> {
    if (cred.provider !== "anthropic") return { ok: false, error: `managed-agent supports provider=anthropic, got ${cred.provider}` };
    if (cred.type !== "api_key") return { ok: false, error: "managed-agent needs an api_key credential with Managed Agents beta access (OAuth-CLI tokens can't call the API)" };
    if (!cred.secret || cred.secret.length < 20) return { ok: false, error: "secret missing or too short" };
    return { ok: true };
  },

  async healthCheck(): Promise<DriverHealthResult> {
    const bin = findAnt();
    return new Promise((resolve) => {
      const p = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout?.on("data", (d) => (out += d.toString()));
      p.on("error", () => resolve({ available: false, error: "`ant` CLI not found", remediation: "Install the Anthropic CLI: https://platform.claude.com/docs/en/api/sdks/cli (then `ant auth login` or set an api_key credential)." }));
      p.on("close", (c) => {
        if (c === 0) resolve({ available: true, version: out.trim().split("\n")[0] || "ant" });
        else resolve({ available: false, error: `\`ant --version\` exited ${c}`, remediation: "Reinstall the Anthropic `ant` CLI." });
      });
      setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } resolve({ available: false, error: "`ant --version` timed out" }); }, 5000);
    });
  },

  async *startSession(opts: DriverSessionOpts): AsyncGenerator<AgentEvent> {
    const bin = findAnt();
    const env = antEnv(opts.credential);

    let ids: { agentId: string; environmentId: string };
    try { ids = await ensureAgentEnv(bin, env, opts.model, opts.systemPrompt); }
    catch (e: any) { yield { type: "error", code: "managed_provision_failed", text: `Could not provision the managed agent/environment: ${e?.message || e}` }; return; }

    let sessionId = opts.sessionId;
    if (!sessionId) {
      try {
        const s = await antJson(bin, env, ["beta:sessions", "create", "--agent", ids.agentId, "--environment-id", ids.environmentId, "--title", "osmoda chat"]);
        sessionId = s.id;
      } catch (e: any) { yield { type: "error", text: `Could not create managed session: ${e?.message || e}` }; return; }
    }
    yield { type: "session", sessionId };

    try {
      await antJson(bin, env, ["beta:sessions:events", "send", "--session-id", sessionId!, "--event", JSON.stringify({ type: "user.message", content: [{ type: "text", text: opts.message }] })]);
    } catch (e: any) { yield { type: "error", text: `Send failed: ${e?.message || e}` }; return; }

    const proc: ChildProcess = spawn(bin, ["beta:sessions:events", "stream", "--session-id", sessionId!, "--format", "jsonl"], { env, stdio: ["ignore", "pipe", "pipe"] });
    if (opts.abortSignal) opts.abortSignal.addEventListener("abort", () => { try { proc.kill("SIGTERM"); } catch { /* gone */ } }, { once: true });

    const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    const state = newAntMapState();
    let done = false;
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let ev: any; try { ev = JSON.parse(line); } catch { continue; }
        for (const o of mapAntStreamEvent(ev, state)) { yield o; if (o.type === "done") done = true; }
        if (done) break;
      }
    } catch { /* stream closed / abort */ }
    try { proc.kill("SIGTERM"); } catch { /* gone */ }
    if (!done) yield { type: "done", sessionId };
  },
};
