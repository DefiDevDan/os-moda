# Spawn API v1 — x402-Gated Public API

Last updated: 2026-05-06 · API version: **1.2.5**

Programmatic API for spawning osModa servers. Any AI agent pays USDC (on Base or Solana) via x402 and gets a running server with its own AI agent. Agents spawning agents.

**v1.2.5 (2026-05-06) — SSE-based async chat with resumable streaming:**

Three additive endpoints on the dashboard surface (`sk_live_` Bearer or session cookie auth — distinct from the v1 `osk_` Bearer used by the rest of this API). The legacy synchronous `POST /chat` stays for compatibility.

- **`POST /api/dashboard/servers/:id/chat-async`** — body `{message, model?}`. Returns `202` immediately with `{conversation_id, message_id}`. The agent runs in the background; clients consume events via the next two endpoints.
- **`GET /api/dashboard/servers/:id/chat-stream/:conversation_id?cursor=N`** — `text/event-stream`. Replays every `ChatEvent` with `id > cursor` from the persistent NDJSON log, then attaches live for new events. Closes with `event: close` when the conversation reaches a terminal event (`done` or `error`). 15 s keepalive comments so Cloudflare/nginx don't cut idle streams. Cursor past terminal returns `410 conversation_terminated`.
- **`GET /api/dashboard/servers/:id/chat-history/:conversation_id`** — full event log as JSON. For cold loads (refresh hours later) and non-SSE clients.
- **`ChatEvent` envelope** (discriminated by `type`):
  - `phase` — `{phase: "thinking" | "answering"}`
  - `tool_call_start` — `{tool, args_preview}`
  - `tool_call_done` — `{tool, result_preview, ok, duration_ms}`
  - `delta` — `{text}` (an assistant token chunk)
  - `done` — `{final_text, tokens_in?, tokens_out?}` (terminal)
  - `error` — `{code, message}` (terminal — e.g. `code:"agent_silent"` when the model never streamed within 120 s)
- **Persistence**: append-only NDJSON at `data/chat-events/<conversation_id>.ndjson`. Retention ≥ 24 h after terminal (default sweep 48 h). The NDJSON file is the source of truth for both live and cold replay.
- **Concurrency**: only one chat-async can be in flight per server (single-user-watching-single-agent assumption). A second concurrent request returns `409 conversation_in_progress`.
- **Out of scope for v1.2.5**: cancelling an in-flight agent, multi-turn parallelism on a single conversation, WebSocket parity for dashboard auth.

Reference integration (60-line client):
```ts
// Start the agent run
const r = await fetch(`/api/dashboard/servers/${orderId}/chat-async`, {
  method: "POST",
  headers: { Authorization: `Bearer ${SK_LIVE}`, "Content-Type": "application/json" },
  body: JSON.stringify({ message: prompt }),
});
const { conversation_id, message_id } = await r.json();

// Stream events live (resumable on refresh via lastSeenId)
let lastSeenId = 0;
const es = new EventSource(
  `/api/dashboard/servers/${orderId}/chat-stream/${conversation_id}?cursor=${lastSeenId}`
);
es.addEventListener("chat", (ev) => {
  const e = JSON.parse(ev.data);  // ChatEvent
  lastSeenId = e.id;
  if (e.type === "delta")     append(e.text);
  if (e.type === "tool_call_start") showTool(e.tool);
  if (e.type === "done")      finalize(e.final_text);
  if (e.type === "error")     showError(e.code, e.message);
});
es.addEventListener("close", () => es.close());
```

**v1.2.3 (2026-05-04 / 2026-05-06) — Swarms retired + smart watchdog + spawn-log:**
- Removed the `Swarms (alpha)` family (`/api/v1/swarms/*`, 16 paths + 2 WS feeds). The same outcome — coordinated autonomous AI businesses — is now delivered by spawning a server, opening the chat WebSocket, and prompting the agent: every spawn ships with full system access plus the **Factories** (spec-kit) surface. The fictional Venture-orchestrator simulator is gone; ~2300 LOC retired.
- **Smart 3-layer watchdog** (2026-05-06): the install monitor now runs every 60 s with three escalating detection layers: `cloud_init_silent` at 4 min (no callbacks at all), `phase_stalled` at 7 min (same phase no progress — auto SSH-tails the box and attaches the install-log tail to `install_error.log_tail`), `final_timeout` at 25 min (hard fail, existing).
- **New `stalled` field on `StatusResponseFull`** — soft-warning state surfaced when a spawn is mid-stall but not yet hard-failed. Lets your dashboard show "we noticed it's slow, investigating…" instead of a frozen spinner. `{step, status, stuck_for_min, since}`. Cleared automatically when the next phase reports progress.
- **Per-order spawn-log** (NDJSON) at `data/spawn-log/<order_id>.ndjson` — every lifecycle event timestamped + structured. Surfaced via `GET /api/dashboard/orders/{id}/spawn-log` (cookie-authed dashboard endpoint, owner-only) for the human-facing "what's happening with my spawn" panel. Not part of the v1 Bearer API surface — AI integrators get the same info from `provision_steps[]` + `install_error` + `stalled` in the status response.
- No impact on stable v1 endpoints (`/plans`, `/spawn/:planId`, `/status/:orderId`, `/tokens/:token_id`, `/spec-kit/projects`, `/chat/{orderId}`, `/docs`, `/.well-known/agent-card.json`).

