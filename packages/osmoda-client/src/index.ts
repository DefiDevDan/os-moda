/**
 * @osmoda/client — first-party TypeScript client for the spawn.os.moda API.
 *
 * Handwritten to mirror /api/v1/docs exactly. Treat it as a compile-time
 * regression test: if this file stops matching the runtime, the OpenAPI
 * spec is wrong and must be fixed.
 *
 * x402 payment is NOT handled here — pass a `fetch` that already wraps it
 * (for example from @x402/fetch) via the `fetcher` option. If you're just
 * calling the read-only endpoints, global fetch is enough.
 */

// ── Types mirrored from /api/v1/docs#components.schemas ─────────────────────

export type PlanId = string;

export interface Plan {
  id: PlanId;
  name: string;
  description?: string;
  cpu: number;
  ram: number;
  disk: number;
  price_usd: number;
  tier?: string;
  endpoint: string;
  x402?: {
    accepts: Array<{ scheme: string; price: string; network: string; payTo: string }>;
  };
}

export interface PlanList {
  plans: Plan[];
  regions: Array<{ id: string; name: string; flag: string }>;
  network: "mainnet" | "testnet";
}

export interface SpawnRequest {
  region?: string;
  ssh_key?: string;
  /** Legacy single-credential shortcut. Auto-promoted to a credential entry at install. */
  ai_provider?: "anthropic" | "openai";
  api_key?: string;
  // v1.2+ modular fields (all optional):
  /** Default agent runtime for the spawned server. */
  runtime?: "claude-code" | "openclaw";
  /** Initial default model for the osmoda agent. */
  default_model?: string;
  /** Credentials to pre-seed. Max 8; secrets must be ≥10 chars. */
  credentials?: SpawnCredentialInput[];
}

export interface SpawnCredentialInput {
  label: string;
  provider: "anthropic" | "openai" | "openrouter" | "deepseek" | string;
  type: "oauth" | "api_key";
  secret: string;
}

/** Order status values. v1.2.1 added `install_failed` + `deleted`. */
export type OrderStatus =
  | "pending"
  | "provisioning"
  | "running"
  | "failed"
  | "install_failed"
  | "deleted";

export interface SpawnResponse {
  order_id: string;
  api_token: string;
  plan: string;
  price_usd: number;
  server_ip: string | null;
  status: OrderStatus;
  status_url: string;
  chat_url: string;
  ssh: string | null;
  message: string;
}

export interface StatusResponseBasic {
  order_id: string;
  status: OrderStatus;
  plan: string;
  created_at: string;
}

/** v1.2.1 — populated on full status when status=install_failed. */
export interface InstallError {
  step: string;
  reason: string;
  /** Last 200 lines of /var/log/osmoda-cloud-init.log. Only present when the
   *  explicit /api/provision-failed callback fired (not on watchdog flips). */
  log_tail?: string;
  at: string;
  /** true = watchdog cron flagged the order at the 25-min mark; false =
   *  install.sh's EXIT trap explicitly posted the failure. */
  watchdog: boolean;
}

/** v1.2.1 — one entry per install phase transition, in order. */
export interface ProvisionStep {
  step: string;
  status: "started" | "done" | "error";
  detail?: string;
  ts: string;
}

/** v1.2.2 — a single spec-kit project on a spawned server. */
export interface SpecKitProject {
  order_id: string;
  server_name: string | null;
  project: string;
  slug: string;
  status: string;
  last_implement_at: string | null;
  spec_path: string;
}

export interface SpecKitProjectsResponse {
  count: number;
  projects: SpecKitProject[];
}

export interface StatusResponseFull extends StatusResponseBasic {
  server_ip: string | null;
  server_name: string | null;
  region: string;
  ssh: string | null;
  chat_url: string;
  price_usd: number;
  /** True after the spawned server's first heartbeat. Until then mid-install. */
  setup_complete?: boolean;
  /** ISO timestamp of the most recent heartbeat (null if never received). */
  last_heartbeat?: string | null;
  /** v1.2.1: install phase log. Empty array on legacy orders. */
  provision_steps?: ProvisionStep[];
  /** v1.2.1: set when status flipped to install_failed. */
  install_failed_at?: string | null;
  /** v1.2.1: only present when status === "install_failed". */
  install_error?: InstallError;
  /** v1.2.3: soft-warning state when an install has been stuck in the same
   *  phase ≥7 min but is still within the 25-min hard timeout. Use this to
   *  show "investigating…" UX instead of a frozen spinner. Cleared
   *  automatically when the next phase reports progress. */
  stalled?: StalledState | null;
}

