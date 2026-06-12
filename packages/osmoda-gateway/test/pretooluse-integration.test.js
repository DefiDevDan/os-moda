/**
 * PreToolUse hook ↔ agentd — real wire-contract integration test (V3).
 *
 * The pure-function unit tests (pretooluse-approval.test.js) cover classification
 * and the backstop regexes. THIS test exercises the actual runtime path the unit
 * tests can't: the hook is spawned as a real subprocess, fed a tool call on stdin,
 * and talks to a STUB agentd over a real Unix-domain socket implementing
 * `POST /approval/check`. It asserts the hook's stdout decision + exit code match
 * the agentd verdict — i.e. that the HTTP-over-unix-socket round trip, the stdin
 * JSON parse, and the deny/allow emission are wired correctly end to end.
 *
 * Hermetic: no real agentd, no network, no funded box. (The full on-box leg —
 * claude-code actually invoking this hook before a native Bash call — needs a
 * running osModa host and is documented in the hook header, not exercised here.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "hooks", "pretooluse-approval.mjs");

/** Start a stub agentd on a Unix socket. `verdict` is the JSON it returns from
 *  POST /approval/check; `onHit` records that it was contacted. */
function stubAgentd(verdict, onHit) {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentd-")), "agentd.sock");
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/approval/check") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        onHit?.(JSON.parse(body || "{}"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(verdict));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(sock, () => resolve({ server, sock })));
}

/** Run the hook subprocess with the given stdin payload + OSMODA_SOCKET. */
function runHook(input, socket) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (socket) env.OSMODA_SOCKET = socket;
    else env.OSMODA_SOCKET = "/nonexistent/agentd.sock"; // force "unreachable"
    const child = spawn(process.execPath, [HOOK], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

function decision(stdout) {
  if (!stdout.trim()) return null; // silent = allow
  try { return JSON.parse(stdout).hookSpecificOutput?.permissionDecision ?? null; }
  catch { return null; }
}

test("Bash ALLOWED when agentd verdict is allow:true", async () => {
  let hit = null;
  const { server, sock } = await stubAgentd({ allow: true }, (b) => (hit = b));
  try {
    const r = await runHook({ tool_name: "Bash", tool_input: { command: "ls -la /tmp" } }, sock);
    assert.equal(r.code, 0);
    assert.equal(decision(r.stdout), null, "no deny emitted → allowed");
    assert.deepEqual(hit, { command: "ls -la /tmp" }, "agentd was queried with the command");
  } finally { server.close(); }
});

test("Bash DENIED (with reason) when agentd verdict is allow:false", async () => {
  const { server, sock } = await stubAgentd({ allow: false, reason: "rm -rf needs approval_id" });
  try {
    const r = await runHook({ tool_name: "Bash", tool_input: { command: "rm -rf /var/lib/osmoda" } }, sock);
    assert.equal(r.code, 0);
    assert.equal(decision(r.stdout), "deny");
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /approval_id/);
  } finally { server.close(); }
});

test("Write to a guardrail-protected path is DENIED without contacting agentd", async () => {
  let hit = false;
  const { server, sock } = await stubAgentd({ allow: true }, () => (hit = true));
  try {
    const r = await runHook(
      { tool_name: "Write", tool_input: { file_path: "/var/lib/osmoda/config/credentials.json.enc" } },
      sock,
    );
    assert.equal(decision(r.stdout), "deny");
    assert.equal(hit, false, "self-protect is local — agentd not queried");
  } finally { server.close(); }
});

test("Write to an ordinary path is ALLOWED", async () => {
  const { server, sock } = await stubAgentd({ allow: true });
  try {
    const r = await runHook(
      { tool_name: "Write", tool_input: { file_path: "/etc/nixos/configuration.nix" } },
      sock,
    );
    assert.equal(r.code, 0);
    assert.equal(decision(r.stdout), null, "ordinary system config is allowed");
  } finally { server.close(); }
});

test("agentd UNREACHABLE + catastrophic command → DENIED by local backstop", async () => {
  const r = await runHook({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }, null);
  assert.equal(decision(r.stdout), "deny");
});

test("agentd UNREACHABLE + ordinary command → ALLOWED (fail open)", async () => {
  const r = await runHook({ tool_name: "Bash", tool_input: { command: "echo hello" } }, null);
  assert.equal(r.code, 0);
  assert.equal(decision(r.stdout), null, "ordinary command fails open when agentd is down");
});

test("non-gated tool (Read) is ALLOWED silently", async () => {
  const r = await runHook({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }, null);
  assert.equal(r.code, 0);
  assert.equal(decision(r.stdout), null);
});

test("malformed stdin fails OPEN (does not brick the agent)", async () => {
  const child = spawn(process.execPath, [HOOK], { env: { ...process.env, OSMODA_SOCKET: "/nonexistent.sock" } });
  let stdout = "";
  child.stdout.on("data", (c) => (stdout += c));
  const code = await new Promise((resolve) => {
    child.on("close", resolve);
    child.stdin.write("not json{{{");
    child.stdin.end();
  });
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "", "malformed input → silent allow");
});
