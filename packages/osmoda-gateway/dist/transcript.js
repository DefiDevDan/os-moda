/**
 * Gateway-owned canonical transcript — modelled on OpenClaw's session store.
 *
 * OpenClaw's defining principle: "All session state is owned by the gateway.
 * UI clients query the gateway for session data." osModa previously split this
 * three ways — the runtime CLI owned its own transcript jsonl, the spawn-app
 * kept a SEPARATE dash-chat NDJSON for the dashboard, and the gateway kept only
 * the {channel:userId → sessionId} map. Those copies drifted (the cause of the
 * garbled "reopen is a total mess" reports).
 *
 * This store makes the GATEWAY the single source of truth for the conversation
 * itself: one JSONL file per session key, one event per line, written as events
 * stream through. It is:
 *   - the canonical record the dashboard reads (no more divergent copies)
 *   - a durable archive that outlives the runtime's own session file
 *   - the basis for re-seeding context if the runtime session is wiped or the
 *     runtime is swapped (claude-code ↔ openclaw) — see buildRecap()
 *
 *   /var/lib/osmoda/state/transcripts/<agentId>/<sessionKey>.jsonl
 */
import * as fs from "node:fs";
import * as path from "node:path";
const TRANSCRIPT_DIR = process.env.OSMODA_TRANSCRIPT_DIR ||
    (process.env.OSMODA_CONFIG_DIR
        ? path.join(process.env.OSMODA_CONFIG_DIR, "..", "state", "transcripts")
        : "/var/lib/osmoda/state/transcripts");
function sanitize(s) {
    return String(s).replace(/[^a-zA-Z0-9_:.@-]/g, "_").slice(0, 200);
}
export class TranscriptStore {
    seqByKey = new Map();
    fileFor(agentId, sessionKey) {
        return path.join(TRANSCRIPT_DIR, sanitize(agentId), `${sanitize(sessionKey)}.jsonl`);
    }
    /** Append one event. Best-effort — never throws into the chat path. */
    append(agentId, sessionKey, ev) {
        try {
            const file = this.fileFor(agentId, sessionKey);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const cacheKey = `${agentId}:${sessionKey}`;
            if (!this.seqByKey.has(cacheKey)) {
                let n = 0;
                try {
                    n = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
                }
                catch {
                    /* new file */
                }
                this.seqByKey.set(cacheKey, n);
            }
            const seq = (this.seqByKey.get(cacheKey) || 0) + 1;
            this.seqByKey.set(cacheKey, seq);
            const full = {
                seq,
                ts: ev.ts || new Date().toISOString(),
                role: ev.role,
                ...(ev.kind ? { kind: ev.kind } : {}),
                ...(ev.text ? { text: ev.text } : {}),
                ...(ev.name ? { name: ev.name } : {}),
                ...(ev.target ? { target: ev.target } : {}),
                ...(ev.outcome ? { outcome: ev.outcome } : {}),
                ...(ev.request_id ? { request_id: ev.request_id } : {}),
                ...(ev.source ? { source: ev.source } : {}),
            };
            fs.appendFileSync(file, JSON.stringify(full) + "\n", { mode: 0o600 });
        }
        catch {
            /* best-effort persistence; chat must never break on a disk hiccup */
        }
    }
    /**
     * Highest seq currently on disk for this key (0 if none). For an append-only
     * file seq == line count, so this is one cheap read with no JSON parse — used
     * by the cross-chat digest to mark a brand-new chat "caught up to head"
     * WITHOUT materializing the peer's whole backlog.
     */
    headSeq(agentId, sessionKey) {
        try {
            const file = this.fileFor(agentId, sessionKey);
            return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
        }
        catch {
            return 0;
        }
    }
    /** Read events with seq > sinceSeq. */
    read(agentId, sessionKey, sinceSeq = 0) {
        try {
            const file = this.fileFor(agentId, sessionKey);
            return fs
                .readFileSync(file, "utf8")
                .split("\n")
                .filter(Boolean)
                .map((l) => {
                try {
                    return JSON.parse(l);
                }
                catch {
                    return null;
                }
            })
                .filter((e) => !!e && typeof e.seq === "number" && e.seq > sinceSeq);
        }
        catch {
            return [];
        }
    }
    /** List all known session transcripts with light metadata. */
    list() {
        const out = [];
        try {
            for (const agentId of fs.readdirSync(TRANSCRIPT_DIR)) {
                const dir = path.join(TRANSCRIPT_DIR, agentId);
                let files;
                try {
                    files = fs.readdirSync(dir);
                }
                catch {
                    continue;
                }
                for (const f of files) {
                    if (!f.endsWith(".jsonl"))
                        continue;
                    const full = path.join(dir, f);
                    let events = 0;
                    let updated_at = "";
                    try {
                        const stat = fs.statSync(full);
                        updated_at = stat.mtime.toISOString();
                        events = fs.readFileSync(full, "utf8").split("\n").filter(Boolean).length;
                    }
                    catch {
                        /* skip */
                    }
                    out.push({ agentId, sessionKey: f.replace(/\.jsonl$/, ""), events, updated_at });
                }
            }
        }
        catch {
            /* no transcripts yet */
        }
        return out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    }
    /**
     * Build a compact recap of prior turns, for re-seeding a fresh runtime
     * session (wiped session file, or a claude-code ↔ openclaw swap). Keeps the
     * tail within maxChars so the recap never dominates the context window —
     * the runtime will compact further if needed.
     */
    buildRecap(agentId, sessionKey, maxChars = 6000) {
        const evs = this.read(agentId, sessionKey);
        if (!evs.length)
            return null;
        const lines = [];
        for (const e of evs) {
            if (e.role === "user" && e.text)
                lines.push(`User: ${e.text}`);
            else if (e.role === "assistant" && e.text)
                lines.push(`You (osModa): ${e.text}`);
            else if (e.role === "tool" && e.kind === "use" && e.name)
                lines.push(`[you ran tool ${e.name}${e.target ? " · " + e.target : ""}]`);
        }
        if (!lines.length)
            return null;
        let recap = lines.join("\n");
        if (recap.length > maxChars) {
            recap = "…[earlier turns omitted for brevity]\n" + recap.slice(recap.length - maxChars);
        }
        return recap;
    }
}
