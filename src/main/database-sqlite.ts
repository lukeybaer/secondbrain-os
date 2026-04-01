// database-sqlite.ts
// SQLite-backed persistent store for SecondBrain.
// Replaces in-memory Maps and per-entity JSON files for:
//   - pending_approvals  (was: Map in telegram.ts + server.ts)
//   - whitelist          (was: whitelist.json)
//   - call_state         (was: calls/{id}.json)
//   - reputation_events  (new)
//   - process_locks      (idempotency guard for scheduled jobs)
//
// Uses better-sqlite3 (synchronous, zero-promise overhead).
// Marked external in electron.vite.config.ts — never bundled by Vite.

import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import { app } from "electron";

// ── Singleton DB connection ───────────────────────────────────────────────────

let _db: Database.Database | null = null;

function getDbPath(): string {
  const dataDir = path.join(app.getPath("userData"), "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "secondbrain.db");
}

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(getDbPath());
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  runMigrations(_db);
  return _db;
}

// ── Migrations ────────────────────────────────────────────────────────────────

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  const current = row?.v ?? 0;

  const migrations: Array<{ version: number; sql: string }> = [
    {
      version: 1,
      sql: `
        -- Approval requests from EA during live calls
        CREATE TABLE IF NOT EXISTS pending_approvals (
          id          TEXT PRIMARY KEY,
          call_id     TEXT,
          request_type TEXT NOT NULL
            CHECK(request_type IN ('share_pii','transfer_call','commit_to_action','reputation_risk','content_approval')),
          description TEXT NOT NULL,
          data_category TEXT,
          created_at  TEXT NOT NULL,
          status      TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','approved','denied','timed_out')),
          resolved_at TEXT,
          response_data TEXT
        );

        -- Caller screening / whitelist
        CREATE TABLE IF NOT EXISTS whitelist (
          phone_number TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          tier         INTEGER NOT NULL DEFAULT 2
            CHECK(tier IN (0,1,2,3)),
          notes        TEXT,
          added_at     TEXT NOT NULL
        );

        -- Reputation-risk events flagged during calls
        CREATE TABLE IF NOT EXISTS reputation_events (
          id          TEXT PRIMARY KEY,
          call_id     TEXT,
          flagged_at  TEXT NOT NULL,
          category    TEXT NOT NULL,
          description TEXT NOT NULL,
          severity    TEXT NOT NULL DEFAULT 'medium'
            CHECK(severity IN ('low','medium','high','critical')),
          transcript_excerpt TEXT,
          reviewed    INTEGER NOT NULL DEFAULT 0
        );

        -- Process locks for scheduled jobs (one job, one flag)
        CREATE TABLE IF NOT EXISTS process_locks (
          lock_key    TEXT PRIMARY KEY,
          acquired_at TEXT NOT NULL,
          expires_at  TEXT NOT NULL,
          job_name    TEXT
        );
      `,
    },
    {
      version: 2,
      sql: `
        -- Index for quick approval lookups by status
        CREATE INDEX IF NOT EXISTS idx_approvals_status ON pending_approvals(status, created_at);

        -- Index for reputation events by call
        CREATE INDEX IF NOT EXISTS idx_reputation_call ON reputation_events(call_id, flagged_at);

        -- Expired lock cleanup view helper (not a real view — just documenting intent)
        CREATE INDEX IF NOT EXISTS idx_locks_expires ON process_locks(expires_at);
      `,
    },
  ];

  for (const m of migrations) {
    if (m.version <= current) continue;
    db.exec(m.sql);
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
    console.log(`[db] Applied migration v${m.version}`);
  }
}

// ── Pending Approvals ─────────────────────────────────────────────────────────

export interface DbApproval {
  id: string;
  call_id?: string;
  request_type: "share_pii" | "transfer_call" | "commit_to_action" | "reputation_risk" | "content_approval";
  description: string;
  data_category?: string;
  created_at: string;
  status: "pending" | "approved" | "denied" | "timed_out";
  resolved_at?: string;
  response_data?: string;
}

export function createApproval(approval: Omit<DbApproval, "status">): DbApproval {
  const db = getDb();
  const row: DbApproval = { ...approval, status: "pending" };
  db.prepare(`
    INSERT INTO pending_approvals
      (id, call_id, request_type, description, data_category, created_at, status)
    VALUES
      (@id, @call_id, @request_type, @description, @data_category, @created_at, 'pending')
  `).run(row);
  return row;
}

export function getApproval(id: string): DbApproval | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM pending_approvals WHERE id = ?").get(id) as DbApproval) ?? null;
}

export function resolveApproval(
  id: string,
  status: "approved" | "denied" | "timed_out",
  responseData?: string,
): void {
  const db = getDb();
  db.prepare(`
    UPDATE pending_approvals
    SET status = ?, resolved_at = ?, response_data = ?
    WHERE id = ?
  `).run(status, new Date().toISOString(), responseData ?? null, id);
}

export function getLatestPendingApproval(): DbApproval | null {
  const db = getDb();
  return (db.prepare(`
    SELECT * FROM pending_approvals
    WHERE status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
  `).get() as DbApproval) ?? null;
}

