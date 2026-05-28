# spawn-server NixOS reference

This is a **reference copy** of `/etc/nixos/configuration.nix` running on
`spawn.os.moda` (root@89.167.93.28). It is not auto-deployed — edits here are
documentation; production changes happen on the box via `nixos-rebuild switch`.
Keep this file in sync with the box after material changes.

## What's installed
- `spawn-app.service` — the Node.js web app on `127.0.0.1:3000` behind nginx.
- `cert-renew.timer` — twice-daily LE renewal + nginx HUP on success.
- `spawn-healthcheck.timer` — every 5 min self-heal (restart spawn-app on
  HTTP≠200; HUP nginx if served cert ≠ on-disk cert).
- `cert-monitor.timer` — daily check; alerts via Telegram if cert <10 days.
- `spawn-backup.timer` — daily 04:13 UTC (+30 min jitter) encrypted off-box
  backup of `/opt/spawn-app/data`.
- `spawn-alerter@%i.service` — template service invoked by `OnFailure=` on the
  five critical units (spawn-app, cert-renew, cert-monitor, spawn-healthcheck,
  spawn-backup) to post the failing unit name to Telegram.
- CLIs in PATH: `spawn-alert`, `spawn-backup`, `certbot`, `age`, `rsync`.

## Activating P0a + P0b — drop four files

The whole alert + backup pipeline ships **inactive-but-wired**. Activate
either or both at any time, with no rebuild, by writing the secret files
below. Ownership root, mode 0600.

### Telegram alerts (P0b)
```
echo '<bot-token>'   > /var/lib/osmoda/secrets/telegram-bot-token   && chmod 600 $_
echo '<chat-id>'     > /var/lib/osmoda/secrets/telegram-chat-id     && chmod 600 $_
spawn-alert "hello from $(hostname)"   # smoke-test
```

### Off-box backups (P0a)
```
echo 'age1...'                              > /var/lib/osmoda/secrets/backup-age-recipient && chmod 600 $_
echo 'u123456@u123456.your-storagebox.de:spawn-backups' > /var/lib/osmoda/secrets/backup-rsync-target && chmod 600 $_
echo '/var/lib/osmoda/secrets/backup-key'   > /var/lib/osmoda/secrets/backup-ssh-key && chmod 600 $_
# Put the ssh private key at the path the file above points to (chmod 600).
systemctl start spawn-backup.service   # smoke-test (uploads now)
```
The age **private key** must NOT live on this box — generate it on a
trusted laptop / 1Password and keep it there.

### Verifying activation
```
journalctl -u spawn-backup.service --no-pager -n 20    # should say "OK (N bytes)"
spawn-alert "test"                                     # should post to Telegram
```

## What's NOT in this file (kept imperative on the box)
- nginx config (`/etc/nginx/conf.d/spawn.conf` + HSTS/security headers).
- Let's Encrypt state (`/etc/letsencrypt/`).
- App secrets (`.env`, `.env_secrets`, `gateway-token`, x402 wallet seeds,
  Stripe keys). They live under `/var/lib/osmoda/secrets/` and
  `/opt/spawn-app/.env*`, mode 0600.

See `docs/DR.md` for the full rebuild-from-scratch runbook and
`docs/HARDENING-STATUS.md` for the production-readiness summary.
