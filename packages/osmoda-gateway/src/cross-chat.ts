/**
 * Cross-chat awareness digest.
 *
 * Named chats are isolated conversations, but they all act on ONE shared root
 * filesystem + services. So each chat must be AWARE of the significant things
 * OTHER chats did — without inhaling their transcripts (that defeats isolation
 * and blows the window).
 *
 * SOURCE (verified by the design audit): the gateway's OWN per-chat transcript
 * tool_use rows. The claude-code driver emits a tool_use for EVERY tool block
 * (native Bash/Write/Edit included) and index.ts persists name+target+outcome
 * per chat — the only source that is both populated with real changes AND
 * correctly chat-attributed. (The agentd ledger was rejected: it records no
 * file/deploy/service events.)
 *
 * MECHANISM: per consumer-chat we keep a per-peer high-water-mark (seq) cursor
 * in the ChatRegistry. Each turn we read each peer's NEW notable tool rows since
 * that mark, render a BOUNDED deterministic digest (no LLM call — OAuth tokens
 * can't hit /v1/messages anyway), and advance the cursor ONLY after the turn
 * succeeds. Steady-state single-chat work => no peers => empty => zero tokens.
 */

import type { TranscriptStore } from "./transcript.js";
import type { ChatRegistry } from "./chats.js";

// Pure-read tools carry no "change" — exclude them so the digest is signal, not
// noise. Everything else (Write/Edit/Bash/shell_exec/file_write/app_*/service
// mutations/nix/…) is treated as a notable change worth surfacing.
const READ_ONLY_TOOLS = new Set([
  "read", "grep", "glob", "directory_list", "file_read", "webfetch",
  "system_query", "system_health", "system_discover", "network_info",
  "service_status", "journal_logs", "event_log", "memory_recall", "agent_card",
  "codegraph_search", "codegraph_context", "codegraph_callers", "codegraph_callees",
  "codegraph_node", "codegraph_explore", "codegraph_files", "codegraph_status",
]);

const MAX_PER_PEER = 6;        // notable actions shown per peer chat
const MAX_PEERS = 8;          // peer chats shown
const MAX_PEERS_SCANNED = 16; // peer transcripts read per turn (bounds O(N) cost)
const MAX_CHARS = 1600;       // ~400 tokens hard cap on the whole digest

function verbFor(name: string): string {
  const n = name.toLowerCase();
  if (n === "write" || n === "file_write") return "wrote";
  if (n === "edit") return "edited";
  if (n === "bash" || n === "shell_exec") return "ran";
  if (n.startsWith("app_")) return name.replace(/^app_/, "app ");
  if (n.startsWith("service_")) return name.replace(/^service_/, "service ");
  return name;
}

export interface CrossChatDigest {
  text: string | null;                              // injected into the turn, or null (nothing new)
  peers: number;                                    // how many peer chats contributed (for the UI chip)
  advance: Array<{ peerKey: string; seq: number }>; // cursors to commit AFTER a successful turn
}

/**
 * Build the cross-chat digest for `currentChatKey`. Pure + best-effort: never
 * throws (caller wraps anyway), returns {text:null} when there's nothing new.
 */
export function buildCrossChatDigest(
  transcripts: TranscriptStore,
  chats: ChatRegistry,
  agentId: string,
  currentChatKey: string,
): CrossChatDigest {
  const advance: Array<{ peerKey: string; seq: number }> = [];
  const blocks: string[] = [];
  // list() is sorted by last_active desc; scan only the most-recently-active
  // peers so the per-turn cost is bounded regardless of total chat count.
  const peers = chats.list(false).filter((c) => c.key !== currentChatKey).slice(0, MAX_PEERS_SCANNED);

  for (const peer of peers) {
    const cursor = chats.getCursor(currentChatKey, peer.key); // -1 if unseen
    if (cursor < 0) {
      // Unseen peer → START CAUGHT-UP to its head: emit NO digest now (never
      // replay a peer's whole backlog the first time this chat runs), and ALWAYS
      // commit the head cursor — even head=0 — so the next turn enters the delta
      // branch and surfaces work done AFTER this point (committing only on head>0
      // would leave the cursor at -1 and silently swallow the peer's next rows).
      advance.push({ peerKey: peer.key, seq: transcripts.headSeq(agentId, peer.key) });
      continue;
    }
    const evs = transcripts.read(agentId, peer.key, cursor);
    if (!evs.length) continue;
    // Advance to this peer's head regardless of notability, so we never re-scan
    // already-seen rows (incl. pure reads) next turn.
    advance.push({ peerKey: peer.key, seq: evs[evs.length - 1].seq });

    const notable = evs.filter(
      (e) => e.role === "tool" && e.kind === "use" && e.name && !READ_ONLY_TOOLS.has(e.name.toLowerCase()),
    );
    if (!notable.length) continue;

    const shown = notable.slice(-MAX_PER_PEER);
    const omitted = notable.length - shown.length;
    const acts = shown.map((e) => `${verbFor(e.name!)}${e.target ? " " + String(e.target).replace(/\s+/g, " ").slice(0, 60) : ""}`);
    let line = `- **${peer.name}**: ${acts.join("; ")}`;
    if (omitted > 0) line += ` (+${omitted} earlier)`;
    blocks.push(line);
    if (blocks.length >= MAX_PEERS) break;
  }

  if (!blocks.length) return { text: null, peers: 0, advance };

  let body = blocks.join("\n");
  if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS) + "\n…(more changes omitted)";
  const text =
    `[Cross-chat update — significant changes OTHER chats on this server made since you last ran here. ` +
    `The filesystem and services are SHARED across chats, so re-check current state before acting on anything below. ` +
    `This is context, NOT a user request.]\n` +
    body +
    `\n[End cross-chat update.]`;
  return { text, peers: blocks.length, advance };
}
