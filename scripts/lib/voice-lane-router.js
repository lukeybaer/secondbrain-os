'use strict';

// Which model actually answers the phone.
//
// 2026-08-16: ExampleCo called and got silence. Amy's voice lane is Codex
// (`amy-codex-subscription-voice`, gpt-5.6-terra). Codex hit its usage limit at
// ~16:45 and every voice turn afterwards failed the same way: the Codex lane
// errored, the request fell through to another Codex path, that failed too, and
// the caller heard nothing. A healthy Claude lane was sitting right there.
//
// ExampleCo's instruction: "sometimes one model is out of tokens and it becomes the
// secondary or fall back or even disabled... you should just proactively set
// that [when the] number one service runs out of tokens. I don't want to deal
// with this hand holding you that you should use one model or the other."
//
// So lane choice is a runtime decision made from observed health, not a
// constant. Three rules keep it safe:
//
//   1. A quota or auth failure is REMEMBERED. Rediscovering a three-day credit
//      outage on every single turn burns the first-content budget and the
//      caller hears silence each time. Failures persist to disk so a proxy
//      restart does not forget.
//   2. Never return an empty lane list. If every lane is cooling down, the one
//      closest to recovery is still attempted. Being wrong is recoverable;
//      being mute is not.
//   3. Only durable failures demote. One transient blip must not flip Amy off
//      her primary model, so transient errors demote a lane only after
//      TRANSIENT_STRIKES consecutive hits.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'amy.voice-lane-health.v1';

// Priority order when everything is healthy. Codex leads because it is the
// current dedicated voice model; Claude is the standing understudy.
const DEFAULT_LANE_ORDER = Object.freeze(['codex-app-server', 'codex-exec', 'claude-cli']);

// A lane is identified by its runtime provider so one provider's outage demotes
// every lane that depends on it. Codex credits dying takes out both Codex lanes.
const LANE_PROVIDER = Object.freeze({
  'codex-app-server': 'codex',
  'codex-exec': 'codex',
  'claude-cli': 'claude',
});

// Quota outages are measured in days, not seconds. Long enough to stop retrying
// every turn, short enough to recover automatically without anyone noticing.
const QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
const AUTH_COOLDOWN_MS = 10 * 60 * 1000;
const TRANSIENT_COOLDOWN_MS = 60 * 1000;
const TRANSIENT_STRIKES = 3;

function healthPath(opts = {}) {
  if (opts.healthPath) return opts.healthPath;
  const dataDir =
    opts.dataDir || process.env.SECONDBRAIN_DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dataDir, 'agent', 'voice-lane-health.json');
}

function readHealth(opts = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(healthPath(opts), 'utf8').replace(/^﻿/, ''));
    if (raw?.schema !== SCHEMA || !raw.providers || typeof raw.providers !== 'object') {
      return { schema: SCHEMA, providers: {} };
    }
    return raw;
  } catch {
    return { schema: SCHEMA, providers: {} };
  }
}

function writeHealth(state, opts = {}) {
  const file = healthPath(opts);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Math.abs(hashString(file))}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(temp, file);
  } catch {
    // Health memory is an optimisation. Losing it degrades to rediscovering an
    // outage per turn, which is bad, but it must never fail a live call.
  }
  return state;
}

function hashString(value) {
  let h = 0;
  for (let i = 0; i < String(value).length; i++) h = (h * 31 + String(value).charCodeAt(i)) | 0;
  return h;
}

/**
 * Classify a lane failure from whatever the runtime gave us: an Error, an exit
 * message, or raw stderr. Kind drives how long the lane stays demoted.
 */
function classifyLaneFailure(input) {
  const text = String(
    (input && (input.message || input.stderr || input.text)) || input || '',
  ).toLowerCase();
  if (!text) return { kind: 'transient', retryAfterMs: TRANSIENT_COOLDOWN_MS };

  // Usage limits, credit exhaustion, plan caps. Codex says "You've hit your
  // usage limit ... try again at Aug 19th"; Claude says "usage limit reached".
  if (
    /usage limit|out of credits?|purchase more credits|quota|rate.?limit|too many requests|\b429\b|insufficient.*(credit|quota|balance)|plan limit|billing/.test(
      text,
    )
  ) {
    return { kind: 'quota', retryAfterMs: parseRetryAfterMs(text) ?? QUOTA_COOLDOWN_MS };
  }
  if (
    /unauthorized|forbidden|\b401\b|\b403\b|invalid.*(api key|token|credential)|not logged in|please log ?in|authentication/.test(
      text,
    )
  ) {
    return { kind: 'auth', retryAfterMs: AUTH_COOLDOWN_MS };
  }
  return { kind: 'transient', retryAfterMs: TRANSIENT_COOLDOWN_MS };
}

