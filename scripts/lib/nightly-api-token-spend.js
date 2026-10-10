'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NIGHTLY_API_TOKEN_LIMIT_USD = 2;

function previousIsoDate(isoDate) {
  const [year, month, day] = String(isoDate || '')
    .split('-')
    .map(Number);
  const value = new Date(Date.UTC(year || 1970, (month || 1) - 1, (day || 1) - 1, 12));
  return value.toISOString().slice(0, 10);
}

function shiftIsoDate(isoDate, days) {
  const [year, month, day] = String(isoDate || '')
    .split('-')
    .map(Number);
  return new Date(Date.UTC(year || 1970, (month || 1) - 1, (day || 1) + days, 12))
    .toISOString()
    .slice(0, 10);
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function trimmedNonemptyString(value) {
  return typeof value === 'string' && value === value.trim() && value.length > 0;
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/,
  );
  if (!match) return false;
  const [, year, month, day, hour, minute, second, millisecond = '000'] = match;
  const parsed = new Date(Date.parse(value));
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day) &&
    parsed.getUTCHours() === Number(hour) &&
    parsed.getUTCMinutes() === Number(minute) &&
    parsed.getUTCSeconds() === Number(second) &&
    parsed.getUTCMilliseconds() === Number(millisecond)
  );
}

function completeSealedRow(row) {
  return Boolean(
    row &&
      row.sealVersion === 1 &&
      row.source === 'nightly-reporting-seal' &&
      validIsoTimestamp(row.sealedAt) &&
      typeof row.proofComplete === 'boolean' &&
      nonNegativeNumber(row.openaiSpentUsd) &&
      nonNegativeInteger(row.openaiCalls) &&
      nonNegativeNumber(row.bedrockSpentUsd) &&
      nonNegativeInteger(row.bedrockCalls) &&
      nonNegativeInteger(row.unsettledReservations) &&
      /^[0-9a-f]{64}$/.test(String(row.bedrockProofHash || '')),
  );
}

function validateSpendLedger(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (raw.night !== undefined && !validIsoDate(raw.night)) {
    return false;
  }
  for (const key of ['spentUsd', 'nightSpentUsd']) {
    if (raw[key] !== undefined && !nonNegativeNumber(raw[key])) return false;
  }
  for (const key of ['calls', 'nightCalls']) {
    if (raw[key] !== undefined && !nonNegativeInteger(raw[key])) return false;
  }
  if (raw.nightHistory !== undefined) {
    if (
      !raw.nightHistory ||
      typeof raw.nightHistory !== 'object' ||
      Array.isArray(raw.nightHistory)
    ) {
      return false;
    }
    for (const [night, row] of Object.entries(raw.nightHistory)) {
      if (!validIsoDate(night) || !row || typeof row !== 'object' || Array.isArray(row)) {
        return false;
      }
      if (!nonNegativeNumber(row.spentUsd) || !nonNegativeInteger(row.calls)) return false;
      for (const key of ['openaiSpentUsd', 'bedrockSpentUsd']) {
        if (row[key] !== undefined && !nonNegativeNumber(row[key])) return false;
      }
      for (const key of ['openaiCalls', 'bedrockCalls', 'unsettledReservations']) {
        if (row[key] !== undefined && !nonNegativeInteger(row[key])) return false;
      }
      if (row.proofComplete !== undefined && typeof row.proofComplete !== 'boolean') return false;
      if (row.sealedAt !== undefined && !validIsoTimestamp(row.sealedAt)) {
        return false;
      }
      if (row.sealVersion !== undefined && row.sealVersion !== 1) return false;
      if (row.source !== undefined && typeof row.source !== 'string') return false;
      if (
        row.bedrockProofHash !== undefined &&
        !/^[0-9a-f]{64}$/.test(String(row.bedrockProofHash))
      ) {
        return false;
      }
      const hasProviderBreakdown =
        row.openaiSpentUsd !== undefined ||
        row.bedrockSpentUsd !== undefined ||
        row.openaiCalls !== undefined ||
        row.bedrockCalls !== undefined;
      if (hasProviderBreakdown) {
        if (
          !nonNegativeNumber(row.openaiSpentUsd) ||
          !nonNegativeNumber(row.bedrockSpentUsd) ||
          !nonNegativeInteger(row.openaiCalls) ||
          !nonNegativeInteger(row.bedrockCalls)
        ) {
          return false;
        }
        if (Math.abs(row.spentUsd - row.openaiSpentUsd - row.bedrockSpentUsd) > 0.00001) {
          return false;
        }
        if (row.calls !== row.openaiCalls + row.bedrockCalls) return false;
      }
      if (row.proofComplete === true && Number(row.unsettledReservations || 0) !== 0) return false;
      if (
        row.source === 'nightly-reporting-seal' &&
        !/^[0-9a-f]{64}$/.test(String(row.bedrockProofHash || ''))
      ) {
        return false;
      }
    }
  }
  return true;
}

