'use strict';

const fs = require('fs');
const path = require('path');

const OTTER_DISPATCH_WINDOW_MS = 5 * 60 * 1000;
// Continuous ingest targets two minutes and may legally take up to five.
// Keep the settling budget aligned with that real producer cadence. The
// post-dispatch end-time fence below prevents a later recording from stealing
// the prompt while this bounded wait is open.
const OTTER_DISPATCH_RETRY_MS = 10 * 60 * 1000;
// A recording that missed the execution window by less than this is reported by
// name rather than as absence. It is never executed; it is only made visible,
// so an owner recording that lands slightly early cannot vanish without trace.
const NEAR_MISS_MS = 60 * 60 * 1000;
const OTTER_DISPATCH_POLL_MS = 20 * 1000;
const OTTER_DISPATCH_FUTURE_SKEW_MS = 5 * 1000;
const OTTER_OWNER_TIME_ZONE = 'America/Chicago';

function epochMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const zoneQualified = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)
    ? `${text}Z`
    : text;
  const parsed = Date.parse(zoneQualified);
  return Number.isFinite(parsed) ? parsed : null;
}

function zonedParts(epoch, timeZone = OTTER_OWNER_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return Object.fromEntries(
    formatter
      .formatToParts(new Date(epoch))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
}

function zonedLocalToEpoch(
  { year, month, day, hour, minute, second = 0 },
  timeZone = OTTER_OWNER_TIME_ZONE,
) {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  let guess = targetAsUtc;
  for (let index = 0; index < 4; index += 1) {
    const parts = zonedParts(guess, timeZone);
    const representedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0,
    );
    const adjustment = targetAsUtc - representedAsUtc;
    if (!adjustment) return guess;
    guess += adjustment;
  }
  const finalParts = zonedParts(guess, timeZone);
  if (
    finalParts.year !== year ||
    finalParts.month !== month ||
    finalParts.day !== day ||
    finalParts.hour !== hour ||
    finalParts.minute !== minute
  ) {
    throw new Error('owner-specified landing time is not a valid local time');
  }
  return guess;
}

function previousCalendarDate({ year, month, day }) {
  const previous = new Date(Date.UTC(year, month - 1, day) - 24 * 60 * 60 * 1000);
  return {
    year: previous.getUTCFullYear(),
    month: previous.getUTCMonth() + 1,
    day: previous.getUTCDate(),
  };
}

function parseOwnerSpecifiedLandingTime(
  prompt,
  promptAtMs = Date.now(),
  timeZone = OTTER_OWNER_TIME_ZONE,
) {
  const text = String(prompt || '');
  const match = text.match(
    /\blanded\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i,
  );
  if (!match) return null;
  const promptMs = epochMs(promptAtMs);
  if (!Number.isFinite(promptMs)) throw new Error('promptAtMs must be a valid timestamp');
  const rawHour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) {
    throw new Error('owner-specified landing time is invalid');
  }
  const isPm = /^p/i.test(match[3]);
  const hour = (rawHour % 12) + (isPm ? 12 : 0);
  const dateMatch = text.match(/\blanded\s+at\s+[^\n,;]*?\bon\s+(\d{4})-(\d{2})-(\d{2})\b/i);
  let date = dateMatch
    ? { year: Number(dateMatch[1]), month: Number(dateMatch[2]), day: Number(dateMatch[3]) }
    : zonedParts(promptMs, timeZone);
  let selectedMs = zonedLocalToEpoch({ ...date, hour, minute }, timeZone);
  if (!dateMatch && selectedMs > promptMs + OTTER_DISPATCH_FUTURE_SKEW_MS) {
    date = previousCalendarDate(date);
    selectedMs = zonedLocalToEpoch({ ...date, hour, minute }, timeZone);
  }
  if (selectedMs > promptMs + OTTER_DISPATCH_FUTURE_SKEW_MS) {
    throw new Error('owner-specified landing time cannot be in the future');
  }
  return {
    ms: selectedMs,
    iso: new Date(selectedMs).toISOString(),
    source: 'owner-specified-landing-minute',
    timeZone,
    matchedText: match[0],
  };
}

