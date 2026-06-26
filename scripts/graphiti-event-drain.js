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
  const file = path.join(root, 'data', 'agent', 'graphiti-drain-latest.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
}

async function drain(opts = {}) {
  const root = opts.root || repoRoot();
  const offset = readOffset(root, 'graphiti');
  const receiptIndex = readReceiptIndex(root);
  const summary = {
    schema: 'graphiti.drain.summary.v1',
    started_at: normalizeIso(new Date()),
    finished_at: null,
    status: 'green',
    attempted: 0,
    added: 0,
    skipped: 0,
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
    if (concurrency === 1 && !since && item.lineNumber <= lastLine) continue;
    const ev = item.event;
    const priorReceipt = receiptIndex[ev.event_id];
    if (priorReceipt && ['ok', 'skipped'].includes(priorReceipt.status)) {
      if (concurrency === 1) {
        offset.files = offset.files || {};
        offset.files[fileName] = item.lineNumber;
      }
      continue;
    }
    if (candidates.length >= opts.max) break;
    candidates.push(item);
  }

  let nextIndex = 0;
  async function processItem(item) {
    const fileName = path.basename(item.file);
    const ev = item.event;
    const policy = shouldDrainEvent(ev);
    if (!policy.ok) {
      summary.skipped++;
      appendReceipt(
        {
          event_id: ev.event_id,
          source: ev.source,
          source_id: ev.source_id,
          status: 'skipped',
          graphiti_ok: false,
          reference_time: ev.reference_time,
          detail: policy.reason,
        },
        root,
        { updateIndex: concurrency === 1 },
      );
      if (concurrency === 1) {
        offset.files = offset.files || {};
        offset.files[fileName] = item.lineNumber;
        saveOffset(offset, root, 'graphiti');
      }
      return;
    }

    summary.attempted++;
    try {
      if (!opts.dryRun) {
        await addEpisode(ev, { timeoutMs: opts.timeoutMs || 45000 });
      }
      summary.added++;
      appendReceipt(
        {
          event_id: ev.event_id,
          source: ev.source,
          source_id: ev.source_id,
          status: 'ok',
          graphiti_ok: true,
          reference_time: ev.reference_time,
          detail: opts.dryRun ? 'dry-run ok' : 'Graphiti accepted event',
        },
        root,
        { updateIndex: concurrency === 1 },
      );
      if (concurrency === 1) {
        offset.files = offset.files || {};
        offset.files[fileName] = item.lineNumber;
        saveOffset(offset, root, 'graphiti');
      }
    } catch (e) {
      summary.failed++;
      summary.status = 'red';
      summary.errors.push({
        event_id: ev.event_id,
        source: ev.source,
        source_id: ev.source_id,
        error: String(e.message || e).slice(0, 400),
      });
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
      if (opts.stopOnError) throw e;
    }
  }

  async function worker() {
    while (nextIndex < candidates.length) {
      const item = candidates[nextIndex++];
      await processItem(item);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));
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

module.exports = { drain };
