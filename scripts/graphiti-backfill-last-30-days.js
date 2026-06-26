#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { appendEventsBulk, normalizeIso, repoRoot } = require('./lib/graphiti-event-log');
const { collectSourceEvents } = require('./lib/graphiti-source-scanner');
const { sourceFamily } = require('./lib/graphiti-source-policy');

function parseArgs(argv) {
  const root = repoRoot();
  const out = {
    root,
    days: 30,
    since: null,
    until: new Date().toISOString(),
    drain: false,
    sources: null,
    maxSessionFiles: 250,
    maxSmsFiles: 500,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--days') out.days = Number(argv[++i] || 30);
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--until') out.until = normalizeIso(argv[++i]);
    else if (a === '--drain') out.drain = true;
    else if (a === '--sources') out.sources = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--max-session-files') out.maxSessionFiles = Number(argv[++i] || 250);
    else if (a === '--max-sms-files') out.maxSmsFiles = Number(argv[++i] || 500);
  }
  if (!out.since) {
    const d = new Date(out.until);
    d.setUTCDate(d.getUTCDate() - out.days + 1);
    d.setUTCHours(0, 0, 0, 0);
    out.since = d.toISOString();
  } else {
    out.since = normalizeIso(out.since);
  }
  return out;
}

function writeLatest(root, summary) {
  const file = path.join(root, 'data', 'agent', 'graphiti-backfill-latest.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
}

async function backfill(opts = {}) {
  const root = opts.root || repoRoot();
  const until = opts.until || new Date().toISOString();
  const since = opts.since || (() => {
    const d = new Date(until);
    d.setUTCDate(d.getUTCDate() - (opts.days || 30) + 1);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  })();
  const events = collectSourceEvents(root, since, until, opts);
  const summary = {
    schema: 'graphiti.backfill.summary.v1',
    generated_at: normalizeIso(new Date()),
    status: 'green',
    range: { since, until },
    discovered: events.length,
    appended: 0,
    duplicates: 0,
    skipped: 0,
    by_source: {},
    by_family: {},
    drain: null,
  };

  for (const ev of events) {
    summary.by_source[ev.source] = summary.by_source[ev.source] || { discovered: 0, appended: 0, duplicates: 0, skipped: 0 };
    summary.by_source[ev.source].discovered++;
    const family = sourceFamily(ev.source);
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
    summary.drain = await drain({ root, since, max: opts.maxDrain || Infinity });
    if (summary.drain.failed) summary.status = 'red';
  }

  writeLatest(root, summary);
  return summary;
}

if (require.main === module) {
  backfill(parseArgs(process.argv))
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      process.exit(summary.status === 'red' ? 1 : 0);
    })
    .catch((e) => {
      console.error(e.stack || e.message);
      process.exit(1);
    });
}

module.exports = { backfill };
