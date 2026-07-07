#!/usr/bin/env node
'use strict';
// PM2 restart-storm guard (ExampleCo 2026-07-07: "how can we be sure a PM2 restart
// storm doesn't ever happen again?"). Runs on EC2 every 2 minutes via cron.
//
// Cause-agnostic by design: it does not care WHY a process restarts (PM2
// file-watch on a churning checkout, a crash loop, an OOM loop). It watches
// the SYMPTOM -- restart velocity -- and halts any process restarting faster
// than a healthy service ever would, before the storm can starve the box.
// It also flags any process running with PM2 file-watch enabled, which is the
// known storm generator and should never be true for a long-running daemon.
//
// The 2026-07-07 incident: gmail-amy-scan ran with watch=true out of the
// git-synced secondbrain-current checkout; every hourly sync churned files and
// restarted it, accumulating 18,673 restarts and pinning the box. Nothing
// watched, so it ran for a long time. This guard is that missing watcher.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_STATE = process.env.PM2_STORM_STATE ||
  '/opt/secondbrain/data/agent/pm2-storm-state.json';
const DEFAULT_INCIDENTS = process.env.PM2_STORM_INCIDENTS ||
  '/opt/secondbrain/data/agent/pm2-storm-incidents.jsonl';

// A healthy service crash-recovers a handful of times at most between guard
// runs. >12 restarts inside one ~2-min window is ~6/min, which no correctly
// behaving daemon does; that is a storm. Conservative on purpose: false
// positives stop a real service, so the bar sits well above legitimate churn.
const STORM_DELTA = Number(process.env.PM2_STORM_DELTA) || 12;
// Only act on a delta when the baseline is recent; a day-old baseline would
// make a normal restart count look like a storm.
const INTERVAL_MAX_MS = Number(process.env.PM2_STORM_INTERVAL_MAX_MS) || 10 * 60 * 1000;