**v1.2.2 (2026-04-30) — spec-driven development + auth-type gating:**
- New free endpoint `GET /api/v1/spec-kit/projects` (Bearer) — discover spec-driven projects across the caller's spawned servers. Aggregated from heartbeat data; no SSH required.
- Every spawn now ships with `github/spec-kit` baked in (uv + specify-cli, pinned `v0.8.4`). The agent gets two new MCP tools (`spec_kit_init` + `spec_kit_run`) that scaffold spec-kit projects on demand. Bumped to **92 MCP tools / 20 system skills**.
- Agent Card gained capability flags: `spec_driven_development`, `spec_kit_version`, plus pre-existing `install_failure_visibility`, `install_watchdog_minutes`, `provision_progress_callbacks`, `network_mode`.
- Agent Card `runtimes[].supported_auth_types` — `claude-code` accepts both `oauth` + `api_key`; `openclaw` accepts `api_key` only. The dashboard Engine tab and SDK both enforce this contract client-side; the customer-server gateway enforces server-side.
- `claude-opus-4-7` is now a default model for the `claude-code` runtime (newest Anthropic Opus). Selectable from the dashboard Engine tab and via the spawn `default_model` field.
- The "(legacy)" suffix on OpenClaw was removed everywhere — it's a first-class engine for BYOK / non-Anthropic providers.

**v1.2.1 (2026-04-29) — install-failure visibility pass:**
- New order statuses: `install_failed` (watchdog or explicit callback) and `deleted`.
- New `install_error` field on full status response when `status=install_failed`. Carries `step`, `reason`, optional `log_tail` (200 lines), `at`, and `watchdog` boolean.
- New `provision_steps[]` field surfaces every install phase transition.
- Server-side callbacks `/api/heartbeat`, `/api/provision-progress`, `/api/provision-failed` documented in OpenAPI for self-hosted operators (NOT for API integrators — the spawned server posts these to its own callback URL).

**v1.2.0 (2026-04-18):** modular runtime — `runtime`, `default_model`, `credentials[]` fields on spawn requests; per-server dashboard config endpoints.

**v1.1.0 (2026-04-17) — production readiness:** idempotent spawn, structured error envelope, request IDs, token expiry + revoke, per-token rate limits, hardened WebSocket (heartbeat / idle / backpressure / concurrency cap), complete OpenAPI 3.0.3 spec.

**Live, interactive reference**: <https://spawn.os.moda/docs> (Swagger UI bound to `/api/v1/docs` — auto-current with the deployed server). The spec ships concrete `example` values on every schema and multi-case `examples` on the most-polled operations (status, spec-kit projects, agent-card).

**What v1 does NOT expose** — call out for integrators planning their dashboards:
- **Server termination via Bearer** — currently dashboard-only at `/api/dashboard/servers/:id` (cookie auth). Integrators should retire the token (`DELETE /api/v1/tokens/{id}`) and ask end-users to delete via the dashboard.
- **Post-spawn agent/credential config via Bearer** — the `/config/*` proxy endpoints are cookie-authed (SSH-tunnelled). Pre-seed `credentials[]` + `runtime` + `default_model` at spawn time instead.
- **Webhooks** — poll `GET /api/v1/status/{orderId}`. Drive sub-status progress UIs from the `provision_steps[]` field.
- **Listing all servers a token owns** — tokens are scoped to a single order. Hold the `order_id` returned by spawn alongside the token.

---

## Quick start

```bash
# 1. See available plans
curl https://spawn.os.moda/api/v1/plans

# 2. Try to spawn (get 402 with payment details)
curl -X POST https://spawn.os.moda/api/v1/spawn/test

# 3. After x402 payment, you get back:
{
  "order_id": "uuid",
  "api_token": "osk_<64-hex>",
  "server_ip": "1.2.3.4",
  "status": "provisioning",
  "status_url": "https://spawn.os.moda/api/v1/status/<orderId>",
  "chat_url": "wss://spawn.os.moda/api/v1/chat/<orderId>",
  "ssh": "ssh root@1.2.3.4"
}

# 4. Poll status
curl -H "Authorization: Bearer osk_<token>" \
  https://spawn.os.moda/api/v1/status/<orderId>

# 5. Chat with the server's AI agent
wscat -c "wss://spawn.os.moda/api/v1/chat/<orderId>?token=osk_<token>"
```

---

## How x402 works

x402 is an HTTP-native payment protocol (Coinbase standard). No API keys. No signup. Just USDC.

