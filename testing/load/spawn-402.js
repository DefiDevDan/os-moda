/**
 * k6 load test — the unpaid spawn path (402 invoice generation).
 *
 * POST /api/v1/spawn/:plan WITHOUT payment returns 402 + an x402 invoice in the
 * `payment-required` header. This exercises plan lookup + x402 invoice
 * generation (the most CPU-bound part of the spawn endpoint) WITHOUT actually
 * provisioning a server or spending money. It also confirms the per-IP/-token
 * rate limiter behaves (5/min on spawn → expect 429s under load, NOT 5xx).
 *
 *   k6 run -e TARGET=https://<staging-host> testing/load/spawn-402.js
 *
 * NOTE: even on staging, the 5/min spawn rate limit means most requests SHOULD
 * 429. The success criterion is: NO 5xx, every response carries X-Request-Id,
 * and 402s carry a decodable invoice. This is a resilience test of the limiter,
 * not a throughput test.
 */
import http from "k6/http";
import { check } from "k6";
import { Rate } from "k6/metrics";

const TARGET = (__ENV.TARGET || "").replace(/\/$/, "");
if (!TARGET) throw new Error("Set -e TARGET=https://<staging-host>.");
if (/spawn\.os\.moda/i.test(TARGET) && __ENV.I_REALLY_MEAN_PROD !== "yes-dos-my-own-users") {
  throw new Error("TARGET is production. Refusing — use a throwaway staging spawn.");
}

const fiveXX = new Rate("server_errors_5xx");

export const options = {
  scenarios: {
    burst: { executor: "constant-vus", vus: 20, duration: "1m" },
  },
  thresholds: {
    // The ONLY hard requirement: the spawn endpoint must never 5xx under burst.
    server_errors_5xx: ["rate==0"],
  },
};

export default function () {
  const res = http.post(`${TARGET}/api/v1/spawn/starter`, "{}", {
    headers: { "Content-Type": "application/json", "User-Agent": "osmoda-k6/1.0" },
  });
  fiveXX.add(res.status >= 500);
  check(res, {
    "not a 5xx": (r) => r.status < 500,
    "expected 402 or 429": (r) => r.status === 402 || r.status === 429,
    "carries X-Request-Id": (r) => !!r.headers["X-Request-Id"],
    "402 carries payment-required header": (r) =>
      r.status !== 402 || !!r.headers["Payment-Required"],
    "429 carries Retry-After": (r) => r.status !== 429 || !!r.headers["Retry-After"],
  });
}