// NEVER auto-stop these: stopping the main backend to "protect" the box would
// itself be the outage (Vapi, Telegram, briefing, the memory endpoint all die
// with it). A protected process that storms gets a LOUD alert and rides PM2's
// own max_restarts brake instead of being halted by this guard. secondbrain-
// backend is MANDATORY and non-removable (Codex review 2026-07-07 #3): the env
// var is additive, it can extend the list but can never drop the backend.
const MANDATORY_NEVER_STOP = ['secondbrain-backend'];
const NEVER_STOP = new Set([
  ...MANDATORY_NEVER_STOP,
  ...(process.env.PM2_STORM_NEVER_STOP || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
]);
// Rate floor for a storm: restarts-per-minute above this, with an absolute
// delta over STORM_DELTA, is a storm even across a monitoring gap (Codex #5),
// so a box pinned long enough to delay the cron does not hide the storm.
const STORM_RATE_PER_MIN = Number(process.env.PM2_STORM_RATE_PER_MIN) || 3;

// Pure classifier: given the previous snapshot and the current pm2 process
// list, decide what to stop and what to flag. No side effects, fully testable.
function classifyPm2Storm(prevState, procs, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const stormDelta = Number(opts.stormDelta) || STORM_DELTA;
  const stormRate = Number(opts.stormRate) || STORM_RATE_PER_MIN;
  const prev = prevState && typeof prevState === 'object' ? prevState.procs || {} : {};

  const neverStop = opts.neverStop instanceof Set ? opts.neverStop : NEVER_STOP;
  const stop = [];
  const protectedStorms = []; // storming but on the never-stop allowlist
  const watchFlags = [];
  const healthy = [];
  const nextProcs = {};

  for (const p of procs) {
    const name = p.name;
    if (!name) continue;
    const restarts = Number(p.restarts) || 0;
    nextProcs[name] = { restarts, ts: now };

    if (p.watch === true) watchFlags.push(name);

    const base = prev[name];
    if (base && Number.isFinite(base.restarts) && Number.isFinite(base.ts) && base.ts <= now) {
      // Counter resets to 0 on a manual pm2 restart/delete; a negative delta is
      // a reset, not a storm.
      const delta = Math.max(0, restarts - base.restarts);
      // Rate over elapsed time, not a fixed window: a storm that accumulated
      // while the box was pinned and the cron was delayed still trips (Codex
      // #5). A 0.5-min floor keeps back-to-back runs from dividing by ~0.
      const elapsedMin = Math.max((now - base.ts) / 60000, 0.5);
      const rate = delta / elapsedMin;
      if (delta > stormDelta && rate >= stormRate) {
        if (neverStop.has(name)) protectedStorms.push({ name, delta, restarts, rate });
        else stop.push({ name, delta, restarts, rate });
        continue;
      }
    }
    healthy.push(name);
  }

  return { stop, protectedStorms, watchFlags, healthy, nextState: { procs: nextProcs, ts: now } };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeJlist(raw) {
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((p) => ({
    name: p.name,
    restarts: (p.pm2_env && (p.pm2_env.restart_time ?? p.pm2_env.restartTime)) || 0,
    watch: Boolean(p.pm2_env && p.pm2_env.watch),
    status: (p.pm2_env && p.pm2_env.status) || 'ExampleCo',
  }));
}

// Single-run lock so overlapping cron invocations cannot double-stop a process
// or interleave state/ledger writes (Codex #4). Steals a lock older than the
// TTL (a crashed prior run). Returns a release fn, or null if a live run holds
// it.
function acquireLock(lockFile, ttlMs = 5 * 60 * 1000) {
  const tryOpen = () => {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, String(process.pid) + ' ' + new Date().toISOString());
    fs.closeSync(fd);
    return () => {
      try {
        fs.unlinkSync(lockFile);
      } catch {}
    };
  };
  try {
    return tryOpen();
  } catch (e) {
    if (e.code !== 'EEXIST') return null;
    try {
      if (Date.now() - fs.statSync(lockFile).mtimeMs > ttlMs) {
        fs.unlinkSync(lockFile);
        return tryOpen();
      }
    } catch {}
    return null;
  }
}

async function runGuard(opts = {}) {
  const runSync = opts.runSync || execSync;
  const stateFile = opts.stateFile || DEFAULT_STATE;
  const incidentsFile = opts.incidentsFile || DEFAULT_INCIDENTS;
  const lockFile = opts.lockFile || stateFile + '.lock';
  const notify = opts.notify;
  const now = Number(opts.now) || Date.now();

  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  } catch {}
  const release = opts.noLock ? () => {} : acquireLock(lockFile);
  if (!release) return { ok: true, skipped: 'locked' };

  try {
    return await runGuardLocked({ runSync, stateFile, incidentsFile, notify, now });
  } finally {
    release();
  }
}

