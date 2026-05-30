# Brief: fix the `/skill` marketing page to match shipped reality

You are editing **one file**: `apps/spawn/public/skill.html` (gitignored; deployed via `cd apps/spawn && bash push.sh`). The page lives at `https://spawn.os.moda/skill`, route `apps/spawn/server.js:5264`.

The page was written at v1.3.1 and has drifted. We're now at **v1.3.25** plus gateway v0.2.1, with five concrete classes of factual error that need fixing. Apply every change below in order, then run the verification block at the end.

**Constraints**

- HTML only — no JS / CSS changes unless required to keep markup valid.
- Preserve existing tone, voice, and section numbering (`01` … `19`, `4b`, `4c`, `12b`, `12c`, `14a`, `14b`, `14c`, `15b`).
- Don't reflow surrounding paragraphs unless the patch demands it.
- Don't strip or move `<meta>` tags except where this brief tells you to.
- When in doubt, prefer surgical edits over rewrites.

---

## Edit 1 — Version stamps: v1.3.1 → v1.3.25

The literal token `v1.3.1` appears multiple times in `<title>`, `<meta>`, JSON-LD, and prose. Replace **every standalone `v1.3.1`** with **`v1.3.25`**, **except** where it's labeling a historical milestone (sections `14c` and the `v1.3.1 NEW` table badges — see Edit 5). Concretely:

**Lines to update (do a regex search to confirm, this is the v1.3.1 set as of today):**

- `14`: `<title>osmoda Architecture - 10 daemons, 92 tools, v1.3.1</title>` → `… v1.3.25</title>`
- `15`: `<meta name="description" …>Inside osmoda v1.3.1: …` → `Inside osmoda v1.3.25: …`
- `26`: `<meta property="og:title" …>` v1.3.1 → v1.3.25
- `27`: `<meta property="og:description" …>` — no version token, leave alone unless one is there
- `31`: `<meta property="og:image:alt" …>` v1.3.1 → v1.3.25
- `37`: `<meta name="twitter:title" …>` v1.3.1 → v1.3.25
- `40`: `<meta name="twitter:image:alt" …>` v1.3.1 → v1.3.25
- `695–696`: JSON-LD `"headline"` and `"description"` — v1.3.1 → v1.3.25
- `738`: lead paragraph — keep `(v1.3.0) unified per-server event stream` and `(v1.3.1) self-serve wedge recovery` as historical anchors, but **append** a clause: *"plus (v1.3.25) dual-signal wedge detection and runtime-tagged disk-persisted sessions."*

**Leave these alone** — they're historical labels and must stay as `v1.3.1`:

- Section `14c` heading `<h2><span class="num">14c</span> v1.3.1 Wedge Detection &amp; Self-Serve Recovery</h2>`
- The `<strong>v1.3.1 NEW</strong>` table badges
- Any reference to "v1.2.7" or earlier

---

## Edit 2 — Stop telling users to write plaintext API keys

**Line ~1169**, replace the block:

```html
echo "sk-ant-api03-YOUR-KEY" > /var/lib/osmoda/config/api-key
chmod 600 /var/lib/osmoda/config/api-key
```