```
Agent → POST /api/v1/spawn/test
Server ← 402 Payment Required
         Headers contain: price ($14.99), networks (Base + Solana), USDC asset, payTo addresses

For Base:   Agent signs USDC transferWithAuthorization (ERC-3009, gasless)
For Solana: Agent signs USDC SPL token transfer

Agent → POST /api/v1/spawn/test
         PAYMENT header with signed authorization

Facilitator (x402.org) verifies + settles on-chain
Server ← 200 OK + server details
```

**Supported networks**:
- **Base (EVM)** — USDC on Base mainnet (chain ID 8453) or Base Sepolia testnet
- **Solana (SVM)** — USDC on Solana mainnet-beta or Devnet

The 402 response advertises both networks. Your x402 client picks whichever chain it has funds on.

**Payment packages**: Uses `@x402/express` + `@x402/evm` + `@x402/svm` middleware. Any x402-compatible client (Coinbase SDK `fetch402`, Daydreams agents, custom implementations) works out of the box.

---

## Endpoints

### Free endpoints (no payment)

#### `GET /api/v1/plans`

List available plans with pricing and x402 payment info.

**Response:**
```json
{
  "plans": [
    {
      "id": "test",
      "name": "Solo",
      "description": "1 agent, light tasks",
      "cpu": 2,
      "ram": 4,
      "disk": 40,
      "price_usd": 14.99,
      "tier": "Try it out",
      "endpoint": "https://spawn.os.moda/api/v1/spawn/test",
      "x402": {
        "accepts": [
          { "scheme": "exact", "price": "$14.99", "network": "eip155:8453", "payTo": "0x..." },
          { "scheme": "exact", "price": "$14.99", "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "payTo": "DFbW..." }
        ]
      }
    }
  ],
  "regions": [
    { "id": "eu-central", "name": "EU Central (Frankfurt)", "flag": "eu" },
    { "id": "eu-north", "name": "EU North (Helsinki)", "flag": "fi" },
    { "id": "us-east", "name": "US East (Virginia)", "flag": "us" },
    { "id": "us-west", "name": "US West (Oregon)", "flag": "us" }
  ],
  "network": "testnet"
}
```

#### `GET /api/v1/tokens/:token_id`

Read token metadata. **Bearer required; a token can only read its own metadata.**

```json
{
  "token_id": "0123abcdef456789",
  "order_id": "e5c49d30-1234-4abc-9def-0123456789ab",
  "created_at": "2026-04-17T12:00:00.000Z",
  "expires_at": "2027-04-17T12:00:00.000Z",
  "revoked_at": null
}
```

#### `DELETE /api/v1/tokens/:token_id`

Revoke the token permanently. **Bearer required; a token can only revoke itself.** Returns `204` on success. Subsequent authenticated calls with that token return `401 token_revoked`.

```bash
curl -X DELETE \
  -H "Authorization: Bearer osk_…" \
  https://spawn.os.moda/api/v1/tokens/0123abcdef456789
```

#### `GET /api/v1/status/:orderId`

Check server provisioning status.

**Without auth** — basic info only:
```json
{
  "order_id": "uuid",
  "status": "provisioning",
  "plan": "Solo",
  "created_at": "2026-03-06T12:00:00.000Z"
}
```

**With `Authorization: Bearer osk_<token>`** — full details. Three concrete cases (live in `/docs` as named examples):

*Running:*
```json
{
  "order_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "running",
  "plan": "Pro",
  "created_at": "2026-05-04T08:00:00.000Z",
  "server_ip": "1.2.3.4",
  "server_name": "osmoda-9cbfc612",
  "region": "eu-central",
  "ssh": "ssh root@1.2.3.4",
  "chat_url": "wss://spawn.os.moda/api/v1/chat/550e8400-e29b-41d4-a716-446655440000",
  "price_usd": 34.99,
  "setup_complete": true,
  "last_heartbeat": "2026-05-04T08:14:00.000Z",
  "provision_steps": [
    { "step": "preflight",    "status": "done", "detail": "ubuntu 24.04",            "ts": "2026-05-04T08:00:30.000Z" },
    { "step": "dependencies", "status": "done", "detail": "rustc + node ready",      "ts": "2026-05-04T08:01:50.000Z" },
    { "step": "build",        "status": "done", "detail": "cargo build in 5m39s",    "ts": "2026-05-04T08:07:31.000Z" },
    { "step": "services",     "status": "done", "detail": "13 osmoda-* units active","ts": "2026-05-04T08:08:14.000Z" },
    { "step": "ready",        "status": "done", "detail": "first heartbeat received","ts": "2026-05-04T08:08:43.000Z" }
  ]
}
```

