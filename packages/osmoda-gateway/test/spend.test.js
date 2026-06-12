import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpendMeter, estimateCostUsd } from "../dist/spend.js";

const agent = (over = {}) => ({ id: "osmoda", model: "claude-opus-4-8", ...over });

test("estimateCostUsd: prefers reported cost; else estimates; strips provider prefix", () => {
  assert.equal(estimateCostUsd("claude-opus-4-8", { cost_usd: 1.23, input_tokens: 9e9 }), 1.23);
  // opus-4-8 = $5/$25 per 1M → 1M in + 1M out = $5 + $25 = $30
  assert.equal(estimateCostUsd("claude-opus-4-8", { input_tokens: 1e6, output_tokens: 1e6 }), 30);
  // provider-prefixed model resolves to the same price
  assert.equal(estimateCostUsd("anthropic/claude-sonnet-4-6", { input_tokens: 1e6, output_tokens: 1e6 }), 18);
  // unknown model → conservative Opus-tier default
  assert.equal(estimateCostUsd("some-future-model", { input_tokens: 1e6 }), 5);
});

test("check: unlimited when no caps set", () => {
  const m = new SpendMeter();
  m.record(agent(), { input_tokens: 1e9, output_tokens: 1e9 });
  assert.equal(m.check(agent()).allowed, true);
});

test("token cap: allowed under, refused at/over", () => {
  const m = new SpendMeter();
  const a = agent({ dailyTokenCap: 1000 });
  assert.equal(m.check(a).allowed, true);
  m.record(a, { input_tokens: 600, output_tokens: 300 }); // 900 < 1000
  assert.equal(m.check(a).allowed, true);
  m.record(a, { input_tokens: 100, output_tokens: 0 }); // 1000 >= 1000
  const c = m.check(a);
  assert.equal(c.allowed, false);
  assert.match(c.reason, /token cap/);
  assert.equal(c.tokensUsed, 1000);
});

test("usd cap: refused once estimated spend crosses the cap", () => {
  const m = new SpendMeter();
  const a = agent({ model: "claude-opus-4-8", dailyUsdCap: 10 });
  m.record(a, { input_tokens: 1e6, output_tokens: 0 }); // $5
  assert.equal(m.check(a).allowed, true);
  m.record(a, { input_tokens: 1e6, output_tokens: 0 }); // +$5 = $10 >= cap
  const c = m.check(a);
  assert.equal(c.allowed, false);
  assert.match(c.reason, /spend cap/);
});

test("day rollover resets the bucket (injected clock)", () => {
  let t = Date.parse("2026-06-12T23:00:00Z");
  const m = new SpendMeter({ now: () => t });
  const a = agent({ dailyTokenCap: 1000 });
  m.record(a, { input_tokens: 1000, output_tokens: 0 });
  assert.equal(m.check(a).allowed, false);
  t = Date.parse("2026-06-13T00:30:00Z"); // next UTC day
  const c = m.check(a);
  assert.equal(c.allowed, true);
  assert.equal(c.tokensUsed, 0);
});

test("alert fires warn at 80% and halt at 100%, once each", () => {
  const events = [];
  const m = new SpendMeter({ alert: (id, level, info) => events.push({ id, level, pct: info.pct }) });
  const a = agent({ dailyTokenCap: 1000 });
  m.record(a, { input_tokens: 850, output_tokens: 0 }); // 85% → warn
  m.record(a, { input_tokens: 50, output_tokens: 0 });  // 90% → no new alert
  m.record(a, { input_tokens: 200, output_tokens: 0 }); // 105% → halt
  assert.deepEqual(events.map((e) => e.level), ["warn", "halt"]);
});

test("persistence: survives a new meter instance", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spend-"));
  const file = path.join(dir, "spend.json");
  const a = agent({ dailyUsdCap: 100 });
  const m1 = new SpendMeter({ file });
  m1.record(a, { input_tokens: 1e6, output_tokens: 0 }); // $5
  const m2 = new SpendMeter({ file });
  assert.equal(Math.round(m2.snapshot("osmoda").cost_usd), 5);
  fs.rmSync(dir, { recursive: true, force: true });
});
