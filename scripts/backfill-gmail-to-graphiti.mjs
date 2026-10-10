#!/usr/bin/env node
// backfill-gmail-to-graphiti.mjs
//
// One-shot walker over data/gmail/raw/ that ingests every existing message
// into Graphiti. Models scripts/backfill-sessions-to-s3.py: read every
// historical raw payload, push each through the same canonical funnel as
// live ingest, then exit.
//
// By default this walker honors the same data/agent/gmail-ingest-seen.json
// dedupe set the watcher uses, so it is safe to run repeatedly. Pass
// --force to ignore the seen-set.
//
// Usage:
//   node scripts/backfill-gmail-to-graphiti.mjs
//   node scripts/backfill-gmail-to-graphiti.mjs --force
//   node scripts/backfill-gmail-to-graphiti.mjs --limit 100
//   node scripts/backfill-gmail-to-graphiti.mjs --dry-run

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const RAW_DIR = join(REPO_ROOT, 'data', 'gmail', 'raw');
const SEEN_PATH = join(REPO_ROOT, 'data', 'agent', 'gmail-ingest-seen.json');
const GRAPHITI_CLI = join(__dirname, 'graphiti-cli.mjs');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY = args.includes('--dry-run');
let LIMIT = Infinity;
const limitIdx = args.indexOf('--limit');
if (limitIdx >= 0 && args[limitIdx + 1]) {
  LIMIT = parseInt(args[limitIdx + 1], 10);
}

function loadSeen() {
  if (FORCE) return new Set();
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

function buildEpisode(msg) {
  const direction = msg.direction || 'inbound';
  const sourceTag = direction === 'outbound' ? 'gmail-outbound' : 'gmail-inbound';
  const plain = msg.body_is_html ? stripHtmlToText(msg.body || '') : (msg.body || '');
  const header = `From: ${msg.from || ''}${msg.to ? ` | To: ${msg.to}` : ''} | Subject: ${msg.subject || ''}`;
  const body = `${header}\n\n${plain}`.slice(0, 3000);
  const name = `Gmail ${direction}: ${(msg.subject || '(no subject)').slice(0, 80)}`;
  return { name, body, sourceTag, time: msg.timestamp || msg.fetched_at };
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
        '--source', `${sourceTag}:${sourceId || 'unknown'}`,
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

async function main() {
  if (!existsSync(RAW_DIR)) {
    console.log(`[backfill-gmail] raw dir missing: ${RAW_DIR}`);
    return;
  }
  const seen = loadSeen();
  const files = readdirSync(RAW_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, mtime: statSync(join(RAW_DIR, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime)
    .map((e) => e.name);
  console.log(`[backfill-gmail] found ${files.length} raw files (force=${FORCE} dry=${DRY})`);
  let processed = 0;
  let skipped = 0;
  let errors = 0;
  for (const file of files) {
    if (processed >= LIMIT) break;
    const id = file.replace(/\.json$/, '');
    if (!FORCE && seen.has(id)) {
      skipped++;
      continue;
    }
    let msg;
    try {
      msg = JSON.parse(readFileSync(join(RAW_DIR, file), 'utf8'));
    } catch (e) {
      console.error(`[backfill-gmail] parse failed ${file}: ${e.message}`);
      errors++;
      continue;
    }
    const ep = buildEpisode(msg);
    if (ep.body.length < 10) {
      seen.add(id);
      skipped++;
      continue;
    }
    const sourceId = msg.message_id || msg.id || id;
    if (DRY) {
      console.log(`[backfill-gmail] would add: ${ep.name} (${sourceId})`);
      processed++;
      continue;
    }
    const result = await callGraphitiAdd({
      name: ep.name,
      body: ep.body,
      sourceTag: ep.sourceTag,
      sourceId,
      time: ep.time,
    });
    if (result.ok) {
      seen.add(id);
      processed++;
      console.log(`[backfill-gmail] ok ${id} (${ep.sourceTag})`);
      saveSeen(seen);
    } else {
      errors++;
      console.error(
        `[backfill-gmail] add failed ${id}: ${result.stderr || `code ${result.code}`}`,
      );
    }
  }
  console.log(
    `[backfill-gmail] done: processed=${processed} skipped=${skipped} errors=${errors}`,
  );
}

main().catch((err) => {
  console.error(`[backfill-gmail] fatal: ${err.message}`);
  process.exit(1);
});
