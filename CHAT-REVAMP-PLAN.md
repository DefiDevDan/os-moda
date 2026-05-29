# Chat revamp plan — port the `agentic-chat-interface` skill to osModa

> Status: **PLAN for review.** Nothing built yet. Target: the server chat at
> `https://spawn.os.moda/#/servers/:id/chat`. Reference: the user's
> `agentic-chat-interface` skill (LIRR `/paieska`). Goal: streaming, Manus-like
> live tool timeline, real stop/abort, graceful errors, no glitches.

## 0. Why it's broken today (grounded diagnosis)

| Symptom | Root cause (verified this session) |
|---|---|
| **No streaming** | OpenClaw is now the executive runtime. `openclaw agent --local --json` returns **one final JSON blob** — no `--stream`/`--ndjson` flag exists. The driver (`packages/osmoda-gateway/src/drivers/openclaw.ts`) accumulates stdout and yields a single `text` at the end. So the reply "appears all at once." (claude-code DID stream; openclaw does not.) |
| **No live action follow** | Same cause — tool calls happen inside the buffered run; the UI never sees `tool_use`/`tool_result` until (or never) the end. |
| **Glitches / double-render** | Dashboard mixes three render paths (WS live, gateway-transcript replay, chat-state poller) with ad-hoc turn mutation. No single state model. We patched dedup + boundary divider but the architecture is still fragile. |
| **Can't stop** | The Stop button sends `{type:"abort"}` but: (a) on openclaw the run is one blocking exec so abort kills the process but the UI doesn't reconcile; (b) no AbortController-style guarantee the front-end stops rendering. |
| **No error displays** | Error frames exist (`agent_silent`, `gateway_wedged`, the new `credential_cooldown`/`credential_exhausted`) but rendering is inconsistent and some are swallowed. |

**The skill's central thesis is exactly the fix:** decouple front-end and
backend with ONE well-defined event contract. Define it once; make every
runtime emit it; make one front-end consume it.

## 1. Key architectural decisions (please react)

1. **Keep WebSocket transport, not SSE.** The skill is SSE (POST→stream).
   osModa chat is a WS relay chain (browser ↔ spawn-app ↔ customer ws-relay ↔
   gateway `/ws` ↔ driver). WS already gives us bidirectional send + abort over
   one socket and the relay is built around it. We adopt the skill's **event
   contract, consume-loop discipline, and components** — but over WS frames, not
   `event:`/`data:` lines. (Skill §7 explicitly invites this when the situation
   differs.) The portable win is the *contract*, not the wire format.

2. **Make OpenClaw stream by tailing its trajectory file.** The embedded run
   writes `/root/.openclaw/agents/<id>/sessions/<session-id>.trajectory.jsonl`
   incrementally (verified: grows live during a run, one event per line). The
   openclaw driver will `fs.watch`/poll-tail that file during the run and emit
   our contract events as lines appear: `toolCall`→`tool_use`,
   `toolResult`→`tool_result`, `assistant` text→`text` deltas, `model.completed`
   /`session.ended`→`done`. The final `--json` stays the authoritative answer
   for de-dup. (Alternative considered: OpenClaw ACP protocol — deeper, deferred.)

3. **Adopt the skill's two-text-channel model.** `interim_text` (planning /
   reasoning between tool calls, collapsible) vs `text` (final answer, clean
   bubble) + `interim_commit_final` de-dup. New for osModa; the trajectory's
   interleaved assistant-text-then-toolCall structure maps cleanly.

4. **Single front-end state model.** Replace the three ad-hoc render paths with
   one in-memory `turn` accumulator (status, interimText, finalText, toolCalls[],
   phase) flushed once per event — mutate locals, flush once (skill §2 + §8). The
   gateway canonical transcript remains the replay source on load.

## 2. The osModa event contract (adapted from skill §1)

Emitted by the gateway driver, forwarded verbatim by the ws-relay + spawn-app,
consumed by the dashboard. WS frame: `{ type: <event>, ... }`.

| `type` | payload | UI effect |
|---|---|---|
| `status` | `{ step }` | streaming status pill text ("Thinking", "Running tools · step 2") |
| `phase` | `{ phase: "planning"\|"answering" }` | flip phase; "answering" clears pill |
| `tool_use` | `{ name, target, round }` | push step into the tool-call timeline (icon + verb + target, spinner) |
| `tool_result` | `{ name, summary, outcome }` | resolve the matching step (spinner → "→ summary") |
| `interim_text` | `{ delta }` | append to collapsible "Thinking" panel |
| `text` | `{ delta }` | append delta to the final answer bubble; clear pill |
| `text_bulk` | `{ content }` | replace final answer wholesale (openclaw final `--json`) |
| `interim_commit_final` | `{ length }` | trim promoted planning text (de-dup) |
| `error` | `{ message, code, canRetry }` | system message + retry banner if recoverable |
| `done` | `{ sessionId }` | mark turn done, collapse thinking, show ✓ chip |
| `credential_cooldown` / `credential_exhausted` | (existing) | osModa-specific banner (already added) |

