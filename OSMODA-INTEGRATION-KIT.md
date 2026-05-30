# osmoda-integration-kit — design draft

> **Status: DRAFT for review. Nothing here is built yet.** This document proposes
> the repo structure, the README a developer would land on, and the SDK/codegen
> spec. React / redline before we scaffold.

Goal: let any developer drop a **spawnable osModa AI agent** into their app in
minutes — spawn a dedicated agent server, pay with USDC (x402), and chat with it
over WebSocket — without hand-wiring HTTP, payments, or reconnect logic.

Modeled on the `proxy-reseller-kit` pattern: a **kit** = typed SDK + payment
helper + ready-to-fork examples, not just docs.

The one rule that keeps it honest: **the SDK core is generated from the live
OpenAPI spec** (`https://spawn.os.moda/api/v1/docs`), so it can never silently
drift from the deployed backend — the exact problem we just audited.

---

## 1. Repo structure

```
osmoda-integration-kit/
├── README.md                      # the landing page drafted in §2
├── LICENSE                        # Apache-2.0 (matches bolivian-peru/os-moda)
├── package.json                   # pnpm workspace root
├── pnpm-workspace.yaml
├── .github/
│   └── workflows/
│       ├── ci.yml                 # build + typecheck + test all packages
│       └── openapi-sync.yml       # nightly: re-fetch /api/v1/docs, regen client,
│                                  #   fail CI if generated/ drifts (keeps SDK ⇄ prod in sync)
│
├── packages/
│   ├── sdk/                       # @osmoda/sdk  (TypeScript, the core deliverable)
│   │   ├── src/
│   │   │   ├── generated/         # OpenAPI codegen output — DO NOT EDIT BY HAND
│   │   │   │   ├── types.ts       #   request/response types from the spec
│   │   │   │   └── paths.ts
│   │   │   ├── client.ts          # OsmodaClient — ergonomic wrapper over generated core
│   │   │   ├── spawn.ts           # spawn() + spawnAndWait() + idempotency
│   │   │   ├── x402.ts            # USDC payment helper (Base / Solana), optional peer dep
│   │   │   ├── chat.ts            # ChatSession — WS client: auth, 30s heartbeat,
│   │   │   │                      #   10m idle, backpressure pause/resume, auto-reconnect
│   │   │   ├── events.ts          # EventStream — SSE client, cursor-resumable
│   │   │   ├── errors.ts          # OsmodaError — typed {code,message,detail,request_id}
│   │   │   ├── tokens.ts          # token get/revoke
│   │   │   └── index.ts
│   │   ├── scripts/
│   │   │   └── codegen.ts         # fetch live OpenAPI → regenerate src/generated/
│   │   ├── test/
│   │   ├── package.json
│   │   └── README.md              # npm-facing short readme
│   │
│   └── sdk-py/                    # osmoda (Python) — PHASE 2, same shape, codegen from spec
│
├── examples/
│   ├── nextjs-spawn-chat/         # full app: pay → spawn → live chat UI (App Router)
│   ├── langchain-tool/            # OsmodaSpawnTool — give a LangChain agent the power
│   │                              #   to spin up its own osModa server and delegate work
│   ├── crewai-tool/               # same idea for CrewAI
│   ├── mcp-server/                # expose osModa spawn/chat as MCP tools to any MCP client
│   └── cli/                       # `npx @osmoda/cli spawn starter` then interactive chat
│
├── docs/
│   ├── quickstart.md
│   ├── auth-and-payments.md       # osk_ tokens, x402 (Base/Solana), quotas, idempotency
│   ├── chat-streaming.md          # WS chat + SSE events, reconnect/backpressure semantics
│   ├── errors.md                  # uniform error envelope, X-Request-Id, 429/Retry-After
│   └── recipes.md                 # copy-paste patterns per use case
│
└── spec/
    └── openapi.json               # vendored snapshot; SOURCE OF TRUTH is the live /api/v1/docs
```

Design choices:
- **pnpm workspace monorepo** so SDK + examples + (later) Python live together and
  examples always build against the local SDK.
