#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { addEpisode } = require('./lib/graphiti-mcp');
const {
  appendReceipt,
  iterEvents,
  normalizeIso,
  readOffset,
  readReceiptIndex,
  rebuildReceiptIndex,
  repoRoot,
  saveOffset,
} = require('./lib/graphiti-event-log');
const { shouldDrainEvent } = require('./lib/graphiti-source-policy');
const { graphitiEnrichmentAdmission } = require('./lib/graphiti-overnight-policy.js');

function parseArgs(argv) {
  const out = { max: Infinity, since: null, dryRun: false, root: repoRoot(), concurrency: 1 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max') out.max = Number(argv[++i] || Infinity);
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--concurrency') out.concurrency = Math.max(1, Number(argv[++i] || 1));
  }
  return out;
}

function writeLatest(root, summary) {
  // A rehearsal must not overwrite the operational record of the last real drain.
  const name = summary.dry_run
    ? 'graphiti-drain-latest-dry-run.json'
    : 'graphiti-drain-latest.json';
  const file = path.join(root, 'data', 'agent', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
}

// Older builds recorded a rehearsal as a delivered receipt ('ok' with a dry-run
// detail). Those receipts are still in append-only logs and would suppress the
// event forever, so a receipt that only ever recorded a rehearsal is not terminal.
function isRehearsalReceipt(receipt) {
  return !!receipt && /dry.?run/i.test(String(receipt.detail || ''));
}

function suppressesDelivery(receipt) {
  if (!receipt) return false;
  if (!['ok', 'skipped'].includes(receipt.status)) return false;
  return !isRehearsalReceipt(receipt);
}

async function drain(opts = {}) {
  const root = opts.root || repoRoot();
  // Seam so tests can exercise delivery without a live Graphiti service.
  const sendEpisode = opts.addEpisode || addEpisode;
  const offset = readOffset(root, 'graphiti');
  const receiptIndex = readReceiptIndex(root);
  const summary = {
    schema: 'graphiti.drain.summary.v1',
    started_at: normalizeIso(new Date()),
    finished_at: null,
    status: 'green',
    attempted: 0,
    added: 0,
    would_add: 0,
    skipped: 0,
    deferred: 0,
    failed: 0,
    dry_run: !!opts.dryRun,
    errors: [],
  };

  const since = opts.since || null;
  const concurrency = Math.max(1, Number(opts.concurrency || 1));
  const candidates = [];
  for (const item of iterEvents(root, { since })) {
    const fileName = path.basename(item.file);
    const lastLine = offset.files && offset.files[fileName] ? Number(offset.files[fileName]) : 0;
    const ev = item.event;
    const priorReceipt = receiptIndex[ev.event_id];
    if (suppressesDelivery(priorReceipt)) {
      if (concurrency === 1) {
        offset.files = offset.files || {};
        offset.files[fileName] = item.lineNumber;
      }
      continue;
    }
    // The receipt is the proof of delivery; the offset is only an optimization, and it
    // must be consulted after it. A failed or rehearsal event keeps its line number
    // while the next event in the same file advances the offset past it, so honouring
    // the offset first would strand it forever and still report green. Skipping on
    // offset alone stays allowed only when the log holds no receipt for the event at
    // all, which is the rotated-receipt-log case the offset exists to cover.
    if (!priorReceipt && concurrency === 1 && !since && item.lineNumber <= lastLine) continue;
    if (candidates.length >= opts.max) break;
    candidates.push(item);
  }

  // Raw events are already durable in the append-only event log. During the
  // briefing window leave offsets and delivery receipts untouched, so a
  // single post-delivery drain performs extraction/dedup instead of making
  // every overnight append compete with repair and report work.
  const enrichment = graphitiEnrichmentAdmission({
    nowMs: opts.nowMs || Date.now(),
    dataDir: opts.dataDir || path.join(root, 'data'),
    date: opts.briefingDate,
    testIngestionPolicyPath: opts.testIngestionPolicyPath,
  });
  if (!opts.dryRun && !enrichment.allowed) {
    summary.status = 'deferred';
    summary.deferred = candidates.length;
    summary.defer_reason = enrichment.reason;
    summary.resume_after = enrichment.resumeAfter;
    summary.finished_at = normalizeIso(new Date());
    writeLatest(root, summary);
    return summary;
  }

  let nextIndex = 0;
  // A dry run is a rehearsal: it must leave no durable trace of delivery. Writing a
  // terminal receipt ('ok'/'skipped') or advancing the offset would make the next real
  // drain skip the event forever, silently dropping it from the graph.
  function commitProgress(receipt, item) {
    if (opts.dryRun) return;
    appendReceipt(receipt, root, { updateIndex: concurrency === 1 });
    if (concurrency === 1) {
      offset.files = offset.files || {};
      offset.files[path.basename(item.file)] = item.lineNumber;
      saveOffset(offset, root, 'graphiti');
    }
  }
  async function processItem(item) {
    const ev = item.event;
    const policy = shouldDrainEvent(ev);
    if (!policy.ok) {
      summary.skipped++;
      commitProgress(
        {
          event_id: ev.event_id,
          source: ev.source,
          source_id: ev.source_id,
          status: 'skipped',
          graphiti_ok: false,
          reference_time: ev.reference_time,
          detail: policy.reason,
        },
        item,
      );
      return;
    }

    summary.attempted++;
    try {
      if (!opts.dryRun) {
        await sendEpisode(ev, { timeoutMs: opts.timeoutMs || 45000 });
      }
      // A rehearsal never delivered anything, so it must not report additions.
      if (opts.dryRun) summary.would_add++;
      else summary.added++;
      commitProgress(
        {
          event_id: ev.event_id,
          source: ev.source,
          source_id: ev.source_id,
          status: 'ok',
          graphiti_ok: true,
          reference_time: ev.reference_time,
          detail: 'Graphiti accepted event',
        },
        item,
      );
    } catch (e) {
      summary.failed++;
      summary.status = 'red';
      summary.errors.push({
        event_id: ev.event_id,
        source: ev.source,
        source_id: ev.source_id,
        error: String(e.message || e).slice(0, 400),
      });
      if (!opts.dryRun) {
        appendReceipt(
          {
            event_id: ev.event_id,
            source: ev.source,
            source_id: ev.source_id,
            status: 'failed',
            graphiti_ok: false,
            reference_time: ev.reference_time,
            detail: String(e.message || e).slice(0, 400),
          },
          root,
          { updateIndex: concurrency === 1 },
        );
      }
      if (opts.stopOnError) throw e;
    }
  }

  async function worker() {
    while (nextIndex < candidates.length) {
      const item = candidates[nextIndex++];
      await processItem(item);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()),
  );
  rebuildReceiptIndex(root);

  summary.finished_at = normalizeIso(new Date());
  if (summary.failed > 0) summary.status = 'red';
  writeLatest(root, summary);
  return summary;
}

if (require.main === module) {
  drain(parseArgs(process.argv))
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      process.exit(summary.failed ? 1 : 0);
    })
    .catch((e) => {
      console.error(e.stack || e.message);
      process.exit(1);
    });
}

module.exports = { drain, isRehearsalReceipt, suppressesDelivery };
