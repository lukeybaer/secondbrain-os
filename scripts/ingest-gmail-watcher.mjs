#!/usr/bin/env node
// ingest-gmail-watcher.mjs
//
// Polls data/gmail/raw/ for new Gmail message JSON files and ingests each
// new file into Graphiti via graphiti-cli.mjs add. Decoupled from the
// fetcher so any process that drops a JSON file into data/gmail/raw/
// (the IMAP fetcher, the Gmail MCP scan, a future webhook receiver) gets
// picked up automatically.
//
// Seen-set lives at data/agent/gmail-ingest-seen.json. The watcher is
// idempotent: replaying the same raw files is a no-op once they are in
// the seen-set.
//
// Usage:
//   node scripts/ingest-gmail-watcher.mjs              one pass, then exit
//   node scripts/ingest-gmail-watcher.mjs --watch      poll every 30s forever
//   node scripts/ingest-gmail-watcher.mjs --interval 60 --watch
//   node scripts/ingest-gmail-watcher.mjs --reset      clear seen-set first
//   node scripts/ingest-gmail-watcher.mjs --limit 5    ingest at most 5 files
//
// Schedule via the existing 2-minute Otter+Gmail loop, or run on demand.

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const { recordGmailMessage } = require('./lib/spine-ingress');
const REPO_ROOT = resolve(__dirname, '..');
const RAW_DIR = join(REPO_ROOT, 'data', 'gmail', 'raw');
const SEEN_PATH = join(REPO_ROOT, 'data', 'agent', 'gmail-ingest-seen.json');
const GRAPHITI_CLI = join(__dirname, 'graphiti-cli.mjs');

const args = process.argv.slice(2);
const WATCH = args.includes('--watch');
const RESET = args.includes('--reset');
let INTERVAL_MS = 30_000;
const intervalIdx = args.indexOf('--interval');
if (intervalIdx >= 0 && args[intervalIdx + 1]) {
  INTERVAL_MS = parseInt(args[intervalIdx + 1], 10) * 1000;
}
let LIMIT = Infinity;
const limitIdx = args.indexOf('--limit');
if (limitIdx >= 0 && args[limitIdx + 1]) {
  LIMIT = parseInt(args[limitIdx + 1], 10);
}

function loadSeen() {
  if (RESET) return new Set();
  if (!existsSync(SEEN_PATH)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(SEEN_PATH, 'utf8'));
    if (Array.isArray(raw)) return new Set(raw);
    if (raw && Array.isArray(raw.ids)) return new Set(raw.ids);
    return new Set();
  } catch {
    return new Set();
  }
}

function saveSeen(seen) {
  mkdirSync(dirname(SEEN_PATH), { recursive: true });
  writeFileSync(
    SEEN_PATH,
    JSON.stringify({ ids: [...seen], updated_at: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

// Mirror of the TS stripHtmlToText helper in src/main/ingest-hooks.ts.
// Kept inline so this script does not depend on the Electron build.
function stripHtmlToText(html) {
  if (!html) return '';
  let s = html;
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, '\n');
  s = s.replace(/<br\s*\/?>(?=)/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function buildEpisodeBody(msg) {
  const plain = msg.body_is_html ? stripHtmlToText(msg.body || '') : (msg.body || '');
  const header = `From: ${msg.from || ''}${msg.to ? ` | To: ${msg.to}` : ''} | Subject: ${msg.subject || ''}`;
  return `${header}\n\n${plain}`.slice(0, 3000);
}

function buildEpisodeName(msg) {
  const direction = msg.direction || 'inbound';
  const subject = msg.subject || '(no subject)';
  return `Gmail ${direction}: ${subject.slice(0, 80)}`;
}

function callGraphitiAdd({ name, body, sourceTag, sourceId, time }) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        GRAPHITI_CLI,
        'add',
        '--name', name,
        '--body', body,
        '--source', `${sourceTag}:${sourceId || 'ExampleCo'}`,
        '--group', 'owner-ea',
        ...(time ? ['--time', time] : []),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ ok: true });
      else resolvePromise({ ok: false, code, stderr: stderr.trim() });
    });
    child.on('error', (err) => resolvePromise({ ok: false, code: -1, stderr: err.message }));
  });
}

async function ingestOnce(seen) {
  if (!existsSync(RAW_DIR)) {
    return { processed: 0, skipped: 0, errors: 0 };
  }
  const files = readdirSync(RAW_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, mtime: statSync(join(RAW_DIR, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime)
    .map((entry) => entry.name);
  let processed = 0;
  let skipped = 0;
  let errors = 0;
  for (const file of files) {
    if (processed >= LIMIT) break;
    const id = file.replace(/\.json$/, '');
    if (seen.has(id)) {
      skipped++;
      continue;
    }
    let msg;
    try {
      msg = JSON.parse(readFileSync(join(RAW_DIR, file), 'utf8'));
    } catch (e) {
      console.error(`[ingest-gmail] parse failed ${file}: ${e.message}`);
      errors++;
      continue;
    }
    const direction = msg.direction || 'inbound';
    const sourceTag = direction === 'outbound' ? 'gmail-outbound' : 'gmail-inbound';
    try {
      recordGmailMessage(msg, { sourceRef: msg.message_id || msg.id || id });
    } catch (e) {
      console.error(`[ingest-gmail] spine write failed ${file}: ${e.message}`);
    }
    const body = buildEpisodeBody(msg);
    if (body.length < 10) {
      // Trivially short: mark seen and skip the LLM call.
      seen.add(id);
      skipped++;
      continue;
    }
    const name = buildEpisodeName(msg);
    const sourceId = msg.message_id || msg.id || id;
    const time = msg.timestamp || msg.fetched_at;
    const result = await callGraphitiAdd({ name, body, sourceTag, sourceId, time });
    if (result.ok) {
      seen.add(id);
      processed++;
      console.log(`[ingest-gmail] ok ${id} (${direction})`);
    } else {
      errors++;
      console.error(`[ingest-gmail] add failed ${id}: ${result.stderr || `code ${result.code}`}`);
      // Do not mark seen so the next pass retries.
    }
    // Persist seen-set after every success so a crash mid-batch still makes
    // progress on the next run.
    saveSeen(seen);
  }
  return { processed, skipped, errors };
}

async function main() {
  const seen = loadSeen();
  if (RESET) saveSeen(seen);
  do {
    const stats = await ingestOnce(seen);
    console.log(
      `[ingest-gmail] pass: processed=${stats.processed} skipped=${stats.skipped} errors=${stats.errors}`,
    );
    if (!WATCH) break;
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  } while (WATCH);
}

main().catch((err) => {
  console.error(`[ingest-gmail] fatal: ${err.message}`);
  process.exit(1);
});
