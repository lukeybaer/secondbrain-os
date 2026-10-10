'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function activeCloudTaskLeases({ dataDir, nowMs = Date.now() } = {}) {
  const taskDir = path.join(String(dataDir || ''), 'tasks');
  let names = [];
  try {
    names = fs.readdirSync(taskDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((name) => readJson(path.join(taskDir, name)))
    .filter((task) => {
      const expiresAt = Date.parse(String(task?.lease?.expiresAt || ''));
      return (
        task?.status === 'running' &&
        String(task?.lease?.holder || '').startsWith('ec2:') &&
        Number.isFinite(expiresAt) &&
        expiresAt > nowMs
      );
    });
}

function pendingRestartPath(dataDir) {
  return path.join(String(dataDir || ''), 'agent', 'ec2-spine-worker-restart-pending.json');
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
}

function deferSpineWorkerRestart({ dataDir, releaseSha = '', nowMs = Date.now() } = {}) {
  const marker = pendingRestartPath(dataDir);
  const active = activeCloudTaskLeases({ dataDir, nowMs });
  if (!active.length) {
    try {
      fs.unlinkSync(marker);
    } catch {}
    return { state: 'restart', activeLeaseCount: 0, marker };
  }
  writeJsonAtomic(marker, {
    schema: 'ec2-spine-worker-restart-pending@1',
    requestedAt: new Date(nowMs).toISOString(),
    releaseSha: String(releaseSha || ''),
    activeLeaseCount: active.length,
  });
  return { state: 'deferred', activeLeaseCount: active.length, marker };
}

function consumePendingSpineWorkerRestart({ dataDir } = {}) {
  const marker = pendingRestartPath(dataDir);
  const pending = readJson(marker);
  if (!pending || pending.schema !== 'ec2-spine-worker-restart-pending@1') {
    return { consumed: false, marker };
  }
  try {
    fs.unlinkSync(marker);
  } catch {
    return { consumed: false, marker };
  }
  return { consumed: true, marker, releaseSha: String(pending.releaseSha || '') };
}

function argValue(flag, argv = process.argv.slice(2)) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] || '' : '';
}

if (require.main === module) {
  const result = deferSpineWorkerRestart({
    dataDir: argValue('--data-dir'),
    releaseSha: argValue('--release-sha'),
  });
  process.stdout.write(result.state);
}

module.exports = {
  activeCloudTaskLeases,
  consumePendingSpineWorkerRestart,
  deferSpineWorkerRestart,
  pendingRestartPath,
};
