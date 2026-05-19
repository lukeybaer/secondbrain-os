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

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

// ── Singleton DB connection ───────────────────────────────────────────────────

let _db: Database.Database | null = null;

function getDbPath(): string {
  const dataDir = path.join(app.getPath('userData'), 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'secondbrain.db');
}

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(getDbPath());
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
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

  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null;
  };
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
    {
      version: 3,
      sql: `
        -- Time Machine: screenshot frames with OCR text
        CREATE TABLE IF NOT EXISTS tm_frames (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp   TEXT NOT NULL,
          ocr_text    TEXT NOT NULL DEFAULT '',
          s3_key      TEXT,
          local_path  TEXT,
          file_size   INTEGER NOT NULL DEFAULT 0,
          is_duplicate INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tm_frames_ts ON tm_frames(timestamp);

        -- FTS5 full-text search on screenshot OCR text
        CREATE VIRTUAL TABLE IF NOT EXISTS tm_frames_fts USING fts5(
          ocr_text, content=tm_frames, content_rowid=id
        );

        -- Sync triggers for FTS5
        CREATE TRIGGER IF NOT EXISTS tm_frames_ai AFTER INSERT ON tm_frames BEGIN
          INSERT INTO tm_frames_fts(rowid, ocr_text) VALUES (new.id, new.ocr_text);
        END;
        CREATE TRIGGER IF NOT EXISTS tm_frames_ad AFTER DELETE ON tm_frames BEGIN
          INSERT INTO tm_frames_fts(tm_frames_fts, rowid, ocr_text) VALUES('delete', old.id, old.ocr_text);
        END;
        CREATE TRIGGER IF NOT EXISTS tm_frames_au AFTER UPDATE ON tm_frames BEGIN
          INSERT INTO tm_frames_fts(tm_frames_fts, rowid, ocr_text) VALUES('delete', old.id, old.ocr_text);
          INSERT INTO tm_frames_fts(rowid, ocr_text) VALUES (new.id, new.ocr_text);
        END;

        -- Time Machine: audio segments with transcripts
        CREATE TABLE IF NOT EXISTS tm_audio_segments (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          start_time      TEXT NOT NULL,
          end_time        TEXT NOT NULL,
          s3_key          TEXT,
          local_path      TEXT,
          transcript      TEXT NOT NULL DEFAULT '',
          is_conversation INTEGER NOT NULL DEFAULT 0,
          conversation_id TEXT,
          created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tm_audio_start ON tm_audio_segments(start_time);

        -- FTS5 full-text search on audio transcripts
        CREATE VIRTUAL TABLE IF NOT EXISTS tm_audio_fts USING fts5(
          transcript, content=tm_audio_segments, content_rowid=id
        );

        CREATE TRIGGER IF NOT EXISTS tm_audio_ai AFTER INSERT ON tm_audio_segments BEGIN
          INSERT INTO tm_audio_fts(rowid, transcript) VALUES (new.id, new.transcript);
        END;
        CREATE TRIGGER IF NOT EXISTS tm_audio_ad AFTER DELETE ON tm_audio_segments BEGIN
          INSERT INTO tm_audio_fts(tm_audio_fts, rowid, transcript) VALUES('delete', old.id, old.transcript);
        END;
        CREATE TRIGGER IF NOT EXISTS tm_audio_au AFTER UPDATE ON tm_audio_segments BEGIN
          INSERT INTO tm_audio_fts(tm_audio_fts, rowid, transcript) VALUES('delete', old.id, old.transcript);
          INSERT INTO tm_audio_fts(rowid, transcript) VALUES (new.id, new.transcript);
        END;

        -- Time Machine: detected conversations
        CREATE TABLE IF NOT EXISTS tm_conversations (
          id              TEXT PRIMARY KEY,
          start_time      TEXT NOT NULL,
          end_time        TEXT NOT NULL,
          duration_seconds INTEGER NOT NULL DEFAULT 0,
          transcript      TEXT NOT NULL DEFAULT '',
          status          TEXT NOT NULL DEFAULT 'detected'
            CHECK(status IN ('detected','transcribing','tagging','complete','error')),
          conversation_id TEXT,
          created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tm_conv_start ON tm_conversations(start_time);
      `,
    },
    {
      version: 4,
      sql: `
        -- Append-only security audit trail for user, AI, tool, and external actions.
        CREATE TABLE IF NOT EXISTS audit_logs (
          id            TEXT PRIMARY KEY,
          created_at    TEXT NOT NULL,
          actor_type    TEXT NOT NULL,
          actor_id      TEXT,
          source        TEXT NOT NULL,
          action        TEXT NOT NULL,
          risk_level    TEXT NOT NULL
            CHECK(risk_level IN ('low','medium','high','critical')),
          decision      TEXT NOT NULL,
          approval_id   TEXT,
          target_type   TEXT,
          target_id     TEXT,
          summary       TEXT NOT NULL,
          metadata_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action, created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_approval ON audit_logs(approval_id);

        -- Richer metadata for approvals created by centralized policy.
        ALTER TABLE pending_approvals ADD COLUMN actor_type TEXT;
        ALTER TABLE pending_approvals ADD COLUMN actor_id TEXT;
        ALTER TABLE pending_approvals ADD COLUMN source TEXT;
        ALTER TABLE pending_approvals ADD COLUMN action TEXT;
        ALTER TABLE pending_approvals ADD COLUMN risk_level TEXT;
        ALTER TABLE pending_approvals ADD COLUMN target_type TEXT;
        ALTER TABLE pending_approvals ADD COLUMN target_id TEXT;
        ALTER TABLE pending_approvals ADD COLUMN policy_reason TEXT;
        ALTER TABLE pending_approvals ADD COLUMN metadata_json TEXT;
        ALTER TABLE pending_approvals ADD COLUMN expires_at TEXT;
        CREATE INDEX IF NOT EXISTS idx_approvals_action ON pending_approvals(action, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_approvals_target ON pending_approvals(target_type, target_id);
      `,
    },
  ];

  for (const m of migrations) {
    if (m.version <= current) continue;
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    console.log(`[db] Applied migration v${m.version}`);
  }
}

