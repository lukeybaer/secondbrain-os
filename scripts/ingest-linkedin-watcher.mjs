#!/usr/bin/env node
// ingest-linkedin-watcher.mjs
//
// Polls data/linkedin/raw/ for new LinkedIn scrape JSON files and ingests
// each new file into Graphiti via graphiti-cli.mjs add. Decoupled from
// linkedin-bulk-scan.js so the scraper does not depend on Graphiti being
// reachable, and the ingest layer does not depend on Playwright.
//
// Seen-set lives at data/agent/linkedin-ingest-seen.json. Idempotent.
//
// Usage:
//   node scripts/ingest-linkedin-watcher.mjs              one pass, then exit
//   node scripts/ingest-linkedin-watcher.mjs --watch      poll every 60s forever
//   node scripts/ingest-linkedin-watcher.mjs --interval 90 --watch
//   node scripts/ingest-linkedin-watcher.mjs --reset      clear seen-set first
//   node scripts/ingest-linkedin-watcher.mjs --limit 5

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const { recordLinkedInMessage } = require('./lib/spine-ingress');
const REPO_ROOT = resolve(__dirname, '..');
const RAW_DIR = join(REPO_ROOT, 'data', 'linkedin', 'raw');
const SEEN_PATH = join(REPO_ROOT, 'data', 'agent', 'linkedin-ingest-seen.json');
const GRAPHITI_CLI = join(__dirname, 'graphiti-cli.mjs');

const args = process.argv.slice(2);
const WATCH = args.includes('--watch');
const RESET = args.includes('--reset');
let INTERVAL_MS = 60_000;
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

// Mirror of the linkedinEvent builder body composition in
// src/main/ingest-hooks.ts. Kept inline so this script does not depend on
// the Electron build.
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
    let scrape;
    try {
      scrape = JSON.parse(readFileSync(join(RAW_DIR, file), 'utf8'));
    } catch (e) {
      console.error(`[ingest-linkedin] parse failed ${file}: ${e.message}`);
      errors++;
      continue;
    }
    const ep = buildEpisode(scrape);
    if ((scrape.type || '').toLowerCase() === 'message') {
      try {
        recordLinkedInMessage(scrape, { sourceRef: scrape.id || id });
      } catch (e) {
        console.error(`[ingest-linkedin] spine write failed ${file}: ${e.message}`);
      }
    }
    if (ep.body.length < 10) {
      seen.add(id);
      skipped++;
      continue;
    }
    const sourceId = scrape.id || id;
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
      console.log(`[ingest-linkedin] ok ${id} (${ep.sourceTag})`);
    } else {
      errors++;
      console.error(
        `[ingest-linkedin] add failed ${id}: ${result.stderr || `code ${result.code}`}`,
      );
    }
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
      `[ingest-linkedin] pass: processed=${stats.processed} skipped=${stats.skipped} errors=${stats.errors}`,
    );
    if (!WATCH) break;
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  } while (WATCH);
}

main().catch((err) => {
  console.error(`[ingest-linkedin] fatal: ${err.message}`);
  process.exit(1);
});
