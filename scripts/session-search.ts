#!/usr/bin/env ts-node
/**
 * session-search.ts
 *
 * SQLite FTS5 search over the S3 session archive metadata. Builds a
 * local index at ~/.secondbrain/sessions.db by downloading the
 * {session-id}.meta.json files from s3://secondbrain-sessions-672613094048-us-east-1/
 * and indexing first_prompt, last_response, topic_guess, and tool_calls.
 *
 * Usage:
 *   npx ts-node scripts/session-search.ts build    # full rebuild from S3
 *   npx ts-node scripts/session-search.ts update   # incremental (last 48h)
 *   npx ts-node scripts/session-search.ts search <query>
 *   npx ts-node scripts/session-search.ts recent [N]
 *
 * Addresses Luke's 2026-04-11 "you were confused before forgetting what
 * I wanted" — Amy can now grep prior sessions to see what Luke actually
 * asked in previous conversations.
 *
 * Commit 16 of 18 in plans/dazzling-rolling-moler.md.
 */

import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BUCKET = 'secondbrain-sessions-672613094048-us-east-1';
const REGION = 'us-east-1';
const DB_DIR = path.join(os.homedir(), '.secondbrain');
const DB_PATH = path.join(DB_DIR, 'sessions.db');
const STAGING_DIR = path.join(DB_DIR, 'meta-cache');

interface SessionMeta {
  session_id: string;
  repo: string;
  started_at?: string | null;
  ended_at?: string | null;
  message_count?: number;
  tool_calls?: string[];
  first_prompt?: string;
  last_response?: string;
  topic_guess?: string;
}

function ensureDirs(): void {
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.mkdirSync(STAGING_DIR, { recursive: true });
}

function openDb(): Database.Database {
  ensureDirs();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      repo TEXT,
      started_at TEXT,
      ended_at TEXT,
      message_count INTEGER,
      tool_calls TEXT,
      first_prompt TEXT,
      last_response TEXT,
      topic_guess TEXT,
      s3_date TEXT,
      indexed_at TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      session_id UNINDEXED,
      first_prompt,
      last_response,
      topic_guess,
      tool_calls,
      content='sessions',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
      INSERT INTO sessions_fts(rowid, session_id, first_prompt, last_response, topic_guess, tool_calls)
      VALUES (new.rowid, new.session_id, new.first_prompt, new.last_response, new.topic_guess, new.tool_calls);
    END;

    CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
      INSERT INTO sessions_fts(sessions_fts, rowid, session_id, first_prompt, last_response, topic_guess, tool_calls)
      VALUES('delete', old.rowid, old.session_id, old.first_prompt, old.last_response, old.topic_guess, old.tool_calls);
    END;
  `);
  return db;
}

function listMetaKeysFromS3(): string[] {
  // Only scan the meta/ prefix. Transcripts under transcripts/ are huge
  // and we don't need them for the index — the meta file already has
  // first_prompt, last_response, topic_guess, and tool_calls.
  const out = execSync(`aws s3 ls s3://${BUCKET}/meta/ --recursive --region ${REGION}`, {
    encoding: 'utf-8',
    maxBuffer: 100 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.json'))
    .map((line) => line.split(/\s+/).pop()!)
    .filter(Boolean);
}

