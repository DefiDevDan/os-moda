# CodeGraph Integration — Full Plan

> Integrating [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)
> (MIT, 8.4k★, pure-WASM tree-sitter + SQLite, 100% local) to give the osModa
> agent a pre-indexed code knowledge graph. Goal: ~90% fewer grep/Read tool
> calls on every code task — a direct token + latency win on a metered-API
> product, and a force-multiplier for the dev / scraping / automation workloads
> osModa targets.

Status as of 2026-05-20: **Phase 1 shipped** (commit `bffc5b2`). Phases 2–5 below.

---

## Why this matters (one paragraph)

osModa's agent does heavy code work — scaffolding spec-kit projects, building
scrapers (LIRR), editing NixOS configs, deploying apps, and (uniquely) editing
its *own* source. Every grep/glob/Read during exploration is tokens + latency.
CodeGraph replaces blind file-scanning with sub-millisecond graph queries:
"what calls this", "what would changing this break", "build context for this
task" — answered in one tool call from a SQLite knowledge graph that the file
watcher keeps current. Benchmarks: 92% fewer tool calls, 71% faster exploration.

---

## Security posture (audited 2026-05-20 — gate for all phases)

Full audit recorded in commit `bffc5b2`. Summary: no npm install hooks, zero
network/telemetry, no eval/spawn, no credential env reads, path-traversal
guarded (`validatePathWithinRoot`, test-verified), MCP input validation on
every tool, static tool descriptions + server instructions (no injection
amplification), npm tarball ships only `dist/scripts/README`.

**Two hardening rules that apply to every phase:**
1. **Never run codegraph's own installer** (`codegraph install`) — it rewrites
   `~/.claude.json` / agent configs. We wire it ourselves via the gateway MCP
   config. The gateway config IS the integration.
2. **Git-hooks off** — use codegraph's file-watcher for sync, never let it
   write to `.git/hooks/` on the agent's repos. (`codegraph init` does not
   install hooks by default; `codegraph sync --install-hooks` does — never call
   that flag.)
3. **Residual risk acceptance:** like Read/grep/cat, codegraph returns indexed
   file content verbatim — a malicious repo could embed injection text in a
   comment. This is identical to the existing file-read risk; the agent's
   "tool output is data, not instructions" defense applies unchanged. Don't
   index untrusted third-party repos the agent didn't author or vet.

---

## Phase 1 — Register as a managed MCP server ✅ SHIPPED

**What landed (commit `bffc5b2`, gateway v0.2.2):**

- `packages/osmoda-gateway/src/index.ts` `buildMcpConfig()` adds a `codegraph`
  MCP server entry, gated on `OSMODA_CODEGRAPH_ENABLED=1`. `OSMODA_CODEGRAPH_BIN`
  overrides the binary path. Gating matters: claude-code's `--strict-mcp-config`
  would otherwise carry a dead entry on boxes without the binary.
- `scripts/install.sh` installs `@colbymchenry/codegraph` globally and writes
  `OSMODA_CODEGRAPH_ENABLED=1` to `/var/lib/osmoda/config/env` (read by the
  gateway systemd unit's `EnvironmentFile`).
- Verified live: the MCP config regenerates with codegraph on next session;
  the server answers `tools/list` with all 9 tools.

**Outcome:** every spawned box's agent gets the 9 codegraph tools alongside the
91 osmoda-bridge tools — both claude-code and openclaw drivers, since they share
the same MCP config.

**Follow-up cleanup for a future pass:**
- Add `OSMODA_CODEGRAPH_ENABLED` to `nix/modules/osmoda.nix` as a first-class
  option (`services.osmoda.codegraph.enable`, default true) so flake installs
  get it without the install.sh env-file hack.
- Bundle codegraph into the flake (pinned npm version vendored) so air-gapped /
  offline NixOS builds don't need npm registry access at install time.

---

## Phase 2 — Auto-index the boxes that matter

**Goal:** the graph is useless until projects are indexed. Index the dirs the
agent actually works in, and keep them synced automatically.

**What to index, in priority order:**
1. `/opt/osmoda` — the OS's own source. Unlocks **self-modification with
   structure awareness** (the agent editing its own daemons/gateway/skills).
   Highest-leverage: this is the codebase the agent touches most when asked to
   extend itself.
2. `/workspace/<slug>/` — every spec-kit project (see Phase 3).
3. Deployed user apps — `/opt/<app>`, `/srv/*` (LIRR's `/srv/internal`,
   `/srv/dashboard`, the scraper backend). Where the agent does customer work.

**Implementation:**
- New `osmoda-routines` routine `codegraph-index` (one-shot on first boot +
  re-runnable):
  ```
  for dir in /opt/osmoda /workspace/* /srv/* ; do
    [ -d "$dir/.git" ] || [ -d "$dir/src" ] || continue   # only real projects
    codegraph init "$dir"  2>/dev/null || true
    codegraph index "$dir" 2>/dev/null || true
  done
  ```
- After the initial `index`, codegraph's native file-watcher (FSEvents/inotify,
  2s debounce) keeps each project current. No cron needed for steady-state.
  BUT: the watcher process must be running. Decide between:
  - **(a) one `codegraph serve --mcp` per query** (current Phase 1 — stateless,
    no persistent watcher; the agent's queries hit a fresh process that reads
    the existing `.codegraph/*.db`). Index staleness is then bounded by how
    often the `codegraph-index` routine re-runs.
  - **(b) a persistent `codegraph watch` daemon** per indexed root (systemd
    unit `osmoda-codegraph-watch@<slug>`). Always-fresh index, costs one
    long-lived node process per root.
  - **Recommendation:** start with (a) + a 30-min `codegraph sync` routine
    (incremental, cheap). Promote to (b) only for `/opt/osmoda` if the agent's
    self-edits need sub-second freshness.