*Install failed (with diagnostic `install_error`):*
```json
{
  "order_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "install_failed",
  "plan": "Pro",
  "created_at": "2026-05-04T08:00:00.000Z",
  "setup_complete": false,
  "install_failed_at": "2026-05-04T08:14:22.000Z",
  "install_error": {
    "step": "build",
    "reason": "Install exited with code 137 at phase build (OOM)",
    "log_tail": "+ cargo build --release\n[ … 198 more lines … ]\nKilled\n",
    "at": "2026-05-04T08:14:22.000Z",
    "watchdog": false
  },
  "provision_steps": [
    { "step": "preflight",    "status": "done",    "ts": "2026-05-04T08:00:30.000Z" },
    { "step": "build",        "status": "started", "ts": "2026-05-04T08:02:10.000Z" },
    { "step": "failed",       "status": "error",   "detail": "Install exited with code 137", "ts": "2026-05-04T08:14:22.000Z" }
  ]
}
```

**Status values**: `pending` → `provisioning` → `running` | `failed` | `install_failed` | `deleted`. See the [order-status table](#order-status-enum) below for which side sets each.

#### `GET /api/v1/spec-kit/projects` *(v1.2.2)*

List spec-driven projects across the caller's spawned servers. **Bearer required** (`osk_<hex>`). Aggregated from each server's most recent heartbeat — no SSH required.

```bash
curl -H "Authorization: Bearer osk_…" \
  https://spawn.os.moda/api/v1/spec-kit/projects
```

**Response:**
```json
{
  "count": 2,
  "projects": [
    {
      "order_id": "550e8400-e29b-41d4-a716-446655440000",
      "server_name": "osmoda-9cbfc612",
      "project": "billing-api",
      "slug": "billing-api",
      "status": "implementing",
      "last_implement_at": "2026-05-04T08:11:42.000Z",
      "spec_path": "/workspace/billing-api/specs/001-billing-api/spec.md"
    }
  ]
}
```

Each project corresponds to a `specify init`-scaffolded directory under `/workspace/<slug>/` on the customer server. Use the [WebSocket chat](#ws-apiv1chatorderidtokenosk_token) with `/speckit-plan`, `/speckit-tasks`, or `/speckit-implement` to advance one. Projects in this list are agent-managed via the `spec_kit_init` + `spec_kit_run` MCP tools.

**Auth note**: tokens are per-order, so this endpoint returns projects for the single server that issued the calling token. To aggregate across many servers under a SaaS umbrella, run one call per token from your own backend.

#### `GET /api/v1/docs`

Full OpenAPI 3.0 specification (machine-readable JSON).

#### `GET /.well-known/agent-card.json`

A2A / ERC-8004 agent discovery card. Returns all plans as skills with x402 pricing, input/output schemas, and endpoint URLs. Used by Daydreams Taskmarket and any A2A-compatible agent for automatic discovery.

---

### x402-gated endpoints (USDC payment required)

All spawn endpoints require x402 USDC payment. Without a valid `PAYMENT` header, the server returns `402 Payment Required` with payment details.

#### `POST /api/v1/spawn/test` — Solo ($14.99/mo)

2 vCPU, 4GB RAM, 40GB SSD. 1 agent, light tasks.

#### `POST /api/v1/spawn/starter` — Pro ($34.99/mo)

4 vCPU, 8GB RAM, 80GB SSD. 2-4 agents, real work.

#### `POST /api/v1/spawn/developer` — Team ($62.99/mo)

8 vCPU, 16GB RAM, 160GB SSD. 5-10 agents, heavy loads.

#### `POST /api/v1/spawn/production` — Scale ($125.99/mo)

16 vCPU, 32GB RAM, 320GB SSD. 10-20+ agents, full fleet.

**Request body** (all fields optional):
```json
{
  "region": "eu-central",
  "ssh_key": "ssh-ed25519 AAAA...",
  "runtime": "claude-code",
  "default_model": "claude-opus-4-7",
  "credentials": [
    { "label": "My Claude Pro", "provider": "anthropic", "type": "oauth",    "secret": "sk-ant-oat01-…" },
    { "label": "Fallback key",  "provider": "anthropic", "type": "api_key",  "secret": "sk-ant-api03-…" }
  ]
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `region` | string | `eu-central` | Server location: `eu-central`, `eu-north`, `us-east`, `us-west` |
| `ssh_key` | string | null | SSH public key (ed25519/RSA/ECDSA). Added to `authorized_keys` |
| `runtime` | string | `claude-code` | Agent runtime engine: `claude-code` or `openclaw`. `claude-code` accepts OAuth + API key; `openclaw` accepts API key only. |
| `default_model` | string | `claude-opus-4-7` (claude-code) / `claude-sonnet-4-6` (openclaw) | Initial default model. Per-agent overrides via the dashboard Engine tab or `/config/agents`. |
| `credentials` | array | `[]` | Up to 8 entries pre-seeded into the server's encrypted credential store (AES-256-GCM). Each: `{label, provider: "anthropic"\|"openai", type: "oauth"\|"api_key", secret}`. OAuth credentials only bind to `claude-code` agents. |
| `ai_provider` | string | null | **Legacy.** `anthropic` or `openai`. Auto-migrated into a single `credentials[]` entry. New integrations should use `credentials[]` directly. |
| `api_key` | string | null | **Legacy.** API key for `ai_provider`. Same auto-migration. |

**Idempotency**: send `Idempotency-Key: <16-128 chars>` to make spawn safe to retry. Cached for 24 h. See the [Idempotency](#idempotency) section.

**Response** (after x402 payment verified):
```json
{
  "order_id": "550e8400-e29b-41d4-a716-446655440000",
  "api_token": "osk_a1b2c3d4...",
  "plan": "Pro",
  "price_usd": 34.99,
  "server_ip": "1.2.3.4",
  "status": "provisioning",
  "status_url": "https://spawn.os.moda/api/v1/status/550e8400-...",
  "chat_url": "wss://spawn.os.moda/api/v1/chat/550e8400-...",
  "ssh": "ssh root@1.2.3.4",
  "message": "Server provisioning. osModa installs in 5-10 minutes."
}
```

**`api_token`**: Your secret key for this server. Used for:
- Full status details: `Authorization: Bearer osk_<token>`
- WebSocket chat: `?token=osk_<token>` query param
- Store it securely. It's shown only once.

---

### WebSocket

#### `WS /api/v1/chat/:orderId?token=osk_<token>`

Real-time chat with the spawned server's AI agent.

**Auth**: `token` query parameter with the `osk_` token from the spawn response. Tokens are validated pre-upgrade; expired or revoked tokens are rejected with `401` or `403` plus `X-Auth-Reason: token_expired|token_revoked|forbidden` on the response line.

**Message size**: max 64 KB per frame.

**Heartbeat**: the server pings every 30 s. Your client MUST respond with pong (the default `ws` / browser `WebSocket` behavior already does this). A missed pong terminates the connection.

**Idle timeout**: the server closes with code `4003 idle_timeout` after 10 minutes of no client messages. Send any frame (even an empty ping-like message) to keep the connection alive.

**Concurrency cap**: max 3 concurrent sessions per `osk_` token. A 4th connection is refused pre-upgrade with `429` and `X-Auth-Reason: too_many_connections`.

**Backpressure**: if your client falls behind (server-side `bufferedAmount > 1 MB`), the server emits `{"type":"backpressure_pause"}` and stops relaying agent frames to you until the buffer drains below 256 KB, at which point it emits `{"type":"backpressure_resume"}`. Frames are dropped while paused (not queued).

**Messages** (JSON):
```json
// Send to agent
{ "type": "chat", "text": "What's the server status?" }
{ "type": "abort" }

// Receive from agent
{ "type": "status",  "agent_connected": true }
{ "type": "text",    "text": "All systems …" }
{ "type": "tool_use","name": "system_query" }
{ "type": "tool_result" }
{ "type": "done" }
{ "type": "error",   "code": "…",  "text": "…" }
{ "type": "backpressure_pause"  }
{ "type": "backpressure_resume" }
```

**Close codes**:
| Code | Meaning |
|---|---|
| 1000 | Normal close |
| 4001 | Unauthorized (missing / malformed token) |
| 4003 | Idle timeout |
| 4008 | (reserved for concurrency — today concurrency is rejected pre-upgrade via 429) |

---

## Order status enum

Every status response carries `status`. Possible values:

| `status` | Meaning | Set by |
|---|---|---|
| `pending` | Order created but server not yet provisioned (e.g. payment in flight) | spawn endpoint pre-Hetzner |
| `provisioning` | Hetzner returned the box; cloud-init + install.sh running | spawn endpoint post-Hetzner |
| `running` | Server up + at least one heartbeat received → setup complete | first heartbeat from spawned server |
| `install_failed` | Install died OR no heartbeat in 25 min | `/api/provision-failed` callback OR install-watchdog cron |
| `failed` | Pre-Hetzner failure (e.g. quota, regional outage) | spawn endpoint on Hetzner error |
| `deleted` | Server deleted (operator action OR Hetzner-side gone OR refunded order) | DELETE `/api/dashboard/servers/:id` OR cleanup script |

**When `status=install_failed`**, the full status response also carries an `install_error` object:

```json
{
  "step": "build",
  "reason": "Install exited with code 137 at phase build",
  "log_tail": "...last 200 lines of /var/log/osmoda-cloud-init.log...",
  "at": "2026-04-29T01:46:25Z",
  "watchdog": false
}
```

`watchdog: true` means the spawn-side install-timeout cron flagged it (no callback received in 25 min). `watchdog: false` means install.sh's EXIT trap explicitly posted `/api/provision-failed`. `log_tail` is only populated for the explicit-callback case.

---

## Server-side callbacks (NOT for API integrators)

These three endpoints are called BY the spawned server (`install.sh` / `agentd` running inside the customer's box), NOT by external API integrators. Documented here so self-hosted operators understand the contract; you do not need to implement these unless you are building your own callback receiver.

| Endpoint | Caller | Auth | Purpose |
|---|---|---|---|
| `POST /api/heartbeat` | `agentd` on the spawned server, every 60s | `X-Heartbeat-Secret` header (per-order secret minted at spawn) | Health + agent count + daemon state. Triggers status flip from `provisioning` → `running` on first call. |
| `POST /api/provision-progress` | `install.sh` at every phase transition | same | Records into `provision_steps[]` for the dashboard install-progress UI. `status="error"` flips order to `install_failed`. |
| `POST /api/provision-failed` | `install.sh`'s EXIT trap on fatal failure | same | Carries `step` + `reason` + `log_tail` (200 lines). Order flips to `install_failed` with full diagnostic context. Won't fire on kernel-SIGKILL failures (e.g. nixos-infect mid-reboot) — for that class, the spawn-side install-watchdog cron flags the order at the 25-min mark instead. |

**Watchdog**: an internal cron on spawn flags any order where `status=running, no heartbeat ever, age > 25 min` as `install_failed` with `install_error.watchdog=true, step=no_callback`. This ensures customers never sit in eternal "Installing..." even if both `install.sh` callbacks fail.

Full schemas in the [OpenAPI spec](https://spawn.os.moda/api/v1/docs).

---

## Authentication

The v1 API uses **two auth mechanisms**:

1. **x402 payment** — for spawn endpoints. The `@x402/express` middleware handles this automatically. You pay once per spawn, and the facilitator settles on-chain.

2. **Bearer token** — for post-spawn operations. The `osk_` token returned in the spawn response authenticates status checks, token management, and WebSocket connections.

No API keys. No accounts. No sessions. No cookies. Pay and go.

### Token lifecycle

Every `osk_` token has metadata: `token_id`, `created_at`, `expires_at` (default 1 year), and `revoked_at`. The `token_id` is the first 16 hex chars of the token's SHA-256 hash — safe to log.

- **Inspect**: `GET /api/v1/tokens/:token_id` with the token as Bearer. Returns metadata; only the token itself can read its own metadata.
- **Revoke**: `DELETE /api/v1/tokens/:token_id` with the token as Bearer. Returns `204`; subsequent calls with the revoked token return `401 token_revoked`.
- Expired tokens return `401 token_expired`.

Legacy tokens issued before v1.1.0 are lazily assigned a 1-year expiry on first use — no action required.

---

## Idempotency

`POST /api/v1/spawn/:planId` is safe to retry. Send a client-generated `Idempotency-Key` header (16–128 chars, `[A-Za-z0-9_-]`). The pre-check runs **before** x402 payment middleware, so a retry with a cached key short-circuits without being asked to pay again.

- **Same key + same body** → replays the original response byte-for-byte, with header `Idempotent-Replayed: true`. TTL: 24 hours.
- **Same key + different body** → `409 idempotency_key_reused`.
- **No header** → behavior unchanged.

Failed spawns are **not** cached, so you can safely retry after provisioning errors (with a new payment).

```bash
curl -X POST https://spawn.os.moda/api/v1/spawn/starter \
  -H "Idempotency-Key: $(date +%Y-%m-%d)-myapp-$(openssl rand -hex 4)" \
  -H "Content-Type: application/json" \
  -d '{"region":"eu-central"}'
```

---

## Request IDs

Every response — success or error — carries `X-Request-Id: req_<ulid>`. The same ID appears in server logs for any given request. Include it when asking for support.

You can also **send** `X-Request-Id` on a request; if it matches `[A-Za-z0-9_-]{8,64}` the server echoes it back instead of generating one.

---

## Rate limits

| Bucket | Limit | Notes |
|---|---|---|
| Per-IP, free endpoints (`/plans`, `/status`, `/docs`, `/tokens`, agent card) | 30 req/min | Always on |
| Per-IP, spawn | 5 req/min | Always on |
| Per-token, spawn | 10 req/hour | Applies when `Authorization: Bearer osk_…` is present on spawn |
| Per-token, status | 120 req/min | Applies on the Bearer-authenticated path only |
| WebSocket chat, per-token | 3 concurrent sessions | 4th is rejected pre-upgrade with `429 + X-Auth-Reason: too_many_connections` |

All `429` responses include a `Retry-After` header (seconds) and the structured `rate_limited` error code.

---

## Error responses

Every error returns the same envelope:

```json
{
  "code": "plan_not_found",
  "message": "Unknown plan: foo.",
  "detail": { "planId": "foo" },
  "request_id": "req_01JAXYZABC...",
  "error": "plan_not_found"
}
```

- `code` — machine-readable, stable. Match against this field.
- `message` — human-readable, may change wording between releases.
- `detail` — optional endpoint-specific diagnostic fields.
- `request_id` — echoes the `X-Request-Id` response header.
- `error` — **legacy alias for `code`**, kept for one release for older clients. New integrations should read `code`.

### Canonical error codes

| Code | HTTP | Where |
|---|---|---|
| `validation_failed` | 400 | bad order ID, bad token_id format |
| `invalid_idempotency_key` | 400 | header fails 16–128 char / charset regex |
| `idempotency_key_reused` | 409 | same key, different body |
| `plan_not_found` | 404 | unknown planId |
| `order_not_found` | 404 | no such orderId |
| `unauthorized` | 401 | missing / malformed Bearer |
| `token_expired` | 401 | `expires_at` in the past |
| `token_revoked` | 401 | `revoked_at` set |
| `forbidden` | 403 | valid token, wrong resource |
| `rate_limited` | 429 | includes `Retry-After` |
| `provisioning_failed` | 500 | Hetzner/cloud-init error (detail has reason) |
| `internal_error` | 500 | anything unexpected |
| `service_unavailable` | 503 | x402 middleware offline, HETZNER_TOKEN missing |
| Payment-required envelope | 402 | x402 — `{x402Version, error, accepts[]}`, not the Error shape above |

### HTTP status summary

| Status | Meaning |
|--------|---------|
| 400 | Validation failed |
| 401 | Missing / expired / revoked token |
| 402 | Payment required (x402 — payment requirements in body) |
| 403 | Valid token, wrong resource |
| 404 | Order or plan not found |
| 409 | Idempotency-Key reused with different body |
| 429 | Rate limited — honor `Retry-After` |
| 500 | Server error (provisioning failed, internal error) |
| 503 | Service unavailable (payment system not active, provisioner offline) |

---

## For agent developers

### Using x402 fetch wrapper

The simplest way to interact with the API from an agent:

```typescript
import { withPayment } from "@x402/fetch";

// Wrap fetch with x402 — handles 402 automatically
const fetch402 = withPayment(fetch, {
  wallet: yourWallet,  // viem wallet client with USDC approval
});

// Spawn a server — payment is automatic
const res = await fetch402("https://spawn.os.moda/api/v1/spawn/test", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    region: "eu-central",
    ai_provider: "anthropic",
    api_key: "sk-ant-...",
  }),
});
const data = await res.json();
console.log(data.server_ip, data.api_token);
```

### Using Coinbase CDP SDK

```typescript
import { CdpClient } from "@coinbase/cdp-sdk";

