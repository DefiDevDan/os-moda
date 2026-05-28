# DR dry-run checklist

Executable companion to [`../DR.md`](../DR.md). Run **quarterly** on a
throwaway VM (never touch the live box). Goal: prove the runbook works and
measure real RTO. Save the filled-in copy as `docs/dr-drills/YYYY-MM-DD.md`
with the captured timings + `journalctl` excerpts.

> **Prerequisite:** off-box backups must be ACTIVE (P0a secret files populated
> on prod, `spawn-backup.service` producing real `spawn-data-*.tar.age` on the
> remote). Until then this drill can only be rehearsed with a hand-made tarball.

## Drill log

| Field | Value |
|---|---|
| Drill date (UTC) | `__________` |
| Operator | `__________` |
| Backup snapshot used | `spawn-data-__________.tar.age` |
| Snapshot age at restore | `____ hours` (RPO observed) |
| **T0** — start | `__:__:__` |
| **T1** — VM provisioned + reachable | `__:__:__` |
| **T2** — NixOS + secrets + repo in place | `__:__:__` |
| **T3** — data restored + decrypted | `__:__:__` |
| **T4** — spawn-app live, HTTPS 200 | `__:__:__` |
| **RTO observed** (T4 − T0) | `____ min` (target ≤ 4 h) |

## Steps (tick as you go)

- [ ] **1. Provision** a throwaway Hetzner CX22 (Ubuntu 24.04), note IP. **Do NOT** point `spawn.os.moda` DNS at it — use the raw IP for the drill.
- [ ] **2. Pull a backup snapshot** from the off-box destination to the drill VM:
      `rsync -e 'ssh -i <key>' <user@host:path>/spawn-data-<latest>.tar.age ./`
- [ ] **3. Decrypt + extract** with the age PRIVATE key (from your password manager, NOT the box):
      `age -d -i ~/age-priv.key spawn-data-<…>.tar.age | tar xz -C /tmp/restore`
      Confirm `/tmp/restore/data/orders.enc` etc. exist and are non-zero.
- [ ] **4. nixos-infect → NixOS**, land `infra/spawn-server/configuration.nix`.
- [ ] **5. Restore secrets** to `/var/lib/osmoda/secrets/` + `/opt/spawn-app/.env*` (mode 0600).
- [ ] **6. Clone repo** + deploy spawn-app (`apps/spawn` via push.sh, or rsync the gitignored checkout) into `/opt/spawn-app`, then move restored `data/` into place.
- [ ] **7. nginx + cert**: land `spawn.conf`; `certbot certonly --webroot` for a drill hostname OR self-signed for the drill (don't request a prod cert for the throwaway).
- [ ] **8. `nixos-rebuild switch`** — all timers + spawn-app up.
- [ ] **9. Smoke** (mirror install.sh assertions):
      - [ ] `curl -k https://<drill-ip>/api/v1/plans` → 200 with plans[]
      - [ ] `systemctl is-active spawn-app cert-renew.timer spawn-healthcheck.timer spawn-backup.timer`
      - [ ] restored `orders.enc` row count ≈ snapshot's
- [ ] **10. Record** T0–T4 + RTO above; paste `journalctl -u spawn-app -n 30` and the smoke output below.
- [ ] **11. Destroy** the drill VM.

## Captured output

```
(paste smoke results + journalctl excerpts here)
```

## Findings / runbook corrections
- (Anything in DR.md that was wrong, slow, or missing — fix DR.md after the drill.)
