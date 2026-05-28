// timemachine-db.ts
// SQLite tables + FTS5 full-text search for Time Machine.
// Stores OCR text from screenshots and audio transcripts locally for fast search.
// Binary files (screenshots, audio) live in S3 — only paths/keys stored here.

import { getDb } from './database-sqlite';

// ─── Types ──────────────────────────────────────────────────────────────

export interface TmFrame {
  id: number;
  timestamp: string;
  ocr_text: string;
  s3_key: string | null;
  local_path: string | null;
  file_size: number;
  is_duplicate: number;
  created_at: string;
}

export interface TmAudioSegment {
  id: number;
  start_time: string;
  end_time: string;
  s3_key: string | null;
  local_path: string | null;
  transcript: string;
  is_conversation: number;
  conversation_id: string | null;
  created_at: string;
}

export interface TmConversation {
  id: string;
  start_time: string;
  end_time: string;
  duration_seconds: number;
  transcript: string;
  status: 'detected' | 'transcribing' | 'tagging' | 'complete' | 'error';
  conversation_id: string | null;
  created_at: string;
}

export interface TmSearchResult {
  type: 'screenshot' | 'audio';
  timestamp: string;
  text: string;
  s3_key?: string;
  local_path?: string;
}

export interface TmStorageStats {
  totalFrames: number;
  totalAudioSegments: number;
  totalConversations: number;
  framesWithFiles: number;
  audioWithFiles: number;
  todayFrames: number;
  todayConversations: number;
}

// ─── Frame Queries ──────────────────────────────────────────────────────

export function insertFrame(
  timestamp: string,
  ocrText: string,
  s3Key: string | null,
  localPath: string | null,
  fileSize: number,
  isDuplicate: boolean,
): number {
  const db = getDb();
  const result = db
    .prepare(
      `
    INSERT INTO tm_frames (timestamp, ocr_text, s3_key, local_path, file_size, is_duplicate, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      timestamp,
      ocrText,
      s3Key,
      localPath,
      fileSize,
      isDuplicate ? 1 : 0,
      new Date().toISOString(),
    );
  return result.lastInsertRowid as number;
}

export function getFramesInRange(start: string, end: string, limit = 200): TmFrame[] {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT * FROM tm_frames
    WHERE timestamp >= ? AND timestamp <= ? AND is_duplicate = 0
    ORDER BY timestamp DESC
    LIMIT ?
  `,
    )
    .all(start, end, limit) as TmFrame[];
}

export function getRecentFrames(limit = 50): TmFrame[] {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT * FROM tm_frames
    WHERE is_duplicate = 0
    ORDER BY timestamp DESC
    LIMIT ?
  `,
    )
    .all(limit) as TmFrame[];
}

export function searchFrameText(query: string, limit = 50): TmFrame[] {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT f.* FROM tm_frames_fts fts
    JOIN tm_frames f ON f.rowid = fts.rowid
    WHERE tm_frames_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `,
    )
    .all(query, limit) as TmFrame[];
}

// ─── Audio Queries ──────────────────────────────────────────────────────

export function insertAudioSegment(
  startTime: string,
  endTime: string,
  s3Key: string | null,
  localPath: string | null,
  transcript: string,
  isConversation: boolean,
): number {
  const db = getDb();
  const result = db
    .prepare(
      `
    INSERT INTO tm_audio_segments (start_time, end_time, s3_key, local_path, transcript, is_conversation, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      startTime,
      endTime,
      s3Key,
      localPath,
      transcript,
      isConversation ? 1 : 0,
      new Date().toISOString(),
    );
  return result.lastInsertRowid as number;
}

export function getAudioInRange(start: string, end: string): TmAudioSegment[] {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT * FROM tm_audio_segments
    WHERE start_time >= ? AND end_time <= ?
    ORDER BY start_time DESC
  `,
    )
    .all(start, end) as TmAudioSegment[];
}

