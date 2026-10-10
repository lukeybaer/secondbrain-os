#!/usr/bin/env node
'use strict';

// PC side of the evidence forwarder (ExampleCo 2026-09-23: evidence lives on EC2,
// not the PC). The PC's append-only evidence files ARE the outbox: this
// forwarder sends each file's new byte range to EC2 (/commands/evidence-append)
// and advances a local offset only after EC2 acknowledges the matching mark.
// While EC2 is unreachable nothing moves and nothing is lost; the next hook
// call or scheduled sync resumes from the last acknowledged offset.
//
// Sources: every PC operation-provenance ledger file (prompt/response events,
// land tests, session archives) and the outbound send-guard decision log.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { provenancePaths } = require('./lib/operation-provenance.js');

const BATCH_BYTES = 512 * 1024;
const FIRST_SIGHT_WINDOW_MS = 3 * 24 * 3600 * 1000;
const RUN_BUDGET_MS = 20000;
const LOCK_STALE_MS = 2 * 60 * 1000;

function runtimeDataDir() {
  if (process.env.SECONDBRAIN_DATA_DIR) return process.env.SECONDBRAIN_DATA_DIR;
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'secondbrain', 'data');
  return path.join(os.homedir(), '.secondbrain', 'data');
}

function loadConfig(env = process.env) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(env.APPDATA || '', 'secondbrain', 'config.json'), 'utf8')); } catch { /* env only */ }
  return {
    baseUrl: String(env.SB_EC2_BASE_URL || config.ec2BaseUrl || '').replace(/\/+$/, ''),
    token: String(env.SB_COMMAND_TOKEN || config.commandToken || ''),
  };
}

function sources(dataDir, homeDir = os.homedir()) {
  const ledgerDir = provenancePaths(dataDir).ledgerDir;
  let files = [];
  try { files = fs.readdirSync(ledgerDir).filter((name) => name.endsWith('.jsonl') && !name.startsWith('fwd-')); } catch { /* no ledger yet */ }
  return [
    ...files.map((name) => ({ stream: 'operation-provenance', file: path.join(ledgerDir, name), key: name })),
    { stream: 'send-guard', file: path.join(homeDir, '.secondbrain', 'outbound-send-guard.log'), key: 'outbound-send-guard.log' },
  ];
}

// Complete lines only, from `offset`, up to the batch budget.
function readBatch(file, offset, budget = BATCH_BYTES) {
  const size = fs.statSync(file).size;
  if (size <= offset) return null;
  const length = Math.min(size - offset, budget);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buffer, 0, length, offset); } finally { fs.closeSync(fd); }
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) return null; // a partial line waits for its newline
  const chunk = buffer.subarray(0, lastNewline + 1).toString('utf8');
  const lines = chunk.split('\n').slice(0, -1);
  return { fromOffset: offset, toOffset: offset + lastNewline + 1, lines };
}

async function forwardAll({ dataDir = runtimeDataDir(), homeDir = os.homedir(), config = loadConfig(), post = null, now = Date.now, host = os.hostname() } = {}) {
  if (!config.baseUrl || !config.token) return { ok: false, reason: 'missing ec2BaseUrl or commandToken', sent: 0 };
  const send = post || (async (body) => {
    const response = await fetch(`${config.baseUrl}/commands/evidence-append`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  });
  const offsetsFile = path.join(dataDir, 'agent', 'evidence-forward', 'local-offsets.json');
  let offsets = {};
  try { offsets = JSON.parse(fs.readFileSync(offsetsFile, 'utf8')); } catch { /* first run */ }
  const started = now();
  let sent = 0;
  let failure = null;
  for (const source of sources(dataDir, homeDir)) {
    if (now() - started > RUN_BUDGET_MS || failure) break;
    let stat;
    try { stat = fs.statSync(source.file); } catch { continue; }
    const key = `${source.stream}|${source.key}`;
    if (offsets[key] === undefined) {
      // History older than the window stays on the PC; start at its end.
      offsets[key] = now() - stat.mtimeMs > FIRST_SIGHT_WINDOW_MS ? stat.size : 0;
    }
    for (let guard = 0; guard < 50; guard += 1) {
      const batch = readBatch(source.file, offsets[key]);
      if (!batch) break;
      let result;
      try { result = await send({ host, stream: source.stream, file: source.key, ...batch }); } catch (error) { failure = String(error?.message || error); break; }
      if (result.status === 200 && Number.isInteger(result.body?.mark)) { offsets[key] = result.body.mark; sent += batch.lines.length; continue; }
      if (result.status === 409 && Number.isInteger(result.body?.mark)) { offsets[key] = result.body.mark; continue; }
      failure = `EC2 answered ${result.status} ${result.body?.error || ''}`.trim();
      break;
    }
  }
  fs.mkdirSync(path.dirname(offsetsFile), { recursive: true });
  fs.writeFileSync(`${offsetsFile}.tmp`, JSON.stringify(offsets));
  fs.renameSync(`${offsetsFile}.tmp`, offsetsFile);
  return { ok: !failure, reason: failure, sent };
}

function withLock(dataDir, action) {
  const lock = path.join(dataDir, 'agent', 'evidence-forward', 'forward.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_STALE_MS) return Promise.resolve({ ok: true, reason: 'another forwarder is running', sent: 0 });
      fs.writeFileSync(lock, String(process.pid));
    } catch { return Promise.resolve({ ok: false, reason: 'lock unavailable', sent: 0 }); }
  }
  return Promise.resolve().then(action).finally(() => { try { fs.unlinkSync(lock); } catch { /* already gone */ } });
}

if (require.main === module) {
  const dataDir = runtimeDataDir();
  withLock(dataDir, () => forwardAll({ dataDir }))
    .then((result) => { console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1; })
    .catch((error) => { console.error(String(error?.message || error)); process.exitCode = 1; });
}

module.exports = { forwardAll, readBatch, sources, loadConfig, withLock };
