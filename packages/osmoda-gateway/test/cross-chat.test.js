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

test("digest surfaces OTHER chats' notable changes, skips reads, advances cursor", () => {
  const { transcripts, chats } = fixture("a");
  const A = chats.resolveOrCreate("Infra"); // consumer
  const B = chats.resolveOrCreate("LIR Scrapers"); // peer
  // Peer B does work (mutations + a read).
  transcripts.append(AGENT, B.key, { role: "tool", kind: "use", name: "Read", target: "/srv/x.js" });
  transcripts.append(AGENT, B.key, { role: "tool", kind: "use", name: "Write", target: "/srv/scraper.js" });
  transcripts.append(AGENT, B.key, { role: "tool", kind: "use", name: "shell_exec", target: "systemctl restart lirr" });
  transcripts.append(AGENT, B.key, { role: "assistant", text: "done" });

  const dg = buildCrossChatDigest(transcripts, chats, AGENT, A.key);
  assert.ok(dg.text, "digest produced");
  assert.match(dg.text, /LIR Scrapers/);
  assert.match(dg.text, /wrote \/srv\/scraper\.js/);
  assert.match(dg.text, /ran systemctl restart lirr/);
  assert.doesNotMatch(dg.text, /Read|x\.js/, "pure-read tool excluded");
  assert.equal(dg.peers, 1);
  // Commit the cursor (as index.ts does after a successful turn).
  for (const a of dg.advance) chats.setCursor(A.key, a.peerKey, a.seq);

  // Nothing new since → empty digest (no token cost in steady state).
  const dg2 = buildCrossChatDigest(transcripts, chats, AGENT, A.key);
  assert.equal(dg2.text, null, "no new peer activity → null");

  // Peer B does ONE more thing → only that shows.
  transcripts.append(AGENT, B.key, { role: "tool", kind: "use", name: "Edit", target: "/srv/scraper.js" });
  const dg3 = buildCrossChatDigest(transcripts, chats, AGENT, A.key);
  assert.ok(dg3.text);
  assert.match(dg3.text, /edited \/srv\/scraper\.js/);
  assert.doesNotMatch(dg3.text, /restart lirr/, "already-seen rows not repeated");
});

test("a chat never sees its OWN activity, and a lone chat has no digest", () => {
  const { transcripts, chats } = fixture("b");
  const only = chats.resolveOrCreate("Solo");
  transcripts.append(AGENT, only.key, { role: "tool", kind: "use", name: "Write", target: "/a" });
  const dg = buildCrossChatDigest(transcripts, chats, AGENT, only.key);
  assert.equal(dg.text, null, "no peers → null (zero overhead for single-chat work)");
});

test("digest is bounded — many peer actions are capped + elided", () => {
  const { transcripts, chats } = fixture("c");
  const A = chats.resolveOrCreate("Consumer");
  const B = chats.resolveOrCreate("Busy");
  for (let i = 0; i < 50; i++) {
    transcripts.append(AGENT, B.key, { role: "tool", kind: "use", name: "Write", target: "/f" + i });
  }
  const dg = buildCrossChatDigest(transcripts, chats, AGENT, A.key);
  assert.ok(dg.text.length < 1800, "digest hard-capped (~400 tokens)");
  assert.match(dg.text, /earlier\)/, "elision marker present");
});