// ── Pending Approvals ─────────────────────────────────────────────────────────

export interface DbApproval {
  id: string;
  call_id?: string;
  request_type:
    | 'share_pii'
    | 'transfer_call'
    | 'commit_to_action'
    | 'reputation_risk'
    | 'content_approval';
  description: string;
  data_category?: string;
  created_at: string;
  status: 'pending' | 'approved' | 'denied' | 'timed_out';
  resolved_at?: string;
  response_data?: string;
  actor_type?: string;
  actor_id?: string;
  source?: string;
  action?: string;
  risk_level?: 'low' | 'medium' | 'high' | 'critical';
  target_type?: string;
  target_id?: string;
  policy_reason?: string;
  metadata_json?: string;
  expires_at?: string;
}

export function createApproval(approval: Omit<DbApproval, 'status'>): DbApproval {
  const db = getDb();
  const row: DbApproval = { ...approval, status: 'pending' };
  const params = {
    id: row.id,
    call_id: row.call_id ?? null,
    request_type: row.request_type,
    description: row.description,
    data_category: row.data_category ?? null,
    created_at: row.created_at,
    actor_type: row.actor_type ?? null,
    actor_id: row.actor_id ?? null,
    source: row.source ?? null,
    action: row.action ?? null,
    risk_level: row.risk_level ?? null,
    target_type: row.target_type ?? null,
    target_id: row.target_id ?? null,
    policy_reason: row.policy_reason ?? null,
    metadata_json: row.metadata_json ?? null,
    expires_at: row.expires_at ?? null,
  };
  db.prepare(
    `
    INSERT INTO pending_approvals
      (id, call_id, request_type, description, data_category, created_at, status,
       actor_type, actor_id, source, action, risk_level, target_type, target_id,
       policy_reason, metadata_json, expires_at)
    VALUES
      (@id, @call_id, @request_type, @description, @data_category, @created_at, 'pending',
       @actor_type, @actor_id, @source, @action, @risk_level, @target_type, @target_id,
       @policy_reason, @metadata_json, @expires_at)
  `,
  ).run(params);
  return row;
}

export function getApproval(id: string): DbApproval | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM pending_approvals WHERE id = ?').get(id) as DbApproval) ?? null;
}

export function resolveApproval(
  id: string,
  status: 'approved' | 'denied' | 'timed_out',
  responseData?: string,
): void {
  const db = getDb();
  db.prepare(
    `
    UPDATE pending_approvals
    SET status = ?, resolved_at = ?, response_data = ?
    WHERE id = ?
  `,
  ).run(status, new Date().toISOString(), responseData ?? null, id);
}