function readBedrockNightUsage({ dataDir, night } = {}) {
  const file = path.join(String(dataDir || ''), 'agent', 'briefing-api-fallback-usage.jsonl');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        ok: true,
        file,
        spentUsd: 0,
        calls: 0,
        reservations: 0,
        unsettledReservations: 0,
        proofHash: crypto.createHash('sha256').update('').digest('hex'),
      };
    }
    return { ok: false, file, reason: 'bedrock-usage-ledger-unreadable' };
  }
  const allRows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return { ok: false, file, reason: 'bedrock-usage-ledger-unreadable' };
    }
    if (
      !row ||
      typeof row !== 'object' ||
      row.schema !== 'briefing_api_fallback_usage.v1' ||
      !['reservation', 'settlement'].includes(row.kind) ||
      !validIsoDate(row.night) ||
      !trimmedNonemptyString(row.reservationId) ||
      !trimmedNonemptyString(row.authorizationId) ||
      !validIsoTimestamp(row.createdAt)
    ) {
      return { ok: false, file, reason: 'bedrock-usage-ledger-unreadable' };
    }
    if (row.kind === 'reservation' && !nonNegativeNumber(row.reservedUsd)) {
      return { ok: false, file, reason: 'bedrock-usage-ledger-unreadable' };
    }
    if (
      row.kind === 'settlement' &&
      (!trimmedNonemptyString(row.model) ||
        !nonNegativeNumber(row.estimatedUsd) ||
        !nonNegativeInteger(row.inputTokens) ||
        !nonNegativeInteger(row.outputTokens))
    ) {
      return { ok: false, file, reason: 'bedrock-usage-ledger-unreadable' };
    }
    allRows.push(row);
  }
  const allReservations = allRows.filter((row) => row.kind === 'reservation');
  const allSettlements = allRows.filter((row) => row.kind === 'settlement');
  const allReservationById = new Map();
  for (const row of allReservations) {
    if (allReservationById.has(row.reservationId)) {
      return { ok: false, file, reason: 'bedrock-usage-ledger-unreadable' };
    }
    allReservationById.set(row.reservationId, row);
  }
  const allSettledIds = new Set();
  for (const row of allSettlements) {
    if (allSettledIds.has(row.reservationId)) {
      return { ok: false, file, reason: 'bedrock-usage-ledger-unreadable' };
    }
    allSettledIds.add(row.reservationId);
    const reservation = allReservationById.get(row.reservationId);
    if (
      !reservation ||
      reservation.authorizationId !== row.authorizationId ||
      reservation.night !== row.night
    ) {
      return { ok: false, file, reason: 'bedrock-usage-ledger-unreadable' };
    }
  }
  const rows = allRows.filter((row) => row.night === night);
  const reservations = rows.filter((row) => row.kind === 'reservation');
  const settlements = rows.filter((row) => row.kind === 'settlement');
  const settledIds = new Set();
  for (const row of settlements) {
    if (settledIds.has(row.reservationId)) {
      return { ok: false, file, reason: 'bedrock-usage-ledger-unreadable' };
    }
    settledIds.add(row.reservationId);
  }
  const spentUsd = settlements.reduce((sum, row) => sum + row.estimatedUsd, 0);
  const proofHash = crypto
    .createHash('sha256')
    .update(rows.map((row) => JSON.stringify(row)).join('\n'))
    .digest('hex');
  return {
    ok: true,
    file,
    spentUsd: Math.round(spentUsd * 10000) / 10000,
    calls: settlements.length,
    reservations: reservations.length,
    unsettledReservations: reservations.filter((row) => !settledIds.has(row.reservationId)).length,
    proofHash,
  };
}

