/**
 * OpenClaw driver — wraps the standalone `openclaw` binary as a child process.
 *
 * OpenClaw is a first-class peer to claude-code. Pick it for the OpenClaw
 * plugin ecosystem or non-Anthropic providers. Credential handling is
 * api_key only — Anthropic does not issue OAuth tokens for OpenClaw, so
 * supported_auth_types is ["api_key"]. We write the credential into
 * OpenClaw's auth-profiles.json format before each session, because
 * OpenClaw expects that file at a known path.
 *
 * This driver uses OpenClaw's one-shot run mode (`openclaw run`) and parses
 * its JSON event stream on stdout. If OpenClaw isn't installed on the host,
 * `testCredential` surfaces a clear error.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type {
  RuntimeDriver,
  DriverSessionOpts,
  AgentEvent,
  Credential,
  CredentialTestResult,
} from "./types.js";

const OPENCLAW_CANDIDATES = [
  process.env.OPENCLAW_PATH,
  "/opt/openclaw/node_modules/.bin/openclaw",
  "/usr/local/bin/openclaw",
  "/run/current-system/sw/bin/openclaw",
].filter(Boolean) as string[];

function findOpenClawBinary(): string | null {
  for (const p of OPENCLAW_CANDIDATES) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

// Serialize auth-profile writes per agent — two concurrent sessions with
// different credentials would otherwise race on the same file and a chat
// could land on the other user's credential.
const authWriteLocks = new Map<string, Promise<void>>();

function writeAuthProfile(agentId: string, cred: Credential): Promise<void> {
  const prev = authWriteLocks.get(agentId) || Promise.resolve();
  const next = prev.then(async () => {
    const dir = path.join("/root/.openclaw/agents", agentId, "agent");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const profile = cred.type === "oauth"
      ? { type: "token", provider: cred.provider, token: cred.secret }
      : { type: "api_key", provider: cred.provider, key: cred.secret };
    const target = path.join(dir, "auth-profiles.json");
    // Atomic write to avoid half-written file being read mid-launch.
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(profile), { mode: 0o600 });
    fs.renameSync(tmp, target);
  }, () => { /* swallow previous error — each call retries its own write */ });
  authWriteLocks.set(agentId, next);
  return next;
}

