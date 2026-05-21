/**
 * Zero-downtime migration — runs once when agents.json is missing.
 *
 * Pre-v1.2 layouts:
 *   1. /var/lib/osmoda/config/api-key    → single Claude Code credential
 *   2. /root/.openclaw/agents/<id>/agent/auth-profiles.json → per-agent OpenClaw auth
 *
 * Post-migration: one credential per distinct secret, one AgentProfile per
 * legacy agent pointing to the matching credential. Existing daemons keep
 * running; this module only writes config files.
 */
export interface MigrationReport {
    ran: boolean;
    imported_credentials: number;
    created_agents: number;
    detected_runtime: "claude-code" | "openclaw" | "mixed" | "none";
    notes: string[];
}
export declare function runMigrationIfNeeded(): MigrationReport;
