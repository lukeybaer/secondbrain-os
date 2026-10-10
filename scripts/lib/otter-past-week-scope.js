'use strict';

const fs = require('fs');
const path = require('path');

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function dateCtFromMs(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function callDateCt(call) {
  for (const value of [
    call?.date,
    call?.start_time,
    call?.created_at,
    call?.meeting_date,
    call?.modified_at,
  ]) {
    if (value == null || value === '') continue;
    const direct = String(value)
      .trim()
      .match(/^(\d{4}-\d{2}-\d{2})/);
    if (direct) return direct[1];
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      const day = dateCtFromMs(numeric < 1e12 ? numeric * 1000 : numeric);
      if (day) return day;
    }
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return dateCtFromMs(parsed);
  }
  return null;
}

function resolveOtterPastWeekWindow(last7) {
  const startDate = String(last7?.start_date || '').slice(0, 10);
  const endDate = String(last7?.end_date || '').slice(0, 10);
  if (!ISO_DAY.test(startDate) || !ISO_DAY.test(endDate)) {
    return { ok: false, reason: 'rolling seven-day coverage window is missing or malformed' };
  }
  if (startDate > endDate) {
    return { ok: false, reason: 'rolling seven-day coverage window is reversed' };
  }
  const spanDays = Math.round(
    (Date.parse(`${endDate}T12:00:00Z`) - Date.parse(`${startDate}T12:00:00Z`)) / 86400000,
  );
  if (spanDays !== 6) {
    return {
      ok: false,
      reason: `rolling coverage window spans ${spanDays + 1} days instead of 7`,
    };
  }
  return { ok: true, startDate, endDate };
}

function callOtid(call) {
  return String(call?.otid || call?.id || call?.call_id || call?.conversation_id || '').trim();
}