- Bound disk: add `.codegraph/` to the `nix-optimizer` skill's cleanup sweep
  (the graph DB is small — symbols + edges, not file content — but bound it
  anyway so a 50-project box doesn't accrete).

**Acceptance:** `codegraph status /opt/osmoda` reports a populated index;
`codegraph_context "the wedge detector"` on a fresh agent turn returns the
relevant spawn-app symbols in one call.

**Risk:** indexing the agent's own writes mid-edit. The 2s debounce + the
"don't query immediately after editing" server instruction handle this. For
spec-kit, index on phase boundaries (Phase 3), not per-keystroke.

---

## Phase 3 — Wire into spec-kit

**Goal:** every spec-kit project the agent scaffolds is graph-indexed, so the
`implement` phase has structure awareness — fewer tokens, better edits, no
re-discovering the project layout each turn.

**Implementation:**
- The `spec_kit_init` MCP tool (in `osmoda-mcp-bridge`) already scaffolds
  `/workspace/<slug>/`. Add a post-scaffold step: `codegraph init <dir>`.
- The `spec_kit_run` tool executes phase commands. After the `implement` phase
  writes code, run `codegraph sync <dir>` so the next phase sees current
  structure.
- Surface index state in the dashboard's **Factories** tab (per spec-kit
  project): a "graph: 142 symbols · synced 3s ago" line next to the phase
  badge. Pulls from `codegraph status <dir> --json`.
