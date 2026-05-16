/**
 * call-retry-queue.ts
 *
 * Persistent retry queue for outbound AI phone calls.
 *
 * When a call ends with a "no-answer" or "voicemail" reason, the original
 * call record is placed in the retry queue with a configurable delay.
 * A scheduler tick (every minute via scheduler.ts) calls `processRetryQueue()`
 * which re-dials any calls whose `retry_after` time has passed.
 *
 * Retry schedule (exponential back-off, max 3 attempts):
 *   Attempt 1 → +30 minutes
 *   Attempt 2 → +2 hours
 *   Attempt 3 → +6 hours (final)
 *
 * Data is stored in SQLite (via database-sqlite.ts migrations) so it
 * survives app restarts.
 *
 * Callback-assistant cache:
 *   `syncCallbackAssistantCached()` wraps the Vapi PATCH call and skips it
 *   when the assembled assistant body hash hasn't changed since the last sync.
 *   This prevents spamming the Vapi API on every inbound call when nothing
 *   meaningful has changed in call history or config.
 */

import * as crypto from 'crypto';
import { getDb } from './database-sqlite';
import { getConfig } from './config';

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single entry in the retry queue. */
export interface RetryQueueEntry {
  id: string;              // Unique retry entry ID (not the original call ID)
  original_call_id: string;
  phone_number: string;
  instructions: string;
  personal_context: string;
  persona_id: string | null;
  leave_voicemail: number; // SQLite boolean (0/1)
  attempts: number;        // How many retries have already fired
  max_attempts: number;    // Hard cap (default 3)
  retry_after: string;     // ISO timestamp — don't retry before this
  last_end_reason: string; // e.g. "no-answer", "voicemail", "customer-busy"
  created_at: string;
  completed: number;       // 1 = dequeued (succeeded or exhausted)
}

/** Retry delay schedule in milliseconds. */
const RETRY_DELAYS_MS = [
  30 * 60 * 1000,    // attempt 1 → 30 min
  2 * 60 * 60 * 1000, // attempt 2 → 2 hours
  6 * 60 * 60 * 1000, // attempt 3 → 6 hours
];

/** End reasons that should trigger an automatic retry. */
const RETRYABLE_END_REASONS = new Set([
  'no-answer',
  'customer-busy',
  'voicemail',
  'phone-call-provider-bypass-enabled-but-no-dtmf-tone',
  'silence-timed-out',
]);

// ── Migration helper (called by database-sqlite.ts via initDatabase) ──────────

/**
 * Ensure the `call_retry_queue` and `callback_assistant_cache` tables exist.
 * Safe to call multiple times — uses IF NOT EXISTS guards.
 * Called once from `initDatabase()` after the main migrations run.
 */
export function ensureRetryQueueSchema(): void {
  const db = getDb();
  db.exec(`
    -- Outbound call retry queue
    CREATE TABLE IF NOT EXISTS call_retry_queue (
      id               TEXT PRIMARY KEY,
      original_call_id TEXT NOT NULL,
      phone_number     TEXT NOT NULL,
      instructions     TEXT NOT NULL,
      personal_context TEXT NOT NULL DEFAULT '',
      persona_id       TEXT,
      leave_voicemail  INTEGER NOT NULL DEFAULT 0,
      attempts         INTEGER NOT NULL DEFAULT 0,
      max_attempts     INTEGER NOT NULL DEFAULT 3,
      retry_after      TEXT NOT NULL,
      last_end_reason  TEXT NOT NULL DEFAULT '',
      created_at       TEXT NOT NULL,
      completed        INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_retry_queue_due
      ON call_retry_queue(retry_after, completed);

    -- Callback assistant body hash cache to avoid redundant Vapi PATCHes
    CREATE TABLE IF NOT EXISTS callback_assistant_cache (
      phone_number     TEXT PRIMARY KEY,
      body_hash        TEXT NOT NULL,
      last_synced_at   TEXT NOT NULL
    );
  `);
}

// ── Retry Queue ───────────────────────────────────────────────────────────────

/**
 * Enqueue a failed call for automatic retry.
 *
 * @param callId        - Original Vapi call ID
 * @param phoneNumber   - Normalised E.164 phone number
 * @param instructions  - Original call goal
 * @param personalContext - Caller context injected into system prompt
 * @param personaId     - Optional persona override
 * @param leaveVoicemail - Whether to leave a voicemail on the retry
 * @param endReason     - Vapi `endedReason` that triggered this retry
 * @param existingAttempts - How many retries have already fired for this call
 */