// This is a reporting receipt, not model authorization. The central paid-call
// gate records every charged success as it happens; morning finalization seals
// the completed CT night so zero charged calls become explicit proof instead
// of an absent ledger row. Corrupt state stays red and is never overwritten.
function sealNightlyApiTokenSpend({ dataDir, briefingDate, now = new Date() } = {}) {
  const night = previousIsoDate(briefingDate);
  const file = path.join(String(dataDir || ''), 'agent', 'openai-api-spend.json');
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      return { ok: false, night, file, reason: 'ledger-unreadable' };
    }
  }
  if (!validateSpendLedger(raw)) return { ok: false, night, file, reason: 'ledger-unreadable' };
  const bedrock = readBedrockNightUsage({ dataDir, night });
  if (!bedrock.ok) return { ok: false, night, file, reason: bedrock.reason };
  const history =
    raw.nightHistory && typeof raw.nightHistory === 'object' && !Array.isArray(raw.nightHistory)
      ? { ...raw.nightHistory }
      : {};
  const currentMatches = String(raw.night || '') === night;
  const existing = history[night] && typeof history[night] === 'object' ? history[night] : null;
  const openaiSpentUsd = currentMatches
    ? Number(raw.nightSpentUsd || 0)
    : Number(existing && (existing.openaiSpentUsd ?? existing.spentUsd)) || 0;
  const openaiCalls = currentMatches
    ? Number(raw.nightCalls || 0)
    : Number(existing && (existing.openaiCalls ?? existing.calls)) || 0;
  const spentUsd = Math.round((openaiSpentUsd + bedrock.spentUsd) * 10000) / 10000;
  const calls = openaiCalls + bedrock.calls;
  const sealedAt = new Date(now).toISOString();
  history[night] = {
    ...(existing || {}),
    sealVersion: 1,
    spentUsd,
    calls,
    openaiSpentUsd,
    openaiCalls,
    bedrockSpentUsd: bedrock.spentUsd,
    bedrockCalls: bedrock.calls,
    bedrockProofHash: bedrock.proofHash,
    unsettledReservations: bedrock.unsettledReservations,
    proofComplete: bedrock.unsettledReservations === 0,
    sealedAt,
    source: 'nightly-reporting-seal',
  };
  const next = {
    ...raw,
    night,
    nightSpentUsd: openaiSpentUsd,
    nightCalls: openaiCalls,
    nightHistory: history,
    lastNightlySeal: { night, sealedAt },
    updatedAt: sealedAt,
  };
  try {
    writeJsonAtomic(file, next);
  } catch (error) {
    return {
      ok: false,
      night,
      file,
      reason: 'ledger-write-failed',
      error: String((error && error.message) || error).slice(0, 300),
    };
  }
  return {
    ok: bedrock.unsettledReservations === 0,
    night,
    spentUsd,
    calls,
    file,
    sealedAt,
    bedrock,
    ...(bedrock.unsettledReservations ? { reason: 'api-settlement-incomplete' } : {}),
  };
}

function spendHistorySummary(raw, night) {
  const history =
    raw &&
    raw.nightHistory &&
    typeof raw.nightHistory === 'object' &&
    !Array.isArray(raw.nightHistory)
      ? { ...raw.nightHistory }
      : {};
  const sum = (keys) =>
    keys.reduce(
      (result, key) => {
        const row = history[key];
        if (!completeSealedRow(row) || row.proofComplete === false) {
          return result;
        }
        result.spentUsd += row.spentUsd;
        result.calls += row.calls;
        result.nightsRecorded += 1;
        return result;
      },
      { spentUsd: 0, calls: 0, nightsRecorded: 0 },
    );
  const weeklyKeys = Array.from({ length: 7 }, (_, index) => shiftIsoDate(night, -index));
  const monthPrefix = `${String(night).slice(0, 7)}-`;
  const monthlyKeys = Object.keys(history).filter(
    (key) => key.startsWith(monthPrefix) && key <= night,
  );
  return {
    weekly: sum(weeklyKeys),
    monthly: sum(monthlyKeys),
  };
}

