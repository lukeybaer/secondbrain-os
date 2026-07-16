#!/usr/bin/env node
/**
 * collect-codex-token-usage.js
 *
 * 2026-05-25 ExampleCo flagged twice on Otter: the token usage card must show
 * percent-of-weekly-subscription burned for both Codex and Claude Code.
 *
 * The right Codex source is its own rollout files. Each Codex Desktop /
 * CLI session at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl writes
 * `event_msg` lines of type "token_count" whose payload.rate_limits
 * ExampleCos the authoritative subscription burn from OpenAI itself:
 *
 *   rate_limits.primary   = 5-hour window  (used_percent, resets_at, window_minutes:300)
 *   rate_limits.secondary = 7-day window   (used_percent, resets_at, window_minutes:10080)
 *
 * The last `token_count` event in the most recent rollout is the freshest
 * known burn %. We also sum per-turn `last_token_usage` across the last
 * 7 days for a tokens-billed figure that complements the percent.
 *
 * Writes data/agent/codex-token-usage-week.json:
 *
 *   {
 *     window: { start, end, days },
 *     plan: "pro" | "plus" | ...,
 *     weekly_used_percent: 13,                    // <-- authoritative
 *     weekly_resets_at: "2026-05-30T14:27:46Z",
 *     five_hour_used_percent: 0,
 *     five_hour_resets_at: "2026-05-23T14:48:11Z",
 *     weekly_input_tokens, weekly_output_tokens,  // approximate, billed-not-cached
 *     sessions, files_scanned,
 *     latest_event_at, generated_at
 *   }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ctDateKey, writeProviderReceipt } = require('./lib/token-usage-receipts.js');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const HOME = process.env.USERPROFILE || os.homedir();
const SESSIONS_ROOT = process.env.CODEX_SESSIONS_DIR || path.join(HOME, '.codex', 'sessions');
const DATA_DIR = process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data');
const OUT_PATH = path.join(
  DATA_DIR,
  'agent',
  'codex-token-usage-week.json',
);

function listRolloutFilesInWindow(startDate, endDate) {
  const out = [];
  if (!fs.existsSync(SESSIONS_ROOT)) return out;
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    const yyyy = String(cursor.getUTCFullYear());
    const mm = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(cursor.getUTCDate()).padStart(2, '0');
    const dayDir = path.join(SESSIONS_ROOT, yyyy, mm, dd);
    if (fs.existsSync(dayDir)) {
      for (const fname of fs.readdirSync(dayDir)) {
        if (fname.startsWith('rollout-') && fname.endsWith('.jsonl')) {
          const full = path.join(dayDir, fname);
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch {}
          out.push({ date: `${yyyy}-${mm}-${dd}`, full, mtime });
        }
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

// Walk a rollout file and return:
//   - latest token_count event's rate_limits + total_token_usage
//   - sum of last_token_usage (billed input = input - cached, plus output)
function scanRollout(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { return null; }
  let latest = null;
  let billedInput = 0;
  let outputTokens = 0;
  let turnEvents = 0;
  let latestTs = '';
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes('"token_count"')) continue;
    let obj;
    try { obj = JSON.parse(line); }
    catch { continue; }
    if (!obj || obj.type !== 'event_msg' || !obj.payload || obj.payload.type !== 'token_count') continue;
    const info = obj.payload.info || {};
    const last = info.last_token_usage || {};
    const rate = obj.payload.rate_limits || {};
    if (typeof last.input_tokens === 'number') {
      const cached = Number(last.cached_input_tokens || 0);
      billedInput += Math.max(0, Number(last.input_tokens) - cached);
      outputTokens += Number(last.output_tokens || 0);
      turnEvents += 1;
    }
    latest = {
      total_token_usage: info.total_token_usage || null,
      last_token_usage: last,
      rate_limits: rate,
      ts: obj.timestamp || '',
      model_context_window: info.model_context_window || null,
    };
    if (obj.timestamp && obj.timestamp > latestTs) latestTs = obj.timestamp;
  }
  return latest ? { latest, billedInput, outputTokens, turnEvents, latestTs } : null;
}

function main() {
  const argDays = (() => {
    const i = process.argv.indexOf('--days');
    return i >= 0 ? parseInt(process.argv[i + 1], 10) : 7;
  })();
  const days = Number.isFinite(argDays) && argDays > 0 ? argDays : 7;
  const clock = process.env.CODEX_USAGE_NOW ? new Date(process.env.CODEX_USAGE_NOW) : new Date();
  const end = Number.isNaN(clock.getTime()) ? new Date() : new Date(clock);
  end.setUTCHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  start.setUTCHours(0, 0, 0, 0);

  const files = listRolloutFilesInWindow(start, end);
  let weeklyBilledInput = 0;
  let weeklyOutput = 0;
  let sessionsCount = 0;
  let mostRecentScan = null;
  let mostRecentTs = '';
  for (const f of files) {
    const s = scanRollout(f.full);
    if (!s) continue;
    sessionsCount += 1;
    weeklyBilledInput += s.billedInput;
    weeklyOutput += s.outputTokens;
    if (s.latestTs > mostRecentTs) {
      mostRecentTs = s.latestTs;
      mostRecentScan = s;
    }
  }

  const rate = (mostRecentScan && mostRecentScan.latest.rate_limits) || {};
  const windows = [rate.primary, rate.secondary].filter(Boolean);
  const weeklyWindow =
    windows.find((w) => Number(w.window_minutes) === 10080) || rate.secondary || {};
  const fiveHourWindow =
    windows.find((w) => Number(w.window_minutes) === 300) ||
    (rate.primary && rate.primary.window_minutes == null ? rate.primary : {});
  const report = {
    window: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), days },
    plan: rate.plan_type || null,
    weekly_used_percent:
      typeof weeklyWindow.used_percent === 'number' ? weeklyWindow.used_percent : null,
    weekly_window_minutes: weeklyWindow.window_minutes || null,
    weekly_resets_at: weeklyWindow.resets_at
      ? new Date(Number(weeklyWindow.resets_at) * 1000).toISOString()
      : null,
    five_hour_used_percent:
      typeof fiveHourWindow.used_percent === 'number' ? fiveHourWindow.used_percent : null,
    five_hour_resets_at: fiveHourWindow.resets_at
      ? new Date(Number(fiveHourWindow.resets_at) * 1000).toISOString()
      : null,
    weekly_input_tokens: weeklyBilledInput,
    weekly_output_tokens: weeklyOutput,
    sessions: sessionsCount,
    files_scanned: files.length,
    latest_event_at: mostRecentTs || null,
    generated_at: new Date().toISOString(),
    source: SESSIONS_ROOT,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  writeProviderReceipt({
    dataDir: DATA_DIR,
    date: process.env.TOKEN_USAGE_RECEIPT_DATE || ctDateKey(end),
    provider: 'codex',
    observedAt: report.generated_at,
    status: typeof report.weekly_used_percent === 'number' ? 'clean' : 'blocked',
    source: SESSIONS_ROOT,
    payload: report,
    defect:
      typeof report.weekly_used_percent === 'number'
        ? null
        : {
            code: 'unsupported_field',
            detail: 'No weekly Codex rate-limit percentage was present in the scanned rollouts.',
          },
  });
  console.log(`[collect-codex-token-usage] wrote ${OUT_PATH}`);
  console.log(`  window: ${report.window.start} to ${report.window.end} (${days}d)`);
  console.log(`  plan: ${report.plan}`);
  console.log(`  weekly_used_percent: ${report.weekly_used_percent}%  (resets ${report.weekly_resets_at})`);
  console.log(`  five_hour_used_percent: ${report.five_hour_used_percent}%  (resets ${report.five_hour_resets_at})`);
  console.log(`  weekly_billed_input_tokens: ${weeklyBilledInput.toLocaleString()}`);
  console.log(`  weekly_output_tokens: ${weeklyOutput.toLocaleString()}`);
  console.log(`  sessions: ${sessionsCount} of ${files.length} rollout files`);
}

if (require.main === module) main();

module.exports = { scanRollout, listRolloutFilesInWindow };