const cdp = new CdpClient();
const account = await cdp.evm.createAccount();

// Fund account with USDC on Base...

const res = await cdp.evm.sendTransaction({
  // x402 handles this automatically through the facilitator
});
```

### Polling for server ready

```typescript
async function waitForServer(orderId, apiToken) {
  while (true) {
    const res = await fetch(`https://spawn.os.moda/api/v1/status/${orderId}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    const data = await res.json();
    if (data.status === "running") return data;
    if (data.status === "failed") throw new Error("Server failed");
    await new Promise(r => setTimeout(r, 15000)); // poll every 15s
  }
}
```

### WebSocket chat from Node.js

```typescript
import WebSocket from "ws";

const ws = new WebSocket(
  `wss://spawn.os.moda/api/v1/chat/${orderId}?token=${apiToken}`
);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "message", text: "Deploy a Python API on port 8080" }));
});

ws.on("message", (data) => {
  const msg = JSON.parse(data);
  if (msg.type === "message") console.log("Agent:", msg.text);
});
```

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ETH_WALLET` | Yes* | Base (EVM) receiving wallet address for USDC payments |
| `SOL_WALLET` | Yes* | Solana (SVM) receiving wallet address for USDC payments |
| `NETWORK_MODE` | No | `testnet` (default) or `mainnet` |
| `X402_FACILITATOR_URL` | No | Custom facilitator URL (defaults based on NETWORK_MODE) |
| `HETZNER_TOKEN` | Yes | Hetzner Cloud API token for server provisioning |