export function searchTranscripts(query: string, limit = 50): TmAudioSegment[] {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT a.* FROM tm_audio_fts fts
    JOIN tm_audio_segments a ON a.rowid = fts.rowid
    WHERE tm_audio_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `,
    )
    .all(query, limit) as TmAudioSegment[];
}

export function markAsConversation(segmentId: number, conversationId: string): void {
  const db = getDb();
  db.prepare(
    `
    UPDATE tm_audio_segments SET is_conversation = 1, conversation_id = ? WHERE id = ?
  `,
  ).run(conversationId, segmentId);
}

// ─── Conversation Queries ───────────────────────────────────────────────

export function insertConversation(
  id: string,
  startTime: string,
  endTime: string,
  durationSeconds: number,
  transcript: string,
): void {
  const db = getDb();
  db.prepare(
    `
    INSERT OR REPLACE INTO tm_conversations (id, start_time, end_time, duration_seconds, transcript, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'detected', ?)
  `,
  ).run(id, startTime, endTime, durationSeconds, transcript, new Date().toISOString());
}

export function updateConversationStatus(
  id: string,
  status: TmConversation['status'],
  conversationId?: string,
): void {
  const db = getDb();
  if (conversationId) {
    db.prepare(`UPDATE tm_conversations SET status = ?, conversation_id = ? WHERE id = ?`).run(
      status,
      conversationId,
      id,
    );
  } else {
    db.prepare(`UPDATE tm_conversations SET status = ? WHERE id = ?`).run(status, id);
  }
}

export function getPendingConversations(): TmConversation[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM tm_conversations WHERE status = 'detected' ORDER BY start_time`)
    .all() as TmConversation[];
}

// ─── Combined Search ────────────────────────────────────────────────────

export function searchAll(query: string, limit = 50): TmSearchResult[] {
  const frames = searchFrameText(query, limit);
  const audio = searchTranscripts(query, limit);

  const results: TmSearchResult[] = [
    ...frames.map((f) => ({
      type: 'screenshot' as const,
      timestamp: f.timestamp,
      text: f.ocr_text,
      s3_key: f.s3_key || undefined,
      local_path: f.local_path || undefined,
    })),
    ...audio.map((a) => ({
      type: 'audio' as const,
      timestamp: a.start_time,
      text: a.transcript,
      s3_key: a.s3_key || undefined,
      local_path: a.local_path || undefined,
    })),
  ];

  // Sort by timestamp descending
  results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return results.slice(0, limit);
}

// ─── Storage Stats ──────────────────────────────────────────────────────

export function getStorageStats(): TmStorageStats {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const totalFrames = (db.prepare(`SELECT COUNT(*) as c FROM tm_frames`).get() as any)?.c || 0;
  const totalAudio =
    (db.prepare(`SELECT COUNT(*) as c FROM tm_audio_segments`).get() as any)?.c || 0;
  const totalConvs =
    (db.prepare(`SELECT COUNT(*) as c FROM tm_conversations`).get() as any)?.c || 0;
  const framesWithFiles =
    (db.prepare(`SELECT COUNT(*) as c FROM tm_frames WHERE local_path IS NOT NULL`).get() as any)
      ?.c || 0;
  const audioWithFiles =
    (
      db
        .prepare(`SELECT COUNT(*) as c FROM tm_audio_segments WHERE local_path IS NOT NULL`)
        .get() as any
    )?.c || 0;
  const todayFrames =
    (
      db
        .prepare(`SELECT COUNT(*) as c FROM tm_frames WHERE timestamp >= ?`)
        .get(`${today}T00:00:00`) as any
    )?.c || 0;
  const todayConvs =
    (
      db
        .prepare(`SELECT COUNT(*) as c FROM tm_conversations WHERE start_time >= ?`)
        .get(`${today}T00:00:00`) as any
    )?.c || 0;

  return {
    totalFrames,
    totalAudioSegments: totalAudio,
    totalConversations: totalConvs,
    framesWithFiles,
    audioWithFiles,
    todayFrames,
    todayConversations: todayConvs,
  };
}

// ─── Pruning Queries ────────────────────────────────────────────────────

export function getExpiredFramePaths(beforeDate: string): { id: number; local_path: string }[] {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT id, local_path FROM tm_frames
    WHERE timestamp < ? AND local_path IS NOT NULL
  `,
    )
    .all(beforeDate) as any[];
}

export function updateFrameOcr(id: number, ocrText: string): void {
  const db = getDb();
  db.prepare(`UPDATE tm_frames SET ocr_text = ? WHERE id = ?`).run(ocrText, id);
}

export function nullifyFrameFiles(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE tm_frames SET local_path = NULL WHERE id IN (${placeholders})`).run(...ids);
}

export function getExpiredAudioPaths(beforeDate: string): { id: number; local_path: string }[] {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT id, local_path FROM tm_audio_segments
    WHERE start_time < ? AND local_path IS NOT NULL
  `,
    )
    .all(beforeDate) as any[];
}

export function nullifyAudioFiles(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE tm_audio_segments SET local_path = NULL WHERE id IN (${placeholders})`).run(
    ...ids,
  );
}