function readNightlyApiTokenSpend({ dataDir, briefingDate, limitUsd } = {}) {
  const limit = Number.isFinite(Number(limitUsd)) ? Number(limitUsd) : NIGHTLY_API_TOKEN_LIMIT_USD;
  const night = previousIsoDate(briefingDate);
  const file = path.join(String(dataDir || ''), 'agent', 'openai-api-spend.json');
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        available: false,
        night,
        spentUsd: null,
        calls: null,
        limitUsd: limit,
        overLimit: true,
        sourceState: 'same-night-proof-missing',
        file,
      };
    }
    return {
      available: false,
      night,
      spentUsd: null,
      calls: null,
      limitUsd: limit,
      overLimit: true,
      sourceState: 'ledger-unreadable',
      file,
    };
  }

  if (!validateSpendLedger(raw)) {
    return {
      available: false,
      night,
      spentUsd: null,
      calls: null,
      limitUsd: limit,
      overLimit: true,
      sourceState: 'ledger-unreadable',
      file,
    };
  }

  const history = spendHistorySummary(raw, night);
  const sealed = raw.nightHistory && raw.nightHistory[night];
  if (!sealed || !sealed.sealedAt) {
    return {
      available: false,
      night,
      spentUsd: null,
      calls: null,
      limitUsd: limit,
      overLimit: true,
      sourceState: 'same-night-proof-missing',
      recordedNight: String(raw && raw.night ? raw.night : ''),
      weeklySpentUsd: history.weekly.spentUsd,
      weeklyCalls: history.weekly.calls,
      weeklyNightsRecorded: history.weekly.nightsRecorded,
      monthlySpentUsd: history.monthly.spentUsd,
      monthlyCalls: history.monthly.calls,
      monthlyNightsRecorded: history.monthly.nightsRecorded,
      file,
    };
  }
  if (!completeSealedRow(sealed)) {
    return {
      available: false,
      night,
      spentUsd: null,
      calls: null,
      limitUsd: limit,
      overLimit: true,
      sourceState: 'same-night-proof-incomplete',
      weeklySpentUsd: history.weekly.spentUsd,
      weeklyCalls: history.weekly.calls,
      weeklyNightsRecorded: history.weekly.nightsRecorded,
      monthlySpentUsd: history.monthly.spentUsd,
      monthlyCalls: history.monthly.calls,
      monthlyNightsRecorded: history.monthly.nightsRecorded,
      file,
    };
  }
  const bedrock = readBedrockNightUsage({ dataDir, night });
  if (!bedrock.ok || bedrock.proofHash !== sealed.bedrockProofHash) {
    return {
      available: false,
      night,
      spentUsd: null,
      calls: null,
      limitUsd: limit,
      overLimit: true,
      sourceState: bedrock.ok ? 'api-provider-proof-changed' : 'ledger-unreadable',
      weeklySpentUsd: history.weekly.spentUsd,
      weeklyCalls: history.weekly.calls,
      weeklyNightsRecorded: history.weekly.nightsRecorded,
      monthlySpentUsd: history.monthly.spentUsd,
      monthlyCalls: history.monthly.calls,
      monthlyNightsRecorded: history.monthly.nightsRecorded,
      file,
    };
  }
  const spentUsd = sealed.spentUsd;
  const calls = sealed.calls;
  if (sealed.proofComplete === false) {
    return {
      available: false,
      night,
      spentUsd,
      calls,
      limitUsd: limit,
      overLimit: true,
      sourceState: 'api-settlement-incomplete',
      unsettledReservations: sealed.unsettledReservations || 0,
      openaiSpentUsd: sealed.openaiSpentUsd || 0,
      bedrockSpentUsd: sealed.bedrockSpentUsd || 0,
      weeklySpentUsd: history.weekly.spentUsd,
      weeklyCalls: history.weekly.calls,
      weeklyNightsRecorded: history.weekly.nightsRecorded,
      monthlySpentUsd: history.monthly.spentUsd,
      monthlyCalls: history.monthly.calls,
      monthlyNightsRecorded: history.monthly.nightsRecorded,
      file,
    };
  }
  return {
    available: true,
    night,
    spentUsd,
    calls,
    limitUsd: limit,
    overLimit: spentUsd > limit,
    sourceState: 'ledger-entry',
    openaiSpentUsd: sealed.openaiSpentUsd || 0,
    openaiCalls: sealed.openaiCalls || 0,
    bedrockSpentUsd: sealed.bedrockSpentUsd || 0,
    bedrockCalls: sealed.bedrockCalls || 0,
    weeklySpentUsd: history.weekly.spentUsd,
    weeklyCalls: history.weekly.calls,
    weeklyNightsRecorded: history.weekly.nightsRecorded,
    monthlySpentUsd: history.monthly.spentUsd,
    monthlyCalls: history.monthly.calls,
    monthlyNightsRecorded: history.monthly.nightsRecorded,
    file,
  };
}

