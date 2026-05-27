#!/usr/bin/env node
/**
 * Thin CLI wrapper around interpret-rejection-into-spec-overrides.js.
 * Reads the full rejection history for an id from
 * content-review/rejections.jsonl, calls interpretRejection (which
 * shells out to `claude -p`), and prints the resolved overrides JSON
 * on stdout. Designed to be called via spawnSync from the synchronous
 * auto-regen-rejected-videos.js main loop.
 *
 * Usage:
 *   node scripts/lib/interpret-rejection-cli.js --id short004_research --title "..." --channel AILifeHacks
 * Output: a single JSON object on stdout. Exit 0 on success, 1 on
 * caller error (bad args / missing rejections file), 0 with error
 * object on parse failure (caller decides whether to hard-block).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { interpretRejection } = require('./interpret-rejection-into-spec-overrides.js');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
const REJECTIONS_PATH = path.join(REPO, 'content-review', 'rejections.jsonl');

function argv(name, fallback = '') {
  const ix = process.argv.indexOf(name);
  if (ix < 0) return fallback;
  return process.argv[ix + 1] || fallback;
}

async function main() {
  const id = argv('--id');
  const title = argv('--title');
  const channel = argv('--channel');
  if (!id) {
    process.stderr.write('--id required\n');
    process.exit(1);
  }
  let raw = [];
  try {
    raw = fs.readFileSync(REJECTIONS_PATH, 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.id === id);
  } catch (e) {
    // No rejections file => nothing to interpret. Print null marker.
    process.stdout.write(JSON.stringify(null));
    return;
  }
  if (!raw.length) {
    process.stdout.write(JSON.stringify(null));
    return;
  }
  const out = await interpretRejection(raw, { id, title, channel });
  process.stdout.write(JSON.stringify(out || null));
}

main().catch((e) => {
  // Non-zero exit so the caller knows to skip the build wire-up, but
  // also print an error JSON so logs are useful.
  process.stdout.write(JSON.stringify({ error: e.message }));
  process.exit(0); // exit 0 with error object inside, per CLI contract
});
