#!/usr/bin/env node
// backfill-linkedin-to-graphiti.mjs
//
// One-shot walker over data/linkedin/raw/ that ingests every existing
// LinkedIn scrape into Graphiti. Same pattern as
// backfill-gmail-to-graphiti.mjs and backfill-sessions-to-s3.py.
//
// Usage:
//   node scripts/backfill-linkedin-to-graphiti.mjs
//   node scripts/backfill-linkedin-to-graphiti.mjs --force
//   node scripts/backfill-linkedin-to-graphiti.mjs --limit 50
//   node scripts/backfill-linkedin-to-graphiti.mjs --dry-run

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const RAW_DIR = join(REPO_ROOT, 'data', 'linkedin', 'raw');
const SEEN_PATH = join(REPO_ROOT, 'data', 'agent', 'linkedin-ingest-seen.json');
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

function buildEpisode(scrape) {
  const type = scrape.type === 'message' ? 'message' : 'profile';
  const sourceTag = type === 'message' ? 'linkedin-message' : 'linkedin-profile';
  const header = scrape.contact_url
    ? `Contact: ${scrape.contact_name} (${scrape.contact_url})`
    : `Contact: ${scrape.contact_name}`;
  const body = `${header}\n\n${scrape.body || ''}`.slice(0, 3000);
  const name = `LinkedIn ${type}: ${scrape.contact_name}`;
  return { name, body, sourceTag, time: scrape.scanned_at || scrape.timestamp };
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

async function main() {
  if (!existsSync(RAW_DIR)) {
    console.log(`[backfill-linkedin] raw dir missing: ${RAW_DIR}`);
    return;
  }
  const seen = loadSeen();
  const files = readdirSync(RAW_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, mtime: statSync(join(RAW_DIR, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime)
    .map((e) => e.name);
  console.log(
    `[backfill-linkedin] found ${files.length} raw files (force=${FORCE} dry=${DRY})`,
  );
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
    let scrape;
    try {
      scrape = JSON.parse(readFileSync(join(RAW_DIR, file), 'utf8'));
    } catch (e) {
      console.error(`[backfill-linkedin] parse failed ${file}: ${e.message}`);
      errors++;
      continue;
    }
    const ep = buildEpisode(scrape);
    if (ep.body.length < 10) {
      seen.add(id);
      skipped++;
      continue;
    }
    const sourceId = scrape.id || id;
    if (DRY) {
      console.log(`[backfill-linkedin] would add: ${ep.name} (${sourceId})`);
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
      console.log(`[backfill-linkedin] ok ${id} (${ep.sourceTag})`);
      saveSeen(seen);
    } else {
      errors++;
      console.error(
        `[backfill-linkedin] add failed ${id}: ${result.stderr || `code ${result.code}`}`,
      );
    }
  }
  console.log(
    `[backfill-linkedin] done: processed=${processed} skipped=${skipped} errors=${errors}`,
  );
}

main().catch((err) => {
  console.error(`[backfill-linkedin] fatal: ${err.message}`);
  process.exit(1);
});
