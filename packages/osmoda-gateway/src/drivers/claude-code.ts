/**
 * Claude Code driver — wraps the `claude` CLI in headless streaming mode.
 *
 * Credential handling:
 *  - type=oauth      → CLAUDE_CODE_OAUTH_TOKEN env var (subscription)
 *  - type=api_key    → ANTHROPIC_API_KEY env var
 *
 * Auth precedence in the CLI is: ANTHROPIC_AUTH_TOKEN → ANTHROPIC_API_KEY →
 * apiKeyHelper → CLAUDE_CODE_OAUTH_TOKEN → interactive login. We scrub the
 * unused env var before spawning so only one path is active.
 *
 * Isolation: --strict-mcp-config locks the MCP server set to just our bridge
 * (ignoring any ~/.claude or project-level MCP configs). Works across all 2.x.
 *
 * The `claude` CLI supports resumable sessions; we pass `--resume <id>` when
 * the caller provides a sessionId.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as https from "node:https";
import type {
  RuntimeDriver,
  DriverSessionOpts,
  AgentEvent,
  Credential,
  CredentialTestResult,
  DriverHealthResult,
} from "./types.js";

function findClaudeBinary(): string {
  const candidates = [
    process.env.CLAUDE_PATH,
    "/usr/local/bin/claude",
    "/run/current-system/sw/bin/claude",
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return "claude";
}

function buildEnv(cred: Credential): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: process.env.HOME || "/root",
    NODE_ENV: "production",
  };
  // Scrub stray credentials from inherited env before selectively re-adding.
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (cred.type === "oauth") {
    env.CLAUDE_CODE_OAUTH_TOKEN = cred.secret;
  } else {
    env.ANTHROPIC_API_KEY = cred.secret;
  }
  return env;
}

export const claudeCodeDriver: RuntimeDriver = {
  name: "claude-code",
  displayName: "Claude Code",
  description:
    "Anthropic's official Claude CLI in headless streaming mode. Works with a Claude Pro OAuth subscription or pay-per-token API key.",
  supportedProviders: ["anthropic"],
  supportedAuthTypes: ["oauth", "api_key"],
  defaultModels: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],

  async healthCheck(): Promise<DriverHealthResult> {
    // Probe `claude --version`. The 2.x CLI prints e.g. "2.1.118 (Claude Code)"
    // to stdout. Anything else (missing binary, wrong version string) means
    // the driver isn't safe to use — block the runtime selection.
    const bin = findClaudeBinary();
    try { fs.accessSync(bin, fs.constants.X_OK); }
    catch {
      return {
        available: false,
        error: `claude binary not found at '${bin}'`,
        remediation:
          "Install: cd /opt/osmoda/packages/osmoda-gateway && npm install && " +
          "ln -sf node_modules/.bin/claude /usr/local/bin/claude",
      };
    }
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const proc = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        proc.stdout?.on("data", (d) => { stdout += d.toString(); });
        proc.stderr?.on("data", (d) => { stderr += d.toString(); });
        proc.on("close", (code) => resolve({ code, stdout, stderr }));
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} ; resolve({ code: 124, stdout, stderr }); }, 5000);
      },
    );
    if (out.code !== 0) {
      return {
        available: false,
        error: `'${bin} --version' exited ${out.code}: ${(out.stderr || out.stdout).trim().slice(0, 200)}`,
        remediation: "Reinstall the claude-code CLI (npm i @anthropic-ai/claude-code).",
      };
    }
    const version = out.stdout.trim().split("\n")[0] || undefined;
    // The 2.x CLI's `--version` shape: "2.1.118 (Claude Code)". The 0.2.x line
    // does NOT use `--print --stream-json --resume` the same way and our driver
    // would not work against it. Refuse < 2.0.
    const major = version ? parseInt(version.split(".")[0] || "0", 10) : 0;
    if (major < 2) {
      return {
        available: false,
        version,
        error: `claude-code driver requires claude CLI >= 2.x (got ${version || "unknown"})`,
        remediation:
          "Upgrade: npm install -g @anthropic-ai/claude-code@^2.1.75 " +
          "(or `cd /opt/osmoda/packages/osmoda-gateway && npm install`).",
      };
    }
    return { available: true, version };
  },

  async testCredential(cred: Credential): Promise<CredentialTestResult> {
    if (cred.provider !== "anthropic") {
      return { ok: false, error: `claude-code supports provider=anthropic, got ${cred.provider}` };
    }
    if (!cred.secret || typeof cred.secret !== "string" || cred.secret.length < 20) {
      return { ok: false, error: "secret missing or too short" };
    }
    const prefixOk =
      (cred.type === "oauth" && cred.secret.startsWith("sk-ant-oat")) ||
      (cred.type === "api_key" && cred.secret.startsWith("sk-ant-api"));
    if (!prefixOk) {
      return {
        ok: false,
        error: `secret prefix doesn't match type=${cred.type} (expected sk-ant-${cred.type === "oauth" ? "oat" : "api"}…)`,
      };
    }
    // Real probe: hit /v1/models with the credential.
    try {
      const result = await probeAnthropic(cred);
      return result;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async *startSession(opts: DriverSessionOpts): AsyncGenerator<AgentEvent> {
    const claude = findClaudeBinary();
    const cwd = opts.workingDir || "/root";
    const env = buildEnv(opts.credential);

    // Pre-flight: if cwd doesn't exist, child_process.spawn() returns ENOENT
    // with a misleading "spawn <claude binary> ENOENT" message that points
    // at the binary, not at the missing cwd. Catch this here so the chat
    // gets a clear "workspace dir missing" error and the gateway doesn't
    // crash on the unhandled error event.
    try {
      fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
    } catch {
      yield {
        type: "error",
        code: "workspace_missing",
        text:
          `Workspace directory '${cwd}' does not exist or isn't readable. ` +
          `Create it on the customer box: 'mkdir -p ${cwd}' and restart osmoda-gateway. ` +
          `(This is a known install.sh regression on pre-v1.3.1 spawns when runtime=claude-code.)`,
      };
      return;
    }
    // Pre-flight: claude binary executable?
    try {
      fs.accessSync(claude, fs.constants.X_OK);
    } catch {
      yield {
        type: "error",
        code: "claude_not_found",
        text:
          `Claude CLI not found or not executable at '${claude}'. ` +
          `Reinstall: 'cd /opt/osmoda/packages/osmoda-gateway && npm install && ` +
          `ln -sf node_modules/.bin/claude /usr/local/bin/claude'.`,
      };
      return;
    }

    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--model", opts.model,
      "--system-prompt", opts.systemPrompt.slice(0, 10000),
      "--mcp-config", opts.mcpConfigPath,
      "--strict-mcp-config",
      "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep,WebFetch,mcp__osmoda__*",
    ];
    if (opts.sessionId) args.push("--resume", opts.sessionId);
    args.push("--", opts.message);

    let proc: ChildProcess;
    try {
      // v1.3.20 — `detached: true` makes claude its own process-group leader
      // so we can kill the WHOLE tree on abort (claude + Bash + file ops +
      // any subprocess it forked). Without this, proc.kill("SIGTERM") only
      // signals claude itself; its children orphan and keep running, with
      // their stdout still flowing through the pipes back to us. User
      // sees "Stop" do nothing while tool output keeps streaming.
      proc = spawn(claude, args, {
        cwd, env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (e) {
      yield {
        type: "error",
        code: "spawn_failed",
        text: `Failed to spawn claude: ${e instanceof Error ? e.message : String(e)}`,
      };
      return;
    }

    // CRITICAL: child_process.spawn() does NOT throw synchronously for ENOENT
    // (missing binary OR missing cwd). It returns a ChildProcess, then later
    // emits an `error` event. With no listener attached, that error becomes
    // an UNHANDLED 'error' event which kills the entire gateway process
    // (Node default behavior). We attach a listener that turns it into a
    // promise we can await alongside the readline loop, so the chat gets a
    // structured error and the gateway stays alive.
    let spawnError: Error | null = null;
    let spawnErrorResolved = false;
    const spawnErrorPromise = new Promise<void>((resolve) => {
      proc.once("error", (e: NodeJS.ErrnoException) => {
        spawnError = e;
        spawnErrorResolved = true;
        resolve();
      });
      // If proc exits cleanly without emitting `error`, free the listener
      proc.once("exit", () => {
        if (!spawnErrorResolved) {
          spawnErrorResolved = true;
          resolve();
        }
      });
    });
    // Race a tiny tick — if spawn instantly errors (ENOENT typically does),
    // we catch it here before trying to read from a dead stdout.
    await Promise.race([
      spawnErrorPromise,
      new Promise((r) => setImmediate(r)),
    ]);
    if (spawnError) {
      const err = spawnError as NodeJS.ErrnoException;
      yield {
        type: "error",
        code: err.code === "ENOENT" ? "spawn_enoent" : "spawn_failed",
        text:
          err.code === "ENOENT"
            ? `spawn ENOENT: either the binary '${claude}' or the cwd '${cwd}' is missing/inaccessible. ` +
              `Verify: 'ls -la ${claude}' and 'ls -la ${cwd}' on the customer box.`
            : `Spawn failed: ${err.message}`,
      };
      return;
    }
    // Close stdin immediately — 2.x CLI waits 3s for stdin data before falling
    // back to the positional message, which adds latency to every call. We
    // always pass the prompt via argv, never via stdin.
    proc.stdin?.end();

    if (opts.abortSignal) {
      // v1.3.20 — Kill the process GROUP, not just the leader. With
      // `detached: true` above, proc.pid is the pgrp id. `process.kill(-pid)`
      // signals every process in the group → claude AND every subprocess
      // it forked (Bash for tool calls, file ops, npm installs, etc).
      // Then race a 2-second SIGKILL escalation: if anything in the group
      // ignored SIGTERM (or claude trapped it for graceful shutdown that
      // takes 30+ seconds), force-kill it.
      opts.abortSignal.addEventListener("abort", () => {
        const pid = proc.pid;
        if (typeof pid !== "number") return;
        try { process.kill(-pid, "SIGTERM"); } catch { /* group already gone */ }
        setTimeout(() => {
          try { process.kill(-pid, 0); } catch { return; } // already dead → noop
          try { process.kill(-pid, "SIGKILL"); } catch { /* race: died between checks */ }
        }, 2000);
      }, { once: true });
    }

    const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    let sessionId: string | undefined;
    let sessionYielded = false;
    // De-dup text deltas PER assistant message. claude-code emits one assistant
    // message before each tool call and another after — each with its own text
    // block that starts at offset 0. A single session-wide counter sliced the
    // 2nd+ message at the *previous* message's length, dropping its opening
    // chars and gluing replies into garbage like
    // "…what happened:cess running and trace…" (the dropped "Let me check the pro"
    // from msg 2). Keying the counter by message.id fixes it: each message's
    // text accumulates from its own 0, and we insert a paragraph break between
    // distinct messages so they don't run together.
    const textLenByMsg = new Map<string, number>();
    let lastTextMsgId: string | null = null;
    let emittedAnyText = false;
    let hasOutput = false;
    // Two-channel contract (parity with the openclaw driver). claude-code emits
    // a text block before EACH tool call and one for the final answer, and we
    // can't know mid-stream which is the final one. So we stream EVERY assistant
    // text block on the INTERIM (thinking) channel live, track how much we've
    // emitted, and at the terminal `result` event promote the authoritative
    // final answer as `text_bulk` (+ interim_commit_final + phase:answering).
    // This is what stops the "wall of preambles" live and the "N Task-completed
    // stubs" on replay — interim text never enters the canonical answer.
    let emittedInterim = 0;
    let lastMsgFullText = "";
    let stderrText = "";
    proc.stderr?.on("data", (d: Buffer) => { stderrText += d.toString(); });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }

        if (event.session_id && !sessionYielded) {
          sessionId = event.session_id;
          sessionYielded = true;
          yield { type: "session", sessionId };
        }

        const t = event.type;
        if (t === "system" && event.subtype === "init") {
          sessionId = event.session_id;
        } else if (t === "assistant") {
          const msgId: string = event.message?.id || "msg-default";
          const content = event.message?.content || [];
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_use" && block.name) {
                yield { type: "tool_use", name: block.name, target: toolTargetHint(block.input) };
                hasOutput = true;
              } else if (block.type === "text" && block.text) {
                const full = block.text;
                const prev = textLenByMsg.get(msgId) || 0;
                if (full.length > prev) {
                  // Stream on the INTERIM channel (live thinking panel), NOT the
                  // final-answer channel — see the two-channel note above. The
                  // authoritative answer is promoted at `result`.
                  let delta = full.slice(prev);
                  if (prev === 0 && emittedAnyText && msgId !== lastTextMsgId) {
                    delta = "\n\n" + delta; // separate distinct assistant messages
                  }
                  yield { type: "interim_text", text: delta };
                  emittedInterim += delta.length;
                  textLenByMsg.set(msgId, full.length);
                  lastTextMsgId = msgId;
                  lastMsgFullText = full; // most-recent message text = final-answer candidate
                  emittedAnyText = true;
                  hasOutput = true;
                }
              }
            }
          }
        } else if (t === "user") {
          const content = event.message?.content || [];
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") yield { type: "tool_result" };
            }
          }
        } else if (t === "result") {
          // 2.x adds `is_error` + `api_error_status` to the terminal result
          // event (e.g. 401 bad creds, 429 rate limit). Surface these as a
          // proper error so consumers can distinguish CLI failures from model
          // output. The error text is usually also echoed as assistant text
          // earlier in the stream; that's fine — consumers filter by event
          // type, and having both means structured + rendered variants both
          // reach the UI.
          if (event.is_error === true) {
            const status = event.api_error_status;
            const msg = typeof event.result === "string" && event.result
              ? event.result
              : `claude-code error${status ? ` (HTTP ${status})` : ""}`;
            yield {
              type: "error",
              code: status ? `http_${status}` : "cli_error",
              text: msg,
            };
          } else {
            // Promote the authoritative final answer (mirrors openclaw.ts
            // end-of-turn). Prefer the CLI's assembled `result` string; fall
            // back to the last assistant message's text. Trim the interim
            // channel (it streamed live) and replace it with ONE clean answer,
            // then flip to the answering phase so the UI collapses "thinking".
            const finalText = (typeof event.result === "string" && event.result.trim())
              ? event.result
              : lastMsgFullText;
            if (finalText && finalText.trim()) {
              if (emittedInterim > 0) yield { type: "interim_commit_final", length: emittedInterim };
              yield { type: "text_bulk", text: finalText };
              yield { type: "phase", phase: "answering" };
              hasOutput = true;
            }
          }
          sessionId = event.session_id || sessionId;
        }
      }
    } catch {
      /* readline close or abort — not an error */
    }

    const exitCode = await new Promise<number>((resolve) => {
      proc.on("close", (c) => resolve(c ?? 1));
      // v1.3.24 — Hard cap bumped from 10 min to 8 hours by default.
      // Users running multi-hour build tasks (full app scaffolds, large
      // refactors, long-running scrapes) were hitting the 10-min wall
      // and losing their work. The user's only kill switches now are:
      //   1. The Stop button (sends `{type:"abort"}` → SIGTERM the group)
      //   2. This 8-hour absolute backstop for runaway processes
      // Override via env: OSMODA_CHAT_HARD_CAP_MS=<ms>.
      const hardCapMs = parseInt(process.env.OSMODA_CHAT_HARD_CAP_MS || "28800000", 10); // 8h
      setTimeout(() => {
        const pid = proc.pid;
        if (typeof pid === "number") {
          try { process.kill(-pid, "SIGKILL"); } catch { /* already dead */ }
        }
        resolve(124);
      }, hardCapMs);
    });

    if (exitCode !== 0 && !hasOutput && !opts.abortSignal?.aborted) {
      const errMsg = stderrText.trim().split("\n").pop() || `claude exited with code ${exitCode}`;
      yield { type: "error", text: errMsg };
    }

    yield { type: "done", sessionId };
  },
};

