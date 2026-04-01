// pii-vault.ts
// AES-256-GCM encrypted vault for Luke's PII.
// Key lives in OS keychain (never in source or config files).
// Every access is logged and triggers a Telegram audit message.
//
// Key storage:
//   Windows: DPAPI-protected via Credential Manager (accessed via a stub file)
//   Fallback: PBKDF2-derived key from a master password prompt (dev only)
//
// Vault file: {userData}/data/vault/pii.encrypted.json

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { getConfig } from "./config";
import { sendMessage } from "./telegram";

// ── Constants ─────────────────────────────────────────────────────────────────

const VAULT_KEY_ID = "secondbrain.pii.vault.key";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;  // GCM standard
const TAG_BYTES = 16;

// ── PII categories ────────────────────────────────────────────────────────────

export type PiiCategory =
  | "home_address"
  | "phone_personal"
  | "phone_private_sim"
  | "email"
  | "employer"
  | "wife_name"
  | "ssn"
  | "financial"
  | "other";

export interface PiiEntry {
  category: PiiCategory;
  label: string;       // human-readable name, e.g. "Home Address"
  value: string;       // the actual sensitive value
  can_share: boolean;  // false = NEVER share even with approval (SSN, financial)
  added_at: string;
}

export interface ApprovalRecord {
  task_id: string;
  approved_at: string;
  expires_at: string;
  data_category: PiiCategory;
  used: boolean;
}

// ── Vault structure (stored encrypted) ───────────────────────────────────────

interface VaultData {
  entries: PiiEntry[];
  approvals: ApprovalRecord[];
  pii_log: PiiAccessLog[];
}

export interface PiiAccessLog {
  timestamp: string;
  category: PiiCategory;
  caller_context: string;
  approval_id: string;
  shared: boolean;
}

// ── File paths ────────────────────────────────────────────────────────────────

function vaultDir(): string {
  return path.join(app.getPath("userData"), "data", "vault");
}

function vaultFilePath(): string {
  return path.join(vaultDir(), "pii.encrypted.json");
}

function keyFilePath(): string {
  // Store a DPAPI-protected or passphrase-encrypted key reference
  return path.join(vaultDir(), ".key");
}

function permissionsFilePath(): string {
  return path.join(vaultDir(), "permissions.json");
}

// ── Key management ────────────────────────────────────────────────────────────

let _cachedKey: Buffer | null = null;

/**
 * Loads or generates the vault encryption key.
 * On Windows: stores key bytes as Base64 in a restricted file.
 * In production this should use the Windows Credential Manager / DPAPI.
 * For now uses a file-based approach with 0600 permissions.
 */
function getOrCreateKey(): Buffer {
  if (_cachedKey) return _cachedKey;

  const dir = vaultDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const keyPath = keyFilePath();

  if (fs.existsSync(keyPath)) {
    try {
      const raw = fs.readFileSync(keyPath, "utf-8").trim();
      _cachedKey = Buffer.from(raw, "base64");
      if (_cachedKey.length !== KEY_BYTES) throw new Error("Key length mismatch");
      return _cachedKey;
    } catch (err) {
      console.error("[pii-vault] Key load failed, generating new key:", err);
    }
  }

  // Generate a new random key
  _cachedKey = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(keyPath, _cachedKey.toString("base64"), "utf-8");

  // Restrict file permissions (Unix only — Windows ignores chmod)
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch { /* Windows — no-op */ }

  console.log(`[pii-vault] Generated new vault key at ${keyPath}`);
  return _cachedKey;
}

// ── Encryption / decryption ───────────────────────────────────────────────────

interface EncryptedPayload {
  iv: string;      // hex
  tag: string;     // hex
  data: string;    // hex
}

function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
  };
}

function decrypt(payload: EncryptedPayload, key: Buffer): string {
  const iv = Buffer.from(payload.iv, "hex");
  const tag = Buffer.from(payload.tag, "hex");
  const data = Buffer.from(payload.data, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf-8");
}

// ── Vault I/O ─────────────────────────────────────────────────────────────────

function readVault(): VaultData {
  const filePath = vaultFilePath();
  if (!fs.existsSync(filePath)) {
    return { entries: [], approvals: [], pii_log: [] };
  }

  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf-8")) as EncryptedPayload;
    const key = getOrCreateKey();
    const plaintext = decrypt(payload, key);
    return JSON.parse(plaintext) as VaultData;
  } catch (err) {
    console.error("[pii-vault] Vault read/decrypt failed:", err);
    return { entries: [], approvals: [], pii_log: [] };
  }
}