function downloadMeta(s3Key: string): SessionMeta | null {
  const localPath = path.join(STAGING_DIR, path.basename(s3Key));
  try {
    execSync(
      `aws s3 cp "s3://${BUCKET}/${s3Key}" "${localPath}" --region ${REGION} --only-show-errors`,
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const content = fs.readFileSync(localPath, 'utf-8');
    return JSON.parse(content) as SessionMeta;
  } catch {
    return null;
  }
}

function extractDateFromKey(s3Key: string): string {
  const match = s3Key.match(/\/(\d{4}-\d{2}-\d{2})\//);
  return match ? match[1] : '';
}

function upsertSession(db: Database.Database, meta: SessionMeta, s3Date: string): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sessions (
      session_id, repo, started_at, ended_at, message_count,
      tool_calls, first_prompt, last_response, topic_guess,
      s3_date, indexed_at
    ) VALUES (
      @session_id, @repo, @started_at, @ended_at, @message_count,
      @tool_calls, @first_prompt, @last_response, @topic_guess,
      @s3_date, @indexed_at
    )
  `);
  stmt.run({
    session_id: meta.session_id,
    repo: meta.repo || 'secondbrain',
    started_at: meta.started_at || null,
    ended_at: meta.ended_at || null,
    message_count: meta.message_count || 0,
    tool_calls: JSON.stringify(meta.tool_calls || []),
    first_prompt: meta.first_prompt || '',
    last_response: meta.last_response || '',
    topic_guess: meta.topic_guess || '',
    s3_date: s3Date,
    indexed_at: new Date().toISOString(),
  });
}

function buildIndex(): void {
  console.log(`Building session index at ${DB_PATH}`);
  const db = openDb();
  const keys = listMetaKeysFromS3();
  console.log(`Found ${keys.length} meta files in s3://${BUCKET}/`);
  let ok = 0;
  let fail = 0;
  for (const key of keys) {
    const meta = downloadMeta(key);
    if (meta && meta.session_id) {
      upsertSession(db, meta, extractDateFromKey(key));
      ok++;
    } else {
      fail++;
    }
    if ((ok + fail) % 25 === 0) {
      console.log(`  ${ok + fail}/${keys.length} processed`);
    }
  }
  console.log(`Index built: ${ok} ok, ${fail} failed`);
  db.close();
}

function search(query: string): void {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT s.session_id, s.started_at, s.topic_guess,
              snippet(sessions_fts, 1, '[', ']', '...', 10) AS prompt_snip,
              snippet(sessions_fts, 2, '[', ']', '...', 10) AS resp_snip
       FROM sessions_fts
       JOIN sessions s ON s.rowid = sessions_fts.rowid
       WHERE sessions_fts MATCH ?
       ORDER BY s.started_at DESC
       LIMIT 20`,
    )
    .all(query) as Array<{
    session_id: string;
    started_at: string;
    topic_guess: string;
    prompt_snip: string;
    resp_snip: string;
  }>;

  if (rows.length === 0) {
    console.log(`No matches for "${query}"`);
    return;
  }

  console.log(`${rows.length} matches for "${query}":\n`);
  for (const r of rows) {
    const date = r.started_at ? r.started_at.slice(0, 10) : '(no date)';
    console.log(`${date}  ${r.session_id.slice(0, 8)}  ${r.topic_guess.slice(0, 80)}`);
    if (r.prompt_snip)
      console.log(`    prompt: ${r.prompt_snip.replace(/\s+/g, ' ').slice(0, 160)}`);
    if (r.resp_snip) console.log(`    reply:  ${r.resp_snip.replace(/\s+/g, ' ').slice(0, 160)}`);
    console.log();
  }
  db.close();
}

function recent(limit: number): void {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT session_id, started_at, topic_guess, message_count
       FROM sessions
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    session_id: string;
    started_at: string;
    topic_guess: string;
    message_count: number;
  }>;

  for (const r of rows) {
    const date = r.started_at ? r.started_at.slice(0, 19).replace('T', ' ') : '(no date)';
    console.log(
      `${date}  ${r.session_id.slice(0, 8)}  [${r.message_count}msg]  ${r.topic_guess.slice(0, 80)}`,
    );
  }
  db.close();
}

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'build':
      buildIndex();
      break;
    case 'search':
      if (args.length === 0) {
        console.error('Usage: session-search.ts search <query>');
        process.exit(1);
      }
      search(args.join(' '));
      break;
    case 'recent':
      recent(parseInt(args[0] || '10', 10));
      break;
    default:
      console.error(
        'Usage:\n  session-search.ts build\n  session-search.ts search <query>\n  session-search.ts recent [N]',
      );
      process.exit(1);
  }
}

main();