/**
 * Distill a tool's input object into a one-line target hint for the chat UI.
 * Order matters: prefer the most human-meaningful field. Truncated so a giant
 * heredoc or file body never floods the activity log.
 */
function toolTargetHint(input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const clip = (s: any, n = 80): string => {
    const str = String(s).replace(/\s+/g, " ").trim();
    return str.length > n ? str.slice(0, n - 1) + "…" : str;
  };
  if (input.command) return clip(input.command);
  if (input.file_path) return clip(input.file_path, 120);
  if (input.path) return clip(input.path, 120);
  if (input.url) return clip(input.url, 120);
  if (input.pattern) return clip(input.pattern);
  if (input.query) return clip(input.query);
  if (input.prompt) return clip(input.prompt);
  return undefined;
}

function isSafeBaseUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: "invalid_url" }; }
  if (u.protocol !== "https:") return { ok: false, reason: "base_url must be https" };
  const host = u.hostname;
  // Reject literal loopback, link-local, and the AWS/GCP metadata endpoint.
  // Prevents an authed attacker with /config/credentials access from using
  // testCredential as an SSRF primitive against internal services.
  if (/^(localhost|127\.|169\.254\.|0\.0\.0\.0|::1|\[::1\]|\[fc|\[fd|metadata\.google\.internal|169\.254\.169\.254)/i.test(host)) {
    return { ok: false, reason: "base_url resolves to a restricted host" };
  }
  // Block RFC1918 by exact-prefix match on literal IPs. Hostnames that later
  // resolve into RFC1918 would bypass this; for defense in depth we'd also
  // want DNS pinning, but the blast radius is gateway-local only.
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return { ok: false, reason: "base_url resolves to a private network" };
  }
  return { ok: true, url: u };
}

function probeAnthropic(cred: Credential): Promise<CredentialTestResult> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
    };
    if (cred.type === "oauth") {
      headers["authorization"] = `Bearer ${cred.secret}`;
    } else {
      headers["x-api-key"] = cred.secret;
    }
    let host = "api.anthropic.com";
    let pathname = "/v1/models";
    if (cred.base_url) {
      const check = isSafeBaseUrl(cred.base_url);
      if (!check.ok) return resolve({ ok: false, error: check.reason });
      host = check.url.host;
      pathname = check.url.pathname.replace(/\/$/, "") + "/v1/models";
    }
    const req = https.request(
      { host, path: pathname, method: "GET", headers, timeout: 10000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(body);
              const models: string[] = Array.isArray(parsed.data)
                ? parsed.data.map((m: any) => m.id).filter(Boolean)
                : [];
              resolve({ ok: true, model_list: models });
            } catch {
              resolve({ ok: true });
            }
          } else if (res.statusCode === 401 || res.statusCode === 403) {
            resolve({ ok: false, error: `HTTP ${res.statusCode} — invalid credential` });
          } else {
            resolve({ ok: false, error: `HTTP ${res.statusCode} ${body.slice(0, 120)}` });
          }
        });
      },
    );
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.end();
  });
}
