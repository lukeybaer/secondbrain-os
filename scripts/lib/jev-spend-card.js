'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_DAILY_CAP_USD,
  DEFAULT_MONTHLY_CAP_USD,
  capsFromEnv,
  ctDay,
  defaultJevLedger,
} = require('./jev-budget.js');

const TITLE = 'JEV SPEND';
const WINDOWS = [
  { key: 'past24h', label: 'Last 24h', milliseconds: 24 * 60 * 60 * 1000 },
  { key: 'past72h', label: 'Last 72h', milliseconds: 72 * 60 * 60 * 1000 },
  { key: 'past30d', label: 'Last 30d', milliseconds: 30 * 24 * 60 * 60 * 1000 },
];

function money(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function ctTimestamp(date) {
  const instant = new Date(date);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(instant);
  return `${ctDay(instant)} ${time} CT`;
}

function nextIsoDay(day) {
  const noon = new Date(`${day}T12:00:00.000Z`);
  noon.setUTCDate(noon.getUTCDate() + 1);
  return noon.toISOString().slice(0, 10);
}

function briefingDateMatchesReader(date, now) {
  if (!date) return true;
  const currentDay = ctDay(new Date(now));
  if (date === currentDay) return true;
  const hourParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const hour = Number(hourParts.find((part) => part.type === 'hour')?.value);
  return hour === 23 && date === nextIsoDay(currentDay);
}

function summarizeRows(rows) {
  return {
    usd: rows.reduce((sum, row) => sum + row.usd, 0),
    decisions: rows.length,
    chargedCalls: rows.filter((row) => row.usd > 0).length,
  };
}

function readStrictLedger(ledgerFile) {
  if (!fs.existsSync(ledgerFile)) {
    return { ok: false, reason: `Jev spend ledger is missing: ${path.basename(ledgerFile)}` };
  }
  let text;
  try {
    text = fs.readFileSync(ledgerFile, 'utf8');
  } catch (error) {
    return { ok: false, reason: 'Jev spend ledger is unreadable.' };
  }
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, reason: `Jev spend ledger line ${index + 1} is invalid JSON.` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: `Jev spend ledger line ${index + 1} must be a JSON object.` };
    }
    const timestampMs = Date.parse(String(parsed.ts || ''));
    const usd = parsed.usd;
    if (!Number.isFinite(timestampMs) || typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
      return {
        ok: false,
        reason: `Jev spend ledger line ${index + 1} is missing a valid timestamp or nonnegative USD amount.`,
      };
    }
    const derivedDay = ctDay(new Date(timestampMs));
    if (parsed.day && String(parsed.day) !== derivedDay) {
      return {
        ok: false,
        reason: `Jev spend ledger line ${index + 1} has a Central-day value that disagrees with its timestamp.`,
      };
    }
    rows.push({
      ...parsed,
      timestampMs,
      usd,
      day: derivedDay,
    });
  }
  return { ok: true, rows };
}