- **`generated/` is committed but never hand-edited**; `openapi-sync.yml` regenerates
  it nightly and **fails CI on drift**, so the published SDK always matches prod.
- Examples are **fork-and-run**, each with its own README + `.env.example`.

---

## 2. README.md (draft of the landing page)

````markdown
# @osmoda/sdk — spawn AI agents into your app

Spin up a dedicated, root-capable AI agent server in minutes, pay per spawn in
USDC, and chat with it over WebSocket. One npm install, ~5 lines.

> Powered by [osModa](https://github.com/bolivian-peru/os-moda) — a NixOS distro
> where an AI agent has full system access (92 tools, audit ledger, atomic
> rollback). The hosted API lives at https://spawn.os.moda.

## Install

```bash
npm install @osmoda/sdk
# optional, only if you let the SDK pay for spawns automatically:
npm install @osmoda/sdk @x402/core @x402/evm   # or @x402/solana
```

## 30-second quickstart

```ts
import { OsmodaClient } from "@osmoda/sdk";

const osmoda = new OsmodaClient();           // defaults to https://spawn.os.moda

// 1. Browse plans (free, no auth)
const plans = await osmoda.plans.list();

// 2. Spawn a server. Returns an osk_ token + orderId.
//    Pays the x402 invoice automatically if you pass a wallet; otherwise it
//    returns the 402 payment requirements for you to handle.
const { orderId, token } = await osmoda.spawn("starter", {
  wallet: myWallet,                          // viem/solana signer (optional)
  runtime: "claude-code",                    // or "openclaw"
  credentials: [{ provider: "anthropic", type: "api_key", secret: process.env.ANTHROPIC_KEY }],
  idempotencyKey: "order-42",                // safe retries, 24h cache
});

// 3. Wait until the agent is live (polls status with backoff)
await osmoda.waitUntilReady(orderId, { token });

// 4. Chat — streaming, auto-reconnecting
const chat = osmoda.chat(orderId, { token });
chat.on("text", (delta) => process.stdout.write(delta));
chat.on("tool", (t) => console.log(`\n[${t.name} ${t.target ?? ""}]`));
chat.on("done", () => console.log("\n— done"));
await chat.send("Deploy a Next.js app on port 3000 bound to localhost and report the URL.");
```

## What you get

| Capability | SDK surface |
|---|---|
| List plans | `osmoda.plans.list()` |
| Spawn a server (x402-gated) | `osmoda.spawn(planId, opts)` / `osmoda.spawnAndWait(...)` |
| Poll status | `osmoda.status(orderId)` · `osmoda.waitUntilReady(orderId)` |
| Live chat (WebSocket) | `osmoda.chat(orderId)` → `.send()`, events: `text·tool·tool_result·done·error` |
| Server event stream (SSE) | `osmoda.events(orderId)` — request lifecycle, wedge/heal, install progress |
| Chat history | `osmoda.history(orderId)` |
| Token management | `osmoda.tokens.get(id)` · `osmoda.tokens.revoke(id)` |
| Restart a wedged agent | `osmoda.restartAgent(orderId, agentId)` |
| Deliver / rotate a credential | `osmoda.setApiKey(orderId, credential)` |
| Spec-kit projects | `osmoda.specKitProjects(orderId)` |
| Agent Card (A2A / ERC-8004) | `osmoda.agentCard()` |

Every response carries an `X-Request-Id`; errors throw a typed `OsmodaError`
(`code`, `message`, `detail?`, `requestId`). `429`s surface `retryAfter`.

## Auth & payments

- **Spawning** is gated by [x402](https://x402.org) — USDC on Base or Solana.
  Pass a `wallet` and the SDK pays the invoice and retries automatically; omit it
  and `spawn()` throws `OsmodaPaymentRequired` with the invoice so you can pay
  your own way.
- **Everything after spawn** uses the returned `osk_` Bearer token. Per-token
  quotas: spawn 10/h, status 120/min.

See [`docs/auth-and-payments.md`](docs/auth-and-payments.md).

## Examples

- [`examples/nextjs-spawn-chat`](examples/nextjs-spawn-chat) — full web app: pay → spawn → chat UI
- [`examples/langchain-tool`](examples/langchain-tool) — give a LangChain agent a tool to spawn & delegate to its own osModa box
- [`examples/crewai-tool`](examples/crewai-tool) — same for CrewAI
- [`examples/mcp-server`](examples/mcp-server) — expose spawn/chat as MCP tools to any MCP client
- [`examples/cli`](examples/cli) — `npx @osmoda/cli spawn starter` then an interactive chat

## Staying in sync

The typed core in `src/generated/` is **generated from the live OpenAPI spec**
(`https://spawn.os.moda/api/v1/docs`). CI regenerates it nightly and fails on
drift, so the SDK can never fall behind the deployed backend.

## License

Apache-2.0.
````

---

## 3. SDK / codegen spec

### 3.1 Two layers
1. **Generated core** (`src/generated/`) — types + low-level path callers produced
   by `openapi-typescript` (+ a tiny typed fetch wrapper). Regenerated from the
   spec; never edited by hand. This is what guarantees prod-sync.
2. **Ergonomic layer** (`client.ts`, `chat.ts`, …) — hand-written, thin, stable.
   Wraps the generated core with the things an OpenAPI client can't express well:
   - x402 payment dance (402 → pay → retry with payment header)
   - WebSocket chat lifecycle (auth via `?token=`, 30 s heartbeat, 10 m idle close
     code `4003`, max 3 sessions/token, `backpressure_pause`/`resume`, reconnect
     with replay)
   - SSE event stream (cursor-resumable, 15 s keepalive)
   - `waitUntilReady()` polling with backoff that respects `Retry-After`
   - error normalization into `OsmodaError`

### 3.2 Versioning
- SDK major.minor tracks the **API contract version** reported by the spec
  (`info.version`). Patch = SDK-only fixes.
- `OsmodaClient` sends an `X-Osmoda-Sdk: ts/<version>` header so we can see SDK
  adoption in request logs.
- (Note: today the spec's `info.version` is `1.3.6`; reconciling the version
  labels across the backend/docs is a prerequisite — tracked separately.)

### 3.3 x402 handling
- `@x402/*` packages are **optional peer deps**. Without a wallet, every free
  endpoint works and `spawn()` returns the invoice instead of paying. With a
  wallet, the SDK handles 402 → pay → retry transparently. This mirrors the
  backend's graceful x402 fallback.

### 3.4 Transport defaults
- Base URL default `https://spawn.os.moda`, override via `new OsmodaClient({ baseUrl })`.
- Node 18+ (global `fetch`/`WebSocket`) and modern browsers; `ws` polyfill only
  where needed.

### 3.5 What ships in v0.1 (proposed scope)
- Generated types + the ergonomic `OsmodaClient` covering all 15 v1 routes.
- `ChatSession` + `EventStream`.
- x402 helper for Base (Solana behind the same interface, phase 1.1).
- Examples: `cli` + `nextjs-spawn-chat` + `langchain-tool`.
- `openapi-sync.yml` drift gate.
- Python SDK and the remaining examples follow in v0.2.

---

## 4. Open questions for you

1. **Names** — repo `osmoda-integration-kit`, npm scope `@osmoda/*`? (Is the
   `@osmoda` org available on npm?)
2. **License** — Apache-2.0 to match the main repo? (proxy-reseller-kit uses … ?)
3. **Where it lives** — its own GitHub repo (recommended, clean for `npm`/stars),
   or a `kit/` folder in `bolivian-peru/os-moda`?
4. **First example to nail** — I'd lead with the **LangChain/CrewAI "agent spawns
   its own agent" tool**, since the A2A / agent-card framing is the most novel and
   on-brand. Agree, or lead with the Next.js app?
5. **Prereq** — reconcile the API version labels first (the `1.3.6` vs `1.3.36`
   drift) so the SDK has one true version to track?
```
