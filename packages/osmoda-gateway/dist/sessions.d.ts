/**
 * Session management — maps user/channel → Claude Code session id used for `--resume`.
 *
 * Storage model:
 *   - In-memory Map for O(1) lookup.
 *   - Persisted to disk so the agent keeps its context across gateway restarts
 *     (config reloads, wedge auto-restart, install.sh re-runs, OS reboots).
 *   - No TTL on read: a single-tenant box should never make the user lose
 *     their agent's memory just because they walked away for 30 minutes.
 *   - Bounded by MAX_SESSIONS with LRU eviction so the file can't grow forever
 *     on shared/integrator boxes.
 *
 * File format (JSON):
 *   { "version": 1, "sessions": [ Session, ... ] }
 *
 * Writes are debounced (250ms) and atomic (tmp + rename).
 */
export interface Session {
    id: string;
    agentId: string;
    claudeSessionId?: string;
    lastActivity: number;
    userId: string;
    channel: string;
}
export declare class SessionStore {
    private sessions;
    private saveTimer;
    private readonly path;
    constructor(diskPath?: string);
    private load;
    private scheduleSave;
    private saveNow;
    /** Force a synchronous flush (call on SIGTERM if you want to be paranoid). */
    flush(): void;
    getOrCreate(userId: string, channel: string, agentId: string): Session;
    updateClaudeSession(userId: string, channel: string, claudeSessionId: string): void;
    /** Forget the claude session id (e.g. user asks to start over). */
    clearClaudeSession(userId: string, channel: string): void;
    private evictIfOver;
    /**
     * No-op for backwards-compat with the old 30-min prune timer.
     * Keeping the method so index.ts setInterval(...) still compiles unchanged.
     * Sessions are never silently expired anymore — only LRU-evicted when the
     * store exceeds MAX_SESSIONS.
     */
    prune(): number;
    get size(): number;
}
