/**
 * REST config endpoints — mounted by index.ts at /config/*.
 *
 * All endpoints require the gateway bearer token (same one used for WS auth).
 * Writes are atomic + trigger SIGHUP to self, so the gateway reloads config
 * without dropping WS clients.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { type ConfigCache } from "./config.js";
export interface ConfigApiDeps {
    cache: ConfigCache;
    authToken: string | null;
    reloadSelf: () => void;
}
/**
 * Returns true if `url.pathname` started with /config/ and the request was
 * handled (response sent). Otherwise returns false so index.ts can fall
 * through to the rest of its routing.
 */
export declare function handleConfigRequest(req: IncomingMessage, res: ServerResponse, url: URL, deps: ConfigApiDeps): Promise<boolean>;