export function getLatestPendingApproval(): DbApproval | null {
  const db = getDb();
  return (
    (db
      .prepare(
        `
    SELECT * FROM pending_approvals
    WHERE status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
  `,
      )
      .get() as DbApproval) ?? null
  );
}

export function listPendingApprovals(): DbApproval[] {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY created_at ASC
  `,
    )
    .all() as DbApproval[];
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
  db.prepare(
    `
    INSERT INTO whitelist (phone_number, name, tier, notes, added_at)
    VALUES (@phone_number, @name, @tier, @notes, @added_at)
    ON CONFLICT(phone_number) DO UPDATE SET
      name = excluded.name,
      tier = excluded.tier,
      notes = excluded.notes
  `,
  ).run(entry);
}

export function getWhitelistEntry(phoneNumber: string): DbWhitelistEntry | null {
  const db = getDb();
  return (
    (db
      .prepare('SELECT * FROM whitelist WHERE phone_number = ?')
      .get(phoneNumber) as DbWhitelistEntry) ?? null
  );
}

export function removeWhitelistEntry(phoneNumber: string): void {
  const db = getDb();
  db.prepare('DELETE FROM whitelist WHERE phone_number = ?').run(phoneNumber);
}

export function getAllWhitelistEntries(): DbWhitelistEntry[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM whitelist ORDER BY tier ASC, name ASC')
    .all() as DbWhitelistEntry[];
}

export function seedDefaultWhitelistDb(): void {
  const now = new Date().toISOString();
  const defaults: DbWhitelistEntry[] = [
    {
      phone_number: '+15555555555',
      name: 'Owner (test)',
      tier: 0,
      notes: "Owner's number — update via Settings or whitelist UI",
      added_at: now,
    },
  ];
  const db = getDb();
  for (const entry of defaults) {
    const existing = db
      .prepare('SELECT 1 FROM whitelist WHERE phone_number = ?')
      .get(entry.phone_number);
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
  severity: 'low' | 'medium' | 'high' | 'critical';
  transcript_excerpt?: string;
  reviewed: boolean;
}

export function createReputationEvent(
  event: Omit<DbReputationEvent, 'reviewed'>,
): DbReputationEvent {
  const db = getDb();
  const row = { ...event, reviewed: 0 };
  db.prepare(
    `
    INSERT INTO reputation_events
      (id, call_id, flagged_at, category, description, severity, transcript_excerpt, reviewed)
    VALUES
      (@id, @call_id, @flagged_at, @category, @description, @severity, @transcript_excerpt, 0)
  `,
  ).run(row);
  return { ...event, reviewed: false };
}

export function getUnreviewedReputationEvents(): DbReputationEvent[] {
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT * FROM reputation_events WHERE reviewed = 0 ORDER BY flagged_at DESC
  `,
    )
    .all() as Array<Omit<DbReputationEvent, 'reviewed'> & { reviewed: number }>;
  return rows.map((r) => ({ ...r, reviewed: r.reviewed === 1 }));
}

export function markReputationEventReviewed(id: string): void {
  const db = getDb();
  db.prepare('UPDATE reputation_events SET reviewed = 1 WHERE id = ?').run(id);
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
  db.prepare('DELETE FROM process_locks WHERE expires_at < ?').run(now.toISOString());

  const existing = db.prepare('SELECT 1 FROM process_locks WHERE lock_key = ?').get(lockKey);
  if (existing) return false; // already held

  try {
    db.prepare(
      `
      INSERT INTO process_locks (lock_key, acquired_at, expires_at, job_name)
      VALUES (?, ?, ?, ?)
    `,
    ).run(lockKey, now.toISOString(), expiresAt, jobName);
    return true;
  } catch {
    return false; // race condition — another process grabbed it
  }
}

export function releaseLock(lockKey: string): void {
  const db = getDb();
  db.prepare('DELETE FROM process_locks WHERE lock_key = ?').run(lockKey);
}

export function lockExists(lockKey: string): boolean {
  const db = getDb();
  // Purge expired first
  db.prepare('DELETE FROM process_locks WHERE expires_at < ?').run(new Date().toISOString());
  return !!db.prepare('SELECT 1 FROM process_locks WHERE lock_key = ?').get(lockKey);
}

// ── Init (call once at app startup) ──────────────────────────────────────────

export function initDatabase(): void {
  try {
    getDb(); // triggers migrations
    seedDefaultWhitelistDb();
    console.log('[db] SQLite initialized at', getDbPath());
  } catch (err) {
    console.error('[db] SQLite initialization failed:', err);
    throw err;
  }
}
