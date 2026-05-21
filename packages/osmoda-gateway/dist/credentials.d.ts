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
export declare function updateCredentialMeta(id: string, patch: Partial<Pick<Credential, "label" | "last_tested_at" | "last_test_ok" | "last_test_error" | "last_used_at">>): boolean;
/** Strip secrets for safe serialization over the wire. */
export declare function redact(cred: Credential): Omit<Credential, "secret"> & {
    secret_preview: string;
};