function readJevSpendSnapshot({
  dataDir,
  ledgerFile = dataDir
    ? path.join(dataDir, 'agent', 'jev-spend.jsonl')
    : defaultJevLedger(),
  now = new Date(),
  caps = capsFromEnv(),
} = {}) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) {
    return { available: false, reason: 'Jev spend snapshot received an invalid clock.' };
  }
  const ledger = readStrictLedger(ledgerFile);
  if (!ledger.ok) return { available: false, reason: ledger.reason, ledgerFile };
  if (ledger.rows.length === 0) {
    return {
      available: false,
      reason: 'Jev spend ledger contains no historical rows, so producer coverage is unproven.',
      ledgerFile,
    };
  }
  const future = ledger.rows.find((row) => row.timestampMs > nowMs + 5 * 60 * 1000);
  if (future) {
    return {
      available: false,
      reason: `Jev spend ledger contains a future-dated row (${ctTimestamp(new Date(future.timestampMs))}).`,
      ledgerFile,
    };
  }
  // Include rows inside the bounded clock-skew tolerance instead of silently
  // dropping real spend written by a host whose clock is seconds ahead.
  const clampedRows = ledger.rows.filter((row) => row.timestampMs > nowMs);
  const eligibleRows = ledger.rows.map((row) => ({
    ...row,
    timestampMs: Math.min(row.timestampMs, nowMs),
    // A tolerated future timestamp may cross Central midnight. Charge it to
    // the reader's current cap window after clamping, not tomorrow's window.
    day: ctDay(new Date(Math.min(row.timestampMs, nowMs))),
  }));
  const windows = Object.fromEntries(
    WINDOWS.map((window) => [
      window.key,
      summarizeRows(eligibleRows.filter((row) => row.timestampMs >= nowMs - window.milliseconds)),
    ]),
  );
  const currentDay = ctDay(new Date(nowMs));
  const currentMonth = currentDay.slice(0, 7);
  const day = summarizeRows(eligibleRows.filter((row) => row.day === currentDay));
  const month = summarizeRows(
    eligibleRows.filter((row) => String(row.day || '').slice(0, 7) === currentMonth),
  );
  const requestedDailyCap = Number(caps.dailyCapUsd);
  const requestedMonthlyCap = Number(caps.monthlyCapUsd);
  const dailyCapUsd = Number.isFinite(requestedDailyCap) && requestedDailyCap >= 0
    ? requestedDailyCap
    : DEFAULT_DAILY_CAP_USD;
  const monthlyCapUsd = Number.isFinite(requestedMonthlyCap) && requestedMonthlyCap >= 0
    ? requestedMonthlyCap
    : DEFAULT_MONTHLY_CAP_USD;
  return {
    available: true,
    ledgerFile,
    generatedAt: new Date(nowMs).toISOString(),
    clampedClockSkew: {
      rows: clampedRows.length,
      maxSeconds: clampedRows.length
        ? Math.ceil(Math.max(...clampedRows.map((row) => row.timestampMs - nowMs)) / 1000)
        : 0,
    },
    newestAt: eligibleRows.length
      ? new Date(eligibleRows.reduce(
          (latest, row) => Math.max(latest, row.timestampMs),
          Number.NEGATIVE_INFINITY,
        )).toISOString()
      : null,
    windows,
    currentDay: { label: currentDay, ...day, capUsd: dailyCapUsd },
    currentMonth: { label: currentMonth, ...month, capUsd: monthlyCapUsd },
    overCap: day.usd > dailyCapUsd || month.usd > monthlyCapUsd,
    coverage: windows.past30d.decisions === 0
      ? 'Canonical append-only ledger read successfully; no Jev decisions were recorded in the last 30 days.'
      : `Canonical append-only ledger read successfully; ${windows.past30d.decisions} decision${windows.past30d.decisions === 1 ? '' : 's'} recorded in the last 30 days.`,
  };
}

function renderJevSpendBody(snapshot) {
  if (!snapshot || !snapshot.available) {
    const refreshed = snapshot?.generatedAt
      ? ctTimestamp(snapshot.generatedAt)
      : 'unavailable';
    return `Data refreshed: ${refreshed}\nJev spend unavailable. Status: RED - ${String(snapshot?.reason || 'unknown ledger error')}`;
  }
  const lines = [`Data refreshed: ${ctTimestamp(snapshot.generatedAt)}`];
  for (const window of WINDOWS) {
    const value = snapshot.windows[window.key];
    lines.push(
      `${window.label}: ${money(value.usd)} across ${value.chargedCalls} charged call${value.chargedCalls === 1 ? '' : 's'} (${value.decisions} recorded decision${value.decisions === 1 ? '' : 's'}).`,
    );
  }
  lines.push(
    `Current CT day (${snapshot.currentDay.label}): ${money(snapshot.currentDay.usd)} of ${money(snapshot.currentDay.capUsd)} aggregate cap.`,
  );
  lines.push(
    `Current CT month (${snapshot.currentMonth.label}): ${money(snapshot.currentMonth.usd)} of ${money(snapshot.currentMonth.capUsd)} aggregate cap.`,
  );
  lines.push('Aggregate caps source: JEV_DAILY_CAP_USD/JEV_MONTHLY_CAP_USD resolved by scripts/lib/jev-budget.js in the EC2 briefing runtime.');
  lines.push(`Coverage: ${snapshot.coverage}`);
  lines.push(`Status: ${snapshot.overCap ? 'RED - aggregate Jev cap exceeded.' : 'Within aggregate Jev caps.'}`);
  if (snapshot.clampedClockSkew?.rows > 0) {
    lines.push(
      `Clock skew noted: ${snapshot.clampedClockSkew.rows} ledger row${snapshot.clampedClockSkew.rows === 1 ? '' : 's'} clamped to the reader clock (maximum ${snapshot.clampedClockSkew.maxSeconds}s ahead).`,
    );
  }
  lines.push(
    snapshot.newestAt
      ? `Newest ledger entry: ${ctTimestamp(snapshot.newestAt)}`
      : 'Newest ledger entry: none recorded.',
  );
  return lines.join('\n');
}

