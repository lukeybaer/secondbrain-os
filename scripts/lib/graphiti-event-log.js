const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EVENT_SCHEMA = 'graphiti.event.v1';
const RECEIPT_SCHEMA = 'graphiti.receipt.v1';

function repoRoot() {
  if (process.env.SECONDBRAIN_ROOT) return process.env.SECONDBRAIN_ROOT;
  if (fs.existsSync('/opt/secondbrain')) return '/opt/secondbrain';
  return path.resolve(__dirname, '..', '..');
}

function eventRoot(root = repoRoot()) {
  return process.env.GRAPHITI_EVENT_ROOT || path.join(root, 'data', 'graphiti-event-log');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (!/EPERM|EACCES|EEXIST/i.test(e.code || '')) throw e;
      try {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      } catch {
        // Antivirus and indexers can briefly hold JSON files on Windows.
      }
    }
  }
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    // best-effort cleanup
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeIso(value, fallback = new Date()) {
  const d = value ? new Date(value) : fallback;
  if (Number.isFinite(d.getTime())) return d.toISOString();
  return fallback.toISOString();
}

function dayKey(value) {
  return normalizeIso(value).slice(0, 10);
}

function stableSourceId(event) {
  const id =
    event.source_id ||
    event.sourceId ||
    event.message_id ||
    event.id ||
    event.gmail_message_hex ||
    event.thread_hex ||
    '';
  if (id) return String(id);
  return sha256([
    event.source || 'ExampleCo',
    event.reference_time || event.timestamp || '',
    event.name || '',
    String(event.body || '').slice(0, 1000),
  ].join('|')).slice(0, 24);
}

function eventId(event) {
  return sha256([
    event.source || 'ExampleCo',
    stableSourceId(event),
    event.reference_time || event.timestamp || '',
  ].join('|')).slice(0, 32);
}

function normalizeEvent(input = {}) {
  const source = String(input.source || 'ExampleCo');
  const sourceId = stableSourceId(input);
  const referenceTime = normalizeIso(input.reference_time || input.referenceTime || input.timestamp);
  const observedAt = normalizeIso(input.observed_at || input.observedAt || new Date());
  const body = String(input.body || input.episode_body || input.text || '').trim();
  return {
    schema: EVENT_SCHEMA,
    event_id: input.event_id || eventId({ ...input, source, source_id: sourceId, reference_time: referenceTime }),
    source,
    source_id: sourceId,
    source_description: input.source_description || `${source}:${sourceId}`,
    name: String(input.name || `${source}:${sourceId}`).slice(0, 180),
    body,
    reference_time: referenceTime,
    observed_at: observedAt,
    raw_path: input.raw_path || input.rawPath || null,
    s3_uri: input.s3_uri || input.s3Uri || null,
    contact_name: input.contact_name || input.contactName || null,
    direction: input.direction || null,
    priority: input.priority || 'normal',
    metadata: input.metadata || {},
  };
}

function indexPath(root = repoRoot()) {
  return path.join(eventRoot(root), 'seen-index.json');
}

function receiptIndexPath(root = repoRoot()) {
  return path.join(eventRoot(root), 'receipt-index.json');
}

function offsetPath(root = repoRoot(), consumer = 'graphiti') {
  return path.join(eventRoot(root), 'offsets', `${consumer}.json`);
}

function appendEvent(input, opts = {}) {
  const root = opts.root || repoRoot();
  const ev = normalizeEvent(input);
  if (!ev.body || ev.body.length < (opts.minBodyLength || 10)) {
    return { ok: false, skipped: true, reason: 'body_too_short', event: ev };
  }

  const base = eventRoot(root);
  ensureDir(base);
  const idxFile = indexPath(root);
  const idx = readJson(idxFile, {});
  const seenKey = `${ev.source}:${ev.source_id}`;
  if (!opts.allowDuplicates && idx[seenKey]) {
    return { ok: true, duplicate: true, event: { ...ev, event_id: idx[seenKey].event_id } };
  }

  const file = path.join(base, `events-${dayKey(ev.reference_time)}.ndjson`);
  fs.appendFileSync(file, JSON.stringify(ev) + '\n');
  idx[seenKey] = {
    event_id: ev.event_id,
    source: ev.source,
    source_id: ev.source_id,
    reference_time: ev.reference_time,
    observed_at: ev.observed_at,
    file: path.basename(file),
  };
  writeJsonAtomic(idxFile, idx);
  return { ok: true, duplicate: false, event: ev, file };
}

