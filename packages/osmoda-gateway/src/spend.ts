/**
 * Per-agent spend meter + daily kill-switch (V1 — the unattended-loop safety floor).
 *
 * A root agent looping 24/7 on the customer's API key with no budget ceiling is
 * an unbounded-cost (and unbounded-behaviour) risk. Before this, the gateway had
 * NO spend guard at all — the only kill-switch was the manual Stop button. This
 * module accumulates per-agent, per-UTC-day token + USD usage and refuses the
 * NEXT turn (with a typed `spend_cap_exceeded`) once a cap is hit — BEFORE the
 * model is invoked, so an over-budget loop can't keep burning.
 *
 * Pure + dependency-injected: `now` is injectable for deterministic day-rollover
 * tests, `file` is optional (omit for in-memory), `alert` fires once per
 * threshold per day. No side effects on import.
 */
import fs from "fs";
import type { AgentProfile } from "./drivers/types.js";

export interface SpendUsage {
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}

export interface SpendCheck {
  allowed: boolean;
  /** Set when !allowed: a one-line human reason for the refusal. */
  reason?: string;
  tokensUsed: number;
  usdUsed: number;
  tokenCap?: number;
  usdCap?: number;
  /** Highest utilisation across the configured caps (0..1+). */
  pct: number;
}

interface DayBucket {
  day: string; // UTC YYYY-MM-DD
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  alerted: { warn: boolean; halt: boolean };
}

/** USD per 1,000,000 tokens. Used to ESTIMATE cost when the runtime doesn't
 * report `cost_usd` (e.g. openclaw, or older CLIs). claude-code reports real
 * cost, so this is a fallback. Conservative defaults for unknown models. */
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-fable-5": { in: 10, out: 50 },
  "claude-mythos-5": { in: 10, out: 50 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
const DEFAULT_PRICE = { in: 5, out: 25 }; // unknown model → assume Opus-tier (conservative)

function priceFor(model: string, table: Record<string, { in: number; out: number }>) {
  const bare = String(model || "").replace(/^[^/]+\//, ""); // strip "anthropic/" provider prefix
  return table[bare] || table[model] || DEFAULT_PRICE;
}

export function estimateCostUsd(model: string, usage: SpendUsage, table = PRICES): number {
  if (typeof usage.cost_usd === "number" && usage.cost_usd > 0) return usage.cost_usd;
  const p = priceFor(model, table);
  return ((usage.input_tokens || 0) / 1e6) * p.in + ((usage.output_tokens || 0) / 1e6) * p.out;
}

export class SpendMeter {
  private file?: string;
  private now: () => number;
  private prices: Record<string, { in: number; out: number }>;
  private alert?: (agentId: string, level: "warn" | "halt", info: { pct: number; usdUsed: number; tokensUsed: number }) => void;
  private buckets = new Map<string, DayBucket>();

  constructor(opts: {
    file?: string;
    now?: () => number;
    prices?: Record<string, { in: number; out: number }>;
    alert?: SpendMeter["alert"];
  } = {}) {
    this.file = opts.file;
    this.now = opts.now || (() => Date.now());
    this.prices = opts.prices || PRICES;
    this.alert = opts.alert;
    this.load();
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** Get the agent's bucket, rolling it over (reset) if the UTC day changed. */
  private bucket(agentId: string): DayBucket {
    const day = this.today();
    let b = this.buckets.get(agentId);
    if (!b || b.day !== day) {
      b = { day, input_tokens: 0, output_tokens: 0, cost_usd: 0, alerted: { warn: false, halt: false } };
      this.buckets.set(agentId, b);
    }
    return b;
  }

  /** Read-only: would the next turn be allowed under this agent's caps? */
  check(agent: AgentProfile): SpendCheck {
    const b = this.bucket(agent.id);
    const tokens = b.input_tokens + b.output_tokens;
    const tokenCap = agent.dailyTokenCap && agent.dailyTokenCap > 0 ? agent.dailyTokenCap : undefined;
    const usdCap = agent.dailyUsdCap && agent.dailyUsdCap > 0 ? agent.dailyUsdCap : undefined;
    const tokenPct = tokenCap ? tokens / tokenCap : 0;
    const usdPct = usdCap ? b.cost_usd / usdCap : 0;
    const pct = Math.max(tokenPct, usdPct);
    const overToken = tokenCap !== undefined && tokens >= tokenCap;
    const overUsd = usdCap !== undefined && b.cost_usd >= usdCap;
    let reason: string | undefined;
    if (overToken) reason = `daily token cap reached (${tokens.toLocaleString()}/${tokenCap!.toLocaleString()} tokens). Resets at 00:00 UTC.`;
    else if (overUsd) reason = `daily spend cap reached ($${b.cost_usd.toFixed(2)}/$${usdCap!.toFixed(2)}). Resets at 00:00 UTC.`;
    return { allowed: !(overToken || overUsd), reason, tokensUsed: tokens, usdUsed: b.cost_usd, tokenCap, usdCap, pct };
  }

  /** Accumulate a completed turn's usage; persist; fire alerts at 80% / 100%. */
  record(agent: AgentProfile, usage: SpendUsage): void {
    const b = this.bucket(agent.id);
    b.input_tokens += Math.max(0, usage.input_tokens || 0);
    b.output_tokens += Math.max(0, usage.output_tokens || 0);
    b.cost_usd += Math.max(0, estimateCostUsd(agent.model, usage, this.prices));
    // Alert once per threshold per day.
    const c = this.check(agent);
    if (this.alert) {
      if (c.pct >= 1 && !b.alerted.halt) {
        b.alerted.halt = true; b.alerted.warn = true;
        this.alert(agent.id, "halt", { pct: c.pct, usdUsed: c.usdUsed, tokensUsed: c.tokensUsed });
      } else if (c.pct >= 0.8 && !b.alerted.warn) {
        b.alerted.warn = true;
        this.alert(agent.id, "warn", { pct: c.pct, usdUsed: c.usdUsed, tokensUsed: c.tokensUsed });
      }
    }
    this.save();
  }

  snapshot(agentId: string): { day: string; input_tokens: number; output_tokens: number; cost_usd: number } {
    const b = this.bucket(agentId);
    return { day: b.day, input_tokens: b.input_tokens, output_tokens: b.output_tokens, cost_usd: b.cost_usd };
  }

  private load(): void {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries<any>(raw)) {
          if (v && typeof v === "object" && typeof v.day === "string") {
            this.buckets.set(k, {
              day: v.day,
              input_tokens: v.input_tokens || 0,
              output_tokens: v.output_tokens || 0,
              cost_usd: v.cost_usd || 0,
              alerted: { warn: !!v.alerted?.warn, halt: !!v.alerted?.halt },
            });
          }
        }
      }
    } catch { /* missing/corrupt → start empty (spend data is reconstructible, not load-bearing) */ }
  }

  private save(): void {
    if (!this.file) return;
    try {
      const obj: Record<string, DayBucket> = {};
      for (const [k, v] of this.buckets) obj[k] = v;
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* best-effort; a missed persist just means a restart loses today's partial tally */ }
  }
}
