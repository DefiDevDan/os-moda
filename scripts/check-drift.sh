#!/usr/bin/env bash
# check-drift.sh — fail if cross-file invariants that have silently drifted before
# disagree again. Runs in CI (the "no-drift" job) and locally. Cheap, no deps.
#
# Why this exists: the canonical runtime default and the agent tool count used to
# disagree across install.sh / osmoda.nix / README (a flake user got one runtime, a
# README reader expected another). This gate makes that class of drift fail loudly.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
note() { echo "  DRIFT: $*"; fail=1; }

# 1) Canonical runtime default must agree across installer + NixOS module + README.
inst=$(grep -oE 'RUNTIME="(claude-code|openclaw)"' scripts/install.sh | head -1 | sed -E 's/.*"(.*)"/\1/')
nixd=$(grep -E 'runtime = mkOption' nix/modules/osmoda.nix | grep -oE 'default = "(claude-code|openclaw)"' | sed -E 's/.*"(.*)"/\1/')
[ "$inst" = "claude-code" ] || note "install.sh default runtime is '$inst' (expected claude-code)"
[ "$nixd" = "claude-code" ] || note "osmoda.nix default runtime is '$nixd' (expected claude-code)"
[ "$inst" = "$nixd" ]       || note "install.sh ('$inst') and osmoda.nix ('$nixd') runtime defaults disagree"
grep -q 'Claude Code (default)' README.md || note "README no longer advertises 'Claude Code (default)'"

# 2) Agent tool count must be consistent — no stray 90/91 'tool' claims in the README
#    (ground truth is 92 registered bridge tools).
if grep -nE '\b9[01]\b' README.md | grep -iqE 'tool'; then
  note "README has a stale 90/91 tool count (should be 92): $(grep -nE '\b9[01]\b' README.md | grep -iE 'tool' | head -1)"
fi

if [ "$fail" = 0 ]; then echo "  ✓ no drift (runtime default + tool count consistent)"; fi
exit "$fail"
