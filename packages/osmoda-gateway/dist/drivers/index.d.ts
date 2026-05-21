/**
 * Driver registry — gateway composes all available runtime drivers here.
 *
 * Adding a new driver is one import + one entry in `allDrivers`.
 */
import type { RuntimeDriver } from "./types.js";
export declare const allDrivers: Record<string, RuntimeDriver>;
export declare function getDriver(name: string): RuntimeDriver | null;
export declare function listDrivers(): RuntimeDriver[];
export * from "./types.js";