// Providers often name their own reset time. Honour it rather than guessing, so
// a lane comes back the moment it can instead of on a fixed timer.
function parseRetryAfterMs(text) {
  const m = String(text).match(
    /try again at ([A-Z][a-z]{2} \d{1,2}[a-z]{0,2},? \d{4}(?:,? \d{1,2}:\d{2}\s*(?:am|pm)?)?)/i,
  );
  if (!m) return null;
  const when = Date.parse(m[1].replace(/(\d{1,2})(st|nd|rd|th)/i, '$1'));
  if (!Number.isFinite(when)) return null;
  const delta = when - Date.now();
  return delta > 0 ? delta : null;
}

function recordLaneFailure(lane, failure, opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const provider = LANE_PROVIDER[lane] || lane;
  const state = readHealth(opts);
  const prior = state.providers[provider] || { consecutiveTransient: 0 };
  const classified = failure && failure.kind ? failure : classifyLaneFailure(failure);

  if (classified.kind === 'transient') {
    const strikes = Number(prior.consecutiveTransient || 0) + 1;
    state.providers[provider] = {
      ...prior,
      consecutiveTransient: strikes,
      lastFailureKind: 'transient',
      lastFailureAt: new Date(nowMs).toISOString(),
      // One blip must not move Amy off her primary model.
      ...(strikes >= TRANSIENT_STRIKES
        ? { unavailableUntil: new Date(nowMs + classified.retryAfterMs).toISOString() }
        : {}),
    };
  } else {
    state.providers[provider] = {
      ...prior,
      consecutiveTransient: 0,
      lastFailureKind: classified.kind,
      lastFailureAt: new Date(nowMs).toISOString(),
      unavailableUntil: new Date(nowMs + classified.retryAfterMs).toISOString(),
      reason: String(classified.reason || classified.kind),
    };
  }
  return writeHealth(state, opts);
}

function recordLaneSuccess(lane, opts = {}) {
  const provider = LANE_PROVIDER[lane] || lane;
  const state = readHealth(opts);
  state.providers[provider] = {
    consecutiveTransient: 0,
    lastSuccessAt: new Date(opts.nowMs || Date.now()).toISOString(),
  };
  return writeHealth(state, opts);
}

function providerAvailableAtMs(provider, state, nowMs) {
  const entry = state.providers?.[provider];
  if (!entry?.unavailableUntil) return 0;
  const until = Date.parse(entry.unavailableUntil);
  if (!Number.isFinite(until) || until <= nowMs) return 0;
  return until;
}

/**
 * Ordered lanes to attempt for this turn, healthiest first.
 *
 * Always non-empty: if every provider is cooling down, the one recovering
 * soonest is still returned. A demoted lane that might work beats certain
 * silence on the call.
 */
function selectVoiceLanes(opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const order = opts.laneOrder || DEFAULT_LANE_ORDER;
  const state = opts.state || readHealth(opts);

  const ranked = order.map((lane, index) => {
    const provider = LANE_PROVIDER[lane] || lane;
    const availableAt = providerAvailableAtMs(provider, state, nowMs);
    return { lane, provider, index, availableAt, healthy: availableAt === 0 };
  });

  const healthy = ranked.filter((x) => x.healthy).sort((a, b) => a.index - b.index);
  if (healthy.length) {
    // Healthy lanes first in priority order, then the demoted ones as a last
    // resort behind them.
    const demoted = ranked
      .filter((x) => !x.healthy)
      .sort((a, b) => a.availableAt - b.availableAt || a.index - b.index);
    return [...healthy, ...demoted].map((x) => x.lane);
  }
  // Everything is demoted. Try whoever recovers soonest rather than going mute.
  return ranked
    .slice()
    .sort((a, b) => a.availableAt - b.availableAt || a.index - b.index)
    .map((x) => x.lane);
}

/** The lane to use first this turn. */
function selectVoiceLane(opts = {}) {
  return selectVoiceLanes(opts)[0];
}

/** Human-readable status, for /health and for saying why a lane was skipped. */
function describeVoiceLaneHealth(opts = {}) {
  const nowMs = opts.nowMs || Date.now();
  const state = opts.state || readHealth(opts);
  const providers = {};
  for (const provider of new Set(Object.values(LANE_PROVIDER))) {
    const availableAt = providerAvailableAtMs(provider, state, nowMs);
    providers[provider] = {
      available: availableAt === 0,
      availableInMs: availableAt === 0 ? 0 : availableAt - nowMs,
      lastFailureKind: state.providers?.[provider]?.lastFailureKind || null,
    };
  }
  return { schema: SCHEMA, order: selectVoiceLanes({ ...opts, state, nowMs }), providers };
}

module.exports = {
  SCHEMA,
  DEFAULT_LANE_ORDER,
  LANE_PROVIDER,
  QUOTA_COOLDOWN_MS,
  AUTH_COOLDOWN_MS,
  TRANSIENT_COOLDOWN_MS,
  TRANSIENT_STRIKES,
  classifyLaneFailure,
  recordLaneFailure,
  recordLaneSuccess,
  selectVoiceLane,
  selectVoiceLanes,
  describeVoiceLaneHealth,
  readHealth,
  healthPath,
};