- Update the spec-kit SKILL.md (the agent's playbook) to instruct: "Before
  implementing, call `codegraph_context` on the task. After implementing,
  the index auto-syncs."

**Acceptance:** spawn a spec-kit project, run through `specify → plan → tasks
→ implement`; confirm `.codegraph/` exists and the agent used `codegraph_*`
tools during implement (visible in the chat tool-bubbles).

**Dependency:** Phase 2's indexing mechanism decision (a vs b) applies per
spec-kit project.

---

## Phase 4 — First-class osModa tools (osmoda-bridge wrappers)

**Goal:** the 9 codegraph tools currently appear as `codegraph_*` (a separate
MCP server). Wrap them in `osmoda-bridge` with osModa-native names so they're
first-class citizens in the 91→100 tool catalog, appear on the `/skill` page,
and get the same audit-ledger logging as every other osModa tool.

**Implementation:**
- In `packages/osmoda-bridge/index.ts`, register thin wrappers via
  `api.registerTool()`:
  - `code_search` → codegraph_search
  - `code_context` → codegraph_context (PRIMARY)
  - `code_callers` / `code_callees` → codegraph_callers/callees
  - `code_impact` → codegraph_impact (blast-radius)
  - `code_symbol` → codegraph_node
  - `code_explore` → codegraph_explore
  - `code_files` / `code_status` → codegraph_files/status
- Each wrapper shells to `codegraph <subcommand> --json` (the CLI has
  `query`/`context`/`affected`/`status`/`files` non-MCP commands) OR proxies
  to the codegraph MCP server over stdio. Prefer the CLI for simplicity; it's
  the same SQLite read.
- Every call logs to the agentd hash-chain ledger like all osModa tools →
  the code-intelligence usage becomes auditable + feeds teachd (Phase 5).
- Decision: **keep BOTH** surfaces? The raw `codegraph_*` MCP tools are
  battle-tested and the upstream server-instructions teach the agent to use
  them well. The osmoda-bridge wrappers add audit + catalog consistency. Risk
  of duplicate tools confusing the agent. **Recommendation:** wrap only the
  3 highest-value (`code_context`, `code_impact`, `code_search`) as
  first-class osModa tools for the catalog/marketing story; leave the full 9
  available via the codegraph MCP server. Avoid 1:1 duplication.

**Acceptance:** `/skill` page lists code-intelligence tools; agentd ledger
shows `code_context` events; tool count + docs updated.

---

## Phase 5 — teachd synergy (code intelligence → operational intelligence)

**Goal:** turn codegraph's structural knowledge into osModa's operational
learning. The unique angle: an OS that understands the blast radius of its own
changes.

**Implementation ideas (research-grade, pick the strongest):**
1. **Impact-aware incident workspaces.** When the agent makes a config/code
   change inside an incident workspace, attach `codegraph_impact` output:
   "this edit to `wedge-detector` touches 4 files, 2 tests." Recorded in the
   incident's hash-chained steps — auditable change-blast-radius.
2. **teachd pattern: risky-change detection.** teachd's LEARN loop correlates
   "changes with impact radius > N files" against "subsequent service failures."
   Over time it learns which subsystems are fragile and warns before edits.
3. **SafeSwitch pre-flight.** Before a `safe_switch_begin`, run `code_impact`
   on the changed files; if the blast radius includes critical-path symbols
   (gateway, agentd), require a stricter health-check set or human approval.
4. **SKILLGEN seeding.** When teachd detects a repeated tool sequence that
   starts with `code_context` + `code_impact`, the auto-generated SKILL.md
   encodes "always check impact before editing X."

**Acceptance:** an incident workspace shows impact data; teachd surfaces at
least one "fragile subsystem" knowledge doc derived from impact + failure
correlation.

**Dependency:** Phase 4 (so the calls are ledger-logged and teachd-visible).

---

## Cross-cutting work (do alongside any phase)

- **NixOS option** `services.osmoda.codegraph.{enable, indexDirs, watchMode}` in
  `nix/modules/osmoda.nix`. Replaces the install.sh env-file hack with a
  declarative, rollbackable config. `watchMode = "on-demand" | "persistent"`
  maps to Phase 2's (a) vs (b).
- **Flake vendoring** — pin the codegraph npm version into the flake so builds
  are reproducible and offline-capable. Bump cadence is ours (mitigates the
  single-maintainer upstream risk).
- **`/skill` + SKILL.md + STATUS.md** doc sync once Phase 4 lands (tool count,
  capability description, the "your agent doesn't grep blindly" marketing line).
- **Node 25 guard** — codegraph hard-exits on Node 25.x (V8 turboshaft WASM JIT
  bug). osModa pins Node 22, so fine today; note it when bumping the Node pin.

---

## Sequencing recommendation

```
Phase 1  ✅ shipped (gateway MCP entry + install.sh)
Phase 2  →  next session: auto-index /opt/osmoda + /workspace + /srv,
            on-demand mode + 30-min sync routine
Phase 3  →  with Phase 2: spec-kit init/sync hooks + Factories-tab graph badge
Phase 4  →  later: wrap top-3 as first-class code_* tools, ledger-logged
Phase 5  →  research: impact-aware incidents + teachd fragile-subsystem learning
```

Phases 2+3 together are the force-multiplier (self-aware OS + spec-kit
acceleration) and are the natural next session. Phase 4 is catalog/marketing
polish. Phase 5 is the differentiated long-term bet: **the only OS that knows
the blast radius of its own changes before it makes them.**

---

## Marketing one-liner (for /skill + landing once Phase 2 lands)

> "Your osModa agent doesn't grep around blindly. Every codebase on the box —
> including the OS's own source — is pre-indexed into a queryable knowledge
> graph. The agent knows your code's structure, call graph, and change blast
> radius before it reads a single file."