async function runGuardLocked({ runSync, stateFile, incidentsFile, notify, now }) {
  let procs;
  try {
    procs = normalizeJlist(String(runSync('pm2 jlist', { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 })));
  } catch (e) {
    return { ok: false, error: `pm2 jlist failed: ${e.message}` };
  }
  if (!procs.length) return { ok: true, note: 'no pm2 processes' };

  const prevState = readJson(stateFile, { procs: {}, ts: 0 });
  const firstRun = !prevState || !prevState.procs || Object.keys(prevState.procs).length === 0;
  const { stop, protectedStorms, watchFlags, nextState } = classifyPm2Storm(prevState, procs, { now });

  const actions = [];
  // Halt storms first: this is the hard guarantee that protects the box.
  for (const s of stop) {
    try {
      runSync(`pm2 stop ${JSON.stringify(s.name)}`, { encoding: 'utf8', timeout: 15000 });
      actions.push({ action: 'stopped', name: s.name, delta: s.delta, restarts: s.restarts });
    } catch (e) {
      actions.push({ action: 'stop-failed', name: s.name, error: String(e.message).slice(0, 120) });
    }
  }

  const incidents = [];
  for (const a of actions) {
    if (a.action === 'stopped') {
      incidents.push(`STOPPED ${a.name}: ${a.delta} restarts since last check (restart storm halted; needs manual pm2 restart once the cause is fixed)`);
    } else if (a.action === 'stop-failed') {
      incidents.push(`STOP FAILED ${a.name}: ${a.error} (storm still active, needs manual pm2 stop)`);
    }
  }
  // A protected process (the main backend) storming is serious, but stopping it
  // would be the outage, so alert loudly and let PM2's max_restarts brake act.
  for (const p of protectedStorms) {
    incidents.push(`PROTECTED ${p.name} is storming (${p.delta} restarts since last check) but was NOT stopped (critical service); investigate now, it is riding pm2 max_restarts only`);
  }
  // watch=true is the known storm generator; flag it loudly even before it
  // storms so the misconfiguration is fixed at the source. First run flags too.
  for (const name of watchFlags) {
    incidents.push(`WATCH ENABLED on ${name}: PM2 file-watch on a long-running daemon is the storm generator; move it to an ecosystem entry with watch:false`);
  }

  // Persist state atomically (tmp then rename) so a crash mid-write cannot
  // leave a half-written file that reads as an empty baseline (Codex #4). The
  // state `ts` doubles as the guard heartbeat the briefing checks for
  // liveness (Codex #1).
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = stateFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(nextState));
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    incidents.push(`STATE WRITE FAILED: ${e.message}`);
  }
  if (incidents.length) {
    try {
      fs.mkdirSync(path.dirname(incidentsFile), { recursive: true });
      fs.appendFileSync(
        incidentsFile,
        JSON.stringify({ ts: new Date(now).toISOString(), incidents, actions }) + '\n',
      );
      // Bound the ledger: keep the last 500 lines so a long-running storm the
      // guard is repeatedly reporting cannot grow the file without limit.
      const all = fs.readFileSync(incidentsFile, 'utf8').trim().split('\n').filter(Boolean);
      if (all.length > 500) fs.writeFileSync(incidentsFile, all.slice(-500).join('\n') + '\n');
    } catch {}
  }

  // Alert on any halt, any protected-process storm, or a watch flag, but never
  // on a bare first-run baseline with nothing wrong. The Telegram text is clean
  // executive English on purpose: raw operational terms (the process manager's
  // name, "restarts") are scrubbed from Telegram by the executive-surface
  // policy and would suppress the whole alert. The detailed operational text
  // stays in the incident ledger, which the briefing reads and formats itself.
  const stopped = actions.filter((a) => a.action === 'stopped').map((a) => a.name);
  const stopFailed = actions.filter((a) => a.action === 'stop-failed').map((a) => a.name);
  const alertBits = [];
  if (stopped.length) {
    alertBits.push(
      `Amy stopped a cloud background service that was restarting in a rapid loop, to keep the system responsive (${stopped.join(', ')}). It stays stopped until the cause is fixed.`,
    );
  }
  if (stopFailed.length) {
    alertBits.push(`A looping cloud service could not be stopped automatically and needs a manual look (${stopFailed.join(', ')}).`);
  }
  if (protectedStorms.length) {
    alertBits.push(
      `A core cloud service is restarting repeatedly; Amy left it running because stopping it would take the system down, but it needs attention now (${protectedStorms.map((p) => p.name).join(', ')}).`,
    );
  }
  if (watchFlags.length) {
    alertBits.push(`A cloud background service is set to auto-restart on file changes, which can cause a restart loop; Amy flagged it for a permanent fix (${watchFlags.join(', ')}).`);
  }
  const shouldAlert = alertBits.length > 0;
  if (shouldAlert && notify) {
    try {
      await notify({
        text: alertBits.join(' '),
        source: 'pm2-storm-guard',
        priority: stopped.length || stopFailed.length || protectedStorms.length ? 'high' : 'normal',
        kind: 'security',
        dedupKey: 'pm2-storm-' + [...actions.map((a) => a.name), ...protectedStorms.map((p) => p.name), ...watchFlags].sort().join('-'),
      });
    } catch {}
  }

  return { ok: true, firstRun, stopped: stop.map((s) => s.name), protectedStorms: protectedStorms.map((p) => p.name), watchFlags, incidents, alertText: alertBits.join(' ') };
}

if (require.main === module) {
  let notify = null;
  try {
    notify = require('./lib/notify-with-fallback').notifyWithFallback;
  } catch {}
  runGuard({ notify })
    .then((r) => {
      console.log(JSON.stringify(r));
      process.exit(0);
    })
    .catch((e) => {
      console.error('[pm2-storm-guard]', e.message);
      process.exit(0);
    });
}

module.exports = { classifyPm2Storm, normalizeJlist, runGuard, STORM_DELTA };
