// regen-retry-decision.js
//
// Structured retry state + dead-letter escalation for video regeneration.
//
// The auto-regen-rejected-videos.js loop previously retried with an opaque
// per-process attempt counter, which meant:
//   * a video could thrash forever across runs (no persistent attempt history)
//   * a stuck video sat in pending_approval indefinitely with the same bad
//     thumbnail/script (no dead-letter when retries exhausted)
//   * the next regen prompt could not learn from the prior failure (no error
//     context propagated forward)
//
// Patterns synthesized from three reference implementations:
//   * openai/openai-agents-python src/agents/retry.py:50-137 (commit b3688db,
//     2026-04-27, 25.4k stars) -- ModelRetryNormalizedError / RetryDecision
//     dataclasses encode status_code + retry_after + replay_safety + reason
//     so each retry decision is inspectable.
//   * microsoft/taskweaver planner.py ask_self_cnt + revise_message pattern
//     (max_self_ask_num=3) -- on failure, append bad output as
//     AttachmentType.invalid_response with the error reason, then re-enter
//     the LLM call with correction in context before dead-letter escalation.
//   * pydantic/pydantic-ai retries.py + durable_exec/ -- ValidationError
//     injected back into the conversation as a structured message before
//     retry, not just a counter increment.
//
// SecondBrain translation:
//   * regen-queue.jsonl    -- per-video RetryDecision history (append-only)
//   * regen-failures.jsonl -- dead-letter when attempts >= max_retries
//   * buildErrorContext()  -- builds a prompt fragment from the last attempt
//                             that the next regen pass injects into its
//                             rejection-note so the rebuild actually
//                             responds to the prior failure mode

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_RETRIES = 3;

// Replay-safety semantics:
//   'safe'   -- step is deterministic given the same inputs (ffmpeg mux,
//               captions re-burn). Re-running cannot make the artifact
//               worse, so retry is unconditional.
//   'unsafe' -- step is non-deterministic (Bedrock thumbnail, ElevenLabs
//               TTS, Pexels selection). Each retry costs money and can
//               drift; require an explicit retry_after gate before re-call.
const STEP_REPLAY_DEFAULT = {
  thumbnail: 'unsafe',
  video: 'unsafe',
  captions: 'safe',
  mux: 'safe',
  unknown: 'unsafe',
};

const REPO = process.env.SECONDBRAIN_ROOT
  || path.resolve(__dirname, '..');

function queuePath() {
  return path.join(REPO, 'data', 'agent', 'regen-queue.jsonl');
}

function deadLetterPath() {
  return path.join(REPO, 'data', 'agent', 'regen-failures.jsonl');
}

// ── Persistence ───────────────────────────────────────────────────────────────

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed
    }
  }
  return out;
}

function isSupersededWorkerBugAttempt(attempt) {
  return attempt
    && attempt.errorCode === 'ec2_io'
    && /local ec2 build claimed success but no output mp4/i.test(attempt.lastError || '');
}

function isSupersededSingleAuthAttempt(attempt) {
  return attempt
    && attempt.errorCode === 'auth'
    && attempt.maxRetries === 1
    && /ElevenLabs TTS auth failed/i.test(attempt.lastError || '');
}

function isSupersededAttempt(attempt) {
  return isSupersededWorkerBugAttempt(attempt) || isSupersededSingleAuthAttempt(attempt);
}

function isResetRecord(row) {
  return row && row.kind === 'regen_reset';
}

function appendJsonl(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
}

/** Read all RetryDecision records for a single video. Newest last. */
function loadAttemptsForVideo(videoId, step, file) {
  const all = readJsonl(file || queuePath());
  const matching = all.filter((r) => r.videoId === videoId && (!step || r.step === step));
  let start = 0;
  for (let i = matching.length - 1; i >= 0; i -= 1) {
    if (isResetRecord(matching[i])) {
      start = i + 1;
      break;
    }
  }
  return matching
    .slice(start)
    .filter((r) => !isResetRecord(r) && !isSupersededAttempt(r));
}

/** Read all dead-letter entries. Used by the briefing to surface escalations. */
function loadDeadLetter(file) {
  return readJsonl(file || deadLetterPath()).filter((entry) => {
    const attempts = Array.isArray(entry.attempts) ? entry.attempts : [];
    return attempts.length === 0 || attempts.some((attempt) => !isSupersededAttempt(attempt));
  });
}

// ── Decision construction ─────────────────────────────────────────────────────

function buildReason(code, attempt, max) {
  if (attempt >= max) return `exhausted after ${max} attempts: ${code}`;
  return `attempt ${attempt}/${max} failed (${code}); will retry`;
}

/**
 * Compute the next RetryDecision for a video given the prior attempts.
 * Caller invokes this AFTER a regen attempt has failed. The returned record
 * is what the next pass will read to decide whether to retry, gate on
 * retry_after, or escalate.
 */
function nextDecision(args) {
  const now = (args.now || (() => new Date()))();
  const attemptCount = args.priorAttempts.length + 1;
  const maxRetries = args.maxRetries == null ? DEFAULT_MAX_RETRIES : args.maxRetries;
  const replaySafety = args.replaySafety || STEP_REPLAY_DEFAULT[args.step] || 'unsafe';
  const reason = buildReason(args.errorCode, attemptCount, maxRetries);
  return {
    videoId: args.videoId,
    step: args.step,
    attempt: attemptCount,
    maxRetries,
    lastError: (args.lastError || '').slice(0, 1000),
    errorCode: args.errorCode || 'unspecified',
    replaySafety,
    retryAfter: args.retryAfter == null ? null : args.retryAfter,
    reason,
    recordedAt: now.toISOString(),
    rejectionNote: args.rejectionNote,
  };
}

