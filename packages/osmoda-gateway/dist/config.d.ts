/**
 * Agents config (/var/lib/osmoda/config/agents.json).
 *
 * In-memory cache + atomic writes + SIGHUP-driven reload. The gateway never
 * reads the file in hot paths; it reads the in-memory snapshot. reload()
 * swaps the snapshot atomically — in-flight sessions keep their closure
 * over the old snapshot; new sessions see the new one.
 */
import type { AgentProfile } from "./drivers/types.js";
export declare const AGENTS_FILE: string;
export interface ChannelBinding {
    channel: string;
    agent_id: string;
}
export interface AgentsFile {
    version: 1;
    agents: AgentProfile[];
    bindings: ChannelBinding[];
}
export declare function loadAgentsFile(): AgentsFile;
export declare function saveAgentsFile(file: AgentsFile): void;
export declare class ConfigCache {
    private snapshot;
    constructor();
    current(): AgentsFile;
    reload(): AgentsFile;
    findAgent(id: string): AgentProfile | undefined;
    agentForChannel(channel: string): AgentProfile | undefined;
    upsertAgent(agent: AgentProfile): void;
    removeAgent(id: string): boolean;
    setBindings(bindings: ChannelBinding[]): void;
}
