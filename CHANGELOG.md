# Changelog

All notable changes to osModa. Format loosely follows [Keep a Changelog](https://keepachangelog.com/);
the project uses a single semver line (the gateway, NixOS module, and repo tag move together).
Per-component maturity lives in [docs/STATUS.md](docs/STATUS.md).

## [1.3.0] — 2026-06-11 — Stable core

The first **stable** cut. Core (10 daemons, the modular gateway, agentd contracts + audit
ledger) is stable; **Claude Code is the main runtime**. Advanced security hardening and the
company-integration layer continue per [STATUS.md](docs/STATUS.md).

### Added
- **Tier-0 PreToolUse approval hook** — the default claude-code agent's native `Bash`/`Write`/
  `Edit` now route through agentd's ApprovalGate + hash-chained ledger (closing the gap where
  native tools bypassed the structured-tool blocklist). Ships via `install.sh` + the NixOS
  module. *Implemented + unit-tested; live end-to-end verification on a box pending.*
- **Persistent named chats** — multiple distinct conversations per server, each with its own
  `--resume` session, transcript, and native compaction; `/chats` REST; zero-move migration.
- **Cross-chat + cross-channel awareness** — bounded, deterministic digest of other chats'
  notable actions, injected per-turn with a "caught up on N changes" chip.
- **`managed-agent` runtime driver (prototype)** — Anthropic Managed Agents via the `ant` CLI
  (cloud sandbox; for the untrusted/scale-out tier, not the tier-0 system agent).
- **`docs/LIQUID-SOFTWARE.md`** — the product thesis.
- **CI**: full `cargo test --workspace` (213 tests, was one module) + a no-drift gate
  (`scripts/check-drift.sh`) that fails if the runtime default or tool count drift across
  install.sh / osmoda.nix / README.

### Changed
- **Claude Code is the canonical default runtime** across `install.sh`, `nix/modules/osmoda.nix`,
  README, and CLAUDE.md (previously the NixOS module defaulted to openclaw — a flake user got a
  different runtime than a curl-installer user). OpenClaw remains a fully-supported peer.
- README brought current to v1.3 (named chats, managed-agent driver, 92 tools, 247 tests) with an
  honest Safety Model section ("what the default agent bypasses today").
- Repo root decluttered — internal planning docs moved under `docs/planning/`.

### Fixed
- **Silent total data-loss** in the hosted control plane: encrypted stores now use atomic
  tmp+rename writes with a `.bak` last-known-good fallback (a torn write previously wiped the
  whole order/billing/auth registry).
- **Wedge auto-restart** (`staleMin` ReferenceError) — fleet self-healing now actually fires.
- `npm test` (gateway) runs under Node 24 as well as the pinned 22.

## [1.2.0] — 2026-04-18
- Modular agent runtime: per-agent runtime/credential/model, hot-reloadable `agents.json`,
  encrypted credential store, SSH-free Engine tab. x402 programmatic spawn API.

## [1.1.0] — 2026-04-17
- v1 public API hardening: uniform error envelope, rate limits, idempotency, request receipts.

## [0.1.0] — initial
- agentd + hash-chained ledger, the 10-daemon architecture, NixOS module, first skills.

[1.3.0]: https://github.com/bolivian-peru/os-moda/releases/tag/v1.3.0
[1.2.0]: https://github.com/bolivian-peru/os-moda/releases/tag/v1.2.0
[1.1.0]: https://github.com/bolivian-peru/os-moda/releases/tag/v1.1.0
[0.1.0]: https://github.com/bolivian-peru/os-moda/releases/tag/v0.1.0
