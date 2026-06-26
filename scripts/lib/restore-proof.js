const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function walkJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function snapshotTasksDir(snapshotDir) {
  return path.join(snapshotDir, 'data', 'tasks');
}

function readSpineTasksFromSnapshot(snapshotDir) {
  const dir = snapshotTasksDir(snapshotDir);
  return walkJsonFiles(dir)
    .map((filePath) => {
      try {
        const task = readJson(filePath);
        if (!task || !task.id || !task.status) return null;
        return {
          id: task.id,
          status: task.status,
          filePath,
          sha256: sha256File(filePath),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function restoreSpineFromSnapshot(snapshotDir, destTasksDir) {
  const tasks = readSpineTasksFromSnapshot(snapshotDir);
  if (tasks.length === 0) {
    throw new Error(`No task JSON files found in snapshot: ${snapshotTasksDir(snapshotDir)}`);
  }
  fs.mkdirSync(destTasksDir, { recursive: true });
  for (const task of tasks) {
    fs.copyFileSync(task.filePath, path.join(destTasksDir, `${task.id}.json`));
  }
  return {
    copied: tasks.length,
    taskIds: tasks.map((task) => task.id).sort(),
    sha256: tasks.map((task) => task.sha256).sort(),
  };
}

function readSessionMetas(metaCacheDir) {
  return walkJsonFiles(metaCacheDir)
    .map((filePath) => {
      try {
        const meta = readJson(filePath);
        if (!meta || !meta.session_id) return null;
        return {
          sessionId: meta.session_id,
          repo: meta.repo || null,
          s3Date: path.basename(path.dirname(filePath)),
          filePath,
          sha256: sha256File(filePath),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function buildRestoreProof({ snapshotDir, metaCacheDir }) {
  const tasks = readSpineTasksFromSnapshot(snapshotDir);
  const sessions = readSessionMetas(metaCacheDir);
  const missing = [];
  if (tasks.length === 0) missing.push('spine-tasks');
  if (sessions.length === 0) missing.push('session-metas');
  return {
    status: missing.length === 0 ? 'green' : 'red',
    missing,
    spineTaskIds: tasks.map((task) => task.id).sort(),
    sessionIds: sessions.map((session) => session.sessionId).sort(),
    evidence: {
      taskHashes: tasks.map((task) => task.sha256).sort(),
      sessionMetaHashes: sessions.map((session) => session.sha256).sort(),
    },
    rebuildCommands: [
      'extract s3://$SECONDBRAIN_BACKUP_BUCKET/snapshots/<snapshot>.zip into a restore directory',
      'copy restore/data/tasks/*.json into the live data/tasks directory',
      'aws s3 sync s3://$SECONDBRAIN_SESSIONS_BUCKET/meta/ ~/.secondbrain/meta-cache/',
      'python scripts/build-sessions-db-py.py',
    ],
  };
}

module.exports = {
  buildRestoreProof,
  readSessionMetas,
  readSpineTasksFromSnapshot,
  restoreSpineFromSnapshot,
  sha256File,
};