function formatHistory(spend) {
  const weeklySpent = Number(spend && spend.weeklySpentUsd) || 0;
  const weeklyCalls = Number(spend && spend.weeklyCalls) || 0;
  const weeklyNights = Number(spend && spend.weeklyNightsRecorded) || 0;
  const monthlySpent = Number(spend && spend.monthlySpentUsd) || 0;
  const monthlyCalls = Number(spend && spend.monthlyCalls) || 0;
  const monthlyNights = Number(spend && spend.monthlyNightsRecorded) || 0;
  return ` Recorded last 7 nights: $${weeklySpent.toFixed(2)} across ${weeklyCalls} charged calls (${weeklyNights}/7 nights recorded). Month to date: $${monthlySpent.toFixed(2)} across ${monthlyCalls} charged calls (${monthlyNights} nights recorded).`;
}

function formatNightlyApiTokenSpendLine(spend) {
  const night = String(spend && spend.night ? spend.night : 'unknown');
  const limit = Number(spend && spend.limitUsd) || NIGHTLY_API_TOKEN_LIMIT_USD;
  if (!spend || !spend.available) {
    const reason =
      spend && spend.sourceState === 'same-night-proof-missing'
        ? 'no same-night spend proof'
        : spend && spend.sourceState === 'same-night-proof-incomplete'
          ? 'same-night spend proof uses an incomplete or legacy seal'
        : spend && spend.sourceState === 'api-provider-proof-changed'
          ? 'paid-provider proof changed after the nightly seal'
        : spend && spend.sourceState === 'api-settlement-incomplete'
          ? `${Number(spend.unsettledReservations) || 0} paid API reservation(s) lack settlement proof`
          : 'spend ledger unreadable';
    return `Daily spend stats: API token spend unavailable for night ${night} against the $${limit.toFixed(2)} nightly limit. Status: RED - ${reason}.${formatHistory(spend)}`;
  }
  const spent = Number(spend.spentUsd) || 0;
  const calls = Number(spend.calls) || 0;
  const verdict = spend.overLimit ? 'RED - over nightly limit' : 'within limit';
  return `Daily spend stats: API token spend $${spent.toFixed(2)} of $${limit.toFixed(2)} nightly limit (${calls} charged call${calls === 1 ? '' : 's'}, night ${night}). Status: ${verdict}.${formatHistory(spend)}`;
}

module.exports = {
  NIGHTLY_API_TOKEN_LIMIT_USD,
  previousIsoDate,
  shiftIsoDate,
  sealNightlyApiTokenSpend,
  spendHistorySummary,
  readNightlyApiTokenSpend,
  formatNightlyApiTokenSpendLine,
};