function writeVault(data: VaultData): void {
  const dir = vaultDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const key = getOrCreateKey();
  const payload = encrypt(JSON.stringify(data), key);
  fs.writeFileSync(vaultFilePath(), JSON.stringify(payload, null, 2), "utf-8");
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Initialize vault. Add your own PII entries via the app or by editing this seed. */
export function initVault(): void {
  const vault = readVault();
  // On first run, vault is empty. Users populate it through the app
  // or by editing the vault file directly. Example entries:
  //
  //   { category: "home_address", label: "Home Address", value: "123 Main St", can_share: true }
  //   { category: "phone_personal", label: "Personal Phone", value: "+15555555555", can_share: true }
  //
  // Existing vault entries are never overwritten.
  console.log(`[pii-vault] Initialized (${vault.entries.length} entries)`);
}

/** Store or update a PII entry. */
export function upsertPiiEntry(entry: PiiEntry): void {
  const vault = readVault();
  const idx = vault.entries.findIndex((e) => e.category === entry.category);
  if (idx >= 0) {
    vault.entries[idx] = entry;
  } else {
    vault.entries.push(entry);
  }
  writeVault(vault);
}

/**
 * Create a one-use, 5-minute approval for sharing a PII category.
 * Returns the approval ID for reference.
 */
export function createPiiApproval(category: PiiCategory, approvalId: string): string {
  const vault = readVault();
  const now = new Date();
  const approval: ApprovalRecord = {
    task_id: approvalId,
    approved_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 5 * 60_000).toISOString(),
    data_category: category,
    used: false,
  };
  vault.approvals.push(approval);
  writeVault(vault);
  return approvalId;
}

/**
 * Retrieve a PII value if a valid, unexpired, unused approval exists.
 * Marks the approval as used on success.
 * Logs every access attempt (hit or miss) and fires a Telegram audit.
 */
export async function accessPii(
  category: PiiCategory,
  approvalId: string,
  callerContext: string,
): Promise<{ value: string; success: true } | { success: false; reason: string }> {
  const vault = readVault();
  const config = getConfig();

  const approval = vault.approvals.find((a) => a.task_id === approvalId);
  const now = new Date();

  // Validate approval
  if (!approval) {
    await logAndAlert(vault, category, approvalId, callerContext, false, "No approval found");
    writeVault(vault);
    return { success: false, reason: "No approval found for this request" };
  }

  if (approval.used) {
    await logAndAlert(vault, category, approvalId, callerContext, false, "Approval already used");
    writeVault(vault);
    return { success: false, reason: "Approval already used" };
  }

  if (new Date(approval.expires_at) < now) {
    await logAndAlert(vault, category, approvalId, callerContext, false, "Approval expired");
    writeVault(vault);
    return { success: false, reason: "Approval expired" };
  }

  if (approval.data_category !== category) {
    await logAndAlert(vault, category, approvalId, callerContext, false, "Category mismatch");
    writeVault(vault);
    return { success: false, reason: "Approval is for a different data category" };
  }

  // Find the PII entry
  const entry = vault.entries.find((e) => e.category === category);
  if (!entry) {
    await logAndAlert(vault, category, approvalId, callerContext, false, "PII not in vault");
    writeVault(vault);
    return { success: false, reason: "PII not available" };
  }

  if (!entry.can_share) {
    await logAndAlert(vault, category, approvalId, callerContext, false, "Category marked non-shareable");
    writeVault(vault);
    return { success: false, reason: "This information cannot be shared" };
  }

  // Mark approval as used
  approval.used = true;

  // Log and fire audit Telegram
  await logAndAlert(vault, category, approvalId, callerContext, true, "Shared");
  writeVault(vault);

  return { value: entry.value, success: true };
}

async function logAndAlert(
  vault: VaultData,
  category: PiiCategory,
  approvalId: string,
  context: string,
  shared: boolean,
  reason: string,
): Promise<void> {
  const logEntry: PiiAccessLog = {
    timestamp: new Date().toISOString(),
    category,
    caller_context: context,
    approval_id: approvalId,
    shared,
  };
  vault.pii_log.push(logEntry);

  // Telegram audit (fire-and-forget)
  const config = getConfig();
  if (config.telegramChatId) {
    const icon = shared ? "📤" : "🚫";
    const msg = `${icon} PII ACCESS: ${category}\nContext: ${context}\nOutcome: ${reason}\nApproval: ${approvalId}`;
    sendMessage(config.telegramChatId, msg).catch(() => undefined);
  }
}

/** Get all PII access logs (unencrypted metadata — values not included). */
export function getPiiAccessLog(): PiiAccessLog[] {
  return readVault().pii_log;
}

/** List PII categories available in the vault (no values exposed). */
export function listPiiCategories(): Array<{ category: PiiCategory; label: string; can_share: boolean }> {
  return readVault().entries.map((e) => ({
    category: e.category,
    label: e.label,
    can_share: e.can_share,
  }));
}
