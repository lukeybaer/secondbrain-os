#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadPeopleFileCatalog } = require('./lib/voice-people-file-target');
const { readJsonl } = require('./lib/voice-people-projection-events');
const { buildProjectionAudit } = require('./lib/voice-people-projection-audit');

const ROOT = path.resolve(
  require('./lib/runtime-root-env.js').usableRuntimeRoot(process.env.SECONDBRAIN_ROOT) || path.join(__dirname, '..'),
);
const DATA_DIR = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(ROOT, 'data'));
const VP_DIR = path.join(DATA_DIR, 'life-archive', 'voiceprints');
const PEOPLE_DIR = path.join(DATA_DIR, 'life-archive', 'people');
const OUT = path.join(VP_DIR, 'voice-people-file-projection-audit-latest.json');
const HISTORY = path.join(VP_DIR, 'voice-people-file-projection-audit-history.jsonl');

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function buildAudit(options = {}) {
  const registryPath = path.join(DATA_DIR, 'life-archive', 'voice-identity-registry.json');
  const loadedRegistry = readJson(registryPath, null);
  return buildProjectionAudit({
    repoRoot: options.repoRoot || ROOT,
    registry:
      options.registry ||
      loadedRegistry || {
        people: {},
        enrollments: [],
      },
    registryPresent: Object.prototype.hasOwnProperty.call(options, 'registryPresent')
      ? options.registryPresent
      : Boolean(loadedRegistry && typeof loadedRegistry === 'object'),
    intelligence:
      options.intelligence ||
      readJson(path.join(VP_DIR, 'otter-speaker-intelligence-latest.json'), {
        known_speakers: [],
      }),
    catalog: options.catalog || loadPeopleFileCatalog(options.repoRoot || ROOT),
    confirmationActions:
      options.confirmationActions ||
      readJsonl(path.join(PEOPLE_DIR, 'voice-confirmation-actions.jsonl')),
    projectionEvents:
      options.projectionEvents ||
      readJsonl(path.join(PEOPLE_DIR, 'voice-people-file-projection-events.jsonl')),
    relayRequests:
      options.relayRequests ||
      readJsonl(path.join(PEOPLE_DIR, 'voice-git-people-sync-requests.jsonl')),
    relayReceipts:
      options.relayReceipts ||
      readJsonl(path.join(PEOPLE_DIR, 'voice-git-people-sync-receipts.jsonl')),
    generatedAt: options.generatedAt,
  });
}

function saveAudit(report, options = {}) {
  const out = options.out || OUT;
  const history = options.history || HISTORY;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.appendFileSync(history, `${JSON.stringify(report)}\n`, 'utf8');
}

function mergeProjectionEvents(source, destination = path.join(
  PEOPLE_DIR,
  'voice-people-file-projection-events.jsonl',
)) {
  const combined = [
    ...readJsonl(destination),
    ...readJsonl(source),
  ];
  const byId = new Map();
  for (const row of combined) {
    const key = row.event_id || JSON.stringify([
      row.producer,
      row.generated_at,
      row.files_written,
      row.request_ids,
    ]);
    byId.set(key, row);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(
    destination,
    [...byId.values()]
      .sort((a, b) => String(a.generated_at || '').localeCompare(String(b.generated_at || '')))
      .map((row) => JSON.stringify(row))
      .join('\n') + (byId.size ? '\n' : ''),
    'utf8',
  );
  return { source_rows: readJsonl(source).length, merged_rows: byId.size };
}

// --projection-gate exits on projection reconciliation only, excluding Git relay delivery.
// The written report keeps the full status, so relay failures stay visible and red.
function auditExitCode(report, argv = process.argv) {
  const gateStatus = argv.includes('--projection-gate')
    ? report.projection_status
    : report.status;
  return gateStatus === 'GREEN' ? 0 : 2;
}

function main() {
  const mergeIndex = process.argv.indexOf('--merge-events');
  const merge = mergeIndex >= 0 && process.argv[mergeIndex + 1]
    ? mergeProjectionEvents(process.argv[mergeIndex + 1])
    : null;
  const report = buildAudit();
  if (merge) report.event_merge = merge;
  if (process.argv.includes('--write')) saveAudit(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = auditExitCode(report);
}

if (require.main === module) main();

module.exports = { auditExitCode, buildAudit, saveAudit, mergeProjectionEvents };