function timestampMs(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function callsInOtterPastWeek(calls, window) {
  if (!window?.ok) return [];
  return (Array.isArray(calls) ? calls : []).filter((call) => {
    const day = callDateCt(call);
    return day && day >= window.startDate && day <= window.endDate;
  });
}

function readJson(file, fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function otterPastWeekInventory({ dataDir, window, expectedCount = null, fsApi = fs } = {}) {
  if (!window?.ok) throw new Error(window?.reason || 'rolling seven-day window is unresolved');
  const rawDir = path.join(String(dataDir || ''), 'otter', 'raw');
  const enrichedDir = path.join(String(dataDir || ''), 'otter', 'enriched');
  if (!fsApi.existsSync(rawDir)) {
    throw new Error(`Otter raw inventory is missing: ${rawDir}`);
  }
  const enrichedOtids = new Set(
    fsApi.existsSync(enrichedDir)
      ? fsApi
          .readdirSync(enrichedDir)
          .filter((value) => value.endsWith('.json'))
          .map((value) => path.basename(value, '.json'))
      : [],
  );
  // Do not rediscover a seven-day cohort by parsing every lifetime transcript.
  // The ingest index, current roster, and coverage blockers are independent,
  // bounded indexes. Their union must contain at least the coverage producer's
  // reported denominator or the healer fails closed instead of falling back to
  // a 2GB+ archive scan. A larger union can mean the current indexes advanced
  // before the coverage report. Admit it only when the independent ingest and
  // roster indexes both prove every call, so this source cycle can rebuild the
  // trailing denominator without accepting one-index corruption.
  const candidates = new Map();
  const candidateSources = new Map();
  const ingestEvidence = new Map();
  const add = (row, explicitDate = '', source = '') => {
    const otid = callOtid(row);
    const date = explicitDate || callDateCt(row);
    if (!otid || !date || date < window.startDate || date > window.endDate) return;
    candidates.set(otid, { otid, date, enriched: enrichedOtids.has(otid) });
    if (source) {
      const sources = candidateSources.get(otid) || new Set();
      sources.add(source);
      candidateSources.set(otid, sources);
    }
  };
  // Ingest entries with no end time and no date field (an unfinalized stub)
  // still prove the call exists; the roster supplies the date. An ingest date
  // that disagrees with the roster is not treated as corroboration.
  const undatedIngestOtids = new Set();
  const seen = readJson(path.join(String(dataDir || ''), 'agent', 'otter-ingest-seen.json'), fsApi);
  for (const entry of Array.isArray(seen?.entries) ? seen.entries : []) {
    const endSeconds = Number(entry?.end_time || entry?.ended_at || 0);
    const durationSeconds = Number(entry?.duration_sec || entry?.duration || 0);
    const startSeconds = endSeconds > 0 ? Math.max(0, endSeconds - durationSeconds) : 0;
    const ingestDate = startSeconds > 0 ? callDateCt({ start_time: startSeconds }) : '';
    if (!ingestDate && !callDateCt(entry) && callOtid(entry)) undatedIngestOtids.add(callOtid(entry));
    add(entry, ingestDate, 'ingest');
    const otid = callOtid(entry);
    if (candidates.has(otid)) {
      ingestEvidence.set(otid, {
        finalized: entry?.finalized === true,
        endedAtMs: timestampMs(entry?.end_time || entry?.ended_at),
      });
    }
  }
  const rosters = readJson(
    path.join(
      String(dataDir || ''),
      'life-archive',
      'voiceprints',
      'otter-call-speaker-rosters-latest.json',
    ),
    fsApi,
  );
  for (const call of Array.isArray(rosters?.calls) ? rosters.calls : []) add(call, '', 'roster');
  const coverage = readJson(
    path.join(
      String(dataDir || ''),
      'life-archive',
      'voiceprints',
      'otter-text-audio-coverage-latest.json',
    ),
    fsApi,
  );
  const excludedCoverageIds = new Set(
    [
      ...(Array.isArray(coverage?.last_7_days?.excluded_processing_grace)
        ? coverage.last_7_days.excluded_processing_grace
        : []),
      ...(Array.isArray(coverage?.last_7_days?.excluded_non_speech)
        ? coverage.last_7_days.excluded_non_speech
        : []),
      ...(Array.isArray(coverage?.last_7_days?.excluded_empty_noise)
        ? coverage.last_7_days.excluded_empty_noise
        : []),
    ]
      .map((row) => callOtid(row))
      .filter(Boolean),
  );
  for (const call of Array.isArray(coverage?.missing_audio) ? coverage.missing_audio : [])
    add(call, '', 'coverage');
  for (const blocker of Array.isArray(coverage?.last_7_days?.blockers)
    ? coverage.last_7_days.blockers
    : []) {
    for (const example of Array.isArray(blocker?.examples) ? blocker.examples : [])
      add(example, '', 'coverage');
  }
  for (const otid of excludedCoverageIds) {
    candidates.delete(otid);
    candidateSources.delete(otid);
  }
  const calls = [...candidates.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.otid.localeCompare(b.otid),
  );
  const isCorroborated = (otid) => {
    const sources = candidateSources.get(otid);
    return Boolean(
      sources?.has('roster') && (sources.has('ingest') || undatedIngestOtids.has(otid)),
    );
  };
  const corroboratedCallCount = calls.filter((call) => isCorroborated(call.otid)).length;
  const coverageGeneratedAtMs = timestampMs(coverage?.generated_at);
  // The coverage receipt owns expectedCount. A roster generated_at can come
  // from an unrelated exact-call merge and is not a whole-cohort freshness
  // boundary. Let a finalized post-coverage ingest enter the bounded scope so
  // the roster producer can process it instead of requiring its own output as
  // an input prerequisite.
  const aheadCallsProven =
    corroboratedCallCount === calls.length ||
    (Number.isFinite(coverageGeneratedAtMs) &&
      corroboratedCallCount >= expectedCount &&
      calls.every((call) => {
        if (isCorroborated(call.otid)) return true;
        const evidence = ingestEvidence.get(call.otid);
        return evidence?.finalized === true && evidence.endedAtMs > coverageGeneratedAtMs;
      }));
  if (
    Number.isInteger(expectedCount) &&
    expectedCount >= 0 &&
    (calls.length < expectedCount ||
      (calls.length > expectedCount && !aheadCallsProven))
  ) {
    throw new Error(
      `bounded Otter indexes identify ${calls.length}/${expectedCount} calls in ${window.startDate} through ${window.endDate}`,
    );
  }
  return {
    calls,
    otids: [...new Set(calls.map((call) => call.otid).filter(Boolean))],
    missingEnrichedOtids: calls.filter((call) => !call.enriched).map((call) => call.otid),
  };
}

module.exports = {
  callDateCt,
  callOtid,
  callsInOtterPastWeek,
  resolveOtterPastWeekWindow,
  otterPastWeekInventory,
};
