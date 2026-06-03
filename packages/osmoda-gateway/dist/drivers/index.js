/**
 * Driver registry — gateway composes all available runtime drivers here.
 *
 * Adding a new driver is one import + one entry in `allDrivers`.
 */
import { claudeCodeDriver } from "./claude-code.js";
import { openClawDriver } from "./openclaw.js";
import { managedAgentDriver } from "./managed-agent.js";
export const allDrivers = {
    [claudeCodeDriver.name]: claudeCodeDriver,
    [openClawDriver.name]: openClawDriver,
    [managedAgentDriver.name]: managedAgentDriver,
};
export function getDriver(name) {
    return allDrivers[name] || null;
}
export function listDrivers() {
    return Object.values(allDrivers);
}
export * from "./types.js";