// ── Recording an attempt ──────────────────────────────────────────────────────

/**
 * Append an attempt to the queue and escalate to dead-letter if exhausted.
 * Returns { exhausted, decision, deadLetter? } so the caller can decide
 * whether to retry now, wait for retry_after, or surface a Telegram alert.
 */
function recordAttempt(args) {
  const queueFile = args.queueFile || queuePath();
  const deadLetterFile = args.deadLetterFile || deadLetterPath();
  const priorAttempts = loadAttemptsForVideo(args.videoId, args.step, queueFile);
  const decision = nextDecision({ ...args, priorAttempts });
  appendJsonl(queueFile, decision);
  const exhausted = decision.attempt >= decision.maxRetries;
  if (!exhausted) return { exhausted, decision };
  const deadLetter = {
    videoId: decision.videoId,
    step: decision.step,
    attempts: [...priorAttempts, decision],
    escalatedAt: decision.recordedAt,
    reason: decision.reason,
  };
  appendJsonl(deadLetterFile, deadLetter);
  return { exhausted, decision, deadLetter };
}

function recordReset(args) {
  const queueFile = args.queueFile || queuePath();
  const now = (args.now || (() => new Date()))();
  appendJsonl(queueFile, {
    kind: 'regen_reset',
    videoId: args.videoId,
    step: args.step,
    reason: args.reason || 'retry budget reset',
    recordedAt: now.toISOString(),
  });
}

// ── Retry gating ──────────────────────────────────────────────────────────────

/**
 * Should the next regen pass actually retry this video right now?
 * Returns 'retry', 'wait' (with the gate timestamp), or 'dead-letter' (exhausted).
 *
 * Mirrors openai-agents-python's RetryDecision: an inspectable record per
 * attempt, not an opaque counter. The caller (auto-regen-rejected-videos.js)
 * calls this BEFORE attempting the next regen.
 */
function shouldRetry(videoId, step, opts) {
  const o = opts || {};
  const now = (o.now || (() => new Date()))();
  const attempts = loadAttemptsForVideo(videoId, step, o.queueFile || queuePath());
  const last = attempts[attempts.length - 1];
  const attemptsSoFar = attempts.length;
  const nextAttempt = attemptsSoFar + 1;
  if (last && last.attempt >= last.maxRetries) {
    return { action: 'dead-letter', attemptsSoFar, nextAttempt, lastDecision: last };
  }
  if (last && last.replaySafety === 'unsafe' && last.retryAfter) {
    const gate = new Date(last.retryAfter);
    if (!Number.isNaN(gate.getTime()) && gate.getTime() > now.getTime()) {
      return { action: 'wait', attemptsSoFar, nextAttempt, lastDecision: last, waitUntil: last.retryAfter };
    }
  }
  return { action: 'retry', attemptsSoFar, nextAttempt, lastDecision: last };
}

// ── Error context for the next regen prompt ───────────────────────────────────

/**
 * Build a prompt fragment that the next regen pass injects into the rejection
 * note. Pattern from taskweaver: the prior bad output + the failure reason
 * become part of the next LLM call's context, so the rebuild explicitly
 * responds to "your last attempt produced X; here is why X failed" rather
 * than re-running the same generation blind.
 */
function buildErrorContext(videoId, step, opts) {
  const o = opts || {};
  const lastN = o.lastN == null ? 2 : o.lastN;
  const attempts = loadAttemptsForVideo(videoId, step, o.queueFile || queuePath());
  if (!attempts.length) return '';
  const recent = attempts.slice(-lastN);
  const lines = [
    `Prior ${step} attempts for ${videoId} have failed; do not repeat the same approach.`,
  ];
  for (const a of recent) {
    lines.push(`- attempt ${a.attempt}/${a.maxRetries} at ${a.recordedAt}: ${a.errorCode} -- ${(a.lastError || '').slice(0, 200)}`);
  }
  lines.push('Address each error above explicitly in this rebuild.');
  return lines.join('\n');
}

// ── Summary for briefing ──────────────────────────────────────────────────────

/**
 * Roll up the dead-letter file into a per-video summary for the briefing
 * "videos blocked by regen failures" card. Newest escalation per video wins.
 */
function summarizeDeadLetter(file) {
  const entries = loadDeadLetter(file);
  const byVideo = new Map();
  for (const e of entries) {
    const key = `${e.videoId}::${e.step}`;
    const existing = byVideo.get(key);
    if (!existing || e.escalatedAt > existing.escalatedAt) {
      byVideo.set(key, e);
    }
  }
  return [...byVideo.values()].map((e) => {
    const last = e.attempts[e.attempts.length - 1];
    return {
      videoId: e.videoId,
      step: e.step,
      attempts: e.attempts.length,
      escalatedAt: e.escalatedAt,
      errorCode: (last && last.errorCode) || 'unspecified',
      lastError: (last && (last.lastError || '').slice(0, 200)) || '',
    };
  });
}

module.exports = {
  DEFAULT_MAX_RETRIES,
  queuePath,
  deadLetterPath,
  loadAttemptsForVideo,
  loadDeadLetter,
  nextDecision,
  recordAttempt,
  recordReset,
  shouldRetry,
  buildErrorContext,
  summarizeDeadLetter,
};
