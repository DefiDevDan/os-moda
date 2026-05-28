/**
 * k6 load test — FREE read endpoints (no auth, no payment, no mutation).
 *
 * Ramps GET /api/v1/plans + GET /api/v1/docs + GET /.well-known/agent-card.json
 * from 10 → 500 virtual users to find p95/p99 latency and the point where the
 * spawn-app / nginx starts shedding load.
 *
 * HARD PROD GUARD: refuses to run against spawn.os.moda. Point TARGET at a
 * throwaway staging spawn (see testing/load/README.md).
 *
 *   k6 run -e TARGET=https://<staging-ip-or-host> testing/load/free-reads.js
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const TARGET = (__ENV.TARGET || "").replace(/\/$/, "");

// ── Prod guard ──────────────────────────────────────────────────────────
if (!TARGET) {
  throw new Error("Set -e TARGET=https://<staging-host>. Refusing to run with no target.");
}
if (/spawn\.os\.moda/i.test(TARGET) && __ENV.I_REALLY_MEAN_PROD !== "yes-dos-my-own-users") {
  throw new Error(
    "TARGET points at production (spawn.os.moda). Load testing prod will trip rate limits and " +
      "degrade real users. Use a throwaway staging spawn. (Override only if you truly mean it.)",
  );
}

const errorRate = new Rate("errors");
const plansLatency = new Trend("plans_latency_ms", true);

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 10 },
        { duration: "1m", target: 50 },
        { duration: "1m", target: 150 },
        { duration: "1m", target: 300 },
        { duration: "1m", target: 500 },
        { duration: "1m", target: 500 }, // soak at peak
        { duration: "30s", target: 0 },
      ],
    },
  },
  thresholds: {
    // Production-grade bar — adjust after the first baseline run.
    http_req_duration: ["p(95)<800", "p(99)<2000"],
    errors: ["rate<0.02"],
  },
};

const PATHS = ["/api/v1/plans", "/api/v1/docs", "/.well-known/agent-card.json"];

export default function () {
  const path = PATHS[Math.floor(Math.random() * PATHS.length)];
  const res = http.get(`${TARGET}${path}`, { headers: { "User-Agent": "osmoda-k6/1.0" } });
  const ok = check(res, {
    "status 200": (r) => r.status === 200,
    "has X-Request-Id": (r) => !!r.headers["X-Request-Id"],
    "body non-empty": (r) => r.body && r.body.length > 0,
  });
  errorRate.add(!ok);
  if (path === "/api/v1/plans") plansLatency.add(res.timings.duration);
  sleep(Math.random() * 0.5);
}
