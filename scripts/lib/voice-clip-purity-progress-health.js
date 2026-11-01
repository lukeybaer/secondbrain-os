'use strict';

// TWO-VOICE CLIP CHECK PROGRESS (owner decision): "make a metric so that
// process finishes eventually - a card for its progress too - and if it stops
// progressing flag it red."
//
// scripts/voice-clip-purity-index.js appends one line per saved batch to
// life-archive/voiceprints/voice-clip-purity-progress.jsonl with how many
// clips are still waiting. This reader turns those lines into percent done,
// the measured rate over the past day, a finish estimate, and a verdict:
//   green   nothing left, or the backlog is shrinking fast enough to finish
//   green   also when a run landed within STALL_HOURS but no rate is measurable
//           yet (the board maps yellow to red, so a moving check never reads yellow)
//   red     no record, no run within STALE_HOURS, remaining not falling over
//           the trailing STALL_HOURS, or the finish estimate is past MAX_ETA_DAYS
// A clip whose check failed counts as remaining until a retry succeeds.

const fs = require('fs');
const { purityProgressPath } = require('./voice-clip-purity');

const HOUR = 3_600_000;
// Runs come every 3 hours; one missed slot is tolerated, two are not.
const STALE_HOURS = 7;
// The rate is measured over the past day.
const WINDOW_HOURS = 24;
// A stall needs at least this much history, so one slot that met a burst of
// new calls is not called a stall.
const STALL_HOURS = 6;
// The backlog must finish inside a month at the measured rate.
const MAX_ETA_DAYS = 30;

function readProgressLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { lines: [], missing: true };
    throw error;
  }
  const lines = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const row = JSON.parse(raw);
      const ms = Date.parse(row.at);
      if (Number.isFinite(ms) && Number.isFinite(row.remaining) && Number.isFinite(row.candidates)) {
        lines.push({ ...row, ms });
      }
    } catch {
      // A torn last line from a killed run is skipped; the next save repairs it.
    }
  }
  lines.sort((a, b) => a.ms - b.ms);
  return { lines, missing: false };
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const hours = (ms) => `${Math.round(ms / HOUR)} hour${Math.round(ms / HOUR) === 1 ? '' : 's'}`;

function readVoiceClipPurityProgressHealth({ dataDir, nowMs = Date.now() } = {}) {
  let read;
  try {
    read = readProgressLines(purityProgressPath(dataDir));
  } catch (error) {
    return red(`progress log unreadable: ${String(error?.message || error).slice(0, 200)}.`);
  }
  const { lines } = read;
  if (!lines.length) {
    return red('no progress record yet; the two-voice check has not logged a run.');
  }
  const last = lines[lines.length - 1];
  const checked = Math.max(0, last.candidates - last.remaining);
  const percent = last.candidates ? (100 * checked) / last.candidates : 100;
  const base = {
    remaining: last.remaining,
    candidates: last.candidates,
    checked,
    percent: Math.round(percent * 10) / 10,
    mixed: last.mixed ?? null,
    last_at: last.at,
  };
  const mixedText =
    (last.mixed != null ? `; ${fmt(last.mixed)} two-voice clips found` : '') +
    (last.errors ? `; ${fmt(last.errors)} failed checks waiting to retry` : '');
  const doneText = `${base.percent}% checked (${fmt(checked)} of ${fmt(last.candidates)})`;

  if (last.ms > nowMs + 5 * 60_000) {
    return { ...red(`newest progress record is dated in the future (${last.at}).`), ...base };
  }
  const age = nowMs - last.ms;
  if (age > STALE_HOURS * HOUR) {
    return {
      ...red(`stalled: no two-voice check run in ${hours(age)} (last ${last.at}); ${doneText}, ${fmt(last.remaining)} left.`),
      ...base,
    };
  }
  if (last.remaining === 0) {
    return { status: 'green', detail: `all ${fmt(last.candidates)} clips checked${mixedText}.`, problems: [], ...base, eta_days: 0 };
  }

  const window = lines.filter((l) => l.ms >= last.ms - WINDOW_HOURS * HOUR);
  const first = window[0];
  const span = last.ms - first.ms;
  if (span < STALL_HOURS * HOUR) {
    if (lines.length === 1 || span < 2 * HOUR) {
      // Moving means a run inside the stall window. Older than that with no
      // second run is no progress for STALL_HOURS, which is red.
      if (age > STALL_HOURS * HOUR) {
        return {
          ...red(`stalled: only one run measured and it is ${hours(age)} old; ${doneText}, ${fmt(last.remaining)} left.`),
          ...base,
        };
      }
      return onPace(base, last);
    }
  }
  // A stall is judged on the trailing flat stretch, so a good morning cannot
  // hide an afternoon with no progress.
  let flatFrom = lines.length - 1;
  while (flatFrom > 0 && lines[flatFrom - 1].remaining <= last.remaining) flatFrom -= 1;
  const flat = last.ms - lines[flatFrom].ms;
  if (flat >= STALL_HOURS * HOUR) {
    return {
      ...red(`stalled: ${fmt(last.remaining)} clips left, no fewer than ${hours(flat)} ago; ${doneText}.`),
      ...base,
      rate_per_day: 0,
    };
  }
  const drop = first.remaining - last.remaining;
  const perDay = (drop * 24 * HOUR) / Math.max(span, 1);
  if (drop <= 0) {
    // A window of STALL_HOURS or more that has not shrunk is not progress, even
    // when the last step went down (a wobbling, growing backlog). Only a window
    // too short to judge stays provisionally green.
    if (span >= STALL_HOURS * HOUR) {
      return {
        ...red(`not shrinking: ${fmt(last.remaining)} clips left, up from ${fmt(first.remaining)} ${hours(span)} ago; ${doneText}.`),
        ...base,
        rate_per_day: 0,
      };
    }
    return { ...onPace(base, last), rate_per_day: 0 };
  }
  const etaDays = last.remaining / perDay;
  const etaText = etaDays < 1 ? 'under a day' : `about ${Math.ceil(etaDays)} day${Math.ceil(etaDays) === 1 ? '' : 's'}`;
  const rateText = `${fmt(perDay)} a day`;
  if (etaDays > MAX_ETA_DAYS) {
    return {
      ...red(`too slow to finish: ${fmt(last.remaining)} left at ${rateText} is ${etaText}, past the ${MAX_ETA_DAYS} day limit; ${doneText}.`),
      ...base,
      rate_per_day: Math.round(perDay),
      eta_days: Math.round(etaDays * 10) / 10,
    };
  }
  return {
    status: 'green',
    detail: `${doneText}; ${fmt(last.remaining)} left, ${etaText} at ${rateText}${mixedText}.`,
    problems: [],
    ...base,
    rate_per_day: Math.round(perDay),
    eta_days: Math.round(etaDays * 10) / 10,
  };
}

// Progress is recent but no finish rate is measurable yet: green, never yellow
// (the board maps yellow to red).
function onPace(base, last) {
  const detail =
    `${base.percent}% done, on pace (${fmt(base.checked)} of ${fmt(base.candidates)} clips` +
    (last.mixed != null ? `, ${fmt(last.mixed)} mixed found` : '') +
    (last.errors ? `, ${fmt(last.errors)} failed checks waiting to retry` : '') +
    ')';
  return { status: 'green', detail, problems: [], ...base };
}

function red(detail) {
  return { status: 'red', detail, problems: [detail] };
}

module.exports = {
  readVoiceClipPurityProgressHealth,
  STALE_HOURS,
  STALL_HOURS,
  WINDOW_HOURS,
  MAX_ETA_DAYS,
};
