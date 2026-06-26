#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const {
  countEventsBySource,
  countReceiptsBySource,
  normalizeIso,
  readReceiptIndex,
  repoRoot,
} = require('./lib/graphiti-event-log');
const { RAW_LIFETIME_SOURCES, rawLifetimeCounts } = require('./lib/graphiti-raw-lifetime-scanner');
const { voiceArcEvents } = require('./lib/graphiti-voice-arc-scanner');
const { sourceRows } = require('./graphiti-coverage-health');

const LIFETIME_SOURCES = [...RAW_LIFETIME_SOURCES, 'voice-arc'];

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseArgs(argv) {
  const out = {
    root: repoRoot(),
    since: '1970-01-01T00:00:00.000Z',
    until: new Date().toISOString(),
    refreshRaw: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--since') out.since = normalizeIso(argv[++i]);
    else if (a === '--until') out.until = normalizeIso(argv[++i]);
    else if (a === '--refresh-raw') out.refreshRaw = true;
  }
  return out;
}

function filterKeys(obj) {
  const out = {};
  for (const key of LIFETIME_SOURCES) {
    if (obj && obj[key] != null) out[key] = obj[key];
  }
  return out;
}

function skippedReceiptCounts(root) {
  const counts = {};
  for (const r of Object.values(readReceiptIndex(root))) {
    if (r && r.status === 'skipped' && LIFETIME_SOURCES.includes(r.source)) {
      counts[r.source] = (counts[r.source] || 0) + 1;
    }
  }
  return counts;
}

function rawCountsFromBackfill(root) {
  const latest = readJson(path.join(root, 'data', 'agent', 'graphiti-lifetime-backfill-latest.json'));
  if (!latest || !latest.by_source) return null;
  const raw = {};
  const subtractSkippedReceipts = latest.unique_ingestible_policy !== 'shouldDrainEvent'
    ? skippedReceiptCounts(root)
    : {};
  for (const source of LIFETIME_SOURCES) {
    if (latest.unique_ingestible_by_source && latest.unique_ingestible_by_source[source] != null) {
      raw[source] = Math.max(
        0,
        Number(latest.unique_ingestible_by_source[source] || 0) - Number(subtractSkippedReceipts[source] || 0),
      );
      continue;
    }
    if (latest.by_source[source]) {
      const discovered = Number(latest.by_source[source].discovered || 0);
      const skipped = Number(latest.by_source[source].skipped || 0);
      raw[source] = Math.max(0, discovered - skipped);
    }
  }
  return {
    raw,
    source: 'graphiti-lifetime-backfill-latest.json',
    generated_at: latest.generated_at,
    first_reference_time: latest.first_reference_time || null,
    last_reference_time: latest.last_reference_time || null,
    discovered_by_layer: latest.discovered_by_layer || null,
  };
}

function recomputeRawCounts(root, since, until) {
  const raw = rawLifetimeCounts(root, since, until);
  const arcs = voiceArcEvents(root, since, until).length;
  return {
    raw: {
      ...raw,
      'voice-arc': arcs,
    },
    source: 'live raw scan',
    generated_at: normalizeIso(new Date()),
    first_reference_time: null,
    last_reference_time: null,
    discovered_by_layer: {
      raw_archive: Object.values(raw).reduce((sum, n) => sum + Number(n || 0), 0),
      voice_arc: arcs,
    },
    archive_by_source: raw,
  };
}

function statusRank(status) {
  return status === 'red' ? 3 : status === 'yellow' ? 2 : status === 'green' ? 1 : 0;
}

function maxStatus(statuses) {
  return statuses.sort((a, b) => statusRank(b) - statusRank(a))[0] || 'green';
}

function writeLatest(root, summary) {
  const outDir = path.join(root, 'data', 'agent');
  fs.mkdirSync(outDir, { recursive: true });
  fs.appendFileSync(path.join(outDir, 'graphiti-lifetime-coverage-health.jsonl'), JSON.stringify(summary) + '\n');
  fs.writeFileSync(path.join(outDir, 'graphiti-lifetime-coverage-health-latest.json'), JSON.stringify(summary, null, 2));
}

function lifetimeCoverageHealth(opts = {}) {
  const root = opts.root || repoRoot();
  const since = opts.since || '1970-01-01T00:00:00.000Z';
  const until = opts.until || new Date().toISOString();
  const rawProof = opts.refreshRaw ? recomputeRawCounts(root, since, until) : (rawCountsFromBackfill(root) || recomputeRawCounts(root, since, until));
  const events = filterKeys(countEventsBySource(root, { since, until }));
  const receipts = filterKeys(countReceiptsBySource(root, { since, until }));
  const rows = sourceRows(rawProof.raw, events, receipts).filter((r) => LIFETIME_SOURCES.includes(r.source));
  const status = maxStatus(rows.map((r) => r.status));
  const voiceRow = rows.find((r) => r.source === 'voice-arc') || {};
  const archiveRows = rows.filter((r) => r.source !== 'voice-arc');
  const archiveRaw = archiveRows.reduce((sum, r) => sum + Number(r.raw_count || 0), 0);
  const archiveOk = archiveRows.reduce((sum, r) => sum + Number(r.graphiti_ok_count || 0), 0);
  const summary = {
    schema: 'graphiti.lifetime_coverage_health.v1',
    generated_at: normalizeIso(new Date()),
    status,
    range: { since, until },
    detail: status === 'green'
      ? `raw lifetime archive and contact voice arcs match Graphiti receipts`
      : 'one or more lifetime Graphiti coverage checks is not green',
    rows,
    raw_count_source: rawProof.source,
    raw_count_generated_at: rawProof.generated_at,
    chronological_replay: {
      status: rawProof.first_reference_time && rawProof.last_reference_time ? 'green' : 'yellow',
      first_reference_time: rawProof.first_reference_time,
      last_reference_time: rawProof.last_reference_time,
      detail: rawProof.first_reference_time && rawProof.last_reference_time
        ? `events are keyed to original source timestamps from ${rawProof.first_reference_time} through ${rawProof.last_reference_time}`
        : 'no timestamp span proof available',
    },
    totals: {
      archive_lifetime_raw: archiveRaw,
      archive_lifetime_graphiti_ok: archiveOk,
      voice_arc_raw: voiceRow.raw_count || 0,
      voice_arc_graphiti_ok: voiceRow.graphiti_ok_count || 0,
    },
    discovered_by_layer: rawProof.discovered_by_layer || null,
    archive_by_source: rawProof.archive_by_source || null,
    healing: {
      backfill: 'node scripts/graphiti-backfill-lifetime.js --drain --concurrency 4',
      drain: 'node scripts/graphiti-event-drain.js --since 1970-01-01T00:00:00.000Z --concurrency 4',
      refresh: 'node scripts/graphiti-lifetime-coverage-health.js',
    },
  };
  writeLatest(root, summary);
  return summary;
}

if (require.main === module) {
  const summary = lifetimeCoverageHealth(parseArgs(process.argv));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.status === 'red' ? 1 : 0);
}

module.exports = {
  LIFETIME_SOURCES,
  lifetimeCoverageHealth,
};
