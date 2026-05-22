# Master Plan — OpenClaw as the Executive Runtime

> **Authority doc.** OpenClaw is osModa's original and primary ("executive")
> agent runtime. claude-code remains a fully-supported, selectable peer. This
> plan makes OpenClaw the default end-to-end — bridge tools, agents, gateway
> default, fleet installs, docs — and verifies it live.

## Why
OpenClaw was the original point of osModa: a local-first, plugin-extensible
agent that *runs the whole system* via the osmoda-bridge (91 daemon tools),
with its own durable session store. We are restoring it to first position.

## Current state (verified this session)
- OpenClaw upgraded to **2026.5.20** (latest) on the live box.
- osmoda-bridge **loads cleanly** (compiled dist + 2026.5 `contracts.tools`
  manifest; `plugins doctor` → no issues; Status: loaded, enabled).
- The gateway `openclaw` driver invocation works (`openclaw agent --local
  --json --model <provider>/<model> --session-id --message`); session
  persistence proven (`octest2.jsonl`).
- **Not yet** verified: a full multi-turn agent turn that actually *calls* the
  osModa tools (credit-blocked until now).

## Phases

### P1 — Bridge loads on latest OpenClaw  ✅ DONE
Compiled CJS dist, `contracts.tools` (91) in `openclaw.plugin.json` +
`package.json`, installed via `openclaw plugins install --link
--dangerously-force-unsafe-install`, root-owned, `registry --refresh`,
`doctor` clean. install.sh fixed for fleet.

### P2 — Agents registered + bridge enabled for them
Register `osmoda` (+ `mobile`) in OpenClaw with the 2026.5
`AuthProfileSecretsStore` auth format; ensure osmoda-bridge is enabled for
them (it's globally enabled). The gateway `openclaw` driver already
auto-registers + writes auth on first run.

### P3 — Make OpenClaw the gateway default
- Live box: switch `osmoda` + `mobile` agents to `runtime: openclaw` via the
  gateway `/config/agents` API (healthCheck-gated; openclaw now available).
- install.sh: default `RUNTIME=openclaw` for new spawns (claude-code still
  selectable).
- NixOS module: `cfg.gateway.runtime` default → `openclaw`.
- claude-code stays a peer; per-agent override preserved.

### P4 — Live verification (executive proof)
A real chat through the gateway on openclaw must:
1. load all 91 osModa tools,
2. successfully call a tool (e.g. `system_health`),
3. carry context across ≥2 turns (same `--session-id`),
4. survive a claude-code↔openclaw swap (gateway transcript re-seed).
Requires a **funded api_key** credential (OpenClaw rejects OAuth).

### P5 — Docs reflect OpenClaw-as-executive
CLAUDE.md, README, docs/STATUS.md, docs/ARCHITECTURE.md, spawn SKILL.md /
llms.txt / skill.html: OpenClaw = primary runtime; claude-code = peer.

### P6 — Fleet rollout
New spawns default to openclaw + bridge auto-registered. Existing boxes:
migrate via the Engine tab (runtime swap, healthCheck-gated) or a one-shot
re-provision of the openclaw plugin.

## Risk & rollback
- claude-code remains fully supported and one Engine-tab click away.
- Runtime swaps are healthCheck-gated (no swap to an unhealthy driver).
- The gateway's canonical transcript + MEMORY.md mean a swap never loses
  conversation memory.
- If a funded credential isn't present, the default flips but chat won't
  produce replies until the key has balance (same constraint as claude-code).

## Execution order
P2 → P3 (live box) → P4 (verify) → P3 (install.sh + NixOS defaults) → P5 → P6.