export const openClawDriver: RuntimeDriver = {
  name: "openclaw",
  displayName: "OpenClaw",
  description:
    "OpenClaw multi-runtime CLI (BYOK). API key only — does not accept Claude Pro OAuth tokens. Pick this for the OpenClaw plugin ecosystem or non-Anthropic providers.",
  supportedProviders: ["anthropic", "openai"],
  supportedAuthTypes: ["api_key"],
  defaultModels: ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "gpt-5"],

  async testCredential(cred: Credential): Promise<CredentialTestResult> {
    if (cred.type !== "api_key") {
      return { ok: false, error: `openclaw supports type=api_key only (got ${cred.type})` };
    }
    if (!findOpenClawBinary()) {
      return { ok: false, error: "openclaw binary not installed on this host" };
    }
    if (cred.provider === "anthropic") {
      if (!cred.secret.startsWith("sk-ant-api")) {
        return { ok: false, error: "anthropic api_key should start with sk-ant-api…" };
      }
    } else if (cred.provider === "openai") {
      if (!cred.secret.startsWith("sk-")) {
        return { ok: false, error: "openai api_key should start with sk-…" };
      }
    } else {
      return { ok: false, error: `provider ${cred.provider} not wired for openclaw` };
    }
    // Lightweight validation only — actually calling OpenClaw just to check
    // a credential is expensive. Format + provider match is enough in v1.
    return { ok: true };
  },

  async *startSession(opts: DriverSessionOpts): AsyncGenerator<AgentEvent> {
    const bin = findOpenClawBinary();
    if (!bin) {
      yield { type: "error", code: "no_binary", text: "openclaw binary not found on this host" };
      yield { type: "done" };
      return;
    }

    // OpenClaw reads auth from a file per agent id. Serialized per-agent so
    // concurrent sessions with different credentials don't collide.
    try { await writeAuthProfile(opts.agent.id, opts.credential); }
    catch (e) {
      yield {
        type: "error",
        code: "auth_write_failed",
        text: e instanceof Error ? e.message : String(e),
      };
      yield { type: "done" };
      return;
    }

    const cwd = opts.workingDir || "/root";
    // Pre-flight cwd — parity with claude-code driver: child_process.spawn()
    // returns ENOENT later with a misleading message when cwd is missing.
    try { fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK); }
    catch {
      yield {
        type: "error",
        code: "workspace_missing",
        text:
          `Workspace directory '${cwd}' does not exist or isn't readable. ` +
          `Create it on the customer box: 'mkdir -p ${cwd}' and retry.`,
      };
      yield { type: "done" };
      return;
    }

    const args = [
      "run",
      "--agent", opts.agent.id,
      "--model", opts.model,
      "--mcp-config", opts.mcpConfigPath,
      "--output-format", "json",
      "--message", opts.message,
    ];
    if (opts.sessionId) args.push("--resume", opts.sessionId);

    let proc: ChildProcess;
    try {
      // Parity with claude-code driver: `detached: true` so the Stop button
      // can kill the whole process group (openclaw + Bash + tool calls + any
      // subprocess it forked). Without this, SIGTERM only hits the leader,
      // children orphan, output keeps streaming back.
      proc = spawn(bin, args, {
        cwd,
        env: { ...process.env, HOME: process.env.HOME || "/root" },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (e) {
      yield {
        type: "error",
        code: "spawn_failed",
        text: `Failed to spawn openclaw: ${e instanceof Error ? e.message : String(e)}`,
      };
      yield { type: "done" };
      return;
    }

    // Trap async ENOENT from spawn — without this, the unhandled 'error'
    // event would crash the gateway (Node default behavior).
    let spawnError: NodeJS.ErrnoException | null = null;
    let spawnErrorResolved = false;
    const spawnErrorPromise = new Promise<void>((resolve) => {
      proc.once("error", (e: NodeJS.ErrnoException) => {
        spawnError = e;
        spawnErrorResolved = true;
        resolve();
      });
      proc.once("exit", () => {
        if (!spawnErrorResolved) { spawnErrorResolved = true; resolve(); }
      });
    });
    await Promise.race([spawnErrorPromise, new Promise((r) => setImmediate(r))]);
    if (spawnError) {
      const err = spawnError as NodeJS.ErrnoException;
      yield {
        type: "error",
        code: err.code === "ENOENT" ? "spawn_enoent" : "spawn_failed",
        text:
          err.code === "ENOENT"
            ? `spawn ENOENT: either '${bin}' or cwd '${cwd}' is missing. ` +
              `Verify: 'ls -la ${bin}' and 'ls -la ${cwd}' on the customer box.`
            : `Spawn failed: ${err.message}`,
      };
      yield { type: "done" };
      return;
    }
    // Close stdin — openclaw reads args, not stdin.
    proc.stdin?.end();

    if (opts.abortSignal) {
      // Kill the process GROUP, not just the leader. Then race a 2s SIGKILL
      // escalation for anything that ignored SIGTERM.
      opts.abortSignal.addEventListener("abort", () => {
        const pid = proc.pid;
        if (typeof pid !== "number") return;
        try { process.kill(-pid, "SIGTERM"); } catch { /* group gone */ }
        setTimeout(() => {
          try { process.kill(-pid, 0); } catch { return; }
          try { process.kill(-pid, "SIGKILL"); } catch { /* race */ }
        }, 2000);
      }, { once: true });
    }

    const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    let stderrText = "";
    let sessionId: string | undefined;
    let hasOutput = false;
    proc.stderr?.on("data", (d: Buffer) => { stderrText += d.toString(); });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }

        // Normalize OpenClaw's event stream into our AgentEvent shape.
        // OpenClaw emits shapes like:
        //   { type: "event", event: "agent", payload: { stream: "assistant", data: { text, delta } } }
        //   { type: "event", event: "tool_use", payload: { name } }
        //   { type: "event", event: "chat", payload: { state: "final", message: { content: [...] } } }
        if (ev.event === "agent" && ev.payload?.stream === "assistant") {
          const delta = ev.payload.data?.delta;
          if (typeof delta === "string" && delta.length) {
            yield { type: "text", text: delta };
            hasOutput = true;
          }
        } else if (ev.event === "tool_use" && ev.payload?.name) {
          yield { type: "tool_use", name: ev.payload.name };
          hasOutput = true;
        } else if (ev.event === "tool_result") {
          yield { type: "tool_result" };
        } else if (ev.event === "chat" && ev.payload?.state === "final") {
          const content = ev.payload.message?.content;
          if (Array.isArray(content) && !hasOutput) {
            const joined = content
              .filter((c: any) => c.type === "text" && c.text)
              .map((c: any) => c.text)
              .join("\n");
            if (joined) { yield { type: "text", text: joined }; hasOutput = true; }
          }
        } else if (ev.type === "session" && ev.session_id) {
          sessionId = ev.session_id;
          yield { type: "session", sessionId };
        }
      }
    } catch { /* ignore */ }

    const code = await new Promise<number>((resolve) => {
      proc.on("close", (c) => resolve(c ?? 1));
      // Parity with claude-code: 8h hard cap, env-overridable. The Stop button
      // (abortSignal → SIGTERM the group) is the user's real kill switch.
      const hardCapMs = parseInt(process.env.OSMODA_CHAT_HARD_CAP_MS || "28800000", 10);
      setTimeout(() => {
        const pid = proc.pid;
        if (typeof pid === "number") {
          try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
        }
        resolve(124);
      }, hardCapMs);
    });
    if (code !== 0 && !hasOutput && !opts.abortSignal?.aborted) {
      yield { type: "error", text: stderrText.trim().split("\n").pop() || `openclaw exited ${code}` };
    }
    yield { type: "done", sessionId };
  },
};
