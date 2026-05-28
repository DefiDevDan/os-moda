# Production hardening — running status

Source goal: [`/Users/admin/Desktop/molt-os/goal.txt`](../goal.txt).

## Done (this session)

| Item | Where it lives | Live verified |
|---|---|---|
| **P0c** Credential fallback in gateway (cooldown 30 min on `out_of_usage`/401/429, retry next healthy of same provider+type, `credential_cooldown` WS frame, `credential_exhausted` if none) | `packages/osmoda-gateway/src/{credentials,index}.ts`, `drivers/types.ts`; tests in `packages/osmoda-gateway/test/credentials.test.js` (3 green) | Gateway deployed to customer box, healthy, both runtimes available |
| **P1** install.sh end-of-install smoke (health 200, both drivers available, openclaw plugins doctor clean, mcp-bridge dist present; **non-zero exit** on any failure) | `scripts/install.sh` (end) | Pushed; will surface on next fleet install |
| **P1** Hard-enforce ApprovalGate (`check_and_reject`, new patterns: `drop database/table/schema`, `truncate table`, `0.0.0.0`-bind) + 3 new tests; **all 19 approval tests green** | `crates/agentd/src/approval.rs` | `cargo test -p agentd approval` ✓ |
| **P1** CI workflow on `bolivian-peru/os-moda` (gateway + integration-kit typecheck/test, agentd cargo check + approval tests) | `.github/workflows/ci.yml` | Pushed; will run on next PR/push |
| **P2** Postgres migration plan (target schema, per-row envelope PII, 6-phase dual-read/dual-write cutover, risks + non-goals) | [`docs/PG-MIGRATION.md`](./PG-MIGRATION.md) | Docs only — plan, no migration |
| **P2** Disaster recovery runbook (RTO 4 h / RPO 24 h initial; step-by-step restore; customer-fleet impact; quarterly dry-run requirement) | [`docs/DR.md`](./DR.md) | Docs only — dry-run not yet performed |

## Blocked — need a secret from the operator

| Item | What's needed |
|---|---|
| **P0a** Off-box encrypted backups (highest data-safety win) | (a) destination + creds (Hetzner Storage Box host/user/path or S3 endpoint+keys+bucket); (b) **age public key** for encryption (private key kept OFF the box being backed up) |
| **P0b** Telegram alerting on `spawn-healthcheck` / `cert-renew` / `spawn-app` failures + cert < 10 d | Telegram bot token (`123456:ABC…`) + chat_id |

## Remaining work — not blocked, but substantial (next session)

- **Wire `check_and_reject` into actual call paths** (`shell_exec`, `system.mutate`, `wallet.send`). Today the primitive is built + tested AND exposed as `POST /approval/check`, but only ApprovalGate code calls it internally. The wiring step (osmoda-bridge `shell_exec` POSTs to the endpoint before exec) is what fully closes the "advisory → enforced" gap. Single, well-scoped TypeScript change.

## Done after the initial status snapshot
- **P1** Spawn-app smoke — **25/25 `node:test` cases green** at `apps/spawn/test/smoke.test.js` (live API smoke against `https://spawn.os.moda`, read-only/negative paths only; covers plans, OpenAPI surface, agent-card, status error envelope + request_id correlation, x402 invoice decode from `payment-required` header, Idempotency-Key validation, path-param validation surface, full auth-required surface, HSTS, chat WS reachability). Runs via `npm test` in `apps/spawn/` before `push.sh`.

## How to pick up next session
1. Read `goal.txt`.
2. Read this file.
3. If the operator has provided the P0a/P0b secrets, execute those next.
4. Otherwise: start on P1 spawn-app tests, then the `check_and_reject` wiring.
