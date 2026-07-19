#!/usr/bin/env node
'use strict';

// One truthful Telegram pointer for the morning briefing. Status comes only
// from the canonical live-board artifact written by render QC. The 5:29/5:30
// notification is a current-state snapshot. A later terminal notification is
// sent only when the state changes to clean or genuinely blocked after repair.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildBriefingDashboardUrl } = require('./briefing-auth.js');
const { defectiveCardCount, isStale, readLiveBoardArtifact } = require('./live-board-truth.js');
const { loadDotEnvIfPresent, notifyWithFallback } = require('./notify-with-fallback.js');

function loadBriefingNotifyEnv(dataDir, env = process.env) {
  if (!dataDir) return;
  loadDotEnvIfPresent(path.resolve(dataDir, '..', '.env'), env);
}

function briefingNotifyMarkerPath(dataDir, date) {
  return path.join(dataDir, 'agent', `briefing-notify-${date}.json`);
}

function acquireBriefingNotifyLease(dataDir, date, nowMs = Date.now()) {
  const file = briefingNotifyMarkerPath(dataDir, date) + '.lock';
  const token = `${process.pid}-${nowMs}-${Math.random().toString(16).slice(2)}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, token);
      fs.closeSync(fd);
      return { file, token };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      try {
        if (nowMs - fs.statSync(file).mtimeMs > 2 * 60 * 1000) {
          fs.unlinkSync(file);
          continue;
        }
      } catch {
        continue;
      }
      return null;
    }
  }
  return null;
}

function releaseBriefingNotifyLease(lease) {
  if (!lease) return;
  try {
    if (fs.readFileSync(lease.file, 'utf8') === lease.token) fs.unlinkSync(lease.file);
  } catch {
    // Best effort. A stale lease is recoverable after two minutes.
  }
}

function readMarker(dataDir, date) {
  try {
    return JSON.parse(fs.readFileSync(briefingNotifyMarkerPath(dataDir, date), 'utf8'));
  } catch {
    return null;
  }
}

function writeMarker(dataDir, date, marker) {
  const file = briefingNotifyMarkerPath(dataDir, date);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(marker, null, 2) + '\n');
  } catch (e) {
    console.warn(`[briefing-notify] could not write marker ${file}: ${e.message}`);
  }
  return file;
}

function safeTitle(value) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeWork(cards, limit = 4) {
  const titles = (Array.isArray(cards) ? cards : [])
    .filter((card) => card && card.status !== 'clean')
    .map((card) => safeTitle(card.title || card.id))
    .filter(Boolean);
  const shown = titles.slice(0, limit);
  if (titles.length > limit) shown.push(`and ${titles.length - limit} more`);
  return shown.join(', ');
}

// Validate the artifact before quoting it. A wrong-day, stale, unreachable,
// or incomplete artifact is "unavailable", never yesterday's count dressed
// up as today's status.
function briefingBoardStatus({ artifact, date, nowMs = Date.now(), refresh = null } = {}) {
  if (refresh && refresh.verified === false) {
    return { state: 'unavailable', reason: refresh.reason || 'live-refresh-unavailable' };
  }
  if (!artifact || artifact.date !== date) {
    return { state: 'unavailable', reason: artifact ? 'wrong-date' : 'missing-artifact' };
  }
  if (artifact.ran !== true || isStale(artifact, nowMs)) {
    return { state: 'unavailable', reason: artifact.ran !== true ? 'not-live-verified' : 'stale' };
  }
  const cards = Array.isArray(artifact.cards) ? artifact.cards : [];
  const defective = defectiveCardCount(artifact);
  if (!cards.length || !Number.isFinite(defective) || defective < 0 || defective > cards.length) {
    return { state: 'unavailable', reason: 'invalid-card-count' };
  }
  const total = cards.length;
  const green = total - defective;
  return {
    state: defective === 0 ? 'clean' : 'ongoing',
    green,
    total,
    defective,
    work: summarizeWork(cards),
    artifactTs: artifact.ts || null,
  };
}

function notificationState(status, phase = 'current') {
  if (!status || status.state === 'unavailable') return 'unavailable';
  if (status.state === 'clean') return 'clean';
  return phase === 'final' ? 'blocked' : 'ongoing';
}

function buildBriefingNotifyText({
  status,
  phase = 'current',
  url = '',
  transition = false,
  watchReportUrl = '',
} = {}) {
  const state = notificationState(status, phase);
  let line;
  if (state === 'clean') {
    line = transition
      ? `Briefing now clean: ${status.green}/${status.total} cards green.`
      : `Briefing ready: ${status.green}/${status.total} cards green.`;
  } else if (state === 'ongoing') {
    line = `Briefing live: ${status.green}/${status.total} cards green. Work is ongoing`;
    if (status.work) line += ` on: ${status.work}`;
    line += '.';
  } else if (state === 'blocked') {
    line = `Briefing final: ${status.green}/${status.total} cards green. Repair window ended`;
    if (status.work) line += ` with: ${status.work}`;
    line += '.';
  } else {
    line = 'Briefing live: current card status unavailable.';
  }
  // One extra line ONLY when today's ledger-assembled overnight watch report
  // exists (the caller verifies existence): the morning drop ExampleCos the
  // "what we learned overnight" link alongside the dashboard link.
  const watchLine = watchReportUrl ? `Watch report: ${watchReportUrl}` : '';
  return [line, url, watchLine].filter(Boolean).join('\n');
}

// The dated watch-report artifact written by scripts/overnight-watch-report.js.
function watchReportArtifactPath(dataDir, date) {
  return path.join(dataDir, 'briefings', `watch-report-${String(date).slice(0, 10)}.html`);
}

// Tokenized URL for the day's watch report, or '' when the file does not
// exist for that date: the notify line must never link a 404. Served by
// ec2-server.js at /briefing/watch-report behind the same auth gate as the
// dashboard, so the link rides the same ?k= capability token.
function buildWatchReportUrl({
  dataDir,
  date,
  env = process.env,
  existsSync = fs.existsSync,
} = {}) {
  if (!dataDir || !date) return '';
  try {
    if (!existsSync(watchReportArtifactPath(dataDir, date))) return '';
  } catch {
    return '';
  }
  const dashBase = String(
    env.BRIEFING_PUBLIC_BASE_URL || 'http://ExampleCo:3001/briefing',
  ).replace(/\/+$/, '');
  return buildBriefingDashboardUrl(
    `${dashBase}/watch-report?date=${String(date).slice(0, 10)}`,
    env.SB_BRIEFING_TOKEN || '',
  );
}

function briefingNotifyKind(stateOrClean) {
  const state =
    typeof stateOrClean === 'boolean' ? (stateOrClean ? 'clean' : 'blocked') : stateOrClean;
  return state === 'blocked' ? 'briefing-blocked' : 'briefing-link';
}

async function notifyBriefingPublishedUnlocked({
  dataDir,
  date,
  artifact,
  phase = 'current',
  refresh = null,
  url = '',
  send,
  now = () => new Date(),
} = {}) {
  const instant = now();
  const status = briefingBoardStatus({ artifact, date, nowMs: instant.getTime(), refresh });
  const state = notificationState(status, phase);
  const markerFile = briefingNotifyMarkerPath(dataDir, date);
  const prior = readMarker(dataDir, date);

  if (prior && prior.state === state && prior.status === 'sent') {
    return {
      status: 'skipped-duplicate',
      state,
      sentAt: prior.sentAt || null,
      transition: false,
      marker: markerFile,
      board: status,
    };
  }

  const transition = Boolean(
    state === 'clean' && prior && prior.state !== 'clean' && prior.status === 'sent',
  );
  loadBriefingNotifyEnv(dataDir);
  const watchReportUrl = buildWatchReportUrl({ dataDir, date });
  const text = buildBriefingNotifyText({ status, phase, url, transition, watchReportUrl });
  const ts = instant.toISOString();
  let outcome;
  try {
    const result = await send({
      text,
      kind: briefingNotifyKind(state),
      source: 'briefing-status',
      priority: 'normal',
      dedup: false,
    });
    if (result && result.ok && !result.suppressed && result.channel === 'telegram') {
      outcome = { status: 'sent', sentAt: ts, channel: 'telegram' };
    } else if (result && result.suppressed) {
      outcome = { status: 'suppressed', reason: String(result.reason || 'suppressed') };
    } else {
      outcome = {
        status: 'failed',
        reason:
          result && result.channel === 'fallback'
            ? 'telegram-send-failed-queued-to-fallback'
            : 'send-not-delivered',
      };
    }
  } catch (e) {
    outcome = { status: 'failed', reason: String((e && e.message) || e).slice(0, 200) };
  }
  if (outcome.status !== 'sent') {
    console.warn(
      `[briefing-notify] not delivered for ${date} (${state}): ${outcome.status} ${outcome.reason || ''}`,
    );
  }

  writeMarker(dataDir, date, {
    date,
    phase,
    state,
    green: status.green ?? null,
    total: status.total ?? null,
    artifactTs: status.artifactTs || null,
    transition,
    updatedAt: ts,
    ...outcome,
    previous: prior
      ? { state: prior.state, status: prior.status, sentAt: prior.sentAt || null }
      : null,
  });
  return { ...outcome, state, transition, marker: markerFile, board: status };
}

async function notifyBriefingPublished(args = {}) {
  let lease;
  try {
    lease = acquireBriefingNotifyLease(args.dataDir, args.date);
  } catch (error) {
    return {
      status: 'failed',
      state: 'unavailable',
      reason: `notify-lease-error: ${String((error && error.message) || error).slice(0, 160)}`,
      marker: briefingNotifyMarkerPath(args.dataDir, args.date),
    };
  }
  if (!lease) {
    return {
      status: 'skipped-inflight',
      state: 'inflight',
      transition: false,
      marker: briefingNotifyMarkerPath(args.dataDir, args.date),
    };
  }
  try {
    return await notifyBriefingPublishedUnlocked(args);
  } finally {
    releaseBriefingNotifyLease(lease);
  }
}

function refreshLiveBoard({ dataDir, date, timeoutMs = 55000 } = {}) {
  const verifier = path.resolve(__dirname, '..', 'verify-dashboard-cards-live.js');
  const result = spawnSync(
    process.execPath,
    [verifier, '--date', date, '--write-artifact', '--data-dir', dataDir],
    {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, SECONDBRAIN_DATA_DIR: dataDir },
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  // Exit 0 = clean and exit 1 = verified defects. Both wrote authoritative
  // artifact state. Exit 2/timeout/spawn failure means truth is unavailable.
  const verified = result.status === 0 || result.status === 1;
  return {
    verified,
    status: result.status,
    reason: verified ? null : result.error ? 'refresh-error' : `refresh-exit-${result.status}`,
  };
}

function parseArgs(argv) {
  const opts = { phase: 'current', refresh: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--data-dir') opts.dataDir = argv[++i];
    else if (arg === '--phase') opts.phase = argv[++i];
    else if (arg === '--refresh-artifact') opts.refresh = true;
    else if (arg === '--url') opts.url = argv[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.date || !opts.dataDir || !['current', 'final'].includes(opts.phase)) {
    console.error(
      'Usage: briefing-notify.js --date YYYY-MM-DD --data-dir DIR --phase current|final [--refresh-artifact]',
    );
    process.exitCode = 2;
    return;
  }
  loadBriefingNotifyEnv(opts.dataDir);
  const refresh = opts.refresh ? refreshLiveBoard(opts) : null;
  const envelope = readLiveBoardArtifact({ dataDir: opts.dataDir });
  const url =
    opts.url ||
    buildBriefingDashboardUrl(
      process.env.BRIEFING_PUBLIC_BASE_URL || 'http://ExampleCo:3001/briefing',
      process.env.SB_BRIEFING_TOKEN || '',
    );
  const result = await notifyBriefingPublished({
    dataDir: opts.dataDir,
    date: opts.date,
    artifact: envelope.artifact,
    phase: opts.phase,
    refresh,
    url,
    send: notifyWithFallback,
  });
  console.log(JSON.stringify(result));
  if (result.status === 'failed' || result.status === 'suppressed') process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `[briefing-notify] failed internally: ${String((error && error.message) || error).slice(0, 200)}`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  notifyBriefingPublished,
  buildBriefingNotifyText,
  buildWatchReportUrl,
  watchReportArtifactPath,
  briefingBoardStatus,
  notificationState,
  briefingNotifyKind,
  refreshLiveBoard,
  parseArgs,
  loadBriefingNotifyEnv,
  briefingNotifyMarkerPath,
  acquireBriefingNotifyLease,
  releaseBriefingNotifyLease,
};
