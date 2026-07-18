#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const {
  countEventsBySource,
  countReceiptsBySource,
  normalizeIso,
  repoRoot,
} = require('./lib/graphiti-event-log');
const { collectSourceEvents } = require('./lib/graphiti-source-scanner');
const {
  SOURCE_SLA_MINUTES,
  shouldDrainEvent,
  sourceFamily,
} = require('./lib/graphiti-source-policy');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readLastJsonl(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = { root: repoRoot(), days: 30, since: null, until: new Date().toISOString() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--days') out.days = Number(argv[++i] || 30);
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--until') out.until = normalizeIso(argv[++i]);
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

function statusRank(status) {
  return status === 'red' ? 3 : status === 'yellow' ? 2 : status === 'green' ? 1 : 0;
}

function maxStatus(statuses) {
  return statuses.sort((a, b) => statusRank(b) - statusRank(a))[0] || 'green';
}

function diskHealth(root) {
  if (process.platform === 'win32' && !/^\/opt\/secondbrain/.test(root.replace(/\\/g, '/'))) {
    return {
      status: 'green',
      detail: 'Graphiti durable store is EC2; local workstation disk is not the capacity gate',
    };
  }
  try {
    const stats = fs.statfsSync(root);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    const usedPct = total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : null;
    return {
      status: usedPct != null && usedPct < 85 ? 'green' : 'red',
      total_bytes: total,
      free_bytes: free,
      used_pct: usedPct,
      detail: usedPct == null ? 'ExampleCo disk usage' : `${usedPct}% used`,
    };
  } catch (e) {
    return { status: 'yellow', detail: `disk probe unavailable: ${e.message}` };
  }
}

function eligibleRawCounts(root, since, until) {
  const counts = {};
  const seen = new Set();
  for (const ev of collectSourceEvents(root, since, until)) {
    if (!shouldDrainEvent(ev).ok) continue;
    const key = `${ev.source}:${ev.source_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts[ev.source] = (counts[ev.source] || 0) + 1;
  }
  return counts;
}

// Pure parity evaluator (exported for tests). Today's Gmail is still arriving and
// the S3 mirror runs on a lag, so a parity gap CONFINED to the current day is
// expected, not a coverage defect. Only a gap on a PAST day (or a stale/missing
// proof, or an unattributed count gap) is red. This stops a handful of same-day
// in-flight emails (e.g. 3/1353 on today's date) from flipping ALL of Graphiti
// coverage red every day. Past-day gaps still flag, so real coverage loss is kept.
//
// The health probe dates its day buckets in UTC, but this evaluator historically
// compared against today in CT. During the ~5-6h window after UTC midnight but
// before CT midnight (i.e. ~7-11:59pm CT), the UTC "today" is one day ahead of
// the CT "today", so a same-day gap on the new UTC date looked like a past-day
// gap and flipped coverage red every night. Fix: treat both today-CT AND today-UTC
// as "still arriving" since either can legitimately be in-flight.
//
// "Parity" is a legacy name: the check is SUFFICIENCY (s3 >= gmail), not equality.
// See the shortfall comment inside for why an S3 surplus is healthy.
function evaluateGmailS3Parity(j, todayCt) {
  if (!j) return { green: false, detail: 'missing Gmail S3 parity proof', ageH: null };
  const ageH = Math.round((Date.now() - Date.parse(j.generated_at || 0)) / 3600000);
  const fresh = ageH <= 30;
  // SUFFICIENCY, not equality. The S3 raw archive is APPEND-ONLY while the Gmail
  // mailbox is MUTABLE (mail gets deleted, archived out of the queried range), so
  // s3_raw_eml_count drifting ABOVE gmail_count is the expected healthy steady
  // state, not coverage loss. An equality assertion scored that healthy surplus as
  // a gap and held the whole check red. Only a SHORTFALL (fewer raw .eml in S3
  // than live Gmail messages) means something was never mirrored.
  const shortfall = Math.max(0, (j.gmail_count || 0) - (j.s3_raw_eml_count || 0));
  const countSufficient = shortfall === 0;
  const missingDays = Array.isArray(j.missing_days) ? j.missing_days.map(String) : [];
  const todayUtc = new Date().toISOString().slice(0, 10);
  const todaySet = new Set([todayCt, todayUtc]);
  const onlyTodayMissing = missingDays.length > 0 && missingDays.every((d) => todaySet.has(d));
  const green = fresh && (countSufficient || onlyTodayMissing);
  const detail = !fresh
    ? `Gmail S3 parity proof is stale (${ageH}h old, threshold 30h)`
    : onlyTodayMissing && !countSufficient
      ? `S3 parity current; ${shortfall} same-day email(s) still syncing (${j.s3_raw_eml_count || 0}/${j.gmail_count || 0}), past days fully mirrored`
      : j.detail || `${j.s3_raw_eml_count || 0}/${j.gmail_count || 0} raw emails in S3`;
  return { green, detail, ageH };
}

function gmailS3Health(root) {
  const file = path.join(root, 'data', 'life-archive', 'gmail-s3-flow-health-latest.json');
  const j = readJson(file);
  const todayCt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const r = evaluateGmailS3Parity(j, todayCt);
  return {
    status: r.green ? 'green' : 'red',
    detail: r.detail,
    generated_at: j && j.generated_at,
    age_hours: r.ageH,
    gmail_count: (j && j.gmail_count) || 0,
    s3_raw_eml_count: (j && j.s3_raw_eml_count) || 0,
    range: (j && j.range) || null,
  };
}

function lifetimeHealth(root) {
  const file = path.join(root, 'data', 'agent', 'graphiti-lifetime-coverage-health-latest.json');
  const j = readJson(file);
  if (!j) return { status: 'red', detail: 'missing lifetime Graphiti coverage proof' };
  const ageH = Math.round((Date.now() - Date.parse(j.generated_at || 0)) / 3600000);
  const rows = Array.isArray(j.rows) ? j.rows : [];
  const chrono = j.chronological_replay || {};
  const green = j.status === 'green' && ageH <= 30 && chrono.status !== 'red';
  return {
    status: green ? 'green' : j.status === 'green' ? 'yellow' : 'red',
    detail: j.detail || 'lifetime coverage proof exists',
    generated_at: j.generated_at,
    age_hours: ageH,
    rows,
    totals: j.totals || {},
    chronological_replay: chrono,
  };
}

function sourceRows(raw, events, receipts) {
  const sources = [
    ...new Set([...Object.keys(raw), ...Object.keys(events), ...Object.keys(receipts)]),
  ].sort();
  return sources.map((source) => {
    const rawCount = raw[source] || 0;
    const eventCount = events[source] || 0;
    const okCount = receipts[source] || 0;
    let status = 'green';
    const notes = [];
    if (rawCount === 0 && eventCount > 0 && okCount > 0) {
      notes.push(
        `raw mirror not local on this host; event log + Graphiti receipts ${okCount}/${eventCount}`,
      );
      return {
        source,
        family: sourceFamily(source),
        raw_count: rawCount,
        event_count: eventCount,
        graphiti_ok_count: okCount,
        status,
        detail: notes.join('; '),
      };
    }
    if (rawCount > 0 && eventCount < rawCount) {
      status = 'red';
      notes.push(`event log ${eventCount}/${rawCount}`);
    }
    if (rawCount > 0 && okCount < rawCount) {
      status = 'red';
      notes.push(`Graphiti receipts ${okCount}/${rawCount}`);
    }
    if (rawCount === 0 && SOURCE_SLA_MINUTES[source]) {
      status = status === 'red' ? 'red' : 'yellow';
      notes.push('no raw source events in window');
    }
    return {
      source,
      family: sourceFamily(source),
      raw_count: rawCount,
      event_count: eventCount,
      graphiti_ok_count: okCount,
      status,
      detail: notes.join('; ') || 'raw, event log, and Graphiti receipts match',
    };
  });
}

function coverageHealth(opts = {}) {
  const root = opts.root || repoRoot();
  const until = opts.until || new Date().toISOString();
  const since =
    opts.since ||
    (() => {
      const d = new Date(until);
      d.setUTCDate(d.getUTCDate() - (opts.days || 30) + 1);
      d.setUTCHours(0, 0, 0, 0);
      return d.toISOString();
    })();

  const raw = eligibleRawCounts(root, since, until);
  const events = countEventsBySource(root, { since, until });
  const receipts = countReceiptsBySource(root, { since, until });
  const rows = sourceRows(raw, events, receipts);
  const provider =
    readJson(path.join(root, 'data', 'agent', 'graphiti-provider-health-latest.json')) ||
    readLastJsonl(path.join(root, 'data', 'agent', 'graphiti-provider-health.jsonl'));
  const graphiti = readLastJsonl(path.join(root, 'data', 'agent', 'graphiti-health.jsonl'));
  const gmailS3 = gmailS3Health(root);
  const lifetime = lifetimeHealth(root);
  const disk = diskHealth(root);
  // gmail_s3 is DELIBERATELY absent from this roll-up. It measures the Gmail ->
  // S3 raw-archive mirror, which is a different subsystem from the knowledge
  // graph. Folding it in meant a Graphiti that was demonstrably healthy
  // (containers up for days, node count growing, episodes landing hours ago)
  // rendered RED under the Graphiti label, sending every reader to debug the
  // wrong system. It stays fully visible as its own row on summary.gmail_s3,
  // and surfaces in the detail line below when it is not green.
  const status = maxStatus([
    ...rows.map((r) => r.status),
    provider ? provider.status : 'red',
    lifetime.status,
    disk.status,
    graphiti && /healthy|green/.test(String(graphiti.status)) ? 'green' : 'red',
  ]);
  const summary = {
    schema: 'graphiti.coverage_health.v1',
    generated_at: normalizeIso(new Date()),
    status,
    range: { since, until },
    detail: [
      status === 'green'
        ? 'raw source counts, event log, Graphiti receipts, lifetime replay, provider chain, and disk all pass'
        : 'one or more Graphiti coverage checks is not green',
      gmailS3.status === 'green'
        ? null
        : `separate subsystem gmail_s3 is ${gmailS3.status}: ${gmailS3.detail}`,
    ]
      .filter(Boolean)
      .join('; '),
    rows,
    provider,
    graphiti,
    gmail_s3: gmailS3,
    lifetime,
    disk,
    healing: {
      backfill: 'node scripts/graphiti-backfill-last-30-days.js --days 30 --drain',
      drain: 'node scripts/graphiti-event-drain.js',
      lifetime:
        'node scripts/graphiti-backfill-lifetime.js --drain --concurrency 4, then node scripts/graphiti-lifetime-coverage-health.js',
      provider: 'node scripts/graphiti-provider-health.js',
      gmail_s3:
        'scripts\\life-archive-sync-s3.bat, then refresh data/life-archive/gmail-s3-flow-health-latest.json',
      disk: 'stop Graphiti backfill if disk exceeds 85%; EC2 root is 100GB gp3',
    },
  };
  const outDir = path.join(root, 'data', 'agent');
  fs.mkdirSync(outDir, { recursive: true });
  fs.appendFileSync(
    path.join(outDir, 'graphiti-coverage-health.jsonl'),
    JSON.stringify(summary) + '\n',
  );
  fs.writeFileSync(
    path.join(outDir, 'graphiti-coverage-health-latest.json'),
    JSON.stringify(summary, null, 2),
  );
  return summary;
}

if (require.main === module) {
  const summary = coverageHealth(parseArgs(process.argv));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.status === 'red' ? 1 : 0);
}

module.exports = { coverageHealth, sourceRows, evaluateGmailS3Parity };