function parseOwnerSpecifiedRecordingEndTime(
  prompt,
  promptAtMs = Date.now(),
  timeZone = OTTER_OWNER_TIME_ZONE,
) {
  const text = String(prompt || '');
  const match = text.match(
    /\b(?:dropped|ended|finished)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i,
  );
  if (!match) return null;
  const promptMs = epochMs(promptAtMs);
  if (!Number.isFinite(promptMs)) throw new Error('promptAtMs must be a valid timestamp');
  const rawHour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) {
    throw new Error('owner-specified recording end time is invalid');
  }
  const isPm = /^p/i.test(match[3]);
  const hour = (rawHour % 12) + (isPm ? 12 : 0);
  const dateMatch = text.match(
    /\b(?:dropped|ended|finished)\s+at\s+[^\n,;]*?\bon\s+(\d{4})-(\d{2})-(\d{2})\b/i,
  );
  let date = dateMatch
    ? { year: Number(dateMatch[1]), month: Number(dateMatch[2]), day: Number(dateMatch[3]) }
    : zonedParts(promptMs, timeZone);
  let selectedMs = zonedLocalToEpoch({ ...date, hour, minute }, timeZone);
  if (!dateMatch && selectedMs > promptMs + OTTER_DISPATCH_FUTURE_SKEW_MS) {
    date = previousCalendarDate(date);
    selectedMs = zonedLocalToEpoch({ ...date, hour, minute }, timeZone);
  }
  if (selectedMs > promptMs + OTTER_DISPATCH_FUTURE_SKEW_MS) {
    throw new Error('owner-specified recording end time cannot be in the future');
  }
  return {
    ms: selectedMs,
    iso: new Date(selectedMs).toISOString(),
    source: 'owner-specified-recording-end-minute',
    timeZone,
    matchedText: match[0],
  };
}

function candidateTimes(raw = {}, stat = {}) {
  // Explicit fields mean "first available to Amy". File mtime is retained only
  // for diagnosis; selector authorization always requires an explicit source.
  const ingestedAtMs = epochMs(raw.ingested_at);
  const explicitLandedAtMs = epochMs(raw.landed_at);
  const landedAtMs =
    ingestedAtMs ??
    explicitLandedAtMs ??
    (Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null);
  const landingSource = Number.isFinite(ingestedAtMs)
    ? 'ingested_at'
    : Number.isFinite(explicitLandedAtMs)
      ? 'landed_at'
      : Number.isFinite(stat.mtimeMs)
        ? 'mtime'
        : null;
  const endTimeMs = epochMs(raw.end_time);
  const explicitEndedAtMs = epochMs(raw.ended_at);
  const endedAtMs = endTimeMs ?? explicitEndedAtMs ?? null;
  const endSource = Number.isFinite(endTimeMs)
    ? 'end_time'
    : Number.isFinite(explicitEndedAtMs)
      ? 'ended_at'
      : null;
  const startTimeMs = epochMs(raw.start_time) ?? epochMs(raw.created_at);
  const startSource = Number.isFinite(epochMs(raw.start_time))
    ? 'start_time'
    : Number.isFinite(epochMs(raw.created_at))
      ? 'created_at'
      : null;
  const durationSeconds = Number(raw.duration_sec ?? raw.duration);
  const durationEndedAtMs =
    Number.isFinite(startTimeMs) && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? startTimeMs + durationSeconds * 1000
      : null;
  const durationEndSource = Number.isFinite(durationEndedAtMs)
    ? `${startSource}+${raw.duration_sec != null ? 'duration_sec' : 'duration'}`
    : null;
  return {
    landedAtMs,
    landingSource,
    endedAtMs,
    endSource,
    durationEndedAtMs,
    durationEndSource,
  };
}

const CANDIDATE_METADATA_KEYS = [
  'id',
  'otterId',
  'otid',
  'speech_id',
  'title',
  'ingested_at',
  'landed_at',
  'end_time',
  'ended_at',
  'created_at',
  'start_time',
  'duration_sec',
  'duration',
];
const CANDIDATE_FULL_PARSE_MAX_BYTES = 256 * 1024;
// Canonical otter-ingest-watch output writes selector metadata before the
// transcript and segment payloads. Otter raw files can still be tens of
// megabytes, so reading 96 KiB from both ends of every lifetime file turned one
// eligibility check into hundreds of megabytes of I/O. The representative
// large-file test pins that producer contract while bounding each candidate to
// 8 KiB per edge.
const CANDIDATE_EDGE_SCAN_BYTES = 8 * 1024;

