/**
 * Driver interface — one file per runtime implementation.
 *
 * Adding a new runtime (Codex, Bedrock, Vertex, generic-OpenAI, …) means
 * dropping a single module in this directory that exports a RuntimeDriver.
 * No changes elsewhere in the gateway.
 */

export type Provider = "anthropic" | "openai" | "openrouter" | "deepseek" | string;
export type AuthType = "oauth" | "api_key";

export interface Credential {
  id: string;
  label: string;
  provider: Provider;
  type: AuthType;
  /** Decrypted secret. Only present in memory; credentials.json.enc stores the ciphertext. */
  secret: string;
  base_url?: string;
  created_at: string;
  last_tested_at?: string | null;
  last_test_ok?: boolean;
  last_test_error?: string | null;
  last_used_at?: string | null;
  /** ISO timestamp until which this credential is in cooldown (exhausted/rate-limited). */
  cooldown_until?: string | null;
  /** Why we cooled this credential down (e.g. "out_of_usage", "http_401", "http_429"). */
  cooldown_reason?: string | null;
}

export interface AgentProfile {
  id: string;
  display_name: string;
  runtime: string;                   // matches RuntimeDriver.name
  credential_id: string;
  model: string;
  channels: string[];
  profile_dir?: string;              // for SOUL.md/AGENTS.md/USER.md
  system_prompt_file?: string;
  enabled: boolean;
  updated_at: string;
}

/**
 * The osModa streaming chat event contract — adapted from the
 * agentic-chat-interface skill (AGENTIC-CHAT-INTERFACE-SKILL.md §1). ONE
 * contract: every runtime driver emits these; the ws-relay forwards them
 * verbatim; the dashboard consumes them. Two text channels (interim_text vs
 * text) keep planning/reasoning separate from the final answer — never
 * collapse them (skill §8).
 */
export interface AgentEvent {
  type:
    | "text"            // delta of the FINAL answer (clears the status pill)
    | "text_bulk"       // replace the final answer wholesale (authoritative final)
    | "interim_text"    // delta of planning/"thinking" text (collapsible panel)
    | "interim_commit_final" // trim N chars of interim that were promoted to final
    | "tool_use"        // a tool call started (push into the timeline)
    | "tool_result"     // a tool call resolved (attach summary/outcome)
    | "status"          // streaming status pill text ("Thinking", "Running tools · 2")
    | "phase"           // "planning" | "answering"
    | "thinking"        // (legacy) kept for back-compat
    | "session" | "error" | "done";
  text?: string;
  name?: string;
  /**
   * For tool_use: a short human-readable hint of WHAT the tool is acting on —
   * a command preview, file path, URL, or query. Lets the chat UI show
   * "Bash · cat /var/log/…" instead of a bare "Bash" badge.
   */
  target?: string;
  /** For tool_result: "success" | "error" when known. */
  outcome?: string;
  /** For tool_result: a one-line result summary ("→ 12 found"). */
  summary?: string;
  /** For status: the pill text. For phase: the phase name. */
  step?: string;
  phase?: "planning" | "answering";
  /** For interim_commit_final: how many trailing interim chars to trim. */
  length?: number;
  /** For tool_use/result: the agentic round index (0-based). */
  round?: number;
  sessionId?: string;
  code?: string;
}

export interface DriverSessionOpts {
  agent: AgentProfile;
  credential: Credential;
  model: string;
  systemPrompt: string;
  mcpConfigPath: string;
  message: string;
  sessionId?: string;
  abortSignal?: AbortSignal;
  workingDir?: string;
}

export interface CredentialTestResult {
  ok: boolean;
  error?: string;
  /** Some providers can report which models this credential unlocks. */
  model_list?: string[];
}

/**
 * Result of probing whether a driver's underlying binary/SDK is installed and
 * has the expected CLI shape. Caught the OpenClaw 2026.5.7 incident where the
 * driver assumed `openclaw run` but the installed binary only exposed
 * `openclaw agent` — every chat through openclaw failed silently with
 * "Unknown command" until we added this probe.
 *
 * Each driver implements healthCheck() and the gateway calls it:
 *   - on /config/drivers list  (surfaces a status badge in the dashboard)
 *   - before any PATCH /config/agents/{id} that changes runtime (blocks the
 *     swap with a clear 422 instead of letting chat fail later)
 *   - on startup (logs warnings for any unavailable driver)
 */
export interface DriverHealthResult {
  /** True if the driver can spawn a working session with proper credentials. */
  available: boolean;
  /** Driver-reported version string when available, e.g. "OpenClaw 2026.5.7". */
  version?: string;
  /** Human-readable reason when `available: false`. */
  error?: string;
  /**
   * Optional remediation hint shown to operators in the dashboard, e.g.
   * "Reinstall: cd /opt/openclaw && npm install openclaw".
   */
  remediation?: string;
  /** ISO timestamp of when the probe ran. Filled in by the gateway. */
  probed_at?: string;
}

export interface RuntimeDriver {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly supportedProviders: Provider[];
  readonly supportedAuthTypes: AuthType[];
  readonly defaultModels: string[];

  /** Non-destructive — should succeed with a 1-token ping or equivalent cheap check. */
  testCredential(cred: Credential): Promise<CredentialTestResult>;

  /**
   * Probe whether the driver's binary is installed and has the CLI shape we
   * expect. MUST be cheap (no API calls, no network), MUST be idempotent,
   * MUST NOT spawn an agent turn. Typical implementation: spawn the binary
   * with `--version` or `--help` and pattern-match the output.
   */
  healthCheck(): Promise<DriverHealthResult>;

  startSession(opts: DriverSessionOpts): AsyncGenerator<AgentEvent>;
}