claude-code mapping: it already emits text deltas + tool_use/tool_result — just
normalize into the contract + split interim vs final on tool-call boundaries.
openclaw mapping: derive from the trajectory tail (decision #2).

## 3. Backend work (the real fix — without this, no front-end matters)

- **B1. Define the contract** in `drivers/types.ts` (extend `AgentEvent` with
  `interim_text`, `text_bulk`, `interim_commit_final`, `status`, `phase`).
- **B2. openclaw driver trajectory-tail streaming.** While the `openclaw agent`
  child runs, tail the session trajectory jsonl; parse + emit contract events
  live. Keep the final `--json` as `text_bulk` (authoritative), using
  `interim_commit_final` to avoid duplicating already-streamed text.
- **B3. claude-code driver normalization.** Map its stream-json to the same
  contract; route pre-final-answer text to `interim_text`, final to `text`.
- **B4. ws-relay (`scripts/install.sh`)** forward the new event types verbatim
  (today it only translates text/tool_use/tool_result/done/error).
- **B5. spawn-app relay (`server.js`)** persist the richer events to the
  canonical transcript so replay reconstructs the timeline (already have
  target/outcome; add interim/phase).
- **B6. gateway `pipeEvent`** pass the new types through (it already forwards
  text/tool_use/tool_result/done/error/credential_*).

## 4. Front-end rebuild (port skill §2–§4 to vanilla JS)

Rebuild the `#/servers/:id/chat` view around one consume loop + one turn model.

- **F1. State model & consume loop** — `currentTurn = {status, interimText,
  finalText, toolCalls[], phase}`; one `flushTurn()` per event (skill §2/§8).
- **F2. Status pill** — ping-dot + text, shown while streaming, cleared on first
  `text` (skill §3.1).
- **F3. Collapsible Thinking timeline** — auto-expand while streaming,
  auto-collapse on answer; live-pluralised header; chevron rotate (skill §3.2).
- **F4. Tool step rows** — icon tile + numbered badge + verb→noun swap + result
  reveal + >5 overflow collapse, driven by a **`TOOL_META` registry** for
  osModa's 91 tools (system_query, shell_exec, safe_switch_*, wallet_*, …) with
  `DEFAULT_TOOL_META` fallback (skill §3.3/§3.4 — this is the main re-skin).
- **F5. Composer** — auto-grow textarea, focus ring, **Send↔Stop swap**,
  Enter/Shift+Enter, placeholder swap (skill §3.6).
- **F6. Markdown answer** — reuse/upgrade `formatChatText` to the skill's
  hand-rolled renderer (headings, ▸ bullets, tables, inline links) (skill §3.10).
- **F7. Completion chip + assistant header** (skill §3.5).
- **F8. Near-bottom-only auto-scroll** (skill §3.9 — the most-respected detail).
- **F9. Retry banner** on recoverable errors (skill §3.8).
- **F10. Welcome quick-prompts** empty state (skill §3.7).

## 5. Resilience (skill §2 — all mandatory)

- **R1. Real abort** — Stop aborts the in-flight turn AND the front-end stops
  rendering immediately; a new send aborts any in-flight one first.
- **R2. 60s stall watchdog** — per-frame timeout; on stall: abort + inject
  "took too long, retry" + arm retry.
- **R3. Error rendering for every code** — `agent_silent`, `agent_disconnected`,
  `gateway_wedged`, `gateway_unreachable`, `credential_exhausted`,
  `credential_cooldown` each get a clear message + the right CTA (retry / restart
  agent / check Engine tab).
- **R4. WS heartbeat tolerance + reconnect** (already partly present).

## 6. Phases (each independently shippable + verifiable)

1. **Backend contract + openclaw trajectory streaming (B1–B2)** — the unlock.
   Verify: a real turn on the box streams tool_use/text live into the trajectory
   tail → gateway WS frames.
2. **Relay + transcript plumbing (B4–B6, B3)** — frames reach the dashboard;
   claude-code normalized.
3. **Front-end consume loop + turn model (F1) + streaming text (F2/F6/F8)** —
   text streams smoothly again.
4. **Tool timeline + TOOL_META (F3/F4) + thinking channel** — Manus feel.
5. **Composer + abort + retry + errors (F5/R1–R3) + completion (F7/F9/F10)**.
6. **Replay parity** — `loadDashChatHistory` reconstructs the new timeline from
   the canonical transcript.

## 7. Deviations from the skill (with rationale — skill §7)

- **WS, not SSE** — osModa's relay chain + bidirectional send/abort. Contract
  preserved; wire format differs.
- **openclaw streaming via trajectory-tail** — the CLI has no stream flag; the
  trajectory jsonl is the only live source. claude-code streams natively.
- **Persistence is the gateway canonical transcript**, not localStorage — already
  built; replay reads it.

## 8. Open questions for the user
1. Your "here some ideas -" list didn't come through — paste it; I'll fold in.
2. OK to keep WS transport (vs rewriting chat to SSE)? (Recommend keep.)
3. Scope: full rebuild of the chat view in one pass, or phase 1–2 (make it
   actually stream) first, then the visual rebuild? (Recommend: phase 1–2 first
   — streaming is the #1 complaint and unblocks everything.)
