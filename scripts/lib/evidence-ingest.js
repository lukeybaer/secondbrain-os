'use strict';

// EC2 side of the PC evidence forwarder (ExampleCo 2026-09-23: evidence lives on
// EC2, not the PC). The PC posts byte ranges of its append-only evidence
// files; EC2 appends them verbatim and keeps a high-water mark per
// (host, stream, file), so a retry can never duplicate a record and a gap can
// never be silently skipped: a batch that does not start at the mark is
// refused with the mark, and the PC resends from there.
//
// Streams:
//   operation-provenance  lines of amy.operation_provenance.v1 events, stored in
//                         the EC2 ledger dir so readOperationEvents merges them
//   send-guard            raw outbound-send-guard.log lines, stored where the
//                         Gravity check reads the send-guard log

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_BATCH_BYTES = 768 * 1024;
const STREAMS = new Set(['operation-provenance', 'send-guard']);
const PROVENANCE_SCHEMA = 'amy.operation_provenance.v1';

function clean(value, max = 80) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, max);
}

function marksPath(dataDir) {
  return path.join(dataDir, 'agent', 'evidence-forward', 'marks.json');
}

function readMarks(dataDir) {
  try { return JSON.parse(fs.readFileSync(marksPath(dataDir), 'utf8')); } catch { return {}; }
}

function writeMarks(dataDir, marks) {
  const file = marksPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(marks));
  fs.renameSync(temp, file);
}

function destination({ dataDir, homeDir, host, stream, file }) {
  if (stream === 'send-guard') return path.join(homeDir, '.secondbrain', 'outbound-send-guard.log');
  return path.join(dataDir, 'agent', 'operation-provenance', 'ledger', `fwd-${clean(host, 40)}-${clean(path.basename(file), 100)}`);
}

// Returns { status, body } for the HTTP layer.
function ingestEvidenceBatch(batch, { dataDir, homeDir = os.homedir() } = {}) {
  const host = clean(batch?.host, 40);
  const stream = String(batch?.stream || '');
  const file = String(batch?.file || '');
  const from = Number(batch?.fromOffset);
  const to = Number(batch?.toOffset);
  const lines = Array.isArray(batch?.lines) ? batch.lines : null;
  if (!host || !STREAMS.has(stream) || !file || !Number.isInteger(from) || !Number.isInteger(to) || to < from || !lines) {
    return { status: 400, body: { ok: false, error: 'malformed_batch' } };
  }
  const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(String(line)) + 1, 0);
  if (bytes > MAX_BATCH_BYTES) return { status: 413, body: { ok: false, error: 'batch_too_large' } };
  if (bytes !== to - from) return { status: 400, body: { ok: false, error: 'range_mismatch', expected: to - from, received: bytes } };
  // A malformed line is set aside in a quarantine file, never stored in the
  // ledger and never allowed to stall the stream: rejecting it would wedge
  // every later record of that file behind it.
  const accepted = [];
  const quarantined = [];
  for (const line of lines) {
    if (stream !== 'operation-provenance') { accepted.push(line); continue; }
    let event = null;
    try { event = JSON.parse(line); } catch { /* quarantined below */ }
    if (event?.schema === PROVENANCE_SCHEMA && event.event_id) accepted.push(line);
    else quarantined.push(line);
  }
  const key = `${host}|${stream}|${file}`;
  const marks = readMarks(dataDir);
  const mark = Number(marks[key] || 0);
  if (to <= mark) return { status: 200, body: { ok: true, duplicate: true, mark } };
  if (from !== mark) return { status: 409, body: { ok: false, error: 'offset_mismatch', mark } };
  const target = destination({ dataDir, homeDir, host, stream, file });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (accepted.length) fs.appendFileSync(target, accepted.map((line) => `${line}\n`).join(''));
  if (quarantined.length) {
    const quarantine = path.join(dataDir, 'agent', 'evidence-forward', 'quarantine.jsonl');
    fs.mkdirSync(path.dirname(quarantine), { recursive: true });
    fs.appendFileSync(quarantine, quarantined.map((line) => `${JSON.stringify({ host, stream, file, line: String(line).slice(0, 4000) })}\n`).join(''));
  }
  marks[key] = to;
  writeMarks(dataDir, marks);
  return { status: 200, body: { ok: true, appended: accepted.length, quarantined: quarantined.length, mark: to } };
}

module.exports = { MAX_BATCH_BYTES, STREAMS, ingestEvidenceBatch, readMarks, destination };
