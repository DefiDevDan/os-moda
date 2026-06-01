import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChatRegistry, slugify, chatKeyForSlug } from "../dist/chats.js";

function tmpReg() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chats-")), "chats.json");
  return { reg: new ChatRegistry(p), path: p };
}

test("slugify is filesystem/transcript safe", () => {
  assert.equal(slugify("LIR Scrapers!"), "lir-scrapers");
  assert.equal(slugify("  Infra / Hardening  "), "infra-hardening");
  assert.equal(slugify(""), "chat");
  assert.equal(chatKeyForSlug("lir-scrapers"), "chat-lir-scrapers");
  // no ':' (reserved) or '_' (ambiguous) in keys
  assert.ok(!/[:_]/.test(chatKeyForSlug(slugify("My_Chat:1"))));
});

test("resolveOrCreate makes one chat per name, idempotent by slug", () => {
  const { reg } = tmpReg();
  const a = reg.resolveOrCreate("LIR Scrapers");
  assert.equal(a.key, "chat-lir-scrapers");
  const a2 = reg.resolveOrCreate("lir scrapers"); // same slug
  assert.equal(a2.key, a.key, "same name/slug resolves to the same chat");
  const b = reg.resolveOrCreate("Marketing Site");
  assert.notEqual(b.key, a.key);
  assert.equal(reg.list().length, 2);
});

test("legacy key registers as Main; 'main' resolves to it (continuity)", () => {
  const { reg } = tmpReg();
  const main = reg.register("spawn-0bac4215"); // legacy relay key
  assert.equal(main.name, "Main");
  assert.equal(main.slug, "main");
  assert.equal(main.key, "spawn-0bac4215", "Main keeps the legacy key → preserves --resume + transcript");
  // When the updated relay later sends chatId="main", it must resolve to the
  // SAME legacy-keyed chat, not mint a fresh chat-main.
  const viaMain = reg.resolveOrCreate("main");
  assert.equal(viaMain.key, "spawn-0bac4215");
});

test("a distinct explicit key does not collapse into Main", () => {
  const { reg } = tmpReg();
  reg.register("spawn-0bac4215"); // becomes Main
  const other = reg.register("spawn-verifytest-9"); // a distinct key
  assert.notEqual(other.key, "spawn-0bac4215");
  assert.notEqual(other.slug, "main");
});

test("rename + archive + list(includeArchived)", () => {
  const { reg } = tmpReg();
  const c = reg.resolveOrCreate("Temp");
  reg.rename(c.key, "Renamed");
  assert.equal(reg.get(c.key).name, "Renamed");
  reg.setArchived(c.key, true);
  assert.equal(reg.list().find((x) => x.key === c.key), undefined, "archived hidden by default");
  assert.ok(reg.list(true).find((x) => x.key === c.key), "archived shown with includeArchived");
});

test("cursors: missing → caught-up sentinel (-1), never 0 (no backlog flood)", () => {
  const { reg } = tmpReg();
  const c = reg.resolveOrCreate("Consumer");
  assert.equal(reg.getCursor(c.key, "chat-peer"), -1, "unseen peer = caught-up, not 0");
  reg.setCursor(c.key, "chat-peer", 42);
  assert.equal(reg.getCursor(c.key, "chat-peer"), 42);
});

test("persists + reloads across instances", () => {
  const { reg, path: p } = tmpReg();
  reg.resolveOrCreate("Persisted Chat");
  reg.setCursor("chat-persisted-chat", "chat-x", 7);
  reg.flush();
  const reg2 = new ChatRegistry(p);
  const c = reg2.get("chat-persisted-chat");
  assert.ok(c, "chat survived reload");
  assert.equal(reg2.getCursor("chat-persisted-chat", "chat-x"), 7, "cursor survived reload");
});
