'use strict';
/**
 * Ship speed summary (ship-jam S-7, owner decision): the median land and the
 * median deploy over the last week, against the targets (land under 5 minutes,
 * deploy under 10). Pure: rows in, summary out. ship.js writes the summary to
 * data/agent/ship-speed-latest.json and copies it to EC2, where the System
 * Health row `ship-speed` turns red when a median misses its target.
 */

const fs = require('fs');
const path = require('path');

const TARGET_MS = Object.freeze({ land: 5 * 60000, deploy: 10 * 60000 });
const WINDOW_DAYS = 7;
const LEDGER = 'ship-runs.jsonl';
const SUMMARY = 'ship-speed-latest.json';

/**
 * The app data folder (SECONDBRAIN_DATA_DIR, else %APPDATA%\secondbrain\data on
 * Windows), never a checkout: a checkout's untracked data/ gets cleaned, which
 * is how the first ledger vanished on 2026-11-16.
 */
function agentDataFile(name, env = process.env, platform = process.platform) {
  const root = env.SECONDBRAIN_DATA_DIR
    || (platform === 'win32' && env.APPDATA ? path.join(env.APPDATA, 'secondbrain', 'data') : path.join(require('os').homedir(), '.secondbrain', 'data'));
  return path.join(root, 'agent', name);
}

function appendRun(row, env = process.env) {
  try {
    const file = agentDataFile(LEDGER, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
    return true;
  } catch {
    return false;
  }
}

function readRuns(env = process.env) {
  try {
    return fs.readFileSync(agentDataFile(LEDGER, env), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/** Rewrite the summary beside the ledger; returns it. */
function writeSummary(env = process.env, nowMs = Date.now()) {
  const summary = summarize(readRuns(env), nowMs);
  try {
    const file = agentDataFile(SUMMARY, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  } catch {
    /* the summary never blocks */
  }
  return summary;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const minutes = (ms) => `${(ms / 60000).toFixed(1)} min`;

/** Durations of successful runs inside the window, by kind. */
function durationsByKind(rows, nowMs, windowDays = WINDOW_DAYS) {
  const since = nowMs - windowDays * 86400000;
  const out = { land: [], deploy: [] };
  // A land is its --check plus its --apply: an apply adds the same branch's
  // latest green check from the hour before it.
  const lastCheck = new Map();
  const sorted = (rows || []).filter((r) => r && Number.isFinite(Date.parse(r.ts))).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  for (const r of sorted) {
    const t = Date.parse(r.ts);
    const d = r.durations || {};
    if (r.ok === false || t > nowMs + 60000) continue;
    if (r.command === 'land' && r.phase === 'check') {
      lastCheck.set(r.branch, { t, ms: d.totalMs });
      continue;
    }
    if (t < since) continue;
    if (r.command === 'land' && Number.isFinite(d.totalMs)) {
      const c = lastCheck.get(r.branch);
      const checkMs = c && t - c.t <= 3600000 && Number.isFinite(c.ms) ? c.ms : 0;
      lastCheck.delete(r.branch);
      out.land.push(d.totalMs + checkMs);
    }
    if (Number.isFinite(d.deploy) && d.deploy > 0) out.deploy.push(d.deploy);
  }
  return out;
}

function summarize(rows, nowMs = Date.now(), windowDays = WINDOW_DAYS) {
  const by = durationsByKind(rows, nowMs, windowDays);
  const part = (kind) => ({ count: by[kind].length, median_ms: median(by[kind]), target_ms: TARGET_MS[kind] });
  const land = part('land');
  const deploy = part('deploy');
  const missed = [land, deploy].map((p, i) => [['land', 'deploy'][i], p]).filter(([, p]) => p.median_ms !== null && p.median_ms > p.target_ms);
  let status = 'green';
  let reason;
  if (missed.length) {
    status = 'red';
    reason = missed.map(([k, p]) => `median ${k} ${minutes(p.median_ms)}, target ${p.target_ms / 60000} min`).join('; ');
  } else if (!land.count && !deploy.count) {
    status = 'unknown';
    reason = `no land or deploy in the last ${windowDays} days`;
  } else {
    const say = (k, p) => (p.count ? `median ${k} ${minutes(p.median_ms)} (n=${p.count})` : `no ${k} this week`);
    reason = `${say('land', land)}, ${say('deploy', deploy)}`;
  }
  return { schema: 'ship-speed@1', generated_at: new Date(nowMs).toISOString(), window_days: windowDays, land, deploy, status, reason };
}

module.exports = { TARGET_MS, WINDOW_DAYS, LEDGER, SUMMARY, agentDataFile, appendRun, readRuns, writeSummary, median, summarize, durationsByKind };