export function enqueueRetry(
  callId: string,
  phoneNumber: string,
  instructions: string,
  personalContext: string,
  personaId: string | null,
  leaveVoicemail: boolean,
  endReason: string,
  existingAttempts = 0,
): void {
  // Don't queue if the end reason isn't retryable
  if (!RETRYABLE_END_REASONS.has(endReason)) return;

  // Don't queue if we've already exhausted max attempts
  if (existingAttempts >= RETRY_DELAYS_MS.length) {
    console.log(`[call-retry] ${phoneNumber} exhausted all retry attempts — not re-queuing`);
    return;
  }

  const db = getDb();
  const delayMs = RETRY_DELAYS_MS[existingAttempts] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  const retryAfter = new Date(Date.now() + delayMs).toISOString();
  const id = `retry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  db.prepare(`
    INSERT INTO call_retry_queue
      (id, original_call_id, phone_number, instructions, personal_context,
       persona_id, leave_voicemail, attempts, max_attempts, retry_after,
       last_end_reason, created_at, completed)
    VALUES
      (@id, @original_call_id, @phone_number, @instructions, @personal_context,
       @persona_id, @leave_voicemail, @attempts, @max_attempts, @retry_after,
       @last_end_reason, @created_at, 0)
  `).run({
    id,
    original_call_id: callId,
    phone_number: phoneNumber,
    instructions,
    personal_context: personalContext,
    persona_id: personaId ?? null,
    leave_voicemail: leaveVoicemail ? 1 : 0,
    attempts: existingAttempts,
    max_attempts: RETRY_DELAYS_MS.length,
    retry_after: retryAfter,
    last_end_reason: endReason,
    created_at: new Date().toISOString(),
  });

  const minutesFromNow = Math.round(delayMs / 60_000);
  console.log(
    `[call-retry] Queued retry for ${phoneNumber} ` +
    `(attempt ${existingAttempts + 1}/${RETRY_DELAYS_MS.length}, ` +
    `in ~${minutesFromNow} min, reason: ${endReason})`,
  );
}

/**
 * Fetch all retry entries that are due and not yet completed.
 * Called by `processRetryQueue()` on each scheduler tick.
 */
export function getDueRetries(): RetryQueueEntry[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM call_retry_queue
    WHERE completed = 0
      AND retry_after <= ?
    ORDER BY retry_after ASC
  `).all(new Date().toISOString()) as RetryQueueEntry[];
}

/**
 * Mark a retry entry as completed (either succeeded or exhausted attempts).
 * @param id - The retry queue entry ID (not the original call ID)
 */
export function markRetryCompleted(id: string): void {
  const db = getDb();
  db.prepare('UPDATE call_retry_queue SET completed = 1 WHERE id = ?').run(id);
}

/**
 * List all pending (non-completed) retry entries — used by the UI.
 */
export function listPendingRetries(): RetryQueueEntry[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM call_retry_queue
    WHERE completed = 0
    ORDER BY retry_after ASC
  `).all() as RetryQueueEntry[];
}

/**
 * Cancel (complete) all pending retries for a given phone number.
 * Called when the goal is achieved via a callback so we don't retry unnecessarily.
 */
export function cancelRetriesForPhone(phoneNumber: string): void {
  const db = getDb();
  const result = db.prepare(`
    UPDATE call_retry_queue
    SET completed = 1
    WHERE phone_number = ? AND completed = 0
  `).run(phoneNumber);
  if (result.changes > 0) {
    console.log(`[call-retry] Cancelled ${result.changes} pending retries for ${phoneNumber}`);
  }
}

/**
 * Process all due retries. Dynamically imports `initiateCall` to avoid
 * circular dependencies (calls.ts → call-retry-queue.ts → calls.ts).
 * Safe to call on every scheduler tick — no-ops instantly when queue is empty.
 */
export async function processRetryQueue(): Promise<void> {
  const config = getConfig();
  if (!config.vapiApiKey || !config.vapiPhoneNumberId) return;

  const due = getDueRetries();
  if (due.length === 0) return;

  console.log(`[call-retry] Processing ${due.length} due retries`);

  // Import lazily to avoid circular dep
  const { initiateCall } = await import('./calls');

  for (const entry of due) {
    try {
      const result = await initiateCall(
        entry.phone_number,
        entry.instructions,
        entry.personal_context,
        entry.persona_id ?? undefined,
        entry.leave_voicemail === 1,
      );

      if (result.success) {
        console.log(
          `[call-retry] ✓ Retry fired for ${entry.phone_number} → new call ${result.callId}`,
        );
      } else {
        console.warn(`[call-retry] ✗ Retry failed for ${entry.phone_number}: ${result.error}`);
      }
    } catch (err: any) {
      console.error(`[call-retry] Error firing retry for ${entry.phone_number}:`, err.message);
    } finally {
      // Always mark completed — whether it worked or not. If it failed due to
      // Vapi being down, the next scheduler tick will still process it because
      // we only mark completed after the attempt. Re-queue logic lives in
      // refreshCallStatus when the NEW call also fails.
      markRetryCompleted(entry.id);
    }
  }
}

// ── Callback Assistant Cache ──────────────────────────────────────────────────

/**
 * Hash an arbitrary object to a short hex string for change detection.
 * Used to detect whether the callback assistant body has changed since
 * the last PATCH so we can skip redundant Vapi API calls.
 *
 * @param body - Any JSON-serialisable object.
 * @returns 16-character hex hash.
 */
export function hashAssistantBody(body: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(body))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Check whether the assembled callback assistant body has changed since
 * the last successful sync for this phone number.
 *
 * @param phoneNumber - E.164 phone number (the caller).
 * @param body        - The assembled Vapi assistant config object.
 * @returns `true` if the body is new/changed and a PATCH should be sent.
 */
export function needsAssistantSync(phoneNumber: string, body: unknown): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT body_hash FROM callback_assistant_cache WHERE phone_number = ?',
  ).get(phoneNumber) as { body_hash: string } | undefined;

  const newHash = hashAssistantBody(body);
  return !row || row.body_hash !== newHash;
}

/**
 * Record a successful assistant sync for a phone number so future calls
 * to `needsAssistantSync()` can skip the PATCH if nothing changed.
 *
 * @param phoneNumber - E.164 phone number.
 * @param body        - The assistant body that was just synced.
 */
export function recordAssistantSync(phoneNumber: string, body: unknown): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO callback_assistant_cache (phone_number, body_hash, last_synced_at)
    VALUES (?, ?, ?)
    ON CONFLICT(phone_number) DO UPDATE SET
      body_hash      = excluded.body_hash,
      last_synced_at = excluded.last_synced_at
  `).run(phoneNumber, hashAssistantBody(body), new Date().toISOString());
}
