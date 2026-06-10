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
export interface TranscriptEvent {
    seq: number;
    ts: string;
    role: "user" | "assistant" | "tool";
    kind?: "use" | "result";
    text?: string;
    name?: string;
    target?: string;
    outcome?: string;
    request_id?: string;
    source?: string;
}
export type TranscriptInput = Omit<TranscriptEvent, "seq" | "ts"> & {
    ts?: string;
};
export declare class TranscriptStore {
    private seqByKey;
    private fileFor;
    /** Append one event. Best-effort — never throws into the chat path. */
    append(agentId: string, sessionKey: string, ev: TranscriptInput): void;
    /**
     * Highest seq currently on disk for this key (0 if none). For an append-only
     * file seq == line count, so this is one cheap read with no JSON parse — used
     * by the cross-chat digest to mark a brand-new chat "caught up to head"
     * WITHOUT materializing the peer's whole backlog.
     */
    headSeq(agentId: string, sessionKey: string): number;
    /** Read events with seq > sinceSeq. */
    read(agentId: string, sessionKey: string, sinceSeq?: number): TranscriptEvent[];
    /** List all known session transcripts with light metadata. */
    list(): Array<{
        agentId: string;
        sessionKey: string;
        events: number;
        updated_at: string;
    }>;
    /**
     * Build a compact recap of prior turns, for re-seeding a fresh runtime
     * session (wiped session file, or a claude-code ↔ openclaw swap). Keeps the
     * tail within maxChars so the recap never dominates the context window —
     * the runtime will compact further if needed.
     */
    buildRecap(agentId: string, sessionKey: string, maxChars?: number): string | null;
}
