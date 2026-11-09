'use strict';

// Owner decision: work gets a 3 hour outer limit instead of a guessed one, because a
// model reads its progress every five minutes and restarts it when it has gone wrong.
// Real deadlines (4:30 AM repair cutoff, 5:30 AM delivery) still apply on top of this.

const WATCHED_WORK_LIMIT_MS = 3 * 60 * 60 * 1000;
const WATCHED_JOB_ENV = 'AMY_WATCHED_JOB_ID';
const WATCHED_JOB_PROGRESS_ENV_NAME = 'AMY_WATCHED_JOB_PROGRESS';

function isWatchedWork(env = process.env) {
  return Boolean(env && env[WATCHED_JOB_ENV]);
}

// Use in place of a guessed limit on work that can run under a watched job. Outside a
// watched job nothing reads the progress, so the caller's own limit still stands.
function watchedLimitMs(unwatchedMs, env = process.env) {
  return isWatchedWork(env) ? WATCHED_WORK_LIMIT_MS : unwatchedMs;
}

// The env for a child that outlives its launcher. The launcher drops its registration when
// it exits, so no reader can see that child; it keeps its own short limits instead of a
// 3 hour limit nobody supervises (owner decision).
function detachedChildEnv(env = process.env) {
  const next = { ...env };
  delete next[WATCHED_JOB_ENV];
  delete next[WATCHED_JOB_PROGRESS_ENV_NAME];
  return next;
}

module.exports = {
  detachedChildEnv,
  WATCHED_JOB_ENV,
  WATCHED_WORK_LIMIT_MS,
  isWatchedWork,
  watchedLimitMs,
};