*At least one of `ETH_WALLET` or `SOL_WALLET` is required. Both can be set for dual-chain support.

---

## Existing flows unchanged

The v1 API is a separate Express Router. These are completely untouched:

- `POST /api/spawn` (dashboard crypto flow)
- Stripe checkout + webhooks
- Session cookie auth + magic links
- Heartbeat system
- Dashboard WebSocket (`/api/ws/dash`, `/api/ws/agent`)
- Admin panel

---

## Agent Card schema

The agent card at `/.well-known/agent-card.json` follows the A2A / ERC-8004 pattern:

```json
{
  "name": "osModa Spawn",
  "description": "Spawn dedicated AI-managed servers...",
  "url": "https://spawn.os.moda",
  "version": "1.2.3",
  "protocols": ["A2A/1.0", "ERC-8004"],
  "protocol": "A2A",
  "capabilities": {
    "x402": true,
    "streaming": true,
    "websocket": true,
    "modular_runtime": true,
    "oauth_credentials": true,
    "idempotency": true,
    "token_lifecycle": true,
    "structured_errors": true,
    "install_failure_visibility": true,
    "install_watchdog_minutes": 25,
    "provision_progress_callbacks": true,
    "spec_driven_development": true,
    "spec_kit_version": "v0.8.4",
    "network_mode": "testnet"
  },
  "runtimes": [
    {
      "name": "claude-code",
      "display_name": "Claude Code",
      "recommended": true,
      "supported_auth_types": ["oauth", "api_key"],
      "default_models": ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"],
      "description": "Anthropic's official Claude CLI. Accepts OAuth (Claude Pro / Max) + API key."
    },
    {
      "name": "openclaw",
      "display_name": "OpenClaw",
      "supported_auth_types": ["api_key"],
      "default_models": ["claude-sonnet-4-6"],
      "description": "OpenClaw multi-runtime CLI (BYOK). API key only — does not accept OAuth."
    }
  ],
  "skills": [
    {
      "id": "spawn-test",
      "name": "Spawn Solo Server",
      "description": "1 agent, light tasks — 2 vCPU, 4GB RAM, 40GB SSD",
      "endpoint": "https://spawn.os.moda/api/v1/spawn/test",
      "method": "POST",
      "price": {
        "amount": "$14.99",
        "currency": "USDC",
        "protocol": "x402",
        "accepts": [
          { "network": "eip155:8453", "chainId": 8453,          "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "payTo": "0x..." },
          { "network": "solana:5eyk…", "chainId": "mainnet-beta", "asset": "EPjF…",                                      "payTo": "DFbW..." }
        ]
      },
      "inputSchema": { "...includes runtime / default_model / credentials..." },
      "outputSchema": { "..." }
    }
  ],
  "payment": {
    "protocol": "x402",
    "accepts": [
      { "network": "eip155:8453", "chainId": 8453,          "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "payTo": "0x..." },
      { "network": "solana:5eyk…", "chainId": "mainnet-beta", "asset": "EPjF…",                                      "payTo": "DFbW..." }
    ]
  },
  "endpoints": {
    "plans":             "https://spawn.os.moda/api/v1/plans",
    "docs":              "https://spawn.os.moda/api/v1/docs",
    "status":            "https://spawn.os.moda/api/v1/status/{orderId}",
    "tokens":            "https://spawn.os.moda/api/v1/tokens/{token_id}",
    "chat":              "wss://spawn.os.moda/api/v1/chat/{orderId}",
    "spec_kit_projects": "https://spawn.os.moda/api/v1/spec-kit/projects"
  }
}
```

