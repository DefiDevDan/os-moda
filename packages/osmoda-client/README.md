# @osmoda/client

First-party TypeScript client for the [osModa Spawn API](https://spawn.os.moda) — currently v1.2.7.

> The SDK wraps the v1 `osk_` Bearer surface (spawn → status → tokens → spec-kit). The dashboard `sk_live_` surface — SSE streaming chat (v1.2.5) and managed agent restart (v1.2.6) — is intentionally not wrapped. SSE is browser-native via `EventSource`, and restart is a tiny POST/GET pair. See `docs/SPAWN-API.md` for reference clients of both.

## Install

```bash
npm install @osmoda/client
```

Works in Node ≥18 and modern browsers (uses global `fetch` and Web Crypto).

## Quick start

```ts
import { OsmodaClient, OsmodaApiError, isAuthTypeCompatible } from "@osmoda/client";

const client = new OsmodaClient();

// Free: list plans.
const { plans, regions } = await client.listPlans();

// Spawn (x402-gated — wrap fetch yourself, e.g. with @x402/fetch):
const paidClient = new OsmodaClient({
  fetcher: withPayment(fetch, { wallet }),
});

const idempotencyKey = `myapp-${Date.now()}-${crypto.randomUUID()}`;
const spawn = await paidClient.spawn("starter", {
  region: "eu-central",
  runtime: "claude-code",                  // v1.2+ modular runtime
  default_model: "claude-opus-4-7",        // newest Anthropic Opus
  credentials: [
    { label: "My Claude Pro", provider: "anthropic", type: "oauth",   secret: "sk-ant-oat01-…" },
    { label: "Fallback API",  provider: "anthropic", type: "api_key", secret: "sk-ant-api03-…" },
  ],
}, {
  idempotencyKey,                          // safe to retry — same key returns same server
});

const bearerClient = new OsmodaClient({ bearer: spawn.api_token });
const server = await bearerClient.waitForRunning(spawn.order_id);
console.log(server.server_ip, server.chat_url);

// v1.2.2: list spec-driven projects on the spawned server.
const { projects } = await bearerClient.specKitProjects();
```

## Modular runtime + auth-type gating

OAuth tokens (`sk-ant-oat01-…`) only work with the `claude-code` runtime.
OpenClaw uses API keys only. Validate on the client before binding a credential
to an agent:

```ts
const reason = isAuthTypeCompatible("openclaw", "oauth");
// → 'Runtime "openclaw" does not accept "oauth" credentials. Supported: api_key.'
```

The agent card at `/.well-known/agent-card.json` is the source of truth:
`runtimes[].supported_auth_types`.

## Polling install progress

Every full-status response carries `provision_steps[]` with phase-by-phase
detail — drive an install-progress UI directly from it:

```ts
const s = await bearerClient.statusFull(orderId);
for (const step of s.provision_steps ?? []) {
  console.log(`[${step.status}] ${step.step}: ${step.detail}`);
}
```

`waitForRunning` already throws an `OsmodaApiError` on `install_failed` with
`install_error` surfaced in `error.detail` — including `log_tail` when an
explicit `/api/provision-failed` callback fired.

## Error handling

Every non-2xx response becomes an `OsmodaApiError` with the structured fields
from the server envelope:

```ts
try {
  await client.spawn("starter", body, { idempotencyKey });
} catch (e) {
  if (e instanceof OsmodaApiError) {
    console.error(e.code, e.message, e.requestId, e.retryAfterSeconds);
  }
}
```

Canonical `code` values (stable across minor versions):
`validation_failed`, `invalid_idempotency_key`, `idempotency_key_reused`,
`plan_not_found`, `order_not_found`, `unauthorized`, `token_expired`,
`token_revoked`, `forbidden`, `rate_limited`, `provisioning_failed`,
`install_failed`, `internal_error`, `service_unavailable`.

## Token lifecycle

```ts
import { tokenIdFromToken } from "@osmoda/client";

const client = new OsmodaClient({ bearer: spawn.api_token });
const tokenId = await tokenIdFromToken(spawn.api_token);

const meta = await client.getToken(tokenId);
console.log(meta.expires_at);

await client.revokeToken(tokenId); // 204, token is dead
```

## WebSocket

The chat endpoint is a plain WebSocket at
`wss://spawn.os.moda/api/v1/chat/{orderId}?token=osk_...` — use the runtime's
`WebSocket` (browser or `ws` on Node). This SDK intentionally does not wrap it,
to avoid pulling `ws` into your bundle.

```ts
const ws = new WebSocket(`${server.chat_url}?token=${spawn.api_token}`);
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ type: "chat", text: "Deploy a Python API on port 8080" }));
});
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  // type: 'status' | 'text' | 'tool_use' | 'tool_result' | 'done' | 'error'
  //     | 'backpressure_pause' | 'backpressure_resume'
});
```

Frame protocol, close codes, idle timeout, and backpressure semantics live
in the `x-websocket` extension at the bottom of `/api/v1/docs`. See also
[docs/SPAWN-API.md](../../docs/SPAWN-API.md).

## What v1 does **not** expose

- Server termination via Bearer (dashboard-only at `/api/dashboard/...`).
- Post-spawn agent/credential config via Bearer (cookie-authed dashboard only).
- Webhooks (poll `/status/{orderId}` instead).
- Listing all servers a token owns (each token is scoped to one order).

## Relationship to the OpenAPI spec

This SDK is handwritten to match `GET /api/v1/docs`. It is **not** generated
— by design. It serves as a compile-time regression check: if the runtime
drifts from the types here, the OpenAPI spec is wrong and must be fixed to
match reality.

Version is kept in lockstep with `info.version` in the OpenAPI spec and
`version` in the Agent Card.
