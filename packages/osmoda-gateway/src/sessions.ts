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

import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_PATH =
  process.env.OSMODA_SESSIONS_PATH ||
  (process.env.OSMODA_CONFIG_DIR
    ? path.join(process.env.OSMODA_CONFIG_DIR!, "..", "state", "sessions.json")
    : "/var/lib/osmoda/state/sessions.json");

const MAX_SESSIONS = 1000;
const SAVE_DEBOUNCE_MS = 250;

export interface Session {
  id: string;
  agentId: string;
  claudeSessionId?: string;
  lastActivity: number;
  userId: string;
  channel: string;
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly path: string;

  constructor(diskPath?: string) {
    this.path = diskPath ?? DEFAULT_PATH;
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.path, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data?.sessions)) {
        for (const s of data.sessions) {
          if (s && typeof s.id === "string" && typeof s.userId === "string" && typeof s.channel === "string") {
            this.sessions.set(`${s.channel}:${s.userId}`, {
              id: s.id,
              agentId: s.agentId ?? "default",
              claudeSessionId: s.claudeSessionId,
              lastActivity: typeof s.lastActivity === "number" ? s.lastActivity : Date.now(),
              userId: s.userId,
              channel: s.channel,
            });
          }
        }
      }
      // eslint-disable-next-line no-console
      console.log(`[sessions] Loaded ${this.sessions.size} sessions from ${this.path}`);
    } catch (e: any) {
      if (e?.code !== "ENOENT") {
        // eslint-disable-next-line no-console
        console.warn(`[sessions] Could not load ${this.path}:`, e?.message || e);
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  private saveNow(): void {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      const data = {
        version: 1,
        saved_at: new Date().toISOString(),
        sessions: Array.from(this.sessions.values()),
      };
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.path);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn(`[sessions] Could not save ${this.path}:`, e?.message || e);
    }
  }

  /** Force a synchronous flush (call on SIGTERM if you want to be paranoid). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveNow();
  }

  getOrCreate(userId: string, channel: string, agentId: string): Session {
    const key = `${channel}:${userId}`;
    const existing = this.sessions.get(key);
    const now = Date.now();

    if (existing) {
      existing.lastActivity = now;
      if (existing.agentId !== agentId) existing.agentId = agentId;
      this.scheduleSave();
      // eslint-disable-next-line no-console
      console.log(
        `[sessions] resume key=${key} claude_session=${existing.claudeSessionId || "(none yet)"}`,
      );
      return existing;
    }

    const session: Session = {
      id: `sess-${now}-${Math.random().toString(36).slice(2, 8)}`,
      agentId,
      claudeSessionId: undefined,
      lastActivity: now,
      userId,
      channel,
    };
    this.sessions.set(key, session);
    this.evictIfOver();
    this.scheduleSave();
    // eslint-disable-next-line no-console
    console.log(`[sessions] NEW key=${key} session=${session.id}`);
    return session;
  }

  updateClaudeSession(userId: string, channel: string, claudeSessionId: string): void {
    const key = `${channel}:${userId}`;
    const session = this.sessions.get(key);
    if (!session) return;
    const changed = session.claudeSessionId !== claudeSessionId;
    session.claudeSessionId = claudeSessionId;
    session.lastActivity = Date.now();
    if (changed) {
      // eslint-disable-next-line no-console
      console.log(`[sessions] bind key=${key} claude_session=${claudeSessionId}`);
    }
    this.scheduleSave();
  }

  /** Forget the claude session id (e.g. user asks to start over). */
  clearClaudeSession(userId: string, channel: string): void {
    const key = `${channel}:${userId}`;
    const session = this.sessions.get(key);
    if (!session) return;
    session.claudeSessionId = undefined;
    this.scheduleSave();
  }

  private evictIfOver(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const sorted = Array.from(this.sessions.entries()).sort(
      (a, b) => a[1].lastActivity - b[1].lastActivity,
    );
    const toRemove = this.sessions.size - MAX_SESSIONS;
    for (let i = 0; i < toRemove; i++) {
      this.sessions.delete(sorted[i][0]);
    }
  }

  /**
   * No-op for backwards-compat with the old 30-min prune timer.
   * Keeping the method so index.ts setInterval(...) still compiles unchanged.
   * Sessions are never silently expired anymore — only LRU-evicted when the
   * store exceeds MAX_SESSIONS.
   */
  prune(): number {
    return 0;
  }

  get size(): number {
    return this.sessions.size;
  }
}
