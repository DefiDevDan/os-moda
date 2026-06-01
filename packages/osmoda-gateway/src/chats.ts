/**
 * Named-chat registry — multiple distinct, persistent conversations per server.
 *
 * WHY: a server may host many parallel threads of work ("lir-scrapers",
 * "infra-hardening", "marketing-site"). Each named chat must keep its OWN
 * conversation history. The gateway already gives that for free: a chat's
 * identity IS its `sessionKey` (the userId half of SessionStore's
 * `${channel}:${userId}` key and TranscriptStore's per-key JSONL file). So a
 * chat = a sessionKey + a display name + lifecycle/cursor metadata. This module
 * is ONLY the registry (names, slugs, archived, last_active, and the per-peer
 * read cursors used by the cross-chat awareness digest). It does NOT touch the
 * isolation machinery — switching chats is just switching which sessionKey the
 * frames carry.
 *
 * Cross-chat awareness (GW2) reads `cursors`: per consumer-chat, a map of
 * peer-chat-key → last-seen transcript seq, so each chat is shown only the
 * NEW significant activity from OTHER chats since it last ran.
 *
 * Storage mirrors SessionStore exactly: in-memory Map, debounced atomic
 * tmp+rename to chats.json, no TTL.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_PATH =
  process.env.OSMODA_CHATS_PATH ||
  (process.env.OSMODA_CONFIG_DIR
    ? path.join(process.env.OSMODA_CONFIG_DIR!, "..", "state", "chats.json")
    : "/var/lib/osmoda/state/chats.json");

const SAVE_DEBOUNCE_MS = 250;
const MAX_NAME = 60;

export interface Chat {
  key: string;                       // the sessionKey/userId — the chat's identity
  name: string;                      // human display name
  slug: string;                      // slugified name (resolution handle)
  created_at: number;
  last_active: number;
  archived: boolean;
  cursors: Record<string, number>;   // peerChatKey -> last-seen transcript seq (GW2)
}

/** Lowercase, [a-z0-9-], collapsed/trimmed. Survives transcript.ts sanitize(). */
export function slugify(name: string): string {
  return (
    String(name || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "chat"
  );
}

/** A brand-new named chat's sessionKey. Hyphen-delimited, never ':' (':' is
 * the reserved channel:userId separator) and never '_' (a legal slug char). */
export function chatKeyForSlug(slug: string): string {
  return "chat-" + slug;
}

/** Is this a legacy/canonical "main" key (pre-named-chats)? The box relay sends
 * `spawn-<id8>`; a no-sessionKey client falls back to `ws-default`. Both are the
 * one original conversation → they map to the "main" chat for continuity. */
function isLegacyMainKey(key: string): boolean {
  return key === "ws-default" || /^spawn-/.test(key) || key === "main" || key === "chat-main";
}

export class ChatRegistry {
  private chats = new Map<string, Chat>(); // key -> Chat
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly path: string;

  constructor(diskPath?: string) {
    this.path = diskPath ?? DEFAULT_PATH;
    this.load();
  }

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.path, "utf8"));
      if (Array.isArray(data?.chats)) {
        for (const c of data.chats) {
          if (c && typeof c.key === "string") {
            this.chats.set(c.key, {
              key: c.key,
              name: typeof c.name === "string" ? c.name : c.key,
              slug: typeof c.slug === "string" ? c.slug : slugify(c.name || c.key),
              created_at: typeof c.created_at === "number" ? c.created_at : Date.now(),
              last_active: typeof c.last_active === "number" ? c.last_active : Date.now(),
              archived: !!c.archived,
              cursors: c.cursors && typeof c.cursors === "object" ? c.cursors : {},
            });
          }
        }
      }
      // eslint-disable-next-line no-console
      console.log(`[chats] loaded ${this.chats.size} chats from ${this.path}`);
    } catch (e: any) {
      if (e?.code !== "ENOENT") console.warn(`[chats] could not load ${this.path}:`, e?.message || e);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, SAVE_DEBOUNCE_MS);
  }

  private saveNow(): void {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, saved_at: new Date().toISOString(), chats: Array.from(this.chats.values()) }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.path);
    } catch (e: any) {
      console.warn(`[chats] could not save ${this.path}:`, e?.message || e);
    }
  }

  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.saveNow();
  }

  private bySlug(slug: string): Chat | undefined {
    for (const c of this.chats.values()) if (c.slug === slug) return c;
    return undefined;
  }

  private hasMain(): boolean {
    return this.bySlug("main") !== undefined;
  }

  /**
   * Lazily register a sessionKey that arrived WITHOUT an explicit chatId
   * (legacy relay path). Does NOT change routing — the caller keeps using the
   * same key — it only makes the chat visible in the list. The first
   * legacy/canonical key becomes "Main"; other distinct keys become their own
   * chats so direct/test sessions never collapse into Main.
   */
  register(key: string): Chat {
    const existing = this.chats.get(key);
    if (existing) { this.touch(key); return existing; }
    let name: string, slug: string;
    if (isLegacyMainKey(key) && !this.hasMain()) {
      name = "Main"; slug = "main";
    } else {
      slug = slugify(key);
      if (this.bySlug(slug)) slug = slug + "-" + (this.chats.size + 1);
      name = key;
    }
    const now = Date.now();
    const chat: Chat = { key, name, slug, created_at: now, last_active: now, archived: false, cursors: {} };
    this.chats.set(key, chat);
    this.scheduleSave();
    return chat;
  }

  /**
   * Resolve a chatId (which may be an exact key, a slug, or a display name) to a
   * chat — creating a new named chat if it doesn't exist yet. This is the path
   * for the named-chat UI/relay (msg.chatId). "main" always resolves to the
   * existing Main chat (preserving the legacy key's history) rather than
   * minting a fresh chat-main.
   */
  resolveOrCreate(idOrName: string): Chat {
    const raw = String(idOrName || "").trim();
    if (!raw) return this.register("ws-default");
    // 1) exact key
    const byKey = this.chats.get(raw);
    if (byKey) { this.touch(raw); return byKey; }
    // 2) by slug (covers "main", a name, or "My Chat")
    const slug = slugify(raw);
    const bySlugMatch = this.bySlug(slug);
    if (bySlugMatch) { this.touch(bySlugMatch.key); return bySlugMatch; }
    // 3) create a new named chat
    let key = chatKeyForSlug(slug);
    let n = 2;
    while (this.chats.get(key)) { key = chatKeyForSlug(slug + "-" + n++); }
    const now = Date.now();
    const chat: Chat = { key, name: raw.slice(0, MAX_NAME), slug, created_at: now, last_active: now, archived: false, cursors: {} };
    this.chats.set(key, chat);
    this.scheduleSave();
    // eslint-disable-next-line no-console
    console.log(`[chats] created "${chat.name}" key=${key}`);
    return chat;
  }

  get(key: string): Chat | undefined { return this.chats.get(key); }

  list(includeArchived = false): Chat[] {
    return Array.from(this.chats.values())
      .filter((c) => includeArchived || !c.archived)
      .sort((a, b) => b.last_active - a.last_active);
  }

  rename(key: string, name: string): Chat | undefined {
    const c = this.chats.get(key);
    if (!c) return undefined;
    c.name = String(name || c.name).slice(0, MAX_NAME);
    this.scheduleSave();
    return c;
  }

  setArchived(key: string, archived: boolean): Chat | undefined {
    const c = this.chats.get(key);
    if (!c) return undefined;
    c.archived = !!archived;
    this.scheduleSave();
    return c;
  }

  touch(key: string): void {
    const c = this.chats.get(key);
    if (c) { c.last_active = Date.now(); this.scheduleSave(); }
  }

  /** Cross-chat awareness cursor (GW2): last transcript seq of `peerKey` that
   * `chatKey` has already been shown. Missing/corrupt → caught-up sentinel -1
   * (caller treats as "current head", never replays the full backlog). */
  getCursor(chatKey: string, peerKey: string): number {
    const c = this.chats.get(chatKey);
    const v = c?.cursors?.[peerKey];
    return typeof v === "number" ? v : -1;
  }

  setCursor(chatKey: string, peerKey: string, seq: number): void {
    const c = this.chats.get(chatKey);
    if (!c) return;
    c.cursors = c.cursors || {};
    c.cursors[peerKey] = seq;
    this.scheduleSave();
  }

  get size(): number { return this.chats.size; }
}