function parseJevSpendBody(body) {
  const text = String(body || '');
  const unavailable = text.match(/Jev spend unavailable\.\s*Status:\s*RED\s*-\s*([^\n]+)/i);
  if (unavailable) {
    return {
      kind: 'jevSpend',
      available: false,
      reason: unavailable[1].trim(),
      refreshed: ((text.match(/Data refreshed:\s*(.*?)(?=\s+Jev spend unavailable\.)/is) || [])[1] || '').trim(),
    };
  }
  const windows = [];
  for (const expected of WINDOWS) {
    const label = expected.label.replace('Last ', '');
    const match = text.match(
      new RegExp(
        `Last\\s+${label}:\\s*\\$([\\d.]+)\\s+across\\s+(\\d+)\\s+charged calls?\\s*\\((\\d+)\\s+recorded decisions?\\)`,
        'i',
      ),
    );
    if (!match) {
      return {
        kind: 'jevSpend',
        available: false,
        reason: `Rendered Jev spend card is missing the Last ${label} window.`,
      };
    }
    const usd = Number(match[1]);
    const chargedCalls = Number(match[2]);
    const decisions = Number(match[3]);
    if (![usd, chargedCalls, decisions].every(Number.isFinite)) {
      return {
        kind: 'jevSpend',
        available: false,
        reason: `Rendered Jev spend card has invalid numbers in the Last ${label} window.`,
      };
    }
    windows.push({ key: label.toLowerCase(), label: `Last ${label}`, usd, chargedCalls, decisions });
  }
  const day = text.match(
    /Current CT day\s*\((\d{4}-\d{2}-\d{2})\):\s*\$([\d.]+)\s+of\s+\$([\d.]+)\s+aggregate cap/i,
  );
  const month = text.match(
    /Current CT month\s*\((\d{4}-\d{2})\):\s*\$([\d.]+)\s+of\s+\$([\d.]+)\s+aggregate cap/i,
  );
  if (!day || !month) {
    return {
      kind: 'jevSpend',
      available: false,
      reason: 'Rendered Jev spend card is missing a current Central cap window.',
    };
  }
  const currentDay = { label: day[1], usd: Number(day[2]), capUsd: Number(day[3]) };
  const currentMonth = { label: month[1], usd: Number(month[2]), capUsd: Number(month[3]) };
  if (![currentDay.usd, currentDay.capUsd, currentMonth.usd, currentMonth.capUsd].every(Number.isFinite)) {
    return { kind: 'jevSpend', available: false, reason: 'Rendered Jev cap usage is invalid.' };
  }
  const displayedDelta = Math.max(
    currentDay.usd - currentDay.capUsd,
    currentMonth.usd - currentMonth.capUsd,
  );
  const statusRed = /Status:\s*RED/i.test(text);
  // The body displays four decimals while the ledger verdict uses full
  // precision. Treat the rendered status as authoritative inside half of one
  // display unit, but reject contradictions large enough to be visible.
  const displayTolerance = 0.00005;
  if ((!statusRed && displayedDelta > displayTolerance) ||
      (statusRed && displayedDelta < -displayTolerance)) {
    return {
      kind: 'jevSpend',
      available: false,
      reason: 'Rendered Jev cap status contradicts the displayed cap totals.',
    };
  }
  return {
    kind: 'jevSpend',
    available: true,
    windows,
    currentDay,
    currentMonth,
    overCap: statusRed,
    refreshed: ((text.match(/Data refreshed:\s*(.*?)(?=\s+Last 24h:)/is) || [])[1] || '').trim(),
    newestAt: ((text.match(/Newest ledger entry:\s*([^\n]*)/i) || [])[1] || '').trim(),
    coverage: ((text.match(/Coverage:\s*(.*?)(?=\s+Status:)/is) || [])[1] || '').trim(),
    capSource: ((text.match(/Aggregate caps source:\s*(.*?)(?=\s+Coverage:)/is) || [])[1] || '').trim(),
    clockSkew: ((text.match(/Clock skew noted:\s*(.*?)(?=\s+Newest ledger entry:)/is) || [])[1] || '').trim(),
  };
}

function buildJevSpendCard({ dataDir, date, now = new Date(), ledgerFile, caps } = {}) {
  const currentDay = ctDay(new Date(now));
  const snapshot = !briefingDateMatchesReader(date, now)
    ? {
        available: false,
        reason: `Jev spend cannot render current rolling windows into briefing date ${date}; reader date is ${currentDay}.`,
      }
    : readJevSpendSnapshot({ dataDir, now, ledgerFile, caps });
  if (!snapshot.generatedAt) snapshot.generatedAt = new Date(now).toISOString();
  const body = renderJevSpendBody(snapshot);
  return {
    title: TITLE,
    body,
    markdown: `${TITLE}:\n${body}`,
    snapshot,
    status: snapshot.available && !snapshot.overCap ? 'clean' : 'blocked',
  };
}

module.exports = {
  TITLE,
  WINDOWS,
  buildJevSpendCard,
  briefingDateMatchesReader,
  money,
  parseJevSpendBody,
  readJevSpendSnapshot,
  readStrictLedger,
  renderJevSpendBody,
  summarizeRows,
};
