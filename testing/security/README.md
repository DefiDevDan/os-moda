# Security scanning — osModa spawn API

`scan.sh` runs **passive / read-only** checks only — safe to point at
production. It will NOT fuzz, brute-force, send active attack payloads, mutate
data, or spend money.

## What it runs (whatever is installed; skips the rest)
1. **Security headers** — curl dump + grep for HSTS/CSP/X-Frame/etc. (always).
2. **nuclei** — safe template tags only (`tls,ssl,http,misconfiguration,
   exposure,cve`), explicitly `-exclude-tags dos,fuzz,intrusive,bruteforce`,
   rate-limited to 20 rps.
3. **ZAP baseline** — passive spider via Docker (`zap-baseline.py`). No active
   attack rules.
4. **testssl.sh** — deep TLS cipher/protocol audit (optional).

## Run
```bash
testing/security/scan.sh                       # defaults to https://spawn.os.moda
testing/security/scan.sh https://staging-host  # or a staging clone
```
Reports land in `testing/security/reports/<timestamp>/`.

## Install the optional tools
- nuclei: `brew install nuclei` or the projectdiscovery release.
- ZAP: needs Docker (`ghcr.io/zaproxy/zaproxy:stable` pulled automatically).
- testssl.sh: `brew install testssl` / distro package.

## Triage
- nuclei `high`/`critical` → fix before next release.
- ZAP `WARN-NEW` → review; many are informational (e.g. cookie flags).
- Headers: we already ship HSTS (2y), CSP, X-Frame-Options, nosniff,
  Referrer-Policy, Permissions-Policy, `server_tokens off`. Regressions here
  are the actionable signal.

## CI note
Not wired into CI (scans are slow + need network egress + Docker). Run
manually before releases, or as a scheduled job from an ops box — NOT from the
spawn server itself.
