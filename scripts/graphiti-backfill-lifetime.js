#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { appendEventsBulk, normalizeIso, repoRoot } = require('./lib/graphiti-event-log');
const { rawLifetimeEvents } = require('./lib/graphiti-raw-lifetime-scanner');
const { shouldDrainEvent, sourceFamily } = require('./lib/graphiti-source-policy');
const { voiceArcEvents } = require('./lib/graphiti-voice-arc-scanner');

function parseArgs(argv) {
  const out = {
    root: repoRoot(),
    since: '1970-01-01T00:00:00.000Z',
    until: new Date().toISOString(),
    archive: true,
    voiceArc: true,
    drain: false,
    concurrency: 4,
    maxDrain: Infinity,
    maxArchive: 0,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--since') out.since = normalizeIso(argv[++i]);
    else if (a === '--until') out.until = normalizeIso(argv[++i]);
    else if (a === '--no-archive') out.archive = false;
    else if (a === '--no-voice-arc') out.voiceArc = false;
    else if (a === '--drain') out.drain = true;
    else if (a === '--concurrency') out.concurrency = Math.max(1, Number(argv[++i] || 4));
    else if (a === '--max-drain') out.maxDrain = Number(argv[++i] || Infinity);
    else if (a === '--max-archive') out.maxArchive = Number(argv[++i] || 0);
  }
  return out;
}

function writeLatest(root, summary) {
  const file = path.join(root, 'data', 'agent', 'graphiti-lifetime-backfill-latest.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
}

function addSummary(summary, ev, result) {
  const family = sourceFamily(ev.source);
  summary.by_source[ev.source] = summary.by_source[ev.source] || { discovered: 0, appended: 0, duplicates: 0, skipped: 0 };
  summary.by_family[family] = summary.by_family[family] || { discovered: 0, appended: 0, duplicates: 0, skipped: 0 };
  summary.by_source[ev.source].discovered++;
  summary.by_family[family].discovered++;
  if (result.duplicate) {
    summary.duplicates++;
    summary.by_source[ev.source].duplicates++;
    summary.by_family[family].duplicates++;
  } else if (result.ok) {
    summary.appended++;
    summary.by_source[ev.source].appended++;
    summary.by_family[family].appended++;
  } else {
    summary.skipped++;
    summary.by_source[ev.source].skipped++;
    summary.by_family[family].skipped++;
  }
}

function chronologicalSort(a, b) {
  const am = Date.parse(a.reference_time || a.observed_at || '');
  const bm = Date.parse(b.reference_time || b.observed_at || '');
  if (Number.isFinite(am) && Number.isFinite(bm) && am !== bm) return am - bm;
  return `${a.source}:${a.source_id}`.localeCompare(`${b.source}:${b.source_id}`);
}

function uniqueIngestibleCounts(events) {
  const seen = new Set();
  const bySource = {};
  const byFamily = {};
  for (const input of events) {
    const source = String(input.source || 'ExampleCo');
    const sourceId = input.source_id || input.sourceId || input.message_id || input.id || '';
    if (!shouldDrainEvent(input).ok) continue;
    const body = String(input.body || input.episode_body || input.text || '').trim();
    const key = `${source}:${sourceId || [input.reference_time || input.timestamp || '', input.name || '', body.slice(0, 1000)].join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bySource[source] = (bySource[source] || 0) + 1;
    const family = sourceFamily(source);
    byFamily[family] = (byFamily[family] || 0) + 1;
  }
  return {
    total: seen.size,
    by_source: bySource,
    by_family: byFamily,
  };
}

async function backfillLifetime(opts = {}) {
  const root = opts.root || repoRoot();
  const since = opts.since || '1970-01-01T00:00:00.000Z';
  const until = opts.until || new Date().toISOString();
  const events = [];
  const discoveredByLayer = {};

  if (opts.archive !== false) {
    const archive = rawLifetimeEvents(root, since, until, { maxGenericFiles: opts.maxGenericFiles || 5000 });
    events.push(...archive);
    discoveredByLayer.raw_archive = archive.length;
  }
  if (opts.voiceArc !== false) {
    const arcs = voiceArcEvents(root, since, until);
    events.push(...arcs);
    discoveredByLayer.voice_arc = arcs.length;
  }

  events.sort(chronologicalSort);
  const unique = uniqueIngestibleCounts(events);
  const summary = {
    schema: 'graphiti.lifetime_backfill.summary.v1',
    generated_at: normalizeIso(new Date()),
    status: 'green',
    range: { since, until },
    chronological_replay: true,
    discovered: events.length,
    unique_ingestible: unique.total,
    unique_ingestible_policy: 'shouldDrainEvent',
    discovered_by_layer: discoveredByLayer,
    appended: 0,
    duplicates: 0,
    skipped: 0,
    by_source: {},
    by_family: {},
    unique_ingestible_by_source: unique.by_source,
    unique_ingestible_by_family: unique.by_family,
    first_reference_time: events.length ? events[0].reference_time : null,
    last_reference_time: events.length ? events[events.length - 1].reference_time : null,
    drain: null,
  };

  for (const ev of events) {
    const family = sourceFamily(ev.source);
    summary.by_source[ev.source] = summary.by_source[ev.source] || { discovered: 0, appended: 0, duplicates: 0, skipped: 0 };
    summary.by_source[ev.source].discovered++;
    summary.by_family[family] = summary.by_family[family] || { discovered: 0, appended: 0, duplicates: 0, skipped: 0 };
    summary.by_family[family].discovered++;
  }

  const bulk = appendEventsBulk(events, { root });
  for (const [source, stats] of Object.entries(bulk.by_source || {})) {
    const family = sourceFamily(source);
    summary.by_source[source] = summary.by_source[source] || { discovered: 0, appended: 0, duplicates: 0, skipped: 0 };
    summary.by_family[family] = summary.by_family[family] || { discovered: 0, appended: 0, duplicates: 0, skipped: 0 };
    for (const key of ['appended', 'duplicates', 'skipped']) {
      summary.by_source[source][key] += Number(stats[key] || 0);
      summary.by_family[family][key] += Number(stats[key] || 0);
      summary[key] += Number(stats[key] || 0);
    }
  }

  if (opts.drain) {
    const { drain } = require('./graphiti-event-drain');
    summary.drain = await drain({
      root,
      since,
      max: opts.maxDrain || Infinity,
      concurrency: opts.concurrency || 4,
      timeoutMs: opts.timeoutMs || 45000,
    });
    if (summary.drain.failed) summary.status = 'red';
  }

  writeLatest(root, summary);
  return summary;
}

if (require.main === module) {
  backfillLifetime(parseArgs(process.argv))
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      process.exit(summary.status === 'red' ? 1 : 0);
    })
    .catch((e) => {
      console.error(e.stack || e.message);
      process.exit(1);
    });
}

module.exports = { backfillLifetime };
