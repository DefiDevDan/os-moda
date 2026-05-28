/**
 * Credential store — AES-256-GCM over a single JSON file.
 *
 * Layout on disk: /var/lib/osmoda/config/credentials.json.enc
 *   ENC:<iv_hex>:<tag_hex>:<ciphertext_hex>
 *
 * Master key resolution, in order:
 *   1. OSMODA_CREDSTORE_KEY env (64-char hex) — for dev
 *   2. Persistent file /var/lib/osmoda/config/.credstore-key (auto-generated, mode 0600)
 *
 * A future iteration will delegate key storage to osmoda-keyd; the file layer
 * keeps working either way because the store only needs bytes.
 *
 * NEVER logs secrets. Only metadata leaves this module on list().
 */
import type { Credential } from "./drivers/types.js";
export declare const CONFIG_DIR: string;
export declare const CREDS_FILE: string;
export interface CredentialsFile {
    version: 1;
    default_credential_id: string | null;
    credentials: Credential[];
}
export declare function loadCredentials(): CredentialsFile;
export declare function saveCredentials(file: CredentialsFile): void;
export declare function addCredential(partial: Omit<Credential, "id" | "created_at">): Credential;
export declare function removeCredential(id: string): boolean;
export declare function setDefault(id: string): boolean;
export declare function getCredential(id: string): Credential | null;
export declare function updateCredentialMeta(id: string, patch: Partial<Pick<Credential, "label" | "last_tested_at" | "last_test_ok" | "last_test_error" | "last_used_at" | "cooldown_until" | "cooldown_reason">>): boolean;
/**
 * Park a credential for `ms` because it errored with a quota/auth/rate-limit
 * signal (out_of_usage / 401 / 429). The session loop will skip cooldowned
 * credentials and fall back to the next healthy one of the same provider+type.
 */
export declare function markCredentialCooldown(id: string, reason: string, ms?: number): boolean;
/** True if this credential is currently in cooldown (cooldown_until > now). */
export declare function isCooldown(c: Pick<Credential, "cooldown_until">): boolean;
/**
 * Pick the next healthy credential of the same provider+type, excluding the
 * one we just tried. Returns null when nothing is available.
 */
export declare function pickFallbackCredential(failed: Credential): Credential | null;
/**
 * Classify a driver error code/text into a cooldown reason string, or null if
 * the error isn't a credential-level failure we should cool down on.
 */
export declare function classifyCredentialError(args: {
    code?: string;
    text?: string;
}): string | null;
/** Strip secrets for safe serialization over the wire. */
export declare function redact(cred: Credential): Omit<Credential, "secret"> & {
    secret_preview: string;
};
