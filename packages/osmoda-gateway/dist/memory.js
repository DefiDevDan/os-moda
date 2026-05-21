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
import * as fs from "node:fs";
import * as path from "node:path";
const MEMORY_DIR = process.env.OSMODA_MEMORY_DIR || "/var/lib/osmoda/memory";
const MAX_MEMORY_CHARS = 8000;
const MAX_DAILY_CHARS = 4000;
function readBounded(p, max) {
    try {
        let s = fs.readFileSync(p, "utf8").trim();
        if (!s)
            return null;
        if (s.length > max)
            s = s.slice(0, max) + "\n…[truncated — open the file for the rest]";
        return s;
    }
    catch {
        return null;
    }
}
function isoDay(offsetDays) {
    return new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);
}
/**
 * Returns a system-prompt block of durable memory, or "" if nothing is stored
 * yet. Safe to call on every turn — pure reads, bounded, never throws.
 */
export function loadDurableMemory() {
    const parts = [];
    const mem = readBounded(path.join(MEMORY_DIR, "MEMORY.md"), MAX_MEMORY_CHARS);
    if (mem)
        parts.push(`## Durable memory (MEMORY.md)\n${mem}`);
    const today = readBounded(path.join(MEMORY_DIR, "daily", `${isoDay(0)}.md`), MAX_DAILY_CHARS);
    if (today)
        parts.push(`## Today's working notes (${isoDay(0)})\n${today}`);
    const yesterday = readBounded(path.join(MEMORY_DIR, "daily", `${isoDay(1)}.md`), MAX_DAILY_CHARS);
    if (yesterday)
        parts.push(`## Yesterday's working notes (${isoDay(1)})\n${yesterday}`);
    if (!parts.length)
        return "";
    return (`\n\n# Persistent memory (auto-loaded every session)\n\n` +
        `This is the source of truth for what you remember across conversations. It is loaded ` +
        `from disk (\`${MEMORY_DIR}\`) at the start of every turn. When you learn a durable fact, ` +
        `user preference, or decision, RECORD it by appending to \`${path.join(MEMORY_DIR, "MEMORY.md")}\` ` +
        `(use the Write/Edit tools, or the \`memory_store\` MCP tool). Put detailed, time-stamped working ` +
        `notes in \`${path.join(MEMORY_DIR, "daily")}/${isoDay(0)}.md\`. Keep MEMORY.md concise — facts ` +
        `and decisions, not transcripts.\n\n` +
        parts.join("\n\n") +
        `\n`);
}
/**
 * Append a line to today's daily note. Used by the gateway to auto-log session
 * boundaries so there is always a dated breadcrumb even if the agent forgets to
 * write one itself. Best-effort.
 */
export function appendDailyNote(line) {
    try {
        const dir = path.join(MEMORY_DIR, "daily");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${isoDay(0)}.md`);
        const stamp = new Date().toISOString().slice(11, 19);
        fs.appendFileSync(file, `- ${stamp} ${line}\n`, { mode: 0o644 });
    }
    catch {
        /* best-effort */
    }
}
