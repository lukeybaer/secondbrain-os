'use strict';

// scripts/lib/jev-budget.js
//
// Shared aggregate spend caps for the authorized Jev decision lanes:
// auth-jev-speaker-naming (ExampleCo 2026-09-18) and the typed decision control
// plane (ExampleCo 2026-09-19/20). $3 per America/Chicago day and $60 per month
// unless the owner changes them. Admission runs BEFORE provider contact and fails closed:
// an unreadable ledger or an over-cap estimate refuses the call.

const fs = require('node:fs');
const path = require('node:path');
const { costUsd, JEV_MODEL, jevErrorDetail } = require('./jev-client.js');

const DEFAULT_DAILY_CAP_USD = 3;
const DEFAULT_MONTHLY_CAP_USD = 60;
const SPEAKER_DAILY_RESERVE_USD = 0.5;
const SPEAKER_MONTHLY_RESERVE_USD = 5;
const OUTREACH_DAILY_RESERVE_USD = 0.5;
const OUTREACH_MONTHLY_RESERVE_USD = 10;

function ctDay(date) {
  // en-CA renders YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(date);
}

function defaultJevLedger(root = path.resolve(__dirname, '..', '..')) {
  const dataDir = process.env.SECONDBRAIN_DATA_DIR || path.join(root, 'data');
  return path.join(dataDir, 'agent', 'jev-spend.jsonl');
}

function capsFromEnv(env = process.env) {
  const daily = Number(env.JEV_DAILY_CAP_USD);
  const monthly = Number(env.JEV_MONTHLY_CAP_USD);
  return {
    dailyCapUsd: Number.isFinite(daily) && daily > 0 ? daily : DEFAULT_DAILY_CAP_USD,
    monthlyCapUsd: Number.isFinite(monthly) && monthly > 0 ? monthly : DEFAULT_MONTHLY_CAP_USD,
  };
}

function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function spendSoFar(rows, now = new Date()) {
  const day = ctDay(now);
  const month = day.slice(0, 7);
  let dayUsd = 0;
  let monthUsd = 0;
  for (const row of rows) {
    const usd = Number(row.usd || 0);
    const rowDay = String(row.day || '');
    if (!rowDay) continue;
    if (rowDay === day) dayUsd += usd;
    if (rowDay.slice(0, 7) === month) monthUsd += usd;
  }
  return { day, dayUsd, monthUsd };
}

function admitJevSpend({
  estimatedTokens,
  ledgerFile = defaultJevLedger(),
  now = new Date(),
  caps = capsFromEnv(),
  lane = 'decision-control',
  surface = '',
} = {}) {
  // list-filtering is a read-compatible alias for receipts and callers shipped
  // before the broader owner authorization was implemented.
  if (!['speaker-naming', 'decision-control', 'list-filtering'].includes(lane)) {
    return { ok: false, reason: `unknown_jev_lane:${lane}` };
  }
  let rows;
  try {
    rows = readLedger(ledgerFile);
  } catch (error) {
    return { ok: false, reason: `ledger_unreadable: ${error.message}` };
  }
  const { dayUsd, monthUsd } = spendSoFar(rows, now);
  const estimateUsd = costUsd(estimatedTokens);
  const controlLane = lane !== 'speaker-naming';
  const dailyAvailable = controlLane
    ? Math.max(0, caps.dailyCapUsd - SPEAKER_DAILY_RESERVE_USD)
    : caps.dailyCapUsd;
  const monthlyAvailable = controlLane
    ? Math.max(0, caps.monthlyCapUsd - SPEAKER_MONTHLY_RESERVE_USD)
    : caps.monthlyCapUsd;
  const effectBearing = String(surface || '').startsWith('external-outreach-approval');
  const laneDailyAvailable = controlLane && !effectBearing
    ? Math.max(0, dailyAvailable - OUTREACH_DAILY_RESERVE_USD)
    : dailyAvailable;
  const laneMonthlyAvailable = controlLane && !effectBearing
    ? Math.max(0, monthlyAvailable - OUTREACH_MONTHLY_RESERVE_USD)
    : monthlyAvailable;
  if (dayUsd + estimateUsd > laneDailyAvailable) {
    return { ok: false, reason: `daily_cap $${laneDailyAvailable} reached for ${lane} ($${dayUsd.toFixed(4)} aggregate spent)` };
  }
  if (monthUsd + estimateUsd > laneMonthlyAvailable) {
    return {
      ok: false,
      reason: `monthly_cap $${laneMonthlyAvailable} reached for ${lane} ($${monthUsd.toFixed(4)} aggregate spent)`,
    };
  }
  return { ok: true, dayUsd, monthUsd, estimateUsd };
}

function recordJevSpend({
  ledgerFile = defaultJevLedger(),
  surface,
  inputTokens = 0,
  latencyMs = null,
  outcome = 'answered',
  model = JEV_MODEL,
  now = new Date(),
  error = null,
} = {}) {
  const row = {
    ts: now.toISOString(),
    day: ctDay(now),
    surface: surface || 'unknown',
    model,
    outcome,
    inputTokens: Number(inputTokens || 0),
    usd: outcome === 'answered' ? costUsd(inputTokens) : 0,
    latencyMs,
  };
  if (error) {
    if (Number(error.status)) row.httpStatus = Number(error.status);
    const detail = jevErrorDetail(error);
    if (detail) row.errorDetail = detail;
  }
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.appendFileSync(ledgerFile, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

module.exports = {
  DEFAULT_DAILY_CAP_USD,
  DEFAULT_MONTHLY_CAP_USD,
  SPEAKER_DAILY_RESERVE_USD,
  SPEAKER_MONTHLY_RESERVE_USD,
  OUTREACH_DAILY_RESERVE_USD,
  OUTREACH_MONTHLY_RESERVE_USD,
  admitJevSpend,
  recordJevSpend,
  spendSoFar,
  readLedger,
  defaultJevLedger,
  capsFromEnv,
  ctDay,
};
