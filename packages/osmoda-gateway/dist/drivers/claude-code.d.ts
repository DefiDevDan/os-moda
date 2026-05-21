/**
 * Claude Code driver — wraps the `claude` CLI in headless streaming mode.
 *
 * Credential handling:
 *  - type=oauth      → CLAUDE_CODE_OAUTH_TOKEN env var (subscription)
 *  - type=api_key    → ANTHROPIC_API_KEY env var
 *
 * Auth precedence in the CLI is: ANTHROPIC_AUTH_TOKEN → ANTHROPIC_API_KEY →
 * apiKeyHelper → CLAUDE_CODE_OAUTH_TOKEN → interactive login. We scrub the
 * unused env var before spawning so only one path is active.
 *
 * Isolation: --strict-mcp-config locks the MCP server set to just our bridge
 * (ignoring any ~/.claude or project-level MCP configs). Works across all 2.x.
 *
 * The `claude` CLI supports resumable sessions; we pass `--resume <id>` when
 * the caller provides a sessionId.
 */
import type { RuntimeDriver } from "./types.js";
export declare const claudeCodeDriver: RuntimeDriver;
