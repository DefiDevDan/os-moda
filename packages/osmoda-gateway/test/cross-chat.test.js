import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// TranscriptStore reads its dir from env at module load — set it before the
// dynamic import below so the store writes into our temp dir.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "xchat-"));
process.env.OSMODA_TRANSCRIPT_DIR = path.join(ROOT, "transcripts");

const { TranscriptStore } = await import("../dist/transcript.js");
const { ChatRegistry } = await import("../dist/chats.js");
const { buildCrossChatDigest } = await import("../dist/cross-chat.js");

const AGENT = "osmoda";

function fixture(label) {
  const transcripts = new TranscriptStore();
  const chats = new ChatRegistry(path.join(ROOT, `chats-${label}.json`));
  return { transcripts, chats };
}

test("new chat starts CAUGHT-UP (no backlog flood), then sees only changes made AFTER", () => {
  const { transcripts, chats } = fixture("a");
  const A = chats.resolveOrCreate("Infra"); // consumer
  const B = chats.resolveOrCreate("LIR Scrapers"); // peer
  // Peer B did work BEFORE the consumer ever ran (this is the backlog).
  transcripts.append(AGENT, B.key, { role: "tool", kind: "use", name: "Read", target: "/srv/x.js" });
  transcripts.append(AGENT, B.key, { role: "tool", kind: "use", name: "Write", target: "/srv/old.js" });
  transcripts.append(AGENT, B.key, { role: "tool", kind: "use", name: "shell_exec", target: "systemctl restart lirr" });

  // A's first turn: must NOT replay B's backlog — start caught-up to B's head.
  const dg1 = buildCrossChatDigest(transcripts, chats, AGENT, A.key);
  assert.equal(dg1.text, null, "brand-new chat is caught-up: NO backlog digest");
  assert.ok(dg1.advance.find((a) => a.peerKey === B.key), "but the cursor advances to B's head");
  for (const a of dg1.advance) chats.setCursor(A.key, a.peerKey, a.seq); // commit (as index.ts does on success)

  // Now B does NEW work AFTER A caught up.
  transcripts.append(AGENT, B.key, { role: "tool", kind: "use", name: "Edit", target: "/srv/scraper.js" });
  transcripts.append(AGENT, B.key, { role: "tool", kind: "use", name: "Read", target: "/srv/scraper.js" });

  const dg2 = buildCrossChatDigest(transcripts, chats, AGENT, A.key);
  assert.ok(dg2.text, "new post-catch-up change surfaces");
  assert.match(dg2.text, /LIR Scrapers/);
  assert.match(dg2.text, /edited \/srv\/scraper\.js/, "the NEW change shows");
  assert.doesNotMatch(dg2.text, /old\.js|restart lirr/, "backlog never replayed");
  assert.doesNotMatch(dg2.text, /Read/, "pure-read tool excluded");
  assert.equal(dg2.peers, 1);
  for (const a of dg2.advance) chats.setCursor(A.key, a.peerKey, a.seq);

  // Nothing new since → empty (zero token cost in steady state).
  assert.equal(buildCrossChatDigest(transcripts, chats, AGENT, A.key).text, null);
});

test("cross-CHANNEL: a web chat's digest surfaces Telegram (mobile-agent) changes", () => {
  const { transcripts, chats } = fixture("xchannel");
  const web = chats.resolveOrCreate("Infra"); // agentId "osmoda"
  const tg = chats.register("tg-555", { agentId: "mobile", name: "Telegram 555" });
  assert.equal(tg.agentId, "mobile", "Telegram peer is owned by the mobile agent");
  // Catch the web chat up to the (empty) Telegram head first.
  for (const a of buildCrossChatDigest(transcripts, chats, "osmoda", web.key).advance) chats.setCursor(web.key, a.peerKey, a.seq);
  // A change made via Telegram is written under the mobile agent's transcript.
  transcripts.append("mobile", tg.key, { role: "tool", kind: "use", name: "Write", target: "/srv/deployed-via-phone.js" });
  // The web chat (osmoda agent) must still see it — cross-CHANNEL, not just cross-chat.
  const dg = buildCrossChatDigest(transcripts, chats, "osmoda", web.key);
  assert.ok(dg.text, "web chat sees the Telegram-originated change");
  assert.match(dg.text, /Telegram 555/);
  assert.match(dg.text, /deployed-via-phone\.js/);
});

test("a chat never sees its OWN activity, and a lone chat has no digest", () => {
  const { transcripts, chats } = fixture("b");
  const only = chats.resolveOrCreate("Solo");
  transcripts.append(AGENT, only.key, { role: "tool", kind: "use", name: "Write", target: "/a" });
  const dg = buildCrossChatDigest(transcripts, chats, AGENT, only.key);
  assert.equal(dg.text, null, "no peers → null (zero overhead for single-chat work)");
});

test("digest is bounded — a SEEN peer's many new actions are capped + elided", () => {
  const { transcripts, chats } = fixture("c");
  const A = chats.resolveOrCreate("Consumer");
  const B = chats.resolveOrCreate("Busy");
  // Catch A up to B's (empty) head first, so subsequent rows are "new".
  for (const a of buildCrossChatDigest(transcripts, chats, AGENT, A.key).advance) chats.setCursor(A.key, a.peerKey, a.seq);
  for (let i = 0; i < 50; i++) {
    transcripts.append(AGENT, B.key, { role: "tool", kind: "use", name: "Write", target: "/f" + i });
  }
  const dg = buildCrossChatDigest(transcripts, chats, AGENT, A.key);
  assert.ok(dg.text && dg.text.length < 1800, "digest hard-capped (~400 tokens)");
  assert.match(dg.text, /earlier\)/, "elision marker present");
});
