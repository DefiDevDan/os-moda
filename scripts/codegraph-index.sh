#!/bin/bash
# codegraph-index.sh — index osModa's own source + workspace + deployed apps
# into the local code knowledge graph. Run once at install + every 30 min via
# the osmoda-codegraph-index.timer for incremental sync. Bounded, best-effort,
# never fails the caller (so a timer tick can't wedge anything).
#
# Indexed roots (priority order):
#   /opt/osmoda     — the OS's own source (self-modification awareness)
#   /workspace/*    — spec-kit projects
#   /srv/*          — deployed user apps (LIRR internal, dashboard, scrapers)
set +e
command -v codegraph >/dev/null 2>&1 || { echo "[codegraph-index] codegraph not installed — skipping"; exit 0; }

INDEX_ROOTS=("/opt/osmoda")
for d in /workspace/*/ /srv/*/; do
  [ -d "$d" ] && INDEX_ROOTS+=("${d%/}")
done

indexed=0; synced=0; skipped=0
for dir in "${INDEX_ROOTS[@]}"; do
  [ -d "$dir" ] || continue
  # Only index real projects: must contain source files, not just config/data.
  if ! find "$dir" -maxdepth 3 -type f \( -name '*.ts' -o -name '*.js' -o -name '*.py' -o -name '*.go' -o -name '*.rs' -o -name '*.nix' -o -name '*.java' -o -name '*.rb' -o -name '*.php' \) -print -quit 2>/dev/null | grep -q .; then
    skipped=$((skipped+1)); continue
  fi
  if [ -d "$dir/.codegraph" ]; then
    codegraph sync "$dir" >/dev/null 2>&1 && synced=$((synced+1))
  else
    codegraph init  "$dir" >/dev/null 2>&1
    codegraph index "$dir" >/dev/null 2>&1 && indexed=$((indexed+1))
  fi
done
echo "[codegraph-index] indexed=$indexed synced=$synced skipped=$skipped roots=${#INDEX_ROOTS[@]}"
exit 0
