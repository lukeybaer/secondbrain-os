'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  const rows = [];
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
    } catch {
      /* skip malformed jsonl row */
    }
  }
  return rows;
}

function coerceIso(value) {
  if (value === null || value === undefined || value === '') return '';
  let ms = NaN;
  if (typeof value === 'number') {
    ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : NaN;
  } else {
    const text = String(value).trim();
    const n = Number(text);
    if (Number.isFinite(n) && text.length >= 10) {
      ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : NaN;
    } else {
      ms = Date.parse(text);
    }
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function readCodexStateRows(statePath = path.join(os.homedir(), '.codex', 'state_5.sqlite')) {
  if (!statePath || !fs.existsSync(statePath)) return [];
  const code = [
    'import json, sqlite3, sys',
    'db = sqlite3.connect(sys.argv[1])',
    'db.row_factory = sqlite3.Row',
    'cols = "id,title,created_at,updated_at,updated_at_ms,archived,cwd,model,reasoning_effort"',
    'rows = [dict(r) for r in db.execute("SELECT " + cols + " FROM threads")]',
    'print(json.dumps(rows))',
  ].join('\n');
  const candidates = [
    [process.env.PYTHON || 'python', ['-c', code, statePath]],
    ['py', ['-3', '-c', code, statePath]],
  ];
  for (const [cmd, args] of candidates) {
    const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    if (res.status !== 0 || !res.stdout) continue;
    try {
      const rows = JSON.parse(res.stdout);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }
  return [];
}

function preferTitle(a, b) {
  const first = String(a || '').trim();
  const second = String(b || '').trim();
  if (!first) return second;
  if (!second) return first;
  return first.length <= second.length ? first : second;
}

function mergeThreadRows(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const prevMs = Date.parse(prev.updatedAt || '') || 0;
  const nextMs = Date.parse(next.updatedAt || '') || 0;
  const title = preferTitle(prev.title, next.title);
  const merged = nextMs >= prevMs ? { ...prev, ...next } : { ...next, ...prev };
  merged.title = title;
  merged.thread_name = title;
  merged.firstUserMessage = prev.firstUserMessage || next.firstUserMessage || '';
  merged.preview = prev.preview || next.preview || '';
  merged.source = prev.source === next.source ? prev.source : 'codex-session-index+state';
  return merged;
}

function normalizeThreadRow(row, nowMs = Date.now()) {
  const id = String(row.id || row.thread_id || row.threadId || row.session_id || '').trim();
  const updatedAt = coerceIso(row.updatedAt || row.updated_at || row.updatedAtMs || row.updated_at_ms || row.ts);
  const updatedMs = Date.parse(updatedAt || '') || 0;
  const title = String(
    row.thread_name ||
      row.displayTitle ||
      row.title ||
      row.name ||
      row.firstUserMessage ||
      row.preview ||
      id ||
      'Codex thread',
  ).replace(/\s+/g, ' ').trim();
  if (!id && !title) return null;
  const archived = row.archived === true || row.archived === 1 || row.isArchived === true;
  const status = archived
    ? 'archived'
    : updatedMs && nowMs - updatedMs <= 2 * 60 * 60 * 1000
      ? 'active_or_recent'
      : 'recent';
  return {
    id,
    title,
    thread_name: title,
    status,
    updatedAt,
    updated_at: updatedAt,
    createdAt: coerceIso(row.createdAt || row.created_at || row.createdAtMs || row.created_at_ms),
    cwd: row.cwd || row.workspace || '',
    firstUserMessage: row.firstUserMessage || row.prompt || '',
    preview: row.preview || row.summary || '',
    source: row.source || 'codex-session-index',
  };
}

function exportCodexThreadIndex({
  sourcePath = path.join(os.homedir(), '.codex', 'session_index.jsonl'),
  statePath = path.join(os.homedir(), '.codex', 'state_5.sqlite'),
  outputPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'secondbrain', 'data', 'agent', 'codex-thread-index.jsonl'),
  nowMs = Date.now(),
} = {}) {
  const byId = new Map();
  for (const row of readJsonl(sourcePath)) {
    const normalized = normalizeThreadRow(row, nowMs);
    if (!normalized) continue;
    const key = normalized.id || normalized.title;
    const prev = byId.get(key);
    byId.set(key, mergeThreadRows(prev, normalized));
  }
  for (const row of readCodexStateRows(statePath)) {
    const normalized = normalizeThreadRow({ ...row, source: 'codex-state' }, nowMs);
    if (!normalized) continue;
    const key = normalized.id || normalized.title;
    const prev = byId.get(key);
    byId.set(key, mergeThreadRows(prev, normalized));
  }
  const rows = [...byId.values()].sort(
    (a, b) => (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0),
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  return { outputPath, count: rows.length, rows };
}

function syncToEc2(filePath) {
  const key = process.env.SB_SSH_KEY || path.join(os.homedir(), '.ssh', 'sb-key.pem');
  const host = process.env.SB_EC2_HOST || 'ec2-user@ExampleCo';
  const remotePath = '/opt/secondbrain/data/agent/codex-thread-index.jsonl';
  const sshOpts = [
    '-i',
    key,
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=5',
    '-o',
    'ServerAliveCountMax=1',
  ];
  const run = (label, cmd, args, timeout) => {
    const res = spawnSync(cmd, args, { stdio: 'inherit', timeout });
    if (res.error) {
      console.error(`${label} failed: ${res.error.message}`);
      return false;
    }
    if (res.signal) {
      console.error(`${label} stopped by signal ${res.signal}`);
      return false;
    }
    if (res.status !== 0) {
      console.error(`${label} exited with status ${res.status}`);
      return false;
    }
    return true;
  };
  if (!run('EC2 mkdir', 'ssh', [...sshOpts, host, 'mkdir -p /opt/secondbrain/data/agent'], 20000)) return false;
  return run('EC2 copy', 'scp', [...sshOpts, filePath, `${host}:${remotePath}`], 30000);
}

if (require.main === module) {
  const sync = process.argv.includes('--sync-ec2');
  const outArg = process.argv.find((arg) => arg.startsWith('--out='));
  const srcArg = process.argv.find((arg) => arg.startsWith('--source='));
  const result = exportCodexThreadIndex({
    sourcePath: srcArg ? srcArg.slice('--source='.length) : undefined,
    outputPath: outArg ? outArg.slice('--out='.length) : undefined,
  });
  console.log(`Exported ${result.count} Codex threads to ${result.outputPath}`);
  if (sync) {
    const ok = syncToEc2(result.outputPath);
    console.log(ok ? 'Synced Codex thread index to EC2.' : 'EC2 sync failed.');
    process.exit(ok ? 0 : 1);
  }
}

module.exports = {
  coerceIso,
  exportCodexThreadIndex,
  normalizeThreadRow,
};
