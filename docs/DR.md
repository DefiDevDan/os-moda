# Disaster recovery runbook — spawn.os.moda

> **Goal:** rebuild a fully-functional production spawn server from scratch
> given (1) the GitHub repo, (2) an off-box encrypted backup of
> `/opt/spawn-app/data`, and (3) the secrets vault.
>
> **Targets (initial — to harden quarterly):** RTO ≤ 4 h, RPO ≤ 24 h.
> RPO is bounded by the backup cadence (daily at 04:13 UTC per
> [`OPENCLAW-EXECUTIVE-PLAN.md`](planning/OPENCLAW-EXECUTIVE-PLAN.md) + goal P0a).

## What can fail
1. **Box disk loss** (Hetzner volume corruption). Most likely DR scenario.
2. **Box compromised** (rotate everything; rebuild fresh).
3. **Region outage.** Spin up in another Hetzner region.
4. **Accidental destructive op** (the ApprovalGate hard-block in `crates/agentd/src/approval.rs` is the prevention; backups are the cure if it ever lands).

## Inputs required before starting
- SSH access to a fresh Hetzner Cloud VM (CX22+, Ubuntu 24.04 image).
- The `.keys/agentos_hetzner` private key (kept off-box, in your password manager).
- The **age/gpg recipient key** (P0a backups are encrypted to it; not on the dead box).
- The secrets vault entries:
  - `ANTHROPIC_API_KEY` (for the spawn-app / spawn-server demo agent, if any)
  - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
  - `TELEGRAM_BOT_TOKEN` (P0b)
  - x402 wallet seed(s) for Base / Solana
  - `gateway-token` (or accept regen — it's per-box)
  - off-box backup endpoint creds (Hetzner Storage Box / S3)
- DNS access for `spawn.os.moda` (point A record at the new VM IP).

## Step-by-step restore

1. **Provision** a fresh Hetzner VM in the target region.
2. **DNS swing.** Point `spawn.os.moda` A record at the new IP. TTL was set
   low; propagation typically <5 min.
3. **Convert to NixOS** via `nixos-infect` (matches the existing prod box).
4. **Land `/etc/nixos/configuration.nix`** — copy the version from the
   primary or the latest `.bak.<ts>` on the disk image. Includes the
   `cert-renew` + `spawn-healthcheck` + (P0a) `backup` timers.
5. **Restore secrets** from the vault to `/var/lib/osmoda/secrets/` and
   `/opt/spawn-app/.env_secrets`. `chmod 600` everything.
6. **Pull the repo:**
   ```bash
   mkdir -p /opt && cd /opt && git clone https://github.com/bolivian-peru/os-moda
   ```
7. **Install nginx + certbot** (imperative today). Land
   `/etc/nginx/conf.d/spawn.conf` (HSTS + headers as currently configured)
   and request a fresh cert (`certbot certonly --webroot -w /var/www/certbot
   -d spawn.os.moda`).
8. **Restore data** from off-box backup:
   ```bash
   # decrypt + extract latest snapshot to /opt/spawn-app/data
   age -d -i ~/age.key /off-box/spawn-data-YYYY-MM-DD.tar.gz.age | tar xz -C /
   chown -R root:root /opt/spawn-app/data && chmod 600 /opt/spawn-app/data/*.enc
   ```
9. **Deploy the spawn-app:** from the operator workstation, in the gitignored
   `apps/spawn/` checkout, `bash push.sh` (rsync + `npm install` + restart).
10. **`nixos-rebuild switch`** to bring up all timers + services.
11. **Smoke checks** (mirrors install.sh post-install assertions):
    - `curl -sI https://spawn.os.moda/ | head -1` → `200 OK`, valid cert
    - `systemctl is-active spawn-app nginx cert-renew.timer spawn-healthcheck.timer backup.timer`
    - Latest 5 `orders.enc` count ≈ pre-incident count
    - One real spawn (or `gh api /repos/bolivian-peru/os-moda` style sanity)
12. **Telegram heartbeat:** send "DR test from $HOSTNAME at $(date)" via the
    bot to confirm alerts work from the new box.
13. **Restore monitoring:** re-attach any external uptime monitor to the new
    IP / hostname.

## What the customer fleet (spawned osModa boxes) needs
Customer boxes are independent — losing the provisioning box does **not**
lose them. They keep running their agents. What breaks:
- Heartbeats won't be accepted (they retry, harmless).
- The dashboard chat proxy is down (customers should fall back to direct SSH
  to their box; document this in the status banner).
Restoring the spawn-app brings everything back live; no per-box action needed.

## Dry-run requirement
Every quarter, dry-run **steps 1–11 on a throwaway VM** using yesterday's
backup. Record the actual time-to-restore and update the RTO target. Capture
journalctl output of the test run in `docs/dr-drills/YYYY-MM-DD.log`.

## Known gaps
- No automated failover yet (manual DNS swing + restore). Tracked: see goal
  "HA / second-host failover".
- No Postgres yet (encrypted JSON files restore quickly but won't scale).
  Tracked: [`PG-MIGRATION.md`](./PG-MIGRATION.md).
- Off-box backup destination + age key custody must be reviewed annually.
