'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultDesktopSessionRegistryDir } = require('./desktop-session-registry.js');

const DEFAULT_STALE_AFTER_MINUTES = 15;
const DEFAULT_LIMIT = 20;

function defaultDesktopTasksDir(env = process.env) {
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return env.SECONDBRAIN_TASKS_DIR || path.join(appData, 'secondbrain', 'data', 'tasks');
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function concise(value, maximum = 500) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maximum);
}

function readDesktopDevSessions({
  registryDir = defaultDesktopSessionRegistryDir(),
  tasksDir = defaultDesktopTasksDir(),
  nowMs = Date.now(),
  staleAfterMinutes = DEFAULT_STALE_AFTER_MINUTES,
  limit = DEFAULT_LIMIT,
} = {}) {
  const staleMinutes = boundedNumber(staleAfterMinutes, DEFAULT_STALE_AFTER_MINUTES, 1, 24 * 60);
  const maximum = Math.floor(boundedNumber(limit, DEFAULT_LIMIT, 1, 100));
  const staleAfterMs = staleMinutes * 60 * 1000;
  const filesIn = (dir) => {
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => name.startsWith('spine-session-') && name.endsWith('.json'))
        .map((name) => ({ dir, name }));
    } catch {
      return [];
    }
  };
  // Registry records win; Task-store reads keep pre-separation sessions visible.
  const files = [...filesIn(registryDir), ...filesIn(tasksDir)];

  const sessions = [];
  const seen = new Set();
  let futureFiltered = 0;
  for (const { dir, name } of files) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      continue;
    }
    if (record?.status !== 'running') continue;
    const updatedMs = Date.parse(record.updatedAt || record.lastProgressAt || record.createdAt || '');
    if (!Number.isFinite(updatedMs)) continue;
    if (updatedMs > nowMs + 60_000) {
      futureFiltered += 1;
      continue;
    }
    if (nowMs - updatedMs > staleAfterMs) continue;
    const fallbackId = name.slice('spine-session-'.length, -'.json'.length);
    const stableId = concise(record.sessionId || fallbackId, 200);
    if (!stableId || seen.has(stableId)) continue;
    seen.add(stableId);
    sessions.push({
      session_id: stableId,
      title: concise(record.title || record.prompt || fallbackId, 300),
      status: 'running',
      origin: concise(record.origin || 'unknown', 80),
      updated_at: new Date(updatedMs).toISOString(),
      started_at: concise(record.startedAt || record.createdAt, 80) || null,
      cwd: concise(record.execution?.cwd, 500) || null,
      branch: concise(record.execution?.branch, 300) || null,
      commit: concise(record.execution?.commit, 100) || null,
      result_summary: concise(record.result?.summary || record.resultSummary || record.result_summary || record.summary, 500) || null,
    });
  }
  sessions.sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  const visible = sessions.slice(0, maximum);
  return {
    ok: true,
    schema: 'amy.desktop-dev-sessions.v1',
    observed_at: new Date(nowMs).toISOString(),
    count: sessions.length,
    returned_count: visible.length,
    total_fresh_running: sessions.length,
    future_filtered: futureFiltered,
    stale_after_minutes: staleMinutes,
    source: 'desktop-spine-session-registry',
    sessions: visible,
  };
}

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_STALE_AFTER_MINUTES,
  defaultDesktopTasksDir,
  defaultDesktopSessionRegistryDir,
  readDesktopDevSessions,
};
