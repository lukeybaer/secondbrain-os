// session-archive.ts
//
// Tier-4 memory retrieval source: the S3 session archive indexed via
// SQLite FTS5 at ~/.secondbrain/sessions.db. When Amy is building
// context for a query, this module is consulted AFTER canonical
// memory, Graphiti, and working memory so prior Claude Code
// conversations with Luke are visible as "here's what you asked
// about this topic before."
//
// Closes Luke's 2026-04-11 concern: "you were so confused about our
// requirements before forgetting what I wanted." With this source
// wired into buildUnifiedContext, Amy can pull prior claims + answers
// from her own session history instead of reconstructing from context.
//
// Commit 18 of 18 in plans/dazzling-rolling-moler.md.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DB_PATH = path.join(os.homedir(), '.secondbrain', 'sessions.db');

/**
 * Escape an FTS5 query so user input doesn't break the query parser.
 * We only keep alphanumerics, spaces, and basic punctuation, then wrap
 * each token in double quotes for an implicit AND.
 */
function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/[^a-zA-Z0-9._-]/g, ''))
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return '';
  // FTS5 OR across tokens = more hits; AND = more precision. Default
  // to OR so Amy surfaces approximate matches when Luke's phrasing
  // doesn't match an exact prior prompt.
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

export interface SessionHit {
  sessionId: string;
  startedAt: string | null;
  topicGuess: string;
  firstPrompt: string;
  lastResponse: string;
}

/**
 * Query the FTS5 session index. Returns up to `limit` most recent
 * matching sessions. Returns empty array if the DB file doesn't exist
 * yet (backfill not run) or if better-sqlite3 fails to load (e.g. in
 * a test environment without the native module).
 */
export function searchSessionArchive(query: string, limit = 5): SessionHit[] {
  if (!query || !query.trim()) return [];
  if (!fs.existsSync(DB_PATH)) return [];

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    return [];
  }

  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  let db: any;
  try {
    db = new Database(DB_PATH, { readonly: true });
  } catch {
    return [];
  }

  try {
    const rows = db
      .prepare(
        `SELECT s.session_id AS sessionId,
                s.started_at AS startedAt,
                s.topic_guess AS topicGuess,
                s.first_prompt AS firstPrompt,
                s.last_response AS lastResponse
         FROM sessions_fts
         JOIN sessions s ON s.rowid = sessions_fts.rowid
         WHERE sessions_fts MATCH ?
         ORDER BY s.started_at DESC
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as SessionHit[];
    return rows;
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Format session hits for injection into a memory context block. Truncates
 * fields so the total block stays under `maxChars`.
 */
export function formatSessionArchiveBlock(hits: SessionHit[], maxChars = 1200): string {
  if (hits.length === 0) return '';

  const lines: string[] = ['### Session archive (prior conversations on this topic)'];
  for (const h of hits) {
    const date = h.startedAt ? h.startedAt.slice(0, 10) : '(undated)';
    const idShort = h.sessionId.slice(0, 8);
    const topic = h.topicGuess?.slice(0, 120).replace(/\s+/g, ' ') ?? '';
    const prompt = h.firstPrompt?.slice(0, 200).replace(/\s+/g, ' ') ?? '';
    const reply = h.lastResponse?.slice(0, 200).replace(/\s+/g, ' ') ?? '';
    lines.push(`- ${date} [${idShort}] ${topic}`);
    if (prompt) lines.push(`  prompt: ${prompt}`);
    if (reply) lines.push(`  reply:  ${reply}`);
  }

  const joined = lines.join('\n');
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars - 12) + '\n… truncated';
}

/**
 * Convenience wrapper that searches and formats in one step.
 */
export function buildSessionArchiveContext(query: string, maxChars = 1200): string {
  const hits = searchSessionArchive(query, 5);
  return formatSessionArchiveBlock(hits, maxChars);
}
