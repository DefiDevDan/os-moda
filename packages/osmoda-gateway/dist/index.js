#!/usr/bin/env node
/**
 * osModa Gateway — modular runtime, credentials, and agent profiles.
 *
 * On boot:
 *   1. Migration runs if agents.json is missing (absorbs legacy files).
 *   2. agents.json + credentials.json.enc are loaded into in-memory caches.
 *   3. Drivers are registered (claude-code + openclaw).
 *   4. HTTP server exposes /health, /config/*, Telegram webhook.
 *   5. WebSocket server exposes /ws for dashboard chat.
 *   6. SIGHUP reloads agents.json (in-flight sessions keep their snapshot).
 *
 * Endpoints:
 *   GET  /health                — runtime + config health
 *   WS   /ws                    — dashboard chat (Bearer header)
 *   POST /telegram              — Telegram webhook
 *   GET  /config/drivers        — available runtimes
 *   GET  /config/agents, PUT, /:id PATCH/DELETE
 *   GET  /config/credentials, POST, /:id PATCH/DELETE
 *   POST /config/credentials/:id/test, /default
 *   POST /config/reload         — SIGHUP self
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import { WebSocketServer, WebSocket } from "ws";
import { SessionStore } from "./sessions.js";
import { TranscriptStore } from "./transcript.js";
import { ChatRegistry } from "./chats.js";
import { buildCrossChatDigest } from "./cross-chat.js";
import { loadDurableMemory } from "./memory.js";
import { ConfigCache } from "./config.js";
import { runMigrationIfNeeded } from "./migrate.js";
import { SpendMeter } from "./spend.js";
import { LoopManager, runAgentTurn } from "./agent-loop.js";
import { getCredential, loadCredentials, markCredentialCooldown, pickFallbackCredential, classifyCredentialError, } from "./credentials.js";
import { getDriver, listDrivers } from "./drivers/index.js";
import { handleConfigRequest } from "./config-api.js";
function loadGatewayEnv() {
    let authToken = null;
    try {
        authToken = fs.readFileSync("/var/lib/osmoda/config/gateway-token", "utf8").trim();
    }
    catch { /* no token file */ }
    return {
        port: parseInt(process.env.OSMODA_GATEWAY_PORT || "18789", 10),
        authToken,
        mcpBridgePath: process.env.OSMODA_MCP_BRIDGE_PATH
            || "/opt/osmoda/packages/osmoda-mcp-bridge/dist/index.js",
        telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
        telegramAllowedUsers: (process.env.TELEGRAM_ALLOWED_USERS || "").split(",").map(s => s.trim()).filter(Boolean),
    };
}
// ── MCP config (per-agent, because paths may differ per profile) ────────
function buildMcpConfig(mcpBridgePath) {
    const servers = {
        osmoda: {
            command: "node",
            args: [mcpBridgePath],
            env: {
                AGENTD_SOCKET: process.env.OSMODA_SOCKET || "/run/osmoda/agentd.sock",
                KEYD_SOCKET: process.env.OSMODA_KEYD_SOCKET || "/run/osmoda/keyd.sock",
                WATCH_SOCKET: process.env.OSMODA_WATCH_SOCKET || "/run/osmoda/watch.sock",
                ROUTINES_SOCKET: process.env.OSMODA_ROUTINES_SOCKET || "/run/osmoda/routines.sock",
                MESH_SOCKET: process.env.OSMODA_MESH_SOCKET || "/run/osmoda/mesh.sock",
                MCPD_SOCKET: process.env.OSMODA_MCPD_SOCKET || "/run/osmoda/mcpd.sock",
                TEACHD_SOCKET: process.env.OSMODA_TEACHD_SOCKET || "/run/osmoda/teachd.sock",
                VOICE_SOCKET: process.env.OSMODA_VOICE_SOCKET || "/run/osmoda/voice.sock",
            },
        },
    };
    // v0.2.2 — Optional CodeGraph MCP server (pre-indexed code knowledge graph,
    // colbymchenry/codegraph, MIT, WASM tree-sitter + SQLite, 100% local).
    // Gives the agent codegraph_search/context/callers/callees/impact/node/
    // files/explore/status — ~90% fewer grep/Read tool calls on code tasks.
    // Gated on OSMODA_CODEGRAPH_ENABLED so a box without the binary installed
    // doesn't carry a dead server entry under claude-code's --strict-mcp-config.
    // Security-audited 2026-05-20: no install hooks, no network, no eval,
    // path-traversal-guarded, static tool descriptions. We never run codegraph's
    // own installer (which would rewrite ~/.claude.json) — this config IS the
    // wiring, and we leave git-hooks off (file-watcher only).
    if (process.env.OSMODA_CODEGRAPH_ENABLED === "1") {
        servers.codegraph = {
            command: process.env.OSMODA_CODEGRAPH_BIN || "codegraph",
            args: ["serve", "--mcp"],
        };
    }
    return { mcpServers: servers };
}
let _mcpConfigPath = null;
function getMcpConfigPath(mcpBridgePath) {
    if (_mcpConfigPath)
        return _mcpConfigPath;
    const stable = "/var/lib/osmoda/config/mcp-bridge.json";
    const fallback = `/tmp/osmoda-mcp-${process.pid}.json`;
    const body = JSON.stringify(buildMcpConfig(mcpBridgePath), null, 2);
    try {
        fs.mkdirSync(path.dirname(stable), { recursive: true });
        fs.writeFileSync(stable, body);
        fs.chmodSync(stable, 0o644);
        _mcpConfigPath = stable;
    }
    catch {
        fs.writeFileSync(fallback, body);
        _mcpConfigPath = fallback;
    }
    return _mcpConfigPath;
}
// ── System prompt (SOUL.md etc) ─────────────────────────────────────────
function loadSystemPromptBase(agent) {
    if (agent.system_prompt_file) {
        try {
            return fs.readFileSync(agent.system_prompt_file, "utf8");
        }
        catch { /* fall through */ }
    }
    const candidates = [
        agent.profile_dir ? path.join(agent.profile_dir, "SOUL.md") : null,
        `/root/workspace/SOUL.md`,
        `/var/lib/osmoda/workspace-${agent.id}/SOUL.md`,
        `/opt/osmoda/templates/agents/${agent.id}/SOUL.md`,
        `/opt/osmoda/templates/SOUL.md`,
    ].filter(Boolean);
    for (const p of candidates) {
        try {
            return fs.readFileSync(p, "utf8");
        }
        catch { /* next */ }
    }
    return `You are osModa, an AI system administrator with full root access. You manage this NixOS server using 92 tools via MCP.`;
}
function loadSystemPrompt(agent) {
    // Base identity (SOUL.md) + durable cross-session memory (MEMORY.md + recent
    // daily notes), so the agent remembers facts/preferences/decisions across
    // brand-new conversations — OpenClaw-style. loadDurableMemory() returns ""
    // when nothing is stored yet, so this is a no-op on a fresh box.
    return loadSystemPromptBase(agent) + loadDurableMemory();
}
// ── Boot ────────────────────────────────────────────────────────────────
const startTime = Date.now();
const migrationReport = runMigrationIfNeeded();
if (migrationReport.ran) {
    console.log(`[gateway] migration: ran=${migrationReport.ran} creds=${migrationReport.imported_credentials} agents=${migrationReport.created_agents} runtime=${migrationReport.detected_runtime}`);
    for (const note of migrationReport.notes)
        console.log(`[gateway]   ${note}`);
}
const env = loadGatewayEnv();
const cache = new ConfigCache();
const sessions = new SessionStore();
const transcripts = new TranscriptStore();
const chats = new ChatRegistry();
// V1 spend kill-switch: per-agent, per-UTC-day token + USD meter. Persisted
// next to sessions.json so today's tally survives a gateway restart (otherwise
// a crash-loop could reset the budget and let an over-cap loop keep burning).
// The alert sink logs at warn (80%) / halt (100%) and DMs Telegram if wired —
// so the operator hears about a runaway loop without watching the dashboard.
const SPEND_PATH = process.env.OSMODA_SPEND_PATH ||
    (process.env.OSMODA_CONFIG_DIR
        ? path.join(process.env.OSMODA_CONFIG_DIR, "..", "state", "spend.json")
        : "/var/lib/osmoda/state/spend.json");
