import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Each test gets its own OSMODA_CONFIG_DIR so the encrypted store is isolated.
function freshConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osmoda-creds-test-"));
  process.env.OSMODA_CONFIG_DIR = dir;
  // The credentials module reads CONFIG_DIR at import time; bust ESM cache.
  return dir;
}

test("classifyCredentialError flags out_of_usage / 429 / 401 — but not generic errors", async () => {
  freshConfigDir();
  const { classifyCredentialError } = await import(`../dist/credentials.js?t=${Date.now()}`);
  assert.equal(classifyCredentialError({ code: "http_400", text: "You're out of extra usage. Add more." }), "out_of_usage");
  assert.equal(classifyCredentialError({ text: "Credit balance is too low" }), "out_of_usage");
  assert.equal(classifyCredentialError({ code: "http_429", text: "rate limit reached" }), "rate_limited");
  assert.equal(classifyCredentialError({ code: "http_401", text: "Unauthorized" }), "auth_failed");
  assert.equal(classifyCredentialError({ code: "http_500", text: "server error" }), null);
  assert.equal(classifyCredentialError({ text: "tool execution failed" }), null);
});

test("markCredentialCooldown + isCooldown + pickFallbackCredential — picks next healthy of same provider+type", async () => {
  freshConfigDir();
  const mod = await import(`../dist/credentials.js?t=${Date.now()}`);
  const a = mod.addCredential({ label: "primary",   provider: "anthropic", type: "api_key", secret: "sk-ant-api-AAA" });
  const b = mod.addCredential({ label: "secondary", provider: "anthropic", type: "api_key", secret: "sk-ant-api-BBB" });
  const c = mod.addCredential({ label: "oauth-one", provider: "anthropic", type: "oauth",   secret: "sk-ant-oat-CCC" });
  // Different type — should NEVER be a fallback for an api_key failure.
  assert.equal(mod.pickFallbackCredential(a)?.id, b.id, "fallback picks the other api_key");
  // Cool b down → no fallback of same type (c is oauth, wrong type).
  mod.markCredentialCooldown(b.id, "out_of_usage", 30 * 60 * 1000);
  assert.equal(mod.isCooldown(mod.getCredential(b.id)), true);
  assert.equal(mod.pickFallbackCredential(a), null, "no healthy api_key left → null");
  // Cool a too — oauth must still NOT be a fallback (type mismatch).
  mod.markCredentialCooldown(a.id, "auth_failed", 30 * 60 * 1000);
  assert.equal(mod.pickFallbackCredential(c), null, "no other oauth credential → null");
  // Manually expire b's cooldown → it becomes a fallback again.
  mod.updateCredentialMeta(b.id, { cooldown_until: new Date(Date.now() - 1000).toISOString() });
  assert.equal(mod.isCooldown(mod.getCredential(b.id)), false);
  assert.equal(mod.pickFallbackCredential(a)?.id, b.id, "expired cooldown → healthy again");
});

test("redact() exposes cooldown fields but never the secret", async () => {
  freshConfigDir();
  const mod = await import(`../dist/credentials.js?t=${Date.now()}`);
  const cred = mod.addCredential({ label: "x", provider: "anthropic", type: "api_key", secret: "sk-ant-api-SECRETSECRET" });
  mod.markCredentialCooldown(cred.id, "out_of_usage", 30 * 60 * 1000);
  const r = mod.redact(mod.getCredential(cred.id));
  assert.equal(r.secret, undefined);
  assert.ok(r.secret_preview.startsWith("sk-ant-api-S"));
  assert.equal(r.cooldown_reason, "out_of_usage");
  assert.ok(new Date(r.cooldown_until).getTime() > Date.now());
});
