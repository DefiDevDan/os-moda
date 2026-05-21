/**
 * Durable cross-session memory — modelled on OpenClaw's MEMORY.md + daily notes.
 *
 * "The model only remembers what gets saved to disk — there is no hidden state."
 * osModa already treats markdown files under /var/lib/osmoda/memory as the
 * ground truth (ZVEC is a derived index). This module loads that ground truth
 * into the system prompt at the start of every chat turn, so the agent
 * remembers facts/preferences/decisions across brand-new conversations — not
 * just within a single resumed runtime session.
 *
 *   MEMORY.md                       durable facts/preferences/decisions
 *   daily/YYYY-MM-DD.md             working notes (today + yesterday loaded)
 *
 * Bounded so a huge memory file can never blow the system-prompt budget.
 */
/**
 * Returns a system-prompt block of durable memory, or "" if nothing is stored
 * yet. Safe to call on every turn — pure reads, bounded, never throws.
 */
export declare function loadDurableMemory(): string;
/**
 * Append a line to today's daily note. Used by the gateway to auto-log session
 * boundaries so there is always a dated breadcrumb even if the agent forgets to
 * write one itself. Best-effort.
 */
export declare function appendDailyNote(line: string): void;