…with the following (preserve the surrounding `<pre>`/`<code>` wrapper and the page's existing syntax-highlight spans):

```bash
# Recommended — encrypted credential store via the gateway's REST surface.
# Persists to /var/lib/osmoda/config/credentials.json.enc (AES-256-GCM, mode 0600).

GATEWAY_TOKEN=$(cat /var/lib/osmoda/config/gateway-token)
curl -s -X POST http://127.0.0.1:18789/config/credentials \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"my-key","provider":"anthropic","type":"api_key","secret":"sk-ant-api03-YOUR-KEY"}'

# Or use the dashboard → Engine tab → Credentials → Add.
# Or pass --credential at spawn time so the box boots with the key already
# bound (see spawn.os.moda API docs).
```

**Then** insert a one-line caveat below the block:

```html
<p class="note">The legacy plaintext path (<code>/var/lib/osmoda/config/api-key</code>) still loads if present at boot, but new installs should use the encrypted store. Never paste raw keys into shell history or log files.</p>
```

**Also at lines ~1157 + 1158** (the NixOS flake example), update the `services.osmoda.enable = true;` block so `apiKeyFile = "/var/lib/osmoda/config/api-key";` is **commented out** with this guidance line above it:

```nix
# Use the encrypted credential store (POST /config/credentials or dashboard
# Engine tab). apiKeyFile is the legacy plaintext fallback, kept for
# air-gapped boxes that can't reach the gateway HTTP surface at first boot.
# apiKeyFile = "/var/lib/osmoda/config/api-key";
```

**Also delete the OpenClaw `auth-profiles.json` snippet at ~lines 1175–1185** (the two `cat > /root/.openclaw/agents/main/agent/auth-profiles.json <<'EOF'` blocks). Replace with a single line:

```html
<p>For OpenClaw runtime credentials, use the same <code>POST /config/credentials</code> endpoint with <code>"provider":"anthropic"</code> and <code>"type":"api_key"</code>. The gateway writes the per-agent <code>auth-profiles.json</code> automatically before each session, serialized per-agent to prevent races between concurrent credential swaps.</p>
```

---

## Edit 3 — Replace obsolete `openclaw config set` channel-setup commands

The `openclaw config set …` CLI does not exist on the modular gateway (v0.2+). It was a pre-v0.2 OpenClaw runtime command. Two blocks need rewriting.

### 3a) §12c "Setting Up Messaging Channels" — lines ~1357–1372

**Replace** the entire `<pre><code>` block that contains:

```
# Telegram setup
# 1. User creates a bot via @BotFather, gets a token
# 2. Save the token:
file_write: path=/var/lib/osmoda/secrets/telegram-bot-token content=BOT_TOKEN
# 3. Enable the channel:
shell_exec: openclaw config set channels.telegram.enabled true
…
```

…with the following:

```bash
# Telegram setup
# 1. User creates a bot via @BotFather and gets a token.
# 2. Save the token (mode 0600, root-owned):
file_write: path=/var/lib/osmoda/secrets/telegram-bot-token content=BOT_TOKEN
# 3. Enable the channel via NixOS option (the proper way on NixOS):
#    services.osmoda.channels.telegram.enable = true;
#    services.osmoda.channels.telegram.tokenFile = "/var/lib/osmoda/secrets/telegram-bot-token";
#    services.osmoda.channels.telegram.allowedUsers = [ "your_username" ];
#    sudo nixos-rebuild switch
#
# Or on a spawn-installed (non-NixOS-flake) box, route through the gateway
# config API and bind the mobile agent to the telegram channel:
GATEWAY_TOKEN=$(cat /var/lib/osmoda/config/gateway-token)
curl -s -X PATCH http://127.0.0.1:18789/config/agents/mobile \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channels":["telegram","whatsapp"]}'
# SIGHUP fires automatically; in-flight WS chats keep their snapshot.

# WhatsApp setup follows the same pattern — services.osmoda.channels.whatsapp.enable
# (NixOS) or the equivalent /config/agents binding. After enabling, scan the QR
# code emitted by `journalctl -u osmoda-gateway --since '30 sec ago'`.
```

### 3b) §18 "Telegram Setup / WhatsApp Setup" — lines ~2147–2167

Same fix, longer block. Replace `openclaw config set channels.telegram.enabled true` (etc.) with the NixOS-options form **plus** the gateway-API alternative shown in 3a. Keep the bot-token-creation steps and the QR-code instructions verbatim.

---

## Edit 4 — Honest trust-tier framing (don't claim Tier 1/2 enforcement that doesn't exist)

The trust-tier section currently reads as if Tier 1 sandbox + Tier 2 bubblewrap isolation are live. They're **designed**; the *tool surface* exists (`sandbox_exec`, `capability_mint`), but the runtime enforcement is not yet wired in. Same with the approval gate — `approval_*` tools exist; the wrapper that actually blocks destructive ops before execution is convention-based today.

### 4a) §02 trust-tier rings — lines ~784, ~788, ~791

**Append** to the TIER 1 ring-desc paragraph (after "… 'trusted but verified' level."):

```html
<em>(Tool surface — <code>sandbox_exec</code>, <code>capability_mint</code> — is shipped. Bubblewrap-backed enforcement on the live execution path is on the v1.4 roadmap; today, capability declarations are advisory and audited rather than kernel-enforced.)</em>
```

**Append** to the TIER 2 ring-desc paragraph (after "Zero trust, full containment."):

```html
<em>(Same caveat: the egress proxy + capability allowlist primitives are live, but bubblewrap is not yet wired into <code>sandbox_exec</code>'s default path.)</em>
```

### 4b) §15 "Approval gate" tool table — line ~1948 area (the `Approval gate` `<h3>` and table)

**Add** a single sentence below the `<h3>`, before the `<table>`:

```html
<p class="note">The four approval tools are wired and persist to SQLite, but enforcement is currently advisory — the agent's system prompt instructs it to call <code>approval_request</code> before destructive ops. Hard-blocking enforcement (a wrapper around <code>shell_exec</code> + the wallet daemon's signing path that refuses to proceed without an approved id) is on the v1.4 roadmap.</p>
```

---

## Edit 5 — Tool-count correctness (91, not 92) + the phantom `message` tool

`grep -c 'api.registerTool(' packages/osmoda-bridge/index.ts` returns **91**. The page's "92" is reached only by listing a `message` tool under a "Channels (multi-surface messaging)" group that has no `registerTool` entry. Either ship the tool or remove the claim. The correct fix today is **remove the claim**.

### 5a) Replace every `92 MCP tools` and `92 tools` with `91 tools`

There are **8 occurrences** of `92` in tool-count context. Update each:

- `14`, `15`, `26`, `27`, `31`, `37`, `38`, `40`, `695`, `696` — meta + JSON-LD: `92 tools` / `92 MCP tools` → `91 MCP tools`
- `738`: lead paragraph: `10 daemons, 92 MCP tools, …` → `10 daemons, 91 MCP tools, …`
- `854`: section heading `<h2><span class="num">04</span> 92 MCP Tools</h2>` → `91 MCP Tools`
- `930`: "Beyond the 92 tools, …" → "Beyond the 91 tools, …"
- `1027`, `1058`, `1059`: installer / what-the-installer-does — `92 MCP tools` → `91 MCP tools`
- `1248`: "osmoda-bridge - 92 tools registered …" → "91 tools"
- `1256`: `<h3>Your 92 Tools (Grouped by Function)</h3>` → `Your 91 Tools …`
- `1794–1797`: section 15 heading + tool-count span + first paragraph — `92 tools` → `91 tools` (three occurrences in this block)

### 5b) Remove the phantom "Channels" tool group entirely

**Lines ~2025–2031** — delete the entire `<h3>Channels (multi-surface messaging) <span class="tool-count">1</span></h3>` block including its `<table>` (the row with `<tr><td>message</td>…</tr>`).

In its place, insert:

```html
<p class="note">Channel routing (Telegram, WhatsApp, web) is handled by the gateway's binding map (<code>agents.json · bindings[]</code>), not a tool the agent calls. The agent's reply text on a Telegram or WhatsApp channel is delivered automatically by the gateway after the runtime emits a frame.</p>
```

### 5c) Re-validate the spec_kit count

The page counts `spec_kit_init` + `spec_kit_run` as 2 of the 91. Those are wired (search `apps/spawn/server.js` for `/api/v1/spec-kit/projects`) but registered as MCP tools, not bridge `api.registerTool` calls — so the bridge grep won't see them. **Leave them in the §15 table**, but **add this note** below the spec-kit subsection heading at ~line 2007:

```html
<p class="note">Spec-kit tools are MCP-protocol tools (managed by <code>osmoda-mcpd</code>), not <code>osmoda-bridge</code> <code>api.registerTool()</code> entries. The 91 count above refers only to the bridge surface.</p>
```

---

## Edit 6 — Daemon enumeration: list all 10 systemd units

§12b "Post-Install: Start All Daemons" at lines ~1194–1199 lists 8 units. Add the missing two.

**Replace:**

```bash
systemctl start osmoda-agentd
systemctl start osmoda-keyd osmoda-watch osmoda-routines
systemctl start osmoda-mesh osmoda-mcpd osmoda-teachd
systemctl start osmoda-gateway   # modular agent gateway on port 18789
```

**With:**

```bash
systemctl start osmoda-agentd
systemctl start osmoda-keyd osmoda-watch osmoda-routines
systemctl start osmoda-mesh osmoda-mcpd osmoda-teachd
systemctl start osmoda-egress    # localhost-only HTTP CONNECT proxy
systemctl start osmoda-voice     # local whisper.cpp STT + piper TTS (optional)
systemctl start osmoda-gateway   # modular agent gateway on 127.0.0.1:18789
```

Update the corresponding `systemctl enable` line (a few lines below) to include `osmoda-egress osmoda-voice`. Update the status-check `for svc in …` loop similarly.

Update the deploy verification box just below ("Check status of all daemons") so it iterates the full ten.

---

## Edit 7 — Default model: match what spawn actually configures

§15b multi-agent table at lines ~2042–2043 lists:

```
osmoda → claude-opus-4-7
mobile → claude-sonnet-4-6
```

`agents.json` on every live spawned box currently shows `claude-opus-4-6`, not `4-7`. Fix this so the doc tells the truth.

**Replace line ~2042** with:

```html
<tr><td><code>osmoda</code></td><td><code>claude-opus-4-6</code></td><td>web, api</td><td>Default. Full system access. Detailed responses. Switchable to <code>claude-opus-4-7</code> per agent via the dashboard Engine tab → Model dropdown.</td></tr>
```

Leave the `mobile` row (`claude-sonnet-4-6`) as-is.

---

## Edit 8 — Update §14c wedge detection to reflect today's dual-signal fix

§14c at lines ~1768–1791 currently describes the **v1.3.1** single-signal (heartbeat-only) detection. Today's v1.3.25 ships dual-signal: wedge requires **both** `last_heartbeat` AND `agent_last_frame_at` to be stale before flipping `agent_wedged=true`. This fixes the false-positive class where the heartbeat-sender process was broken but the agent was actively streaming chat frames.

**Append a fourth bullet** to the "v1.3.1 ships three additive layers" intro paragraph:

```html
<p><strong>v1.3.25 update — dual-signal detection</strong>. The wedge detector now requires <strong>both</strong> the agentd heartbeat <em>and</em> the gateway chat-frame signal (<code>agent_last_frame_at</code>) to be stale before flipping <code>agent_wedged=true</code>. Recovery clears the flag the moment either signal goes fresh. This removes a false-positive class where the heartbeat sender was wedged but the agent was actively answering chat — previously the order showed "Agent stalled — restarting" while the agent was perfectly responsive. The recovery log now includes <code>alive_via: "heartbeat" | "agent_frame"</code> so operators can see which plane carried the heal.</p>
```

---

## Edit 9 — Add a "What's new since v1.3.1" section near the top

Insert a new section between the existing `<section>` for "01 The Problem We Solve" and "02 Three-Tier Trust Architecture" — call it `00b` (or replace the page's numbering scheme if you'd rather; pick whichever causes the least visual churn).

```html
<section>
  <h2><span class="num">00b</span> What's new since v1.3.1</h2>
  <p>The page underneath this banner was written at v1.3.1. The shipped product is at <strong>v1.3.25</strong> + gateway <strong>v0.2.1</strong>. Material changes since the original write-up:</p>
  <ul>
    <li><strong>v1.3.18</strong> — gateway binds to <code>127.0.0.1</code> by default (was <code>0.0.0.0</code>); single <code>bindCredentialToGateway()</code> path for dashboard + reseller key delivery.</li>
    <li><strong>v1.3.20</strong> — Stop button kills the whole process group, not just the leader. <code>detached: true</code> spawn + <code>process.kill(-pid, "SIGTERM")</code> + 2 s SIGKILL escalation.</li>
    <li><strong>v1.3.24</strong> — Long-running tasks supported. <code>CHAT_WATCHDOG_MS</code> 15 min, <code>FIRST_SIGNAL_TIMEOUT_MS</code> 10 min, <code>OSMODA_CHAT_HARD_CAP_MS</code> 8 h default (env-overridable). Same caps for both claude-code and openclaw drivers.</li>
    <li><strong>v1.3.25</strong> — Dual-signal wedge detection (heartbeat <em>and</em> chat-frame must both be stale before flagging wedged). Eliminates the "Agent stalled — restarting" false positive class.</li>
    <li><strong>gateway v0.2.1</strong> — Sessions persist to disk at <code>/var/lib/osmoda/state/sessions.json</code> (atomic tmp+rename, debounced 250 ms, mode 0600). Agent memory survives gateway restarts and idle gaps. <code>Session.runtime</code> tags every session so flipping claude-code ↔ openclaw via the Engine tab wipes the foreign session id and starts cleanly in the new runtime — no more "claude session not found" on swap.</li>
    <li><strong>install.sh</strong> — openclaw binary installed on every spawn (was: only when <code>--runtime=openclaw</code>). Engine-tab runtime swap now always lands on a present binary.</li>
  </ul>
</section>
```

Don't renumber existing sections to make room — just slot in `00b` before `01`.

---

## Verification (run after every edit, must all pass before deploy)

```bash
cd /Users/admin/Desktop/molt-os

# 1. No v1.3.1 in tool-count / version-stamp contexts.
#    Surviving v1.3.1 should ONLY appear in §14c heading + historical badges.
grep -nE "v1\.3\.1[^0-9]" apps/spawn/public/skill.html | grep -vE "v1\.3\.1 (NEW|Wedge)" | grep -vE "section 14c"
# Expect: 0 lines (or only ones you intentionally kept).

# 2. No 92 tool-count claims survive.
grep -nE "92 (MCP )?[Tt]ools?" apps/spawn/public/skill.html
# Expect: 0 lines.

# 3. No openclaw-config-set syntax survives.
grep -n "openclaw config set" apps/spawn/public/skill.html
# Expect: 0 lines.

# 4. No plaintext-api-key recommendation survives.
grep -n 'echo .sk-ant-' apps/spawn/public/skill.html
# Expect: 0 lines.

# 5. The phantom "message" tool entry is gone.
grep -nE '<td>message</td>|Channels.*multi-surface' apps/spawn/public/skill.html
# Expect: 0 lines.

# 6. Both osmoda-egress and osmoda-voice are in the systemctl block.
grep -nE 'systemctl (start|enable).*osmoda-(egress|voice)' apps/spawn/public/skill.html
# Expect: at least 2 lines.

# 7. v1.3.25 + gateway 0.2.1 mentioned.
grep -nE "v1\.3\.25|gateway.*0\.2\.1|dual-signal|sessions\.json" apps/spawn/public/skill.html
# Expect: at least 5 lines.

# 8. HTML still well-formed (best-effort).
python3 -c "
from html.parser import HTMLParser
class P(HTMLParser):
    def __init__(s): super().__init__(); s.stack=[]; s.errs=[]
    def handle_starttag(s,t,a):
        if t not in ('br','hr','img','meta','link','input','source','col','area'): s.stack.append(t)
    def handle_endtag(s,t):
        if s.stack and s.stack[-1]==t: s.stack.pop()
        elif t in s.stack: s.errs.append(f'tag mismatch: closing {t} but stack tip is {s.stack[-1]}'); s.stack.remove(t)
        else: s.errs.append(f'closing {t} with no open tag')
p=P()
p.feed(open('apps/spawn/public/skill.html').read())
print('tag errors:', len(p.errs), '— first 5:', p.errs[:5])
print('unclosed at end:', p.stack[-10:])
"
# Expect: tag errors: 0 (some whitespace-only mismatches in CDATA are OK; investigate if >5).
```

If every check passes, deploy:

```bash
cd /Users/admin/Desktop/molt-os/apps/spawn
bash push.sh
```

After deploy, confirm the live page reflects the changes:

```bash
curl -s https://spawn.os.moda/skill | grep -oE '<title>[^<]+</title>'
# Expect: <title>osmoda Architecture - 10 daemons, 91 tools, v1.3.25</title>

curl -s https://spawn.os.moda/skill | grep -c "openclaw config set"
# Expect: 0
```

---

## What NOT to do

- Don't open a PR. `apps/spawn` is **gitignored**. The only deploy path is `bash push.sh` from `apps/spawn/`.
- Don't touch `apps/spawn/server.js`. The `/skill` route just sends the file as-is.
- Don't rewrite the daemon descriptions, the mesh-crypto paragraph, the audit-ledger SQL schema, or the architecture diagram — those are accurate.
- Don't claim *any* enforcement that isn't in the code today. If unsure whether something is shipped, search the codebase or default to "on the v1.4 roadmap."
- Don't add emoji.

## File you're editing

`/Users/admin/Desktop/molt-os/apps/spawn/public/skill.html` — 2275 lines, single self-contained HTML file with inline CSS.

## When you're done

Reply with:
1. The summary of edits applied (count + section names, not full diffs).
2. The output of every `grep` in the Verification block.
3. Confirmation that `bash push.sh` succeeded and the curl checks return expected values.
