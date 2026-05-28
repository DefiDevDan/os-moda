#!/usr/bin/env bash
# Read-only / passive security scan of the spawn API surface.
#
# SAFE BY DESIGN — this runs ONLY non-intrusive checks:
#   - nuclei with safe template tags (tls, http misconfig, exposures, CVEs,
#     security headers) — no fuzzing, no auth bruteforce, no DoS templates.
#   - ZAP BASELINE scan (passive spider only; NO active attack payloads).
# Both are safe to point at production. Neither mutates data or spends money.
#
# Usage:
#   testing/security/scan.sh [TARGET]
#   TARGET defaults to https://spawn.os.moda
#
# Requires (any subset — the script runs what's installed):
#   - nuclei   (https://github.com/projectdiscovery/nuclei)
#   - docker   (for ZAP baseline: ghcr.io/zaproxy/zaproxy)
#   - testssl.sh (optional, TLS deep-check)
set -uo pipefail

TARGET="${1:-https://spawn.os.moda}"
OUT="testing/security/reports/$(date -u +%Y%m%d_%H%M%S)"
mkdir -p "$OUT"
echo "== osModa passive security scan =="
echo "target : $TARGET"
echo "output : $OUT"
echo

# 1. Security headers (always available — pure curl).
echo "--- [1/4] security headers (curl) ---"
curl -sI "$TARGET/api/v1/plans" | tee "$OUT/headers.txt" | \
  grep -iE 'strict-transport|content-security|x-frame|x-content-type|referrer-policy|permissions-policy|server' || true
echo

# 2. nuclei — safe template tags only.
if command -v nuclei >/dev/null 2>&1; then
  echo "--- [2/4] nuclei (safe tags: tls,ssl,http,misconfiguration,exposure,cve) ---"
  nuclei -u "$TARGET" \
    -tags tls,ssl,http,misconfiguration,exposure,cve \
    -severity low,medium,high,critical \
    -rate-limit 20 -timeout 10 \
    -exclude-tags dos,fuzz,intrusive,bruteforce \
    -o "$OUT/nuclei.txt" -stats 2>"$OUT/nuclei.log" || true
  echo "  → $OUT/nuclei.txt"
else
  echo "--- [2/4] nuclei NOT installed — skipping (install: https://github.com/projectdiscovery/nuclei) ---"
fi
echo

# 3. ZAP baseline (passive spider; no active attacks). Docker-based.
if command -v docker >/dev/null 2>&1; then
  echo "--- [3/4] ZAP baseline (passive) ---"
  docker run --rm -v "$(pwd)/$OUT:/zap/wrk:rw" -t ghcr.io/zaproxy/zaproxy:stable \
    zap-baseline.py -t "$TARGET" -r zap-baseline.html -m 2 2>"$OUT/zap.log" || true
  echo "  → $OUT/zap-baseline.html"
else
  echo "--- [3/4] docker NOT available — skipping ZAP baseline ---"
fi
echo

# 4. testssl.sh (optional deep TLS).
if command -v testssl.sh >/dev/null 2>&1; then
  echo "--- [4/4] testssl.sh ---"
  testssl.sh --quiet --color 0 "$TARGET" >"$OUT/testssl.txt" 2>&1 || true
  echo "  → $OUT/testssl.txt"
else
  echo "--- [4/4] testssl.sh NOT installed — skipping ---"
fi

echo
echo "== done. Review $OUT/ =="
echo "Triage: any high/critical nuclei finding or ZAP WARN-NEW is actionable."
