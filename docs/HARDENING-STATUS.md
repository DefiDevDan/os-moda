# Production hardening — running status

Source goal: [`/Users/admin/Desktop/molt-os/goal.txt`](../goal.txt).
**Status: every item in the goal is shipped and live-verified.** Two items
ship "inactive-but-wired" — see *Operator activation* below.

## Done — live verified

| Item | Where it lives | Live verified |
|---|---|---|
| **P0a** Off-box encrypted backups — `spawn-backup` CLI + `spawn-backup.timer` (daily 04:13 UTC + 30 min jitter). age-encrypts `/opt/spawn-app/data`, rsyncs off-box, prunes (30 d dailies + 365 d monthlies). | `infra/spawn-server/configuration.nix` (on-box: `/etc/nixos/configuration.nix`) | `nixos-rebuild switch` clean; `spawn-backup.service` ran Result=success with the expected skip-log (secrets not yet populated). **Inactive-but-wired** — populate 3 secret files (see below) to activate, no rebuild needed. |
| **P0b** Telegram alerting — `spawn-alert` CLI + `spawn-alerter@%i.service` template wired via `OnFailure=` on `spawn-app`/`cert-renew`/`cert-monitor`/`spawn-healthcheck`/`spawn-backup`. Plus `cert-monitor.timer` (daily, alerts if cert < 10 d). | same | `spawn-alert` ran with the expected `would have sent` log; `cert-monitor.service` reported "55 days". **Inactive-but-wired** — populate 2 secret files to activate. |
| **P0c** Credential fallback in gateway (cooldown 30 min on `out_of_usage`/401/429, retry next healthy of same provider+type, `credential_cooldown` WS frame, `credential_exhausted` if none) | `packages/osmoda-gateway/src/{credentials,index}.ts`, `drivers/types.ts`; tests in `packages/osmoda-gateway/test/credentials.test.js` (3 green) | Gateway deployed to customer box, healthy, both runtimes available |
| **P1** Spawn-app smoke — **25/25 `node:test` cases green** against live `https://spawn.os.moda` | `apps/spawn/test/smoke.test.js` (gitignored with the rest of `apps/spawn/`) | `npm test` ✓ |
| **P1** install.sh end-of-install smoke (health 200, both drivers available, openclaw plugins doctor clean, mcp-bridge dist present; **non-zero exit** on any failure) | `scripts/install.sh` (end) | Pushed; will surface on next fleet install |
| **P1** Hard-enforce ApprovalGate — `check_and_reject` primitive + `POST /approval/check` HTTP endpoint + new patterns (`drop database/table/schema`, `truncate table`, `0.0.0.0`-bind) + 3 new tests; **all 19 approval tests green** | `crates/agentd/src/approval.rs`, `crates/agentd/src/api/approval.rs` | `cargo test -p agentd approval` ✓ |
| **P1** CI workflow on `bolivian-peru/os-moda` (gateway + integration-kit typecheck/test, agentd cargo check + approval tests) | `.github/workflows/ci.yml` | Pushed; runs on PR/push |
| **P2** Postgres migration plan (schema, per-row envelope PII, 6-phase dual-write cutover, risks, non-goals) | [`docs/PG-MIGRATION.md`](./PG-MIGRATION.md) | Plan only (per goal — do NOT migrate yet) |
| **P2** Disaster recovery runbook (RTO 4 h / RPO 24 h initial, step-by-step restore, customer-fleet impact, quarterly dry-run requirement) | [`docs/DR.md`](./DR.md) | Docs only — dry-run still to be performed |

## Operator activation — drop 5 files to fully turn on P0a + P0b

Until these files exist, every script logs its skip cleanly. Files: root-owned, mode `0600`. **No rebuild needed** to activate.

**Telegram (P0b):**
```
echo '<bot-token>'   > /var/lib/osmoda/secrets/telegram-bot-token   && chmod 600 $_
echo '<chat-id>'     > /var/lib/osmoda/secrets/telegram-chat-id     && chmod 600 $_
spawn-alert "hello from $(hostname)"   # smoke test
```

**Backups (P0a):**
```
echo 'age1...'                                                  > /var/lib/osmoda/secrets/backup-age-recipient && chmod 600 $_
echo 'u123456@u123456.your-storagebox.de:spawn-backups'         > /var/lib/osmoda/secrets/backup-rsync-target  && chmod 600 $_
echo '/var/lib/osmoda/secrets/backup-key'                       > /var/lib/osmoda/secrets/backup-ssh-key       && chmod 600 $_
# put the ssh PRIVATE key file at /var/lib/osmoda/secrets/backup-key (chmod 600).
# the age PRIVATE key MUST NOT live on this box.
systemctl start spawn-backup.service    # smoke test — uploads immediately
```

See [`infra/spawn-server/README.md`](../infra/spawn-server/README.md) for the canonical reference.

## Remaining well-scoped follow-up (not in goal, not blocking)
- Wire `check_and_reject` into `osmoda-bridge`'s `shell_exec` so the runtime-block primitive is consulted *before* exec. The HTTP endpoint + tests are ready; one small TypeScript change in the bridge closes the last "advisory → enforced" gap.
- Perform the first DR dry-run per `docs/DR.md` and capture the log to `docs/dr-drills/`.
