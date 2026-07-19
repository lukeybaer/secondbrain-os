#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { archiveLifetimeCounts, archiveLifetimeEvents } = require('./lib/graphiti-life-archive-db');
const { appendEventsBulk, normalizeIso, repoRoot } = require('./lib/graphiti-event-log');

function parseArgs(argv) {
  const out = { root: repoRoot(), max: 0, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') out.root = argv[++i];
    else if (arg === '--db') out.db = argv[++i];
    else if (arg === '--manifest') out.manifest = argv[++i];
    else if (arg === '--receipt') out.receipt = argv[++i];
    else if (arg === '--max') out.max = Number(argv[++i] || 0);
    else if (arg === '--dry-run') out.dryRun = true;
  }
  if (!out.db || !out.manifest || !out.receipt) {
    throw new Error('usage: graphiti-index-migrated-files.js --db <db> --manifest <jsonl> --receipt <json>');
  }
  return out;
}

function readManifest(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function buildFolderRollups(rows, observedAt = new Date().toISOString()) {
  const folders = new Map();
  for (const row of rows) {
    if (row.sensitivity) continue;
    const rel = String(row.source_relative_path || '').replace(/\\/g, '/');
    const top = rel.includes('/') ? rel.split('/')[0] : '[root]';
    const current = folders.get(top) || {
      folder: top,
      files: 0,
      bytes: 0,
      earliest: null,
      latest: null,
      extraction: {},
    };
    current.files += 1;
    current.bytes += Number(row.size || 0);
    const created = row.created_at || null;
    if (created && (!current.earliest || created < current.earliest)) current.earliest = created;
    if (created && (!current.latest || created > current.latest)) current.latest = created;
    const status = row.extraction_status || 'ExampleCo';
    current.extraction[status] = (current.extraction[status] || 0) + 1;
    folders.set(top, current);
  }
  return [...folders.values()].sort((a, b) => a.folder.localeCompare(b.folder)).map((folder) => ({
    source: 'archive-lifetime-generic-file',
    source_id: `oldpc-desktop-ExampleCo:folder-rollup:${folder.folder}`,
    source_description: 'oldpc-desktop-ExampleCo-folder-rollup',
    name: `Old PC migrated archive folder: ${folder.folder}`,
    body: [
      `ExampleCo's migrated old-PC archive contains the folder ${folder.folder}.`,
      `Non-sensitive catalog coverage: ${folder.files} files and ${folder.bytes} bytes.`,
      `Best known file-date range: ${folder.earliest || 'ExampleCo'} through ${folder.latest || 'ExampleCo'}.`,
      `Extraction coverage: ${JSON.stringify(folder.extraction)}.`,
      'Exact filenames, paths, timestamps, hashes, and searchable content are in the local life-archive FTS and rebuildable manifest.',
    ].join('\n'),
    reference_time: folder.latest || observedAt,
    observed_at: observedAt,
    raw_path: null,
    contact_name: null,
    direction: null,
    priority: 'normal',
    metadata: {
      migration: 'oldpc-desktop-ExampleCo',
      folder: folder.folder,
      files: folder.files,
      bytes: folder.bytes,
      earliest: folder.earliest,
      latest: folder.latest,
      contains_sensitive_entries: false,
      rollup_only: true,
    },
  }));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function run(opts) {
  const since = '1970-01-01T00:00:00.000Z';
  const until = '2100-01-01T00:00:00.000Z';
  // The exporter must come from the reviewed code checkout, while the durable
  // event log may live under a different runtime/shared root.
  const codeRoot = path.resolve(__dirname, '..');
  const counts = archiveLifetimeCounts(codeRoot, since, until, { db: opts.db });
  const individual = archiveLifetimeEvents(codeRoot, since, until, {
    db: opts.db,
    ...(opts.max ? { max: opts.max } : {}),
    timeoutMs: 10 * 60 * 1000,
  });
  const manifestRows = readManifest(opts.manifest);
  const rollups = buildFolderRollups(manifestRows);
  const events = [...individual, ...rollups];
  const appended = opts.dryRun ? null : appendEventsBulk(events, { root: opts.root });
  const receipt = {
    schema: 'oldpc-migrated-files.graphiti-index.v1',
    generated_at: normalizeIso(new Date()),
    status: counts.eligible === individual.length ? 'green' : 'yellow',
    dry_run: !!opts.dryRun,
    database: path.resolve(opts.db),
    manifest: path.resolve(opts.manifest),
    archive_items_total: counts.total,
    archive_items_graphiti_eligible: counts.eligible,
    individual_events_prepared: individual.length,
    folder_rollup_events_prepared: rollups.length,
    event_log_result: appended,
    policy: {
      individual: 'Only items explicitly marked graphiti_eligible=true by the migrated-file indexer.',
      rollups: 'Top-level aggregate counts only; sensitive manifest rows are omitted.',
      excluded: 'Secrets, browser/session stores, private keys, personal/tax/recruiting data, noisy code, and unsupported binaries.',
    },
  };
  writeJsonAtomic(opts.receipt, receipt);
  return receipt;
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(run(parseArgs(process.argv)), null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

module.exports = { buildFolderRollups, parseArgs, readManifest, run };