const spend = new SpendMeter({
    file: SPEND_PATH,
    alert: (agentId, level, info) => {
        const pct = Math.round(info.pct * 100);
        const line = level === "halt"
            ? `🛑 Agent "${agentId}" hit its daily spend cap (${pct}% · $${info.usdUsed.toFixed(2)} · ${info.tokensUsed.toLocaleString()} tokens). Further turns are refused until 00:00 UTC.`
            : `⚠️ Agent "${agentId}" is at ${pct}% of its daily spend cap ($${info.usdUsed.toFixed(2)} · ${info.tokensUsed.toLocaleString()} tokens).`;
        console.warn(`[spend] ${line}`);
        if (env.telegramBotToken) {
            for (const u of env.telegramAllowedUsers) {
                sendTelegram(env.telegramBotToken, u, line).catch(() => { });
            }
        }
    },
});
// V2 agent loop engine: the autonomy scheduler. A loop is a named chat the
// gateway drives on a cadence toward a goal, gated by the V1 spend meter every
// tick. Persisted next to sessions.json so loops survive a restart (rescheduled
// on cadence, never re-fired all at once — see resumeAll()).
const LOOPS_PATH = process.env.OSMODA_LOOPS_PATH ||
    (process.env.OSMODA_CONFIG_DIR
        ? path.join(process.env.OSMODA_CONFIG_DIR, "..", "state", "loops.json")
        : "/var/lib/osmoda/state/loops.json");
