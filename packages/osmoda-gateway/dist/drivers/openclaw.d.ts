/**
 * OpenClaw driver — wraps the standalone `openclaw` binary as a child process.
 *
 * OpenClaw is a first-class peer to claude-code. Pick it for the OpenClaw
 * plugin ecosystem or non-Anthropic providers. Credential handling is
 * api_key only — Anthropic does not issue OAuth tokens for OpenClaw, so
 * supported_auth_types is ["api_key"]. We write the credential into
 * OpenClaw's auth-profiles.json format before each session, because
 * OpenClaw expects that file at a known path.
 *
 * This driver uses OpenClaw's one-shot run mode (`openclaw run`) and parses
 * its JSON event stream on stdout. If OpenClaw isn't installed on the host,
 * `testCredential` surfaces a clear error.
 */
import type { RuntimeDriver } from "./types.js";
export declare const openClawDriver: RuntimeDriver;