export function listPendingApprovals(): DbApproval[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY created_at ASC
  `).all() as DbApproval[];
}

// ── Whitelist ─────────────────────────────────────────────────────────────────

export interface DbWhitelistEntry {
  phone_number: string;
  name: string;
  tier: 0 | 1 | 2 | 3;
  notes?: string;
  added_at: string;
}

export function upsertWhitelistEntry(entry: DbWhitelistEntry): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO whitelist (phone_number, name, tier, notes, added_at)
    VALUES (@phone_number, @name, @tier, @notes, @added_at)
    ON CONFLICT(phone_number) DO UPDATE SET
      name = excluded.name,
      tier = excluded.tier,
      notes = excluded.notes
  `).run(entry);
}

export function getWhitelistEntry(phoneNumber: string): DbWhitelistEntry | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM whitelist WHERE phone_number = ?").get(phoneNumber) as DbWhitelistEntry) ?? null;
}

export function removeWhitelistEntry(phoneNumber: string): void {
  const db = getDb();
  db.prepare("DELETE FROM whitelist WHERE phone_number = ?").run(phoneNumber);
}

export function getAllWhitelistEntries(): DbWhitelistEntry[] {
  const db = getDb();
  return db.prepare("SELECT * FROM whitelist ORDER BY tier ASC, name ASC").all() as DbWhitelistEntry[];
}

export function seedDefaultWhitelistDb(): void {
  const now = new Date().toISOString();
  const defaults: DbWhitelistEntry[] = [
    {
      phone_number: "+15555555555",
      name: "Owner (test)",
      tier: 0,
      notes: "Owner's number — update via Settings or whitelist UI",
      added_at: now,
    },
  ];
  const db = getDb();
  for (const entry of defaults) {
    const existing = db.prepare("SELECT 1 FROM whitelist WHERE phone_number = ?").get(entry.phone_number);
    if (!existing) upsertWhitelistEntry(entry);
  }
}

// ── Reputation Events ─────────────────────────────────────────────────────────

export interface DbReputationEvent {
  id: string;
  call_id?: string;
  flagged_at: string;
  category: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  transcript_excerpt?: string;
  reviewed: boolean;
}

export function createReputationEvent(event: Omit<DbReputationEvent, "reviewed">): DbReputationEvent {
  const db = getDb();
  const row = { ...event, reviewed: 0 };
  db.prepare(`
    INSERT INTO reputation_events
      (id, call_id, flagged_at, category, description, severity, transcript_excerpt, reviewed)
    VALUES
      (@id, @call_id, @flagged_at, @category, @description, @severity, @transcript_excerpt, 0)
  `).run(row);
  return { ...event, reviewed: false };
}

export function getUnreviewedReputationEvents(): DbReputationEvent[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM reputation_events WHERE reviewed = 0 ORDER BY flagged_at DESC
  `).all() as Array<Omit<DbReputationEvent, "reviewed"> & { reviewed: number }>;
  return rows.map((r) => ({ ...r, reviewed: r.reviewed === 1 }));
}

export function markReputationEventReviewed(id: string): void {
  const db = getDb();
  db.prepare("UPDATE reputation_events SET reviewed = 1 WHERE id = ?").run(id);
}

// ── Process Locks (idempotency) ───────────────────────────────────────────────

/**
 * Attempt to acquire a named process lock.
 * Returns true if acquired, false if already held (and not expired).
 * Lock auto-expires after timeoutMinutes.
 */
export function acquireLock(lockKey: string, jobName: string, timeoutMinutes = 30): boolean {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + timeoutMinutes * 60_000).toISOString();

  // Purge expired locks first
  db.prepare("DELETE FROM process_locks WHERE expires_at < ?").run(now.toISOString());

  const existing = db.prepare("SELECT 1 FROM process_locks WHERE lock_key = ?").get(lockKey);
  if (existing) return false; // already held

  try {
    db.prepare(`
      INSERT INTO process_locks (lock_key, acquired_at, expires_at, job_name)
      VALUES (?, ?, ?, ?)
    `).run(lockKey, now.toISOString(), expiresAt, jobName);
    return true;
  } catch {
    return false; // race condition — another process grabbed it
  }
}

export function releaseLock(lockKey: string): void {
  const db = getDb();
  db.prepare("DELETE FROM process_locks WHERE lock_key = ?").run(lockKey);
}

export function lockExists(lockKey: string): boolean {
  const db = getDb();
  // Purge expired first
  db.prepare("DELETE FROM process_locks WHERE expires_at < ?").run(new Date().toISOString());
  return !!db.prepare("SELECT 1 FROM process_locks WHERE lock_key = ?").get(lockKey);
}

// ── Init (call once at app startup) ──────────────────────────────────────────

export function initDatabase(): void {
  try {
    getDb(); // triggers migrations
    seedDefaultWhitelistDb();
    console.log("[db] SQLite initialized at", getDbPath());
  } catch (err) {
    console.error("[db] SQLite initialization failed:", err);
    throw err;
  }
}