const loops = new LoopManager({
    getAgent: (id) => cache.findAgent(id),
    getCredential: (id) => getCredential(id) ?? undefined,
    getDriver: (n) => getDriver(n) ?? undefined,
    loadSystemPrompt: (agent) => loadSystemPrompt(agent),
    mcpConfigPath: getMcpConfigPath(env.mcpBridgePath),
    spendCheck: (a) => spend.check(a),
    spendRecord: (a, u) => spend.record(a, u),
    getSessionId: (key, agentId, runtime) => sessions.getOrCreate(key, "loop", agentId, runtime).claudeSessionId,
    saveSessionId: (key, sid, runtime) => sessions.updateClaudeSession(key, "loop", sid, runtime),
    appendTranscript: (agentId, key, row) => transcripts.append(agentId, key, row),
    registerChat: (key, opts) => chats.register(key, opts),
    file: LOOPS_PATH,
    log: (m) => console.log(m),
});
// Reschedule persisted running loops AFTER the box has settled (on cadence, not
// at t=0) so a reboot doesn't fire every loop simultaneously.
loops.resumeAll();
// Prune expired sessions every 5 minutes.
setInterval(() => sessions.prune(), 5 * 60 * 1000);
// SIGHUP → in-memory config reload. Does not interrupt active sessions.
process.on("SIGHUP", () => {
    try {
        cache.reload();
        console.log(`[gateway] SIGHUP: config reloaded (${cache.current().agents.length} agents)`);
    }
    catch (e) {
        console.error("[gateway] SIGHUP reload failed:", e instanceof Error ? e.message : String(e));
    }
});
function reloadSelf() {
    cache.reload();
    // Also kick the actual OS signal in case upstream expects it.
    try {
        process.kill(process.pid, "SIGHUP");
    }
    catch { /* ignore */ }
}
// Graceful shutdown: cancel loop timers + abort in-flight loop turns so a
// restart doesn't leave an orphaned claude process burning the credential.
for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
        try {
            loops.shutdown();
        }
        catch { /* best-effort */ }
        process.exit(0);
    });
}
// ── HTTP server ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${env.port}`);
    // Config API — may handle + respond.
    if (await handleConfigRequest(req, res, url, { cache, authToken: env.authToken, reloadSelf, spendCheck: (a) => spend.check(a) })) {
        return;
    }
    // Health
    if (url.pathname === "/health" || url.pathname === "/api/health") {
        const creds = loadCredentials();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            status: "ok",
            runtime: "modular",
            drivers: listDrivers().map(d => d.name),
            agents: cache.current().agents.map(a => ({
                id: a.id, runtime: a.runtime, model: a.model, enabled: a.enabled,
            })),
            credentials_count: creds.credentials.length,
            uptime: Math.floor((Date.now() - startTime) / 1000),
            sessions: sessions.size,
        }));
        return;
    }
    // Canonical transcript API (gateway owns session state; UI queries here).
    // Bearer-authed with the gateway token, same as /config/*.
    if (url.pathname === "/sessions" || url.pathname.startsWith("/sessions/")) {
        if (env.authToken) {
            const auth = req.headers.authorization;
            if (auth !== `Bearer ${env.authToken}`) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "unauthorized" }));
                return;
            }
        }
        // GET /sessions → list
        if (req.method === "GET" && url.pathname === "/sessions") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ sessions: transcripts.list() }));
            return;
        }
        // GET /sessions/<agentId>/<sessionKey>/transcript?since=N
        const m = url.pathname.match(/^\/sessions\/([^/]+)\/(.+)\/transcript$/);
        if (req.method === "GET" && m) {
            const agentId = decodeURIComponent(m[1]);
            const sessionKey = decodeURIComponent(m[2]);
            const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ agentId, sessionKey, events: transcripts.read(agentId, sessionKey, since) }));
            return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
    }
    // Named-chat registry API (gateway owns chat identity; the dashboard lists +
    // creates + renames + archives chats here). Bearer-authed like /sessions.
    if (url.pathname === "/chats" || url.pathname.startsWith("/chats/")) {
        if (env.authToken) {
            const auth = req.headers.authorization;
            if (auth !== `Bearer ${env.authToken}`) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "unauthorized" }));
                return;
            }
        }
        const json = (code, obj) => {
            res.writeHead(code, { "Content-Type": "application/json" });
            res.end(JSON.stringify(obj));
        };
        const readBody = async () => {
            let body = "";
            for await (const chunk of req) {
                body += chunk;
                if (body.length > 64 * 1024)
                    throw new Error("too large");
            }
            return body ? JSON.parse(body) : {};
        };
        if (req.method === "GET" && url.pathname === "/chats") {
            json(200, { chats: chats.list(url.searchParams.get("archived") === "1") });
            return;
        }
        if (req.method === "POST" && url.pathname === "/chats") {
            let b;
            try {
                b = await readBody();
            }
            catch {
                json(400, { error: "bad_body" });
                return;
            }
            if (!b.name || typeof b.name !== "string") {
                json(400, { error: "name_required" });
                return;
            }
            try {
                json(200, { chat: chats.resolveOrCreate(b.name) });
            }
            catch (e) {
                json(429, { error: "chat_limit", message: e?.message || "chat limit reached" });
            }
            return;
        }
        const cm = url.pathname.match(/^\/chats\/(.+)$/);
        if (cm) {
            const key = decodeURIComponent(cm[1]);
            if (req.method === "PATCH") {
                let b;
                try {
                    b = await readBody();
                }
                catch {
                    json(400, { error: "bad_body" });
                    return;
                }
                let c = chats.get(key);
                if (!c) {
                    json(404, { error: "not_found" });
                    return;
                }
                if (typeof b.name === "string")
                    c = chats.rename(key, b.name) || c;
                if (typeof b.archived === "boolean")
                    c = chats.setArchived(key, b.archived) || c;
                json(200, { chat: c });
                return;
            }
            if (req.method === "DELETE") {
                const c = chats.setArchived(key, true); // soft delete (archive) — never lose transcript
                json(c ? 200 : 404, c ? { ok: true, chat: c } : { error: "not_found" });
                return;
            }
        }
        json(404, { error: "not_found" });
        return;
    }
    // V2 autonomy API: one-shot turn injection + the agent loop engine. Bearer-
    // authed like /sessions and /chats. This is the surface routines/cron/external
    // triggers use to make the agent ACT between user messages.
    if (url.pathname === "/agent/turn" || url.pathname === "/loops" || url.pathname.startsWith("/loops/")) {
        if (env.authToken) {
            const auth = req.headers.authorization;
            if (auth !== `Bearer ${env.authToken}`) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "unauthorized" }));
                return;
            }
        }
        const json = (code, obj) => {
            res.writeHead(code, { "Content-Type": "application/json" });
            res.end(JSON.stringify(obj));
        };
        const readBody = async () => {
            let body = "";
            for await (const chunk of req) {
                body += chunk;
                if (body.length > 64 * 1024)
                    throw new Error("too large");
            }
            return body ? JSON.parse(body) : {};
        };
        // POST /agent/turn { agentId?, message, sessionKey? } → fire ONE turn now.
        // Spend-gated (402 when capped). Lands in a named chat so the user sees it.
        if (req.method === "POST" && url.pathname === "/agent/turn") {
            let b;
            try {
                b = await readBody();
            }
            catch {
                json(400, { error: "bad_body" });
                return;
            }
            if (!b.message || typeof b.message !== "string") {
                json(400, { error: "message_required" });
                return;
            }
            const agent = b.agentId ? cache.findAgent(b.agentId) : cache.agentForChannel("web");
            if (!agent) {
                json(404, { error: "no_agent" });
                return;
            }
            const cred = getCredential(agent.credential_id);
            if (!cred) {
                json(400, { error: "no_credential" });
                return;
            }
            const drv = getDriver(agent.runtime);
            if (!drv) {
                json(400, { error: "no_driver" });
                return;
            }
            const gate = spend.check(agent);
            if (!gate.allowed) {
                json(402, { error: "spend_cap_exceeded", message: gate.reason });
                return;
            }
            const sessionKey = (typeof b.sessionKey === "string" && b.sessionKey) || "main";
            chats.register(sessionKey);
            const session = sessions.getOrCreate(sessionKey, "api", agent.id, agent.runtime);
            transcripts.append(agent.id, sessionKey, { role: "user", text: b.message, source: "api" });
            const result = await runAgentTurn({
                agent, credential: cred, driver: drv,
                systemPrompt: loadSystemPrompt(agent),
                mcpConfigPath: getMcpConfigPath(env.mcpBridgePath),
                message: b.message,
                sessionId: session.claudeSessionId,
                workingDir: agent.profile_dir,
                onEvent: (e) => {
                    if (e.type === "tool_use")
                        transcripts.append(agent.id, sessionKey, { role: "tool", kind: "use", name: e.name, target: e.target });
                    else if (e.type === "tool_result")
                        transcripts.append(agent.id, sessionKey, { role: "tool", kind: "result", outcome: e.outcome });
                },
            });
            if (result.usage)
                spend.record(agent, result.usage);
            if (result.sessionId)
                sessions.updateClaudeSession(sessionKey, "api", result.sessionId, agent.runtime);
            if (result.text.trim())
                transcripts.append(agent.id, sessionKey, { role: "assistant", text: result.text });
            json(result.error && !result.hadOutput ? 502 : 200, {
                ok: !(result.error && !result.hadOutput),
                text: result.text, error: result.error || undefined,
                toolCount: result.toolCount, usage: result.usage, sessionKey,
            });
            return;
        }
        if (req.method === "GET" && url.pathname === "/loops") {
            json(200, { loops: loops.list() });
            return;
        }
        if (req.method === "POST" && url.pathname === "/loops") {
            let b;
            try {
                b = await readBody();
            }
            catch {
                json(400, { error: "bad_body" });
                return;
            }
            try {
                const loop = loops.create({
                    agentId: b.agentId || cache.agentForChannel("web")?.id,
                    goal: b.goal,
                    intervalSeconds: b.intervalSeconds,
                    maxIterations: b.maxIterations,
                    stopSentinel: b.stopSentinel,
                    name: b.name,
                });
                json(200, { loop });
            }
            catch (e) {
                json(400, { error: "create_failed", message: e?.message || String(e) });
            }
            return;
        }
        const lm = url.pathname.match(/^\/loops\/([^/]+)(?:\/(stop|pause|resume))?$/);
        if (lm) {
            const id = decodeURIComponent(lm[1]);
            const action = lm[2];
            if (req.method === "GET" && !action) {
                const l = loops.get(id);
                json(l ? 200 : 404, l ? { loop: l } : { error: "not_found" });
                return;
            }
            if (req.method === "POST" && action === "stop") {
                const l = loops.stop(id);
                json(l ? 200 : 404, l ? { loop: l } : { error: "not_found" });
                return;
            }
            if (req.method === "POST" && action === "pause") {
                const l = loops.pause(id);
                json(l ? 200 : 404, l ? { loop: l } : { error: "not_found" });
                return;
            }
            if (req.method === "POST" && action === "resume") {
                const l = loops.resume(id);
                json(l ? 200 : 404, l ? { loop: l } : { error: "not_found" });
                return;
            }
        }
        json(404, { error: "not_found" });
        return;
    }
    // Telegram webhook
    if (req.method === "POST" && url.pathname === "/telegram") {
        await handleTelegram(req, res);
        return;
    }
    res.writeHead(404);
    res.end("Not Found");
});
// ── WebSocket ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
    if (env.authToken) {
        const auth = req.headers.authorization;
        if (!auth || auth !== `Bearer ${env.authToken}`) {
            ws.close(4001, "Unauthorized");
            return;
        }
    }
    let abortController = null;
    // Serialized turns: one chat turn at a time per connection (the agreed model).
    // The relay multiplexes all named chats over this one ws, and abortController
    // is per-connection — without this gate a 2nd message would clobber the first
    // turn's controller, orphaning it (unabortable, credential-leaking).
    let busy = false;
    ws.on("message", async (data) => {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        }
        catch {
            ws.send(JSON.stringify({ type: "error", text: "Invalid JSON" }));
            return;
        }
        if (msg.type === "abort" && abortController) {
            abortController.abort();
            abortController = null;
            return;
        }
        if (msg.type !== "chat" || !msg.text)
            return;
        if (busy) {
            ws.send(JSON.stringify({
                type: "error", code: "turn_in_progress",
                text: "A turn is already running on this server — one at a time. Wait for it to finish, or press Stop.",
            }));
            return;
        }
        const agent = msg.agentId ? cache.findAgent(msg.agentId) : cache.agentForChannel("web");
        if (!agent) {
            ws.send(JSON.stringify({ type: "error", text: "No agent configured" }));
            return;
        }
        if (!agent.credential_id) {
            ws.send(JSON.stringify({ type: "error", text: `Agent ${agent.id} has no credential configured` }));
            return;
        }
        const credential = getCredential(agent.credential_id);
        if (!credential) {
            ws.send(JSON.stringify({ type: "error", text: `Credential ${agent.credential_id} not found` }));
            return;
        }
        const driver = getDriver(agent.runtime);
        if (!driver) {
            ws.send(JSON.stringify({ type: "error", text: `Unknown runtime ${agent.runtime}` }));
            return;
        }
        // V1 spend kill-switch: refuse the turn BEFORE invoking the model if this
        // agent has reached its daily token/USD cap. This is the floor that makes an
        // unattended loop safe — without it, a looping agent on the customer's key
        // has no cost ceiling. Refused here (before the transcript append) so a
        // capped turn doesn't pollute history. Resets at 00:00 UTC.
        const spendGate = spend.check(agent);
        if (!spendGate.allowed) {
            ws.send(JSON.stringify({
                type: "error", code: "spend_cap_exceeded",
                text: spendGate.reason || "Daily spend cap reached. Resets at 00:00 UTC.",
            }));
            return;
        }
        // Named chats: an explicit chatId routes to that chat's OWN session +
        // transcript (full isolation, native --resume history). A legacy frame
        // (sessionKey only, or neither) keeps its key UNCHANGED — no routing change
        // for existing conversations — and is lazily registered so it appears in
        // the chat list. "main"/legacy keys map to the Main chat for continuity.
        // Resolve the chat WITHOUT auto-creating (abuse vector — a client must not
        // be able to mint unbounded chats by sending arbitrary chatIds). An explicit
        // chatId that matches a chat created via POST /chats routes to it; anything
        // else (incl. "main" or an unknown id) falls back to the server's ORIGINAL
        // conversation key, registered as "Main" for continuity + the chat list.
        // New chats are minted ONLY via POST /chats.
        let sessionKey;
        const existingChat = msg.chatId ? chats.resolve(msg.chatId) : undefined;
        if (existingChat) {
            sessionKey = existingChat.key;
        }
        else {
            sessionKey = msg.sessionKey || "ws-default";
            chats.register(sessionKey);
        }
        chats.touch(sessionKey);
        const session = sessions.getOrCreate(sessionKey, "web", agent.id, agent.runtime);
        // Canonical transcript: record the user's message (gateway owns session
        // state — the dashboard reads this, and it survives runtime swaps).
        transcripts.append(agent.id, sessionKey, { role: "user", text: msg.text, source: "web" });
        // Durable re-seed: if the runtime has no native session to resume (fresh
        // box, wiped session file, or a claude-code↔openclaw swap) but we DO have a
        // prior transcript, prepend a compact recap so the agent keeps its memory
        // beyond the runtime's own storage. The runtime compacts further if needed.
        let messageToSend = msg.text;
        if (!session.claudeSessionId) {
            const recap = transcripts.buildRecap(agent.id, sessionKey);
            if (recap) {
                messageToSend =
                    `[Conversation recap — restored from osModa's durable transcript because the ` +
                        `runtime session was not available (new session, or runtime switched). Continue the ` +
                        `conversation naturally; do NOT re-introduce yourself or repeat earlier answers.]\n\n` +
                        `${recap}\n\n[End of recap. The user's new message follows.]\n\n${msg.text}`;
                console.log(`[transcript] re-seeded ${agent.id}:${sessionKey} from durable transcript (${recap.length} chars)`);
            }
        }
        // Cross-chat awareness: prepend a bounded digest of significant changes
        // OTHER named chats made since this chat last ran. Best-effort — must never
        // block the turn. Cursors advance only AFTER the turn succeeds (below).
        let digestAdvance = [];
        try {
            const dg = buildCrossChatDigest(transcripts, chats, agent.id, sessionKey);
            digestAdvance = dg.advance;
            if (dg.text) {
                messageToSend = `${dg.text}\n\n${messageToSend}`;
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "cross_chat_digest", text: dg.text, peers: dg.peers }));
                }
                console.log(`[cross-chat] injected digest for ${sessionKey} (${dg.peers} peer chat(s))`);
            }
        }
        catch (e) {
            console.warn(`[cross-chat] digest skipped: ${e?.message || e}`);
        }
        busy = true; // serialized-turn gate (cleared in finally); set before the first await
        abortController = new AbortController();
        const systemPrompt = loadSystemPrompt(agent);
        let turnText = "";
        const flushAssistant = () => {
            if (turnText.trim()) {
                transcripts.append(agent.id, sessionKey, { role: "assistant", text: turnText });
                turnText = "";
            }
        };
        // Run one pass through the driver. Returns:
        //   sawCredError: a quota/auth/rate-limit error (cooldown candidate)
        //   hadOutput:    whether any text/tool frame reached the client (in which
        //                 case a fallback retry would be confusing — skip it)
        //   credErrorReason: out_of_usage / rate_limited / auth_failed (or null)
        //   lastErrorText: for surfacing
        const runPass = async (cred) => {
            let sawCredError = false;
            let hadOutput = false;
            let credErrorReason = null;
            let lastErrorText = null;
            for await (const event of driver.startSession({
                agent, credential: cred, model: agent.model, systemPrompt,
                mcpConfigPath: getMcpConfigPath(env.mcpBridgePath),
                message: messageToSend,
                sessionId: session.claudeSessionId,
                abortSignal: abortController.signal,
                workingDir: agent.profile_dir,
            })) {
                if (ws.readyState !== WebSocket.OPEN)
                    break;
                if (event.type === "text" && event.text) {
                    turnText += event.text;
                    hadOutput = true;
                }
                else if (event.type === "text_bulk" && event.text) {
                    // Authoritative final answer (openclaw) — replace the accumulator so
                    // the persisted transcript holds the clean answer, not the interim.
                    turnText = event.text;
                    hadOutput = true;
                }
                else if (event.type === "interim_text") {
                    // Planning/thinking text — streamed to the client live but NOT the
                    // canonical answer; don't pollute turnText. (Counts as output so a
                    // credential-error fallback isn't triggered after real progress.)
                    hadOutput = true;
                }
                else if (event.type === "tool_use") {
                    // Do NOT flush the assistant accumulator here. A single logical turn
                    // interleaves text + tools; flushing per tool_use persisted N+1 stub
                    // assistant rows per turn (the fragmented "Task completed" bug). Tool
                    // rows are appended in order; the ONE assistant answer is flushed at
                    // `done`. (With the two-channel driver, turnText only holds the final
                    // text_bulk anyway — but dropping the flush also covers answer→tool.)
                    transcripts.append(agent.id, sessionKey, {
                        role: "tool", kind: "use", name: event.name, target: event.target,
                    });
                    hadOutput = true;
                }
                else if (event.type === "tool_result") {
                    transcripts.append(agent.id, sessionKey, { role: "tool", kind: "result", outcome: event.outcome });
                }
                else if (event.type === "done") {
                    flushAssistant();
                    // V1 spend meter: bill this turn's usage to the agent's daily bucket.
                    // Fires the warn/halt alert internally; the NEXT turn's spend.check
                    // enforces the cap. (claude-code reports real cost_usd; openclaw falls
                    // back to the price-table estimate.)
                    if (event.usage)
                        spend.record(agent, event.usage);
                }
                else if (event.type === "error") {
                    lastErrorText = event.text || lastErrorText;
                    const reason = classifyCredentialError({ code: event.code, text: event.text });
                    if (reason) {
                        sawCredError = true;
                        credErrorReason = reason;
                    }
                }
                // Suppress the terminal error frame from the client if we're about to
                // try a fallback — the dashboard would show a scary error for a turn
                // that's actually still in progress.
                if (event.type === "error" && sawCredError && !hadOutput)
                    continue;
                pipeEvent(ws, event, sessionKey, agent.runtime);
            }
            return { sawCredError, hadOutput, credErrorReason, lastErrorText };
        };
        try {
            let active = credential;
            let pass = await runPass(active);
            // Fallback: if THIS credential is exhausted and we haven't streamed any
            // output yet, cool it down and retry once with the next healthy
            // credential of the same provider+type.
            if (pass.sawCredError && !pass.hadOutput) {
                markCredentialCooldown(active.id, pass.credErrorReason || "unknown", 30 * 60 * 1000);
                const next = pickFallbackCredential(active);
                // Tell the dashboard what just happened (state.changed semantics).
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: "credential_cooldown",
                        credential_id: active.id,
                        label: active.label,
                        reason: pass.credErrorReason,
                        cooldown_minutes: 30,
                        falling_back_to: next ? { id: next.id, label: next.label } : null,
                    }));
                }
                console.log(`[creds] cooldown ${active.label} (${pass.credErrorReason}); fallback → ${next?.label || "none"}`);
                if (next) {
                    active = next;
                    pass = await runPass(active);
                }
                else {
                    // No fallback available — surface the original error to the client.
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: "error",
                            code: "credential_exhausted",
                            text: `All ${credential.provider} ${credential.type} credentials are exhausted/cooldowned. ${pass.lastErrorText || ""}`,
                        }));
                    }
                }
            }
            flushAssistant();
            // Cross-chat cursors advance ONLY when the turn actually DELIVERED output
            // (pass.hadOutput) — NOT on a credential-exhausted no-fallback soft failure,
            // which sends an error frame without throwing. Otherwise we'd mark peer
            // changes "seen" that the agent never actually processed, dropping them.
            if (pass.hadOutput) {
                for (const a of digestAdvance)
                    chats.setCursor(sessionKey, a.peerKey, a.seq);
            }
        }
        catch (e) {
            flushAssistant();
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "error", text: e?.message || String(e) }));
            }
        }
        finally {
            abortController = null;
            busy = false; // release the serialized-turn gate no matter how the turn ended
        }
    });
    ws.on("close", () => { if (abortController)
        abortController.abort(); });
});
function pipeEvent(ws, event, sessionKey, runtime) {
    switch (event.type) {
        case "text":
            ws.send(JSON.stringify({ type: "text", text: event.text }));
            break;
        // Streaming chat contract (agentic-chat-interface skill §1) — forward verbatim.
        case "text_bulk":
            ws.send(JSON.stringify({ type: "text_bulk", text: event.text }));
            break;
        case "interim_text":
            ws.send(JSON.stringify({ type: "interim_text", text: event.text }));
            break;
        case "interim_commit_final":
            ws.send(JSON.stringify({ type: "interim_commit_final", length: event.length }));
            break;
        case "status":
            ws.send(JSON.stringify({ type: "status", step: event.step }));
            break;
        case "phase":
            ws.send(JSON.stringify({ type: "phase", phase: event.phase }));
            break;
        case "tool_use":
            ws.send(JSON.stringify({ type: "tool_use", name: event.name, target: event.target, round: event.round }));
            break;
        case "tool_result":
            ws.send(JSON.stringify({ type: "tool_result", name: event.name, outcome: event.outcome, summary: event.summary }));
            break;
        case "thinking":
            ws.send(JSON.stringify({ type: "thinking", text: event.text }));
            break;
        case "session":
            if (event.sessionId)
                sessions.updateClaudeSession(sessionKey, "web", event.sessionId, runtime);
            break;
        case "done":
            if (event.sessionId)
                sessions.updateClaudeSession(sessionKey, "web", event.sessionId, runtime);
            ws.send(JSON.stringify({ type: "done" }));
            break;
        case "error":
            ws.send(JSON.stringify({ type: "error", text: event.text, code: event.code }));
            break;
    }
}
// ── Telegram ───────────────────────────────────────────────────────────
async function handleTelegram(req, res) {
    if (!env.telegramBotToken) {
        res.writeHead(503);
        res.end("Telegram not configured");
        return;
    }
    let body = "";
    try {
        for await (const chunk of req) {
            body += chunk;
            if (body.length > 1024 * 1024) {
                res.writeHead(413);
                res.end("Too large");
                return;
            }
        }
    }
    catch {
        res.writeHead(400);
        res.end("Bad request");
        return;
    }
    let update;
    try {
        update = JSON.parse(body);
    }
    catch {
        res.writeHead(400);
        res.end("Invalid JSON");
        return;
    }
    res.writeHead(200);
    res.end("ok"); // ack immediately
    const message = update.message;
    if (!message?.text || !message?.chat?.id)
        return;
    const chatId = String(message.chat.id);
    const username = message.from?.username || "";
    if (env.telegramAllowedUsers.length &&
        !env.telegramAllowedUsers.includes(username) &&
        !env.telegramAllowedUsers.includes(chatId))
        return;
    const agent = cache.agentForChannel("telegram");
    if (!agent || !agent.credential_id) {
        await sendTelegram(env.telegramBotToken, chatId, "Telegram agent not configured. Visit the dashboard → Settings → Agents.");
        return;
    }
    const credential = getCredential(agent.credential_id);
    if (!credential) {
        await sendTelegram(env.telegramBotToken, chatId, "Telegram agent's credential is missing. Visit Settings → Credentials.");
        return;
    }
    const driver = getDriver(agent.runtime);
    if (!driver) {
        await sendTelegram(env.telegramBotToken, chatId, `Agent runtime ${agent.runtime} not available.`);
        return;
    }
    // V1 spend kill-switch: same daily cap enforced on the Telegram path.
    const tgSpendGate = spend.check(agent);
    if (!tgSpendGate.allowed) {
        await sendTelegram(env.telegramBotToken, chatId, `🛑 ${tgSpendGate.reason || "Daily spend cap reached. Resets at 00:00 UTC."}`);
        return;
    }
    const session = sessions.getOrCreate(chatId, "telegram", agent.id, agent.runtime);
    const systemPrompt = loadSystemPrompt(agent);
    // Register this Telegram conversation as a cross-CHANNEL peer + record its
    // turns in the canonical transcript (keyed by the mobile agentId), so its
    // changes are visible to web named chats — and it sees theirs.
    chats.register(chatId, { agentId: agent.id, name: `Telegram ${chatId}` });
    chats.touch(chatId);
    transcripts.append(agent.id, chatId, { role: "user", text: message.text, source: "telegram" });
    // Cross-chat awareness: prepend a digest of changes other chats/channels made.
    let messageToSend = message.text;
    let tgAdvance = [];
    try {
        const dg = buildCrossChatDigest(transcripts, chats, agent.id, chatId);
        tgAdvance = dg.advance;
        if (dg.text)
            messageToSend = `${dg.text}\n\n${messageToSend}`;
    }
    catch { /* awareness is best-effort — never block a Telegram reply */ }
    let fullText = "";
    let turnText = "";
    let delivered = false;
    try {
        for await (const event of driver.startSession({
            agent, credential, model: agent.model, systemPrompt,
            mcpConfigPath: getMcpConfigPath(env.mcpBridgePath),
            message: messageToSend,
            sessionId: session.claudeSessionId,
            workingDir: agent.profile_dir,
        })) {
            // Two-channel contract: the FINAL answer is text_bulk (both drivers). The
            // old code only summed `text`, which neither driver emits anymore → empty
            // Telegram replies. Capture text_bulk (primary) + text (legacy fallback);
            // ignore interim_text (that's thinking, not the reply).
            if (event.type === "text_bulk" && event.text) {
                fullText = event.text;
                turnText = event.text;
                delivered = true;
            }
            else if (event.type === "text" && event.text) {
                fullText += event.text;
                turnText += event.text;
                delivered = true;
            }
            else if (event.type === "tool_use") {
                transcripts.append(agent.id, chatId, { role: "tool", kind: "use", name: event.name, target: event.target });
            }
            else if (event.type === "tool_result") {
                transcripts.append(agent.id, chatId, { role: "tool", kind: "result", outcome: event.outcome });
            }
            else if (event.type === "session" && event.sessionId) {
                sessions.updateClaudeSession(chatId, "telegram", event.sessionId, agent.runtime);
            }
            else if (event.type === "done") {
                if (event.sessionId)
                    sessions.updateClaudeSession(chatId, "telegram", event.sessionId, agent.runtime);
                if (event.usage)
                    spend.record(agent, event.usage); // V1 spend meter (parity with web path)
            }
            else if (event.type === "error" && event.text && !fullText) {
                fullText = event.text;
            }
        }
    }
    catch (e) {
        fullText = `Error: ${e?.message || String(e)}`;
    }
    if (turnText.trim())
        transcripts.append(agent.id, chatId, { role: "assistant", text: turnText });
    // Advance cross-chat cursors only on a delivered turn (parity with the web path).
    if (delivered)
        for (const a of tgAdvance)
            chats.setCursor(chatId, a.peerKey, a.seq);
    if (fullText)
        await sendTelegram(env.telegramBotToken, chatId, fullText);
}
async function sendTelegram(botToken, chatId, text) {
    const body = JSON.stringify({
        chat_id: chatId,
        text: text.length > 4096 ? text.slice(0, 4093) + "..." : text,
        parse_mode: "Markdown",
    });
    return new Promise((resolve) => {
        const req = https.request({
            hostname: "api.telegram.org",
            path: `/bot${botToken}/sendMessage`,
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        }, (r) => { r.on("data", () => { }); r.on("end", () => resolve()); });
        req.on("error", (e) => { console.error("[gateway] Telegram send error:", e.message); resolve(); });
        req.write(body);
        req.end();
    });
}
// ── Start ───────────────────────────────────────────────────────────────
// v1.3.18 — Bind to 127.0.0.1 by default. The gateway's HTTP+WS surface
// only needs to be reachable by:
//   1. The customer's own scripts (curl over loopback) — fine on localhost
//   2. The spawn-app's gatewayProxy — which SSH-tunnels in, then curl's
//      http://127.0.0.1:18789/config/* (so loopback works perfectly)
//   3. The customer's SSH tunnel from a laptop (`ssh -L 18789:localhost:18789`)
// There is NO production reason to expose this on 0.0.0.0. Token auth
// alone is not a sufficient defense — defense in depth requires we don't
// publish the surface in the first place.
//
// Override: set OSMODA_GATEWAY_BIND=0.0.0.0 in env if you genuinely need
// public access (and accept the responsibility).
const bindHost = process.env.OSMODA_GATEWAY_BIND || "127.0.0.1";
server.listen(env.port, bindHost, () => {
    console.log(`[gateway] osModa Gateway (modular) listening on ${bindHost}:${env.port}`);
    if (bindHost === "0.0.0.0") {
        console.warn(`[gateway] ⚠️  bound to 0.0.0.0 — gateway is reachable from the public internet. Set OSMODA_GATEWAY_BIND=127.0.0.1 to lock down.`);
    }
    console.log(`[gateway] drivers: ${listDrivers().map(d => d.name).join(", ")}`);
    const current = cache.current();
    console.log(`[gateway] agents: ${current.agents.map(a => `${a.id}(${a.runtime}/${a.model})`).join(", ") || "<none>"}`);
    console.log(`[gateway] credentials: ${loadCredentials().credentials.length}`);
});
