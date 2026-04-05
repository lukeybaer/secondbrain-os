// whitelist.ts — caller screening / tier lookup
// Backed by SQLite (pending_approvals table lives in database-sqlite.ts).
// API is identical to the old JSON-on-disk version — callers don't need changes.

import {
  upsertWhitelistEntry,
  getWhitelistEntry,
  removeWhitelistEntry,
  getAllWhitelistEntries,
  type DbWhitelistEntry,
} from "./database-sqlite";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Screening tier:
 *  0 = VIP  — instant transfer, bypass EA entirely
 *  1 = Known — EA bridges (introduces itself and passes call through)
 *  2 = Unknown — EA screens (asks caller's name / purpose before deciding)
 *  3 = Block — hang up immediately
 */
export type WhitelistTier = 0 | 1 | 2 | 3;

export interface WhitelistEntry {
  phone_number: string; // E.164 format, e.g. "+15555555555"
  name: string;
  tier: WhitelistTier;
  notes?: string;
  added_at: string; // ISO 8601
}

export interface ScreeningResult {
  action: "instant_transfer" | "bridge" | "screen" | "block";
  entry?: WhitelistEntry;
  tier: WhitelistTier;
}

// ── Tier → action mapping ─────────────────────────────────────────────────────

function tierToAction(tier: WhitelistTier): ScreeningResult["action"] {
  switch (tier) {
    case 0: return "instant_transfer";
    case 1: return "bridge";
    case 2: return "screen";
    case 3: return "block";
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** No-op — initialization is handled by database-sqlite.ts's initDatabase() at startup. */
export async function initWhitelist(): Promise<void> {
  // SQLite init + seed happens in initDatabase() — nothing to do here
}

/**
 * Looks up a phone number and returns the appropriate screening action.
 * Unknown numbers default to tier 2 (screen).
 */
export async function checkNumber(phoneNumber: string): Promise<ScreeningResult> {
  const entry = getWhitelistEntry(phoneNumber) as DbWhitelistEntry | null;

  if (!entry) {
    return { action: "screen", tier: 2 };
  }

  const tier = entry.tier as WhitelistTier;
  return { action: tierToAction(tier), entry, tier };
}

/**
 * Inserts or replaces a whitelist entry (upsert by phone_number).
 */
export async function addToWhitelist(entry: WhitelistEntry): Promise<void> {
  upsertWhitelistEntry(entry as DbWhitelistEntry);
}

/**
 * Removes an entry by phone number. No-op if not found.
 */
export async function removeFromWhitelist(phoneNumber: string): Promise<void> {
  removeWhitelistEntry(phoneNumber);
}

/**
 * Returns the full whitelist sorted by tier then name.
 */
export async function getWhitelist(): Promise<WhitelistEntry[]> {
  return getAllWhitelistEntries() as WhitelistEntry[];
}

/**
 * Seeds the whitelist with default trusted contacts.
 * Safe to call on every startup — handled by database-sqlite.ts's seedDefaultWhitelistDb().
 */
export async function seedDefaultWhitelist(): Promise<void> {
  // Handled automatically by initDatabase()
}