function appendEventsBulk(inputs, opts = {}) {
  const root = opts.root || repoRoot();
  const base = eventRoot(root);
  ensureDir(base);
  const idxFile = indexPath(root);
  const idx = readJson(idxFile, {});
  const buffers = new Map();
  const results = {
    ok: true,
    appended: 0,
    duplicates: 0,
    skipped: 0,
    by_source: {},
  };

  function sourceRow(source) {
    results.by_source[source] = results.by_source[source] || { appended: 0, duplicates: 0, skipped: 0 };
    return results.by_source[source];
  }

  for (const input of inputs) {
    const ev = normalizeEvent(input);
    const row = sourceRow(ev.source);
    if (!ev.body || ev.body.length < (opts.minBodyLength || 10)) {
      results.skipped++;
      row.skipped++;
      continue;
    }
    const seenKey = `${ev.source}:${ev.source_id}`;
    if (!opts.allowDuplicates && idx[seenKey]) {
      results.duplicates++;
      row.duplicates++;
      continue;
    }
    const file = path.join(base, `events-${dayKey(ev.reference_time)}.ndjson`);
    if (!buffers.has(file)) buffers.set(file, []);
    buffers.get(file).push(JSON.stringify(ev));
    idx[seenKey] = {
      event_id: ev.event_id,
      source: ev.source,
      source_id: ev.source_id,
      reference_time: ev.reference_time,
      observed_at: ev.observed_at,
      file: path.basename(file),
    };
    results.appended++;
    row.appended++;
  }

  for (const [file, lines] of buffers.entries()) {
    fs.appendFileSync(file, lines.join('\n') + '\n');
  }
  writeJsonAtomic(idxFile, idx);
  return results;
}

function liExampleContFiles(root = repoRoot()) {
  const base = eventRoot(root);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .filter((name) => /^events-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name))
    .sort()
    .map((name) => path.join(base, name));
}

function readOffset(root = repoRoot(), consumer = 'graphiti') {
  return readJson(offsetPath(root, consumer), { schema: 'graphiti.offset.v1', files: {} });
}

function saveOffset(offset, root = repoRoot(), consumer = 'graphiti') {
  writeJsonAtomic(offsetPath(root, consumer), offset);
}

function appendReceipt(receipt, root = repoRoot(), opts = {}) {
  const r = {
    schema: RECEIPT_SCHEMA,
    ts: normalizeIso(receipt.ts || new Date()),
    event_id: receipt.event_id,
    source: receipt.source || null,
    source_id: receipt.source_id || null,
    status: receipt.status || 'ExampleCo',
    graphiti_ok: !!receipt.graphiti_ok,
    reference_time: receipt.reference_time || null,
    detail: receipt.detail || '',
    attempt: receipt.attempt || 1,
  };
  const base = eventRoot(root);
  ensureDir(base);
  fs.appendFileSync(path.join(base, `receipts-${dayKey(r.ts)}.ndjson`), JSON.stringify(r) + '\n');
  if (opts.updateIndex === false) return r;
  const idxFile = receiptIndexPath(root);
  const idx = readJson(idxFile, {});
  idx[r.event_id] = r;
  writeJsonAtomic(idxFile, idx);
  return r;
}

function readReceiptIndex(root = repoRoot()) {
  return readJson(receiptIndexPath(root), {});
}

function rebuildReceiptIndex(root = repoRoot()) {
  const base = eventRoot(root);
  const idx = {};
  if (!fs.existsSync(base)) {
    writeJsonAtomic(receiptIndexPath(root), idx);
    return idx;
  }
  const files = fs
    .readdirSync(base)
    .filter((name) => /^receipts-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name))
    .sort()
    .map((name) => path.join(base, name));
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (!r.event_id) continue;
      const existing = idx[r.event_id];
      if (!existing || existing.status !== 'ok' || r.status === 'ok') {
        idx[r.event_id] = r;
      }
    }
  }
  writeJsonAtomic(receiptIndexPath(root), idx);
  return idx;
}

function* iterEvents(root = repoRoot(), opts = {}) {
  const sinceMs = opts.since ? Date.parse(opts.since) : -Infinity;
  const untilMs = opts.until ? Date.parse(opts.until) : Infinity;
  for (const file of liExampleContFiles(root)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const ms = Date.parse(ev.reference_time || ev.observed_at || '');
      if (Number.isFinite(ms) && ms >= sinceMs && ms <= untilMs) {
        yield { event: ev, file, lineNumber: i + 1 };
      }
    }
  }
}

function countEventsBySource(root = repoRoot(), opts = {}) {
  const counts = {};
  const seen = new Set();
  for (const { event } of iterEvents(root, opts)) {
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    counts[event.source] = (counts[event.source] || 0) + 1;
  }
  return counts;
}

function countReceiptsBySource(root = repoRoot(), opts = {}) {
  const sinceMs = opts.since ? Date.parse(opts.since) : -Infinity;
  const untilMs = opts.until ? Date.parse(opts.until) : Infinity;
  const counts = {};
  for (const r of Object.values(readReceiptIndex(root))) {
    const ms = Date.parse(r.reference_time || r.ts || '');
    if (Number.isFinite(ms) && ms >= sinceMs && ms <= untilMs && r.status === 'ok') {
      counts[r.source] = (counts[r.source] || 0) + 1;
    }
  }
  return counts;
}

module.exports = {
  EVENT_SCHEMA,
  RECEIPT_SCHEMA,
  appendEvent,
  appendEventsBulk,
  appendReceipt,
  countEventsBySource,
  countReceiptsBySource,
  dayKey,
  eventRoot,
  iterEvents,
  liExampleContFiles,
  normalizeEvent,
  normalizeIso,
  readOffset,
  readReceiptIndex,
  rebuildReceiptIndex,
  repoRoot,
  saveOffset,
};