/** v1.2.3 — soft-warning state surfaced by the smart watchdog. */
export interface StalledState {
  step: string;
  status: "started" | "done" | "error";
  stuck_for_min: number;
  since: string;
}

export interface TokenMeta {
  token_id: string;
  order_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface ApiError {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
  request_id: string;
  /** Deprecated legacy alias for `code`. Prefer `code`. Removed in v2. */
  error?: string;
}

// ── Error class ─────────────────────────────────────────────────────────────

export class OsmodaApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: Record<string, unknown> | undefined;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, body: ApiError, retryAfter: number | null) {
    super(`[${body.code}] ${body.message}`);
    this.name = "OsmodaApiError";
    this.code = body.code;
    this.status = status;
    this.detail = body.detail;
    this.requestId = body.request_id ?? null;
    this.retryAfterSeconds = retryAfter;
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

export interface OsmodaClientOptions {
  /** Base URL. Defaults to https://spawn.os.moda. */
  baseUrl?: string;
  /** Bearer osk_ token. Required for status(full), tokens.*, and chat. */
  bearer?: string;
  /** Custom fetch (e.g. an x402-wrapped fetch). Defaults to global fetch. */
  fetcher?: typeof fetch;
  /** Default request timeout in ms. Defaults to 30 000. Spawn uses 10 min. */
  timeoutMs?: number;
}

export class OsmodaClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly bearer: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: OsmodaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://spawn.os.moda").replace(/\/$/, "");
    this.fetcher = opts.fetcher ?? fetch;
    this.bearer = opts.bearer;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { timeoutMs?: number; expect204?: boolean } = {},
  ): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), init.timeoutMs ?? this.timeoutMs);
    const headers = new Headers(init.headers);
    if (this.bearer) headers.set("Authorization", `Bearer ${this.bearer}`);
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    let res: Response;
    try {
      res = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const retryAfterHdr = res.headers.get("Retry-After");
    const retryAfter = retryAfterHdr ? parseInt(retryAfterHdr, 10) : null;

    if (init.expect204 && res.status === 204) return undefined as T;

    // Anything not 2xx is structured error per v1.1.0 contract.
    if (!res.ok) {
      let body: ApiError;
      try {
        body = (await res.json()) as ApiError;
      } catch {
        body = {
          code: "unknown_error",
          message: `HTTP ${res.status} ${res.statusText}`,
          request_id: res.headers.get("X-Request-Id") ?? "",
        };
      }
      throw new OsmodaApiError(res.status, body, Number.isFinite(retryAfter) ? retryAfter : null);
    }

    return (await res.json()) as T;
  }

  // ── Plans ────────────────────────────────────────────────────────────

  listPlans(): Promise<PlanList> {
    return this.request<PlanList>("/api/v1/plans", { method: "GET" });
  }

  // ── Spawn ────────────────────────────────────────────────────────────

  /**
   * Spawn a server. Pass `idempotencyKey` to make retries safe; same key +
   * same body returns the same response (see /docs#x-idempotency).
   */
  spawn(
    planId: PlanId,
    body: SpawnRequest = {},
    opts: { idempotencyKey?: string; timeoutMs?: number } = {},
  ): Promise<SpawnResponse> {
    const headers: Record<string, string> = {};
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    return this.request<SpawnResponse>(`/api/v1/spawn/${encodeURIComponent(planId)}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs ?? 10 * 60_000,
    });
  }

  // ── Status ───────────────────────────────────────────────────────────

  /** Basic status — no auth required. */
  status(orderId: string): Promise<StatusResponseBasic> {
    return this.request<StatusResponseBasic>(
      `/api/v1/status/${encodeURIComponent(orderId)}`,
      { method: "GET" },
    );
  }

  /** Full status — requires Bearer set on the client. */
  statusFull(orderId: string): Promise<StatusResponseFull> {
    if (!this.bearer) throw new Error("statusFull requires bearer osk_ token");
    return this.request<StatusResponseFull>(
      `/api/v1/status/${encodeURIComponent(orderId)}`,
      { method: "GET" },
    );
  }

  /**
   * Poll status until `status === "running"` or a terminal failure
   * (`"failed"` / `"install_failed"`). Throws on failure with the relevant
   * error code and surfaces `install_error` in the thrown error's `detail`
   * when available. Polls every 15 s by default, up to 30 min.
   */
  async waitForRunning(
    orderId: string,
    opts: { intervalMs?: number; maxWaitMs?: number } = {},
  ): Promise<StatusResponseFull> {
    const interval = opts.intervalMs ?? 15_000;
    const deadline = Date.now() + (opts.maxWaitMs ?? 30 * 60_000);
    for (;;) {
      const s = await this.statusFull(orderId);
      if (s.status === "running") return s;
      if (s.status === "failed" || s.status === "install_failed") {
        throw new OsmodaApiError(
          500,
          {
            code: s.status === "install_failed" ? "install_failed" : "provisioning_failed",
            message:
              s.install_error?.reason ??
              `Order ${orderId} failed to provision (status=${s.status}).`,
            detail: s.install_error
              ? (s.install_error as unknown as Record<string, unknown>)
              : undefined,
            request_id: "",
          },
          null,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(`waitForRunning timed out after ${opts.maxWaitMs ?? 30 * 60_000}ms`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  // ── Tokens ───────────────────────────────────────────────────────────

  getToken(tokenId: string): Promise<TokenMeta> {
    return this.request<TokenMeta>(`/api/v1/tokens/${encodeURIComponent(tokenId)}`, {
      method: "GET",
    });
  }

  revokeToken(tokenId: string): Promise<void> {
    return this.request<void>(`/api/v1/tokens/${encodeURIComponent(tokenId)}`, {
      method: "DELETE",
      expect204: true,
    });
  }

  // ── Spec-kit (v1.2.2) ────────────────────────────────────────────────

  /**
   * List spec-driven projects across the caller's spawned server (token is
   * per-order, so this returns projects for one server). Bearer required.
   */
  specKitProjects(): Promise<SpecKitProjectsResponse> {
    if (!this.bearer) throw new Error("specKitProjects requires bearer osk_ token");
    return this.request<SpecKitProjectsResponse>("/api/v1/spec-kit/projects", {
      method: "GET",
    });
  }
}

// ── Auth-type compatibility helper (v1.2.2) ────────────────────────────

/**
 * Validate a credential `type` against a runtime per the agent-card's
 * `runtimes[].supported_auth_types`. Returns null on compatible, or a
 * human-readable reason string on mismatch. Use before binding a credential
 * to an agent so the customer-server gateway doesn't have to reject it.
 */
export function isAuthTypeCompatible(
  runtime: "claude-code" | "openclaw" | string,
  authType: "oauth" | "api_key" | string,
): string | null {
  const SUPPORT: Record<string, ReadonlyArray<string>> = {
    "claude-code": ["oauth", "api_key"],
    "openclaw":    ["api_key"],
  };
  const accepted = SUPPORT[runtime];
  if (!accepted) return null; // unknown runtime — let the server decide
  if (accepted.includes(authType)) return null;
  return `Runtime "${runtime}" does not accept "${authType}" credentials. ` +
    `Supported: ${accepted.join(", ")}.`;
}

// ── Convenience: tokenIdFromToken ──────────────────────────────────────────

/**
 * Derive the public `token_id` (first 16 hex chars of the SHA-256 of the
 * raw osk_ token) without a server round-trip. Uses Web Crypto (browser +
 * Node 20+).
 */
export async function tokenIdFromToken(osk: string): Promise<string> {
  const bytes = new TextEncoder().encode(osk);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 16);
}
