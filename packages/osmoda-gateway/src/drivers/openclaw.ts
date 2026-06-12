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
  DriverHealthResult,
} from "./types.js";
import { mapTrajectoryEvent, newTrajectoryState } from "./openclaw-trajectory.js";

function findOpenClawBinary(): string | null {
  // Read OPENCLAW_PATH at CALL time (not module-load) — the env can be set
  // after import (e.g. by tests) and may change across runs.
  const candidates = [
    process.env.OPENCLAW_PATH,
    "/opt/openclaw/node_modules/.bin/openclaw",
    "/usr/local/bin/openclaw",
    "/run/current-system/sw/bin/openclaw",
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

// Base dir for OpenClaw per-agent state (auth profiles + session trajectories).
// Overridable via OPENCLAW_AGENTS_DIR so the driver is testable off-box (the
// integration test points it at a temp dir + a simulated openclaw binary).
function agentsBaseDir(): string {
  return process.env.OPENCLAW_AGENTS_DIR || "/root/.openclaw/agents";
}

// Serialize auth-profile writes per agent — two concurrent sessions with
// different credentials would otherwise race on the same file and a chat
// could land on the other user's credential.
const authWriteLocks = new Map<string, Promise<void>>();

function writeAuthProfile(agentId: string, cred: Credential): Promise<void> {
  const prev = authWriteLocks.get(agentId) || Promise.resolve();
  const next = prev.then(async () => {
    const dir = path.join(agentsBaseDir(), agentId, "agent");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // OpenClaw 2026.5+ auth store shape (AuthProfileSecretsStore):
    //   { version: 1, profiles: { "<profileId>": <AuthProfileCredential> } }
    // The pre-2026.5 driver wrote a BARE credential object ({type,provider,key})
    // which the new loader silently ignores → "No API key found for provider".
    // That single mismatch is why every openclaw chat failed after the
    // 2026.5.7 upgrade. Verified live: this shape authenticates (the only
    // remaining failure on test was a billing/credit error from the provider).
    const profileId = `${cred.provider}-default`;
    const credential =
      cred.type === "oauth"
        ? { type: "token", provider: cred.provider, token: cred.secret }
        : { type: "api_key", provider: cred.provider, key: cred.secret };
    const store = { version: 1, profiles: { [profileId]: credential } };
    const target = path.join(dir, "auth-profiles.json");
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(tmp, target);
  }, () => { /* swallow previous error — each call retries its own write */ });
  authWriteLocks.set(agentId, next);
  return next;
}

/**
 * OpenClaw 2026.5+ requires each non-default agent id to be registered in its
 * agent registry before `openclaw agent --agent <id>` will run it (otherwise:
 * "Unknown agent id"). Idempotent: lists agents, adds the id if missing. The
 * auth profile is written separately (writeAuthProfile) into the agent dir.
 */
const agentRegisterLocks = new Map<string, Promise<void>>();
function ensureAgentRegistered(bin: string, agentId: string, workspace: string): Promise<void> {
  const prev = agentRegisterLocks.get(agentId) || Promise.resolve();
  const next = prev.then(() => new Promise<void>((resolve) => {
    const list = spawn(bin, ["agents", "list"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    list.stdout?.on("data", (d) => { out += d.toString(); });
    list.on("close", () => {
      // Match "- <id>" lines from `agents list`. `main` always exists.
      const present = new RegExp(`(^|\\n)\\s*-\\s+${agentId}\\b`).test(out) || agentId === "main";
      if (present) return resolve();
      const dir = path.join(agentsBaseDir(), agentId, "agent");
      const add = spawn(
        bin,
        ["agents", "add", agentId, "--non-interactive", "--workspace", workspace, "--agent-dir", dir],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
      add.on("close", () => resolve());
      add.on("error", () => resolve());
      setTimeout(() => { try { add.kill("SIGKILL"); } catch {} ; resolve(); }, 15000);
    });
    list.on("error", () => resolve());
    setTimeout(() => { try { list.kill("SIGKILL"); } catch {} ; resolve(); }, 8000);
  }), () => {});
  agentRegisterLocks.set(agentId, next);
  return next;
}

export const openClawDriver: RuntimeDriver = {
  name: "openclaw",
  displayName: "OpenClaw",
  description:
    "OpenClaw multi-runtime CLI (BYOK). API key only — does not accept Claude Pro OAuth tokens. Pick this for the OpenClaw plugin ecosystem or non-Anthropic providers.",
  supportedProviders: ["anthropic", "openai"],
  // OpenClaw 2026.5 accepts a static bearer token too (written as an
  // AuthProfile of type "token") — verified live: a Claude OAuth subscription
  // token authenticated through `openclaw agent --local` (only blocked by the
  // subscription's usage cap, not by auth). So both api_key and oauth work.
  supportedAuthTypes: ["api_key", "oauth"],
  defaultModels: ["claude-opus-4-8", "claude-fable-5", "claude-opus-4-7", "claude-sonnet-4-6", "gpt-5"],

  async healthCheck(): Promise<DriverHealthResult> {
    // Probe the openclaw binary AND verify the CLI shape this driver depends on.
    //
    // Historical incident (2026-05-14): the driver was written against an
    // older OpenClaw that exposed `openclaw run --agent X --message Y`. The
    // installed binary at the time was OpenClaw 2026.5.7 which had renamed
    // the subcommand to `openclaw agent` (with a different option set and a
    // mandatory `openclaw agents add` registration step). Every chat through
    // openclaw failed with "Unknown command: openclaw run" but the gateway
    // surfaced it as a bare `agent_error`. The probe below detects this
    // class of CLI drift so the driver fails LOUD at runtime-selection time
    // instead of silently at chat time.
    const bin = findOpenClawBinary();
    if (!bin) {
      return {
        available: false,
        error: "openclaw binary not installed on this host",
        remediation:
          "Install: mkdir -p /opt/openclaw && cd /opt/openclaw && " +
          "npm install openclaw && ln -sf /opt/openclaw/node_modules/.bin/openclaw /usr/local/bin/openclaw",
      };
    }
    const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const proc = spawn(bin, ["--help"], { stdio: ["ignore", "pipe", "pipe"] });
        let so = "", se = "";
        proc.stdout?.on("data", (d) => { so += d.toString(); });
        proc.stderr?.on("data", (d) => { se += d.toString(); });
        proc.on("close", (c) => resolve({ code: c, stdout: so, stderr: se }));
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} ; resolve({ code: 124, stdout: so, stderr: se }); }, 5000);
      },
    );
    if (code !== 0) {
      return {
        available: false,
        error: `'${bin} --help' exited ${code}: ${(stderr || stdout).trim().slice(0, 200)}`,
        remediation: "Reinstall: cd /opt/openclaw && npm install openclaw",
      };
    }
    // Extract version. Output begins "🦞 OpenClaw 2026.5.7 (eeef486) — …".
    const versionMatch = stdout.match(/OpenClaw\s+([\d.]+(?:[-+][\w.]+)?)/);
    const version = versionMatch ? `OpenClaw ${versionMatch[1]}` : undefined;
    // This driver targets the 2026.5+ CLI: `openclaw agent --local --json …`.
    // Require the `agent` subcommand. (Pre-2026.5 used `openclaw run`; if we
    // ever see that without `agent`, the driver's invocation won't match.)
    const hasAgent = /^\s+agent\b/m.test(stdout) || /^Commands:[\s\S]*\bagent\b/m.test(stdout);
    if (!hasAgent) {
      return {
        available: false,
        version,
        error:
          `Installed ${version || "openclaw"} does not expose the 'openclaw agent' subcommand ` +
          `this driver invokes. Expected OpenClaw 2026.5+.`,
        remediation:
          "Upgrade: cd /opt/openclaw && npm install openclaw@latest, then restart osmoda-gateway.",
      };
    }
    return { available: true, version };
  },

  async testCredential(cred: Credential): Promise<CredentialTestResult> {
    if (cred.type !== "api_key" && cred.type !== "oauth") {
      return { ok: false, error: `openclaw supports type=api_key or oauth (got ${cred.type})` };
    }
    if (!findOpenClawBinary()) {
      return { ok: false, error: "openclaw binary not installed on this host" };
    }
    if (cred.provider === "anthropic") {
      // api_key → sk-ant-api…; oauth subscription token → sk-ant-oat…
      const ok = cred.type === "oauth" ? cred.secret.startsWith("sk-ant-oat") : cred.secret.startsWith("sk-ant-api");
      if (!ok) {
        return { ok: false, error: `anthropic ${cred.type} should start with sk-ant-${cred.type === "oauth" ? "oat" : "api"}…` };
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

    // Register the agent id with OpenClaw's registry if it isn't already
    // (2026.5+ rejects `--agent <id>` for unregistered ids).
    try { await ensureAgentRegistered(bin, opts.agent.id, cwd); } catch { /* best-effort */ }

    // Stable session id for continuity. OpenClaw maintains the conversation
    // under whatever id we pass; reuse it across turns. We echo it back as a
    // `session` event so the gateway persists it and resumes next turn.
    const sessionKey = opts.sessionId || `oc-${opts.agent.id}-${Date.now()}`;
    // OpenClaw expects provider/model form; default models in agents.json may be
    // bare ("claude-opus-4-7") — prefix with the credential's provider.
    const modelArg = opts.model.includes("/") ? opts.model : `${opts.credential.provider}/${opts.model}`;
    const args = [
      "agent",
      "--agent", opts.agent.id,
      "--local",
      "--json",
      "--model", modelArg,
      "--session-id", sessionKey,
      "--message", opts.message,
    ];

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

    // Persist the session id immediately so continuity survives even if the
    // turn errors before producing output.
    yield { type: "session", sessionId: sessionKey };

    // `openclaw agent --json` writes its RESULT as JSON on stdout and routes
    // diagnostics ([agent/embedded], [diagnostic], [model-fallback]) to stderr.
    // We accumulate stdout and parse at the end. Some builds emit NDJSON event
    // lines instead of one object — handle both: collect candidate JSON values,
    // prefer the last one that carries reply text.
    const sessionId: string | undefined = sessionKey;
    let stderrText = "";
    let stdoutText = "";
    let hasOutput = false;
    proc.stderr?.on("data", (d: Buffer) => { stderrText += d.toString(); });
    proc.stdout?.on("data", (d: Buffer) => { stdoutText += d.toString(); });

    const extractText = (v: any): string | undefined => {
      if (!v || typeof v !== "object") return undefined;
      // CONFIRMED shape (OpenClaw 2026.5.20, funded run): the final --json is
      // { payloads:[{text}], meta:{ finalAssistantVisibleText, ... } }.
      if (v.meta && typeof v.meta.finalAssistantVisibleText === "string" && v.meta.finalAssistantVisibleText.trim()) {
        return v.meta.finalAssistantVisibleText;
      }
      if (Array.isArray(v.payloads)) {
        const joined = v.payloads
          .filter((p: any) => p && typeof p.text === "string" && p.text.trim())
          .map((p: any) => p.text)
          .join("\n");
        if (joined.trim()) return joined;
      }
      if (v.meta && typeof v.meta.finalAssistantRawText === "string" && v.meta.finalAssistantRawText.trim()) {
        return v.meta.finalAssistantRawText;
      }
      // Fallbacks (older/alternate builds).
      if (typeof v.text === "string" && v.text.trim()) return v.text;
      if (typeof v.reply === "string" && v.reply.trim()) return v.reply;
      if (typeof v.output === "string" && v.output.trim()) return v.output;
      if (typeof v.result === "string" && v.result.trim()) return v.result;
      const content = v.message?.content || v.content;
      if (Array.isArray(content)) {
        const joined = content
          .filter((c: any) => c && c.type === "text" && c.text)
          .map((c: any) => c.text)
          .join("\n");
        if (joined.trim()) return joined;
      }
      if (v.data) { const inner = extractText(v.data); if (inner) return inner; }
      if (v.payload) { const inner = extractText(v.payload); if (inner) return inner; }
      return undefined;
    };

    // ── Live streaming via trajectory tail (the openclaw "streaming" fix) ──
    // `openclaw agent --json` only returns the final blob, but the run writes
    // an append-only trajectory JSONL as it executes. We poll it while the
    // child runs and emit contract events (status / tool_use / tool_result /
    // interim_text) per round — see openclaw-trajectory.ts for the rationale +
    // honest granularity note (per-round, not per-token).
    const trajPath = path.join(
      agentsBaseDir(),
      opts.agent.id.replace(/[^A-Za-z0-9_.:-]/g, "_"),
      "sessions",
      sessionKey.replace(/[^A-Za-z0-9_.:-]/g, "_") + ".trajectory.jsonl",
    );
    const trajState = newTrajectoryState();
    // CRITICAL: a RESUMED session (--session-id) reuses the SAME trajectory file,
    // which is append-only and already holds every prior turn's rounds. If we
    // tailed from byte 0 we'd re-emit all of that history as tool_use/interim_text
    // every turn — the "same messages over and over" bug. So seek past the
    // pre-existing content and stream only THIS turn's appended lines. (OpenClaw's
    // multi-second boot means the new turn hasn't written yet when we stat, so we
    // never drop the current turn's events; a brand-new session has no file → 0.)
    let trajOffset = 0;
    try { trajOffset = fs.statSync(trajPath).size; } catch { /* new session, file not created yet */ }
    let trajBuf = "";
    const readNewTrajectoryEvents = (): AgentEvent[] => {
      const evs: AgentEvent[] = [];
      try {
        const stat = fs.statSync(trajPath);
        if (stat.size > trajOffset) {
          const fd = fs.openSync(trajPath, "r");
          const len = stat.size - trajOffset;
          const b = Buffer.alloc(len);
          fs.readSync(fd, b, 0, len, trajOffset);
          fs.closeSync(fd);
          trajOffset = stat.size;
          trajBuf += b.toString("utf8");
          let nl: number;
          while ((nl = trajBuf.indexOf("\n")) !== -1) {
            const line = trajBuf.slice(0, nl);
            trajBuf = trajBuf.slice(nl + 1);
            if (!line.trim()) continue;
            try { evs.push(...mapTrajectoryEvent(JSON.parse(line), trajState)); } catch { /* partial/garbage line */ }
          }
        }
      } catch { /* file not created yet (ENOENT) — fine */ }
      return evs;
    };

    let closed = false;
    let exitCode = 1;
    proc.on("close", (c) => { closed = true; exitCode = c ?? 1; });
    // Hard cap (parity w/ claude-code): SIGKILL the group after 8h → close fires.
    const hardCapMs = parseInt(process.env.OSMODA_CHAT_HARD_CAP_MS || "28800000", 10);
    const hardCapTimer = setTimeout(() => {
      const pid = proc.pid;
      if (typeof pid === "number") { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
    }, hardCapMs);
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    // Stream loop: drain new trajectory events every ~400ms until the child
    // exits, then one final drain to catch trailing lines.
    while (!closed) {
      for (const e of readNewTrajectoryEvents()) yield e;
      await sleep(400);
    }
    clearTimeout(hardCapTimer);
    for (const e of readNewTrajectoryEvents()) yield e;
    const code = exitCode;

    // Parse the accumulated stdout. Try whole-buffer JSON first (the common
    // `--json` single-object case), then fall back to NDJSON line scan,
    // then to raw text.
    let replyText: string | undefined;
    const trimmed = stdoutText.trim();
    if (trimmed) {
      try {
        replyText = extractText(JSON.parse(trimmed));
      } catch {
        for (const line of trimmed.split("\n")) {
          const s = line.trim();
          if (!s.startsWith("{") && !s.startsWith("[")) continue;
          try { const t = extractText(JSON.parse(s)); if (t) replyText = t; } catch { /* skip */ }
        }
      }
      // Last resort: if stdout had content but no JSON text field, and the
      // process succeeded, surface the raw stdout so the user isn't left blank.
      if (!replyText && code === 0 && !/^[\s{[]/.test(trimmed)) replyText = trimmed;
    }
    if (replyText) {
      // The authoritative final answer. If we streamed interim/round text into
      // the thinking panel, tell the client to trim it (skill §1 de-dup), then
      // replace the answer wholesale. text_bulk → clean final bubble.
      if (trajState.emittedInterim > 0) {
        yield { type: "interim_commit_final", length: trajState.emittedInterim };
      }
      yield { type: "text_bulk", text: replyText };
      yield { type: "phase", phase: "answering" };
      hasOutput = true;
    }

    if (code !== 0 && !hasOutput && !opts.abortSignal?.aborted) {
      // OpenClaw surfaces provider errors (billing, rate limit, auth) in the
      // stderr diagnostics — pull the most informative line.
      const errLine =
        (stderrText.match(/error="?([^"\n]+)"?/) || [])[1] ||
        stderrText.trim().split("\n").filter(Boolean).pop() ||
        `openclaw exited ${code}`;
      yield { type: "error", text: errLine };
    }
    yield { type: "done", sessionId };
  },
};