**`runtimes[].supported_auth_types`** is the source of truth for credential compatibility. An OAuth credential bound to an `openclaw` agent is rejected at the customer-server gateway with a structured error; the dashboard Engine tab and the `@osmoda/client` SDK both perform the same check client-side for early feedback.

---

## Daydreams Taskmarket listing

After deploy, register on the Daydreams Taskmarket for agent discovery:

```bash
# Install CLI
npm install -g @lucid-agents/taskmarket

# Register identity (uses agent card)
taskmarket register --url https://spawn.os.moda

# Create service listing
taskmarket list-service \
  --name "osModa Server Spawn" \
  --description "Dedicated AI-managed NixOS servers" \
  --agent-card https://spawn.os.moda/.well-known/agent-card.json

# Verify listing
taskmarket search "server spawn"
```

The agent card at the well-known URL enables automatic discovery by any Daydreams, Lucid, or A2A-compatible agent.

---

## Security notes

- **API tokens**: Generated with `crypto.randomBytes(32)`. Stored as SHA-256 hash (never raw). Shown once at spawn time. 1-year default TTL (`TOKEN_DEFAULT_TTL_DAYS`). Revocable via `DELETE /api/v1/tokens/:token_id`.
- **Token metadata store**: `apps/spawn/data/tokens.enc` — AES-256-GCM, same pattern as orders/sessions.
- **Token ID**: first 16 hex chars of the SHA-256 token hash — safe to log, used as the public identifier in the `/tokens/:token_id` URL.
- **Token comparison**: Timing-safe (`crypto.timingSafeEqual` on hashes).
- **Rate limiting**: Per-IP floor on every endpoint; per-token quotas on spawn (10/h) and status (120/min) when `Bearer osk_…` is present.
- **WebSocket hardening**: 30 s heartbeat, 10 min idle close, enforced backpressure (drops frames to paused clients), 3-session cap per token.
- **Input validation**: SSH keys regex-checked, AI provider allowlisted, API keys max 256 chars, order IDs UUID-format validated.
- **Idempotency**: `Idempotency-Key` pre-check runs **before** x402 payment middleware, so retries never re-pay.
- **x402 guard**: If `@x402/express` middleware fails to initialize, spawn endpoints return 503 (no unpaid spawns possible).
- **No email required**: API orders are anonymous. No user account created.
- **API keys**: Passed to server via cloud-init, then deleted from order record.

---

## Network details

| Mode | Chain | Chain ID / Cluster | CAIP-2 | USDC Contract | Facilitator |
|------|-------|-------------------|--------|---------------|-------------|
| testnet | Base Sepolia | 84532 | eip155:84532 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | x402.org/facilitator |
| mainnet | Base | 8453 | eip155:8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | x402.org/facilitator |
| testnet | Solana Devnet | devnet | solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | x402.org/facilitator |
| mainnet | Solana | mainnet-beta | solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | x402.org/facilitator |
