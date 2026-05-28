# Load testing — osModa spawn API

> **Never run against `spawn.os.moda` (production).** All scripts hard-refuse
> that host. Production has a 5/min spawn rate limit + real paying users; load
> testing it = DOSing yourself. Use a **throwaway staging spawn**.

## Why staging
A spawn server is just a Hetzner VM running the same stack. To load-test the
API behavior, stand up one disposable box, point k6 at it, then destroy it.

## Set up a staging target
1. Spawn a throwaway server (lowest plan) via the dashboard or API, OR run the
   spawn-app locally: `cd apps/spawn && node server.js` (binds `127.0.0.1:3000`).
2. `export TARGET=http://127.0.0.1:3000`  (local) or `https://<staging-ip>`.

## Install k6
- macOS: `brew install k6`
- Linux: https://k6.io/docs/get-started/installation/

## Run

```bash
# Free read endpoints — ramps 10→500 VUs, measures p95/p99 + error rate.
k6 run -e TARGET=$TARGET free-reads.js

# Unpaid spawn (402) path under burst — proves the rate limiter never 5xx's.
k6 run -e TARGET=$TARGET spawn-402.js
```

## What to look for
- **free-reads**: `http_req_duration p(95)` and `p(99)`. Thresholds start at
  p95 < 800ms / p99 < 2s — re-baseline after the first run. Watch where the
  error rate climbs as VUs increase: that's your single-node ceiling.
- **spawn-402**: the run PASSES iff `server_errors_5xx == 0`. Most requests
  will be 429 (the 5/min limiter doing its job) — that's expected and healthy.
  A 5xx here means the limiter or x402 invoice path falls over under burst.

## After the run
Record findings (peak rps before degradation, p99, observed ceiling) into
`docs/HARDENING-STATUS.md` so the HA/Postgres decision is data-driven, then
**destroy the staging box**.

## Safety recap
- Scripts throw if `TARGET` is unset or matches `spawn.os.moda`.
- No script provisions a real server or spends money — the spawn test stops at
  the 402 invoice. Nothing here mutates data.
