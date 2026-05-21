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
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
export const CONFIG_DIR = process.env.OSMODA_CONFIG_DIR || "/var/lib/osmoda/config";
export const CREDS_FILE = path.join(CONFIG_DIR, "credentials.json.enc");
const KEY_FILE = path.join(CONFIG_DIR, ".credstore-key");
function masterKey() {
    const env = process.env.OSMODA_CREDSTORE_KEY || "";
    if (/^[0-9a-fA-F]{64}$/.test(env))
        return Buffer.from(env, "hex");
    try {
        const raw = fs.readFileSync(KEY_FILE);
        if (raw.length >= 32)
            return raw.subarray(0, 32);
    }
    catch { /* create below */ }
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const buf = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, buf, { mode: 0o600 });
    return buf;
}
function encrypt(plaintext) {
    const key = masterKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `ENC:${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}
function decrypt(data) {
    if (!data.startsWith("ENC:"))
        return data;
    const parts = data.split(":");
    if (parts.length !== 4)
        throw new Error("credentials.json.enc: malformed envelope");
    const [, ivHex, tagHex, ctHex] = parts;
    if (!/^[0-9a-f]+$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(tagHex) || !/^[0-9a-f]+$/i.test(ctHex)) {
        throw new Error("credentials.json.enc: non-hex envelope field");
    }
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    if (iv.length !== 16 || tag.length !== 16) {
        throw new Error("credentials.json.enc: bad IV/tag length");
    }
    const key = masterKey();
    const dec = crypto.createDecipheriv("aes-256-gcm", key, iv);
    dec.setAuthTag(tag);
    return Buffer.concat([dec.update(Buffer.from(ctHex, "hex")), dec.final()]).toString("utf8");
}
function emptyFile() {
    return { version: 1, default_credential_id: null, credentials: [] };
}
export function loadCredentials() {
    try {
        const raw = fs.readFileSync(CREDS_FILE, "utf8");
        const parsed = JSON.parse(decrypt(raw));
        if (parsed && parsed.version === 1 && Array.isArray(parsed.credentials))
            return parsed;
    }
    catch { /* empty below */ }
    return emptyFile();
}
function atomicWrite(file, content, mode = 0o600) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, content, { mode });
    fs.renameSync(tmp, file);
}
export function saveCredentials(file) {
    if (file.version !== 1)
        file.version = 1;
    atomicWrite(CREDS_FILE, encrypt(JSON.stringify(file, null, 2)));
}
function newId() {
    return "cred_" + crypto.randomBytes(12).toString("hex");
}
export function addCredential(partial) {
    const file = loadCredentials();
    const cred = {
        id: newId(),
        created_at: new Date().toISOString(),
        ...partial,
    };
    file.credentials.push(cred);
    if (!file.default_credential_id)
        file.default_credential_id = cred.id;
    saveCredentials(file);
    return cred;
}
export function removeCredential(id) {
    const file = loadCredentials();
    const idx = file.credentials.findIndex((c) => c.id === id);
    if (idx < 0)
        return false;
    file.credentials.splice(idx, 1);
    if (file.default_credential_id === id) {
        file.default_credential_id = file.credentials[0]?.id || null;
    }
    saveCredentials(file);
    return true;
}
export function setDefault(id) {
    const file = loadCredentials();
    if (!file.credentials.some((c) => c.id === id))
        return false;
    file.default_credential_id = id;
    saveCredentials(file);
    return true;
}
export function getCredential(id) {
    const file = loadCredentials();
    return file.credentials.find((c) => c.id === id) || null;
}
export function updateCredentialMeta(id, patch) {
    const file = loadCredentials();
    const c = file.credentials.find((x) => x.id === id);
    if (!c)
        return false;
    Object.assign(c, patch);
    saveCredentials(file);
    return true;
}
/** Strip secrets for safe serialization over the wire. */
export function redact(cred) {
    const { secret, ...rest } = cred;
    return {
        ...rest,
        secret_preview: secret ? `${secret.slice(0, 12)}…${secret.slice(-4)}` : "",
    };
}