function topLevelJsonScalar(text, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(
    new RegExp(
      `(?:^|\\r?\\n)\\s{2}"${escapedKey}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|-?\\d+(?:\\.\\d+)?|true|false|null)(?:,|\\r?$)`,
      'm',
    ),
  );
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

function readCandidateMetadata(file, stat) {
  if (Number(stat?.size || 0) <= CANDIDATE_FULL_PARSE_MAX_BYTES) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const fd = fs.openSync(file, 'r');
  try {
    const edgeBytes = Math.min(CANDIDATE_EDGE_SCAN_BYTES, stat.size);
    const head = Buffer.alloc(edgeBytes);
    const tail = Buffer.alloc(edgeBytes);
    fs.readSync(fd, head, 0, edgeBytes, 0);
    fs.readSync(fd, tail, 0, edgeBytes, Math.max(0, stat.size - edgeBytes));
    const edges = `${head.toString('utf8')}\n${tail.toString('utf8')}`;
    return Object.fromEntries(
      CANDIDATE_METADATA_KEYS.map((key) => [key, topLevelJsonScalar(edges, key)]).filter(
        ([, value]) => value !== undefined,
      ),
    );
  } finally {
    fs.closeSync(fd);
  }
}

function readCandidates(rawDir, { notBeforeMs: _notBeforeMs = null } = {}) {
  if (!fs.existsSync(rawDir)) return [];
  return fs
    .readdirSync(rawDir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((name) => {
      const file = path.join(rawDir, name);
      try {
        return { file, name, stat: fs.statSync(file) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map(({ file, name, stat }) => {
      try {
        const raw = readCandidateMetadata(file, stat);
        return {
          file,
          id: String(raw.id || raw.otterId || raw.otid || raw.speech_id || name),
          title: String(raw.title || name),
          ...candidateTimes(raw, stat),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function selectRecentOtterTranscript({
  candidates = [],
  dispatchAtMs = Date.now(),
  observedAtMs = dispatchAtMs,
  currentTimeMs = Date.now(),
  windowMs = OTTER_DISPATCH_WINDOW_MS,
  futureSkewMs = OTTER_DISPATCH_FUTURE_SKEW_MS,
} = {}) {
  const dispatchMs = epochMs(dispatchAtMs);
  const observedMs = epochMs(observedAtMs);
  const currentMs = epochMs(currentTimeMs);
  if (!Number.isFinite(dispatchMs)) throw new Error('dispatchAtMs must be a valid timestamp');
  if (!Number.isFinite(observedMs)) throw new Error('observedAtMs must be a valid timestamp');
  if (!Number.isFinite(currentMs)) throw new Error('currentTimeMs must be a valid timestamp');
  if (observedMs < dispatchMs) throw new Error('observedAtMs cannot precede dispatchAtMs');
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs must be positive');
  if (!Number.isFinite(futureSkewMs) || futureSkewMs < 0) {
    throw new Error('futureSkewMs must be non-negative');
  }
  if (dispatchMs > currentMs + futureSkewMs) {
    throw new Error('dispatchAtMs cannot be in the future');
  }
  if (observedMs > currentMs + futureSkewMs) {
    throw new Error('observedAtMs cannot be in the future');
  }
  if (observedMs > dispatchMs + OTTER_DISPATCH_RETRY_MS + futureSkewMs) {
    throw new Error('observedAtMs cannot exceed the retry deadline');
  }

  const ordered = candidates
    .filter(
      (candidate) =>
        Number.isFinite(candidate?.landedAtMs) &&
        typeof candidate?.id === 'string' &&
        candidate.id.trim().length > 0,
    )
    .sort((a, b) => b.landedAtMs - a.landedAtMs);
  if (!ordered.length) {
    return {
      eligible: false,
      executionAuthorized: false,
      noop: true,
      reason: 'no-transcripts',
      message: 'no recent transcript; nothing executed',
    };
  }

  const eligibleCandidates = ordered.filter((candidate) => {
    const landedBeforeOrAtDispatch = candidate.landedAtMs <= dispatchMs;
    const landedDuringRetry =
      candidate.landedAtMs > dispatchMs && candidate.landedAtMs <= observedMs;
    const hasExplicitEndProof =
      candidate.endSource === 'end_time' || candidate.endSource === 'ended_at';
    const recordingEndedBeforeDispatch =
      Number.isFinite(candidate.endedAtMs) &&
      candidate.endedAtMs <= dispatchMs &&
      hasExplicitEndProof;
    const hasExplicitLandingProof =
      candidate.landingSource === 'ingested_at' || candidate.landingSource === 'landed_at';
    return (
      candidate.landedAtMs >= dispatchMs - windowMs &&
      hasExplicitLandingProof &&
      (landedBeforeOrAtDispatch ||
        (landedDuringRetry && recordingEndedBeforeDispatch))
    );
  });
  if (!eligibleCandidates.length) {
    const newest = ordered[0];
    const ageMs = dispatchMs - newest.landedAtMs;
    // 2026-08-18: refusing to EXECUTE an out-of-window recording is correct and
    // stays correct. Reporting plain ABSENCE when one is sitting just outside
    // the boundary is not: ExampleCo's feedback note landed 7.2 minutes before his
    // dispatch, this branch said only "no recent transcript; nothing executed",
    // and every directive in it was silently lost. A near miss now names itself
    // so the caller surfaces it instead of concluding nothing was recorded.
    const nearMiss = ageMs >= 0 && ageMs <= NEAR_MISS_MS;
    const minutes = (ageMs / 60000).toFixed(1);
    return {
      eligible: false,
      executionAuthorized: false,
      noop: true,
      reason: 'no-recent-transcript',
      nearMiss,
      message: nearMiss
        ? `no recent transcript; nothing executed (near miss: ${newest.id} landed ${minutes} min before dispatch, outside the ${Math.round(windowMs / 60000)} min window; surface it to ExampleCo before concluding absence)`
        : 'no recent transcript; nothing executed',
      newest: {
        file: newest.file,
        id: newest.id,
        landedAt: new Date(newest.landedAtMs).toISOString(),
        ageMs,
      },
    };
  }

  const eligibleById = new Map();
  for (const candidate of eligibleCandidates) {
    if (!eligibleById.has(candidate.id)) eligibleById.set(candidate.id, candidate);
  }
  if (eligibleById.size > 1) {
    return {
      eligible: false,
      executionAuthorized: false,
      noop: true,
      reason: 'ambiguous-recent-transcripts',
      message: 'ambiguous recent transcripts; nothing executed',
      candidates: [...eligibleById.values()].map((candidate) => ({
        file: candidate.file,
        id: candidate.id,
        landedAt: new Date(candidate.landedAtMs).toISOString(),
      })),
    };
  }

  const recent = eligibleById.values().next().value;

  return {
    eligible: true,
    executionAuthorized: true,
    noop: false,
    reason: 'recent-transcript',
    transcript: {
      ...recent,
      landedAt: new Date(recent.landedAtMs).toISOString(),
      endedAt: Number.isFinite(recent.endedAtMs)
        ? new Date(recent.endedAtMs).toISOString()
        : null,
      ageMs: dispatchMs - recent.landedAtMs,
      observedAgeMs: observedMs - recent.landedAtMs,
      landedDuringRetry: recent.landedAtMs > dispatchMs,
    },
  };
}

function selectOtterTranscriptByLandingMinute({
  candidates = [],
  landedAtMs,
  currentTimeMs = Date.now(),
  futureSkewMs = OTTER_DISPATCH_FUTURE_SKEW_MS,
} = {}) {
  const specifiedMs = epochMs(landedAtMs);
  const currentMs = epochMs(currentTimeMs);
  if (!Number.isFinite(specifiedMs)) throw new Error('landedAtMs must be a valid timestamp');
  if (!Number.isFinite(currentMs)) throw new Error('currentTimeMs must be a valid timestamp');
  if (specifiedMs > currentMs + futureSkewMs) {
    throw new Error('owner-specified landing time cannot be in the future');
  }
  const minuteStartMs = Math.floor(specifiedMs / 60_000) * 60_000;
  const minuteEndMs = minuteStartMs + 60_000;
  const matching = candidates
    .filter(
      (candidate) =>
        Number.isFinite(candidate?.landedAtMs) &&
        candidate.landedAtMs >= minuteStartMs &&
        candidate.landedAtMs < minuteEndMs &&
        (candidate.landingSource === 'ingested_at' || candidate.landingSource === 'landed_at') &&
        typeof candidate?.id === 'string' &&
        candidate.id.trim().length > 0,
    )
    .sort((a, b) => b.landedAtMs - a.landedAtMs);
  const byId = new Map();
  for (const candidate of matching) {
    if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
  }
  const envelope = {
    selectionMode: 'owner-specified-landing-minute',
    specifiedLandingMinute: new Date(minuteStartMs).toISOString(),
  };
  if (!byId.size) {
    return {
      ...envelope,
      eligible: false,
      executionAuthorized: false,
      noop: true,
      reason: 'no-transcript-at-specified-time',
      message: 'no transcript at the owner-specified landing minute; nothing executed',
    };
  }
  if (byId.size > 1) {
    return {
      ...envelope,
      eligible: false,
      executionAuthorized: false,
      noop: true,
      reason: 'ambiguous-specified-transcripts',
      message: 'ambiguous transcripts at the owner-specified landing minute; nothing executed',
      candidates: [...byId.values()].map((candidate) => ({
        file: candidate.file,
        id: candidate.id,
        landedAt: new Date(candidate.landedAtMs).toISOString(),
      })),
    };
  }
  const selected = byId.values().next().value;
  return {
    ...envelope,
    eligible: true,
    executionAuthorized: true,
    noop: false,
    reason: 'owner-specified-transcript',
    transcript: {
      ...selected,
      landedAt: new Date(selected.landedAtMs).toISOString(),
      endedAt: Number.isFinite(selected.endedAtMs)
        ? new Date(selected.endedAtMs).toISOString()
        : null,
      ageMs: currentMs - selected.landedAtMs,
      landedDuringRetry: false,
    },
  };
}

function selectOtterTranscriptByRecordingEndMinute({
  candidates = [],
  endedAtMs,
  currentTimeMs = Date.now(),
  futureSkewMs = OTTER_DISPATCH_FUTURE_SKEW_MS,
} = {}) {
  const specifiedMs = epochMs(endedAtMs);
  const currentMs = epochMs(currentTimeMs);
  if (!Number.isFinite(specifiedMs)) throw new Error('endedAtMs must be a valid timestamp');
  if (!Number.isFinite(currentMs)) throw new Error('currentTimeMs must be a valid timestamp');
  if (specifiedMs > currentMs + futureSkewMs) {
    throw new Error('owner-specified recording end time cannot be in the future');
  }
  const minuteStartMs = Math.floor(specifiedMs / 60_000) * 60_000;
  const minuteEndMs = minuteStartMs + 60_000;
  const matching = [];
  for (const candidate of candidates) {
    if (typeof candidate?.id !== 'string' || !candidate.id.trim()) continue;
    const evidence = [
      {
        value: candidate.endedAtMs,
        source: candidate.endSource,
        allowed: candidate.endSource === 'end_time' || candidate.endSource === 'ended_at',
      },
      {
        value: candidate.durationEndedAtMs,
        source: candidate.durationEndSource,
        allowed:
          candidate.durationEndSource === 'start_time+duration_sec' ||
          candidate.durationEndSource === 'created_at+duration_sec' ||
          candidate.durationEndSource === 'start_time+duration' ||
          candidate.durationEndSource === 'created_at+duration',
      },
    ].filter(
      (row) =>
        row.allowed &&
        Number.isFinite(row.value) &&
        row.value >= minuteStartMs &&
        row.value < minuteEndMs,
    );
    if (!evidence.length) continue;
    matching.push({
      ...candidate,
      matchedRecordingEndMs: evidence[0].value,
      matchedRecordingEndSource: evidence[0].source,
    });
  }
  matching.sort((a, b) => b.matchedRecordingEndMs - a.matchedRecordingEndMs);
  const byId = new Map();
  for (const candidate of matching) {
    if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
  }
  const envelope = {
    selectionMode: 'owner-specified-recording-end-minute',
    specifiedRecordingEndMinute: new Date(minuteStartMs).toISOString(),
  };
  if (!byId.size) {
    return {
      ...envelope,
      eligible: false,
      executionAuthorized: false,
      noop: true,
      reason: 'no-transcript-ending-at-specified-time',
      message: 'no transcript ending at the owner-specified minute; nothing executed',
    };
  }
  if (byId.size > 1) {
    return {
      ...envelope,
      eligible: false,
      executionAuthorized: false,
      noop: true,
      reason: 'ambiguous-specified-recording-ends',
      message: 'ambiguous transcripts ending at the owner-specified minute; nothing executed',
      candidates: [...byId.values()].map((candidate) => ({
        file: candidate.file,
        id: candidate.id,
        recordingEndedAt: new Date(candidate.matchedRecordingEndMs).toISOString(),
        endSource: candidate.matchedRecordingEndSource,
      })),
    };
  }
  const selected = byId.values().next().value;
  return {
    ...envelope,
    eligible: true,
    executionAuthorized: true,
    noop: false,
    reason: 'owner-specified-recording-end-transcript',
    transcript: {
      ...selected,
      landedAt: Number.isFinite(selected.landedAtMs)
        ? new Date(selected.landedAtMs).toISOString()
        : null,
      endedAt: new Date(selected.matchedRecordingEndMs).toISOString(),
      endSource: selected.matchedRecordingEndSource,
      ageMs: currentMs - selected.matchedRecordingEndMs,
      landedDuringRetry: false,
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function selectRecentOtterTranscriptWithRetry({
  rawDir,
  dispatchAtMs = Date.now(),
  windowMs = OTTER_DISPATCH_WINDOW_MS,
  retryMs = OTTER_DISPATCH_RETRY_MS,
  pollMs = OTTER_DISPATCH_POLL_MS,
  readCandidatesFn = readCandidates,
  nowFn = Date.now,
  sleepFn = sleep,
} = {}) {
  const dispatchMs = epochMs(dispatchAtMs);
  if (!Number.isFinite(dispatchMs)) throw new Error('dispatchAtMs must be a valid timestamp');
  if (!Number.isFinite(retryMs) || retryMs < 0 || retryMs > OTTER_DISPATCH_RETRY_MS) {
    throw new Error(`retryMs must be between 0 and ${OTTER_DISPATCH_RETRY_MS}`);
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('pollMs must be positive');

  const startedAtMs = Number(nowFn());
  if (!Number.isFinite(startedAtMs)) throw new Error('nowFn must return a valid timestamp');
  if (dispatchMs > startedAtMs + OTTER_DISPATCH_FUTURE_SKEW_MS) {
    throw new Error('dispatchAtMs cannot be in the future');
  }
  const retryBudgetMs = Math.max(0, retryMs - Math.max(0, startedAtMs - dispatchMs));
  let attempts = 0;
  let waitedMs = 0;
  let result;
  for (;;) {
    attempts += 1;
    const currentTimeMs = Number(nowFn());
    if (!Number.isFinite(currentTimeMs)) throw new Error('nowFn must return a valid timestamp');
    const observedAtMs = Math.max(
      dispatchMs,
      Math.min(currentTimeMs, dispatchMs + retryMs),
    );
    result = selectRecentOtterTranscript({
      candidates: readCandidatesFn(rawDir, { notBeforeMs: dispatchMs - windowMs }),
      dispatchAtMs: dispatchMs,
      observedAtMs,
      currentTimeMs,
      windowMs,
    });
    if (result.eligible) {
      return {
        ...result,
        attempts,
        waitedMs,
      };
    }

    if (waitedMs >= retryBudgetMs) {
      return { ...result, attempts, waitedMs };
    }
    const delayMs = Math.min(pollMs, retryBudgetMs - waitedMs);
    await sleepFn(delayMs);
    waitedMs += delayMs;
  }
}

module.exports = {
  OTTER_DISPATCH_WINDOW_MS,
  OTTER_DISPATCH_RETRY_MS,
  OTTER_DISPATCH_POLL_MS,
  OTTER_DISPATCH_FUTURE_SKEW_MS,
  OTTER_OWNER_TIME_ZONE,
  candidateTimes,
  parseOwnerSpecifiedLandingTime,
  parseOwnerSpecifiedRecordingEndTime,
  readCandidateMetadata,
  readCandidates,
  selectRecentOtterTranscript,
  selectRecentOtterTranscriptWithRetry,
  selectOtterTranscriptByLandingMinute,
  selectOtterTranscriptByRecordingEndMinute,
};
