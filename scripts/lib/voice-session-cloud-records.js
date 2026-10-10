'use strict';

// Voice-side reader for the receipted session cloud plane.
//
// 2026-08-16 owner call 01a00b2d: ExampleCo asked "how's that session going where
// we're trying to optimize the token spend" and check_spine answered "I don't
// see an active or recent ... session". His overnight watcher session
// (claude:de51ab1a) had been working eleven minutes earlier, and its record was
// sitting in this host's own projection.json the whole time. handleCheckSpineVoice
// only ever read the EC2-local task dir plus the Codex thread mirror, so every
// Claude session on ExampleCo's PC was invisible to the phone.
//
// This module turns that projection into spine-shaped records. Three rules keep
// it safe on the Vapi webhook path and honest in what it claims:
//
//   1. Local file read only. No network, and deliberately NOT querySessionCloud,
//      whose FTS subprocess (session-cloud-query.js) can take ~20 s and would eat
//      the whole webhook budget on a probe-0 status question.
//   2. Parent vs subagent comes from the structural `source_kind` /
//      `parent_session_id` the plane already records, never from prompt prose.
//      dispatch-delivery.js:496 documents why: reading raw text made a parent
//      session vanish because ExampleCo's own text discussed "agent-subagent" spend.
//   3. Liveness is derived, not copied. `running` plus a stale `last_observed_at`
//      is reported as last-seen evidence, never as current activity.

const path = require('path');
const { readSessionProjection } = require('./session-cloud-plane');

// A session is only spoken of as currently active if the plane observed its
// source inside this window. Matches the 20 min liveness horizon already used by
// sessionStatusSnapshot in session-cloud-query.js.
const SOURCE_FRESH_MS = 20 * 60 * 1000;
// How far back a session stays worth naming as "recent" on a status question.
const RECENT_SESSION_MS = 24 * 60 * 60 * 1000;
// Per-session dialogue turns retained for deep probes. Sessions run to hundreds
// of activities; the voice path only ever speaks a handful.
const MAX_DIALOGUE_TURNS = 12;
// Hard ceiling on sessions returned, newest first, so a growing plane cannot
// slow the webhook down.
const DEFAULT_SESSION_LIMIT = 40;

// Prompt text captured from a blocked Stop hook is machinery talking to itself,
// not ExampleCo stating a topic. It must never become a session's spoken identity.
const HOOK_FEEDBACK_RE =
  /^\s*(stop hook feedback|\[[\w-]+\]\s*BLOCKED|system-reminder|<system-reminder>)/i;

function isOwnerPromptText(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return !HOOK_FEEDBACK_RE.test(s);
}

function providerOrigin(provider) {
  const p = String(provider || '').toLowerCase();
  if (p === 'claude') return 'claude-code';
  if (p === 'codex') return 'codex';
  return p || 'session';
}

// Codex rows carry a raw epoch (seconds or ms) where Claude rows carry ISO
// strings. Treating an epoch as unparseable made whole Codex sessions sort to
// the bottom and drop out of the recency window.
function parseTs(...values) {
  for (const v of values) {
    if (v == null || v === '') continue;
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v < 1e12 ? v * 1000 : v;
    }
    const numeric = typeof v === 'string' && /^\d{10}(\d{3})?$/.test(v.trim()) ? Number(v) : NaN;
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

function isoOrNull(value) {
  const ms = parseTs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function firstMeaningful(...values) {
  for (const v of values) {
    const s = String(v == null ? '' : v).trim();
    if (s) return s;
  }
  return '';
}

// The plane's session.title is a workspace slug ("C--Users-ExampleCo-... Claude
// session"), which tells ExampleCo nothing on a phone call. What identifies a session
// to him is what he asked it to do. Prefer the opening owner prompt, then the
// most recent substantive summary, and only then the slug.
function speakableTitle(session, mainActivities) {
  const opening = mainActivities.find((a) => isOwnerPromptText(a.prompt_summary));
  if (opening) return String(opening.prompt_summary).trim();
  const latestSummary = [...mainActivities]
    .reverse()
    .find((a) => firstMeaningful(a.result_summary, a.progress_summary));
  if (latestSummary) {
    return firstMeaningful(latestSummary.result_summary, latestSummary.progress_summary);
  }
  return firstMeaningful(session && session.title, `${session && session.provider} session`);
}

// Everything ExampleCo could plausibly say about this session, in one string, so the
// existing lexical scorer can match on what was actually discussed rather than
// on a title he has never seen. This is what lets "the token spend session"
// reach a session whose stored title is a workspace slug.
// Deliberately NOT the whole transcript. Matching over every word a session ever
// said makes the scorer promiscuous: across hundreds of turns almost any query
// finds a third of its terms somewhere and wins. Measured on the live projection,
// a full-dialogue corpus matched "stadium seat map rebuild" to a session about
// booking a restaurant. What identifies a session is what ExampleCo ASKED it to do,
// plus where it currently stands, so the corpus is his prompts and the last few
// summaries, bounded. Full dialogue stays available for deep probes below.
const TOPIC_TEXT_MAX = 3000;
const TOPIC_SUMMARY_TURNS = 3;

function topicText(session, mainActivities) {
  const ownerPrompts = mainActivities
    .filter((a) => isOwnerPromptText(a.prompt_summary))
    .map((a) => a.prompt_summary);
  const recentSummaries = mainActivities
    .slice(-TOPIC_SUMMARY_TURNS)
    .map((a) => firstMeaningful(a.result_summary, a.progress_summary));
  return [...ownerPrompts, ...recentSummaries, (session && session.latest_result_summary) || '']
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, TOPIC_TEXT_MAX);
}

// Recent turns of real dialogue, oldest to newest, so a deep probe can quote what
// the session actually said instead of paraphrasing a status field.
function dialogueTurns(mainActivities) {
  const turns = [];
  for (const a of mainActivities) {
    const text = firstMeaningful(a.result_summary, a.progress_summary);
    if (!text) continue;
    turns.push({
      ts: a.updated_at || a.occurred_at || '',
      status: a.status || '',
      text: String(text).replace(/\s+/g, ' ').trim(),
    });
  }
  return turns.slice(-MAX_DIALOGUE_TURNS);
}

// `running` in the plane means "the last event we saw was a start". If the source
// has not been observed since, that is stale evidence, not current work. Callers
// speak `active` as live and `last_seen` as history.
function deriveLiveness(session, latestActivity, nowMs) {
  const lastObservedMs = parseTs(
    session && session.last_observed_at,
    latestActivity && latestActivity.last_observed_at,
  );
  const updatedMs = parseTs(
    session && session.updated_at,
    latestActivity && latestActivity.updated_at,
  );
  const declaredRunning =
    String((session && session.status) || '').toLowerCase() === 'running' ||
    Number(session && session.active_activity_count) > 0;
  const terminalVerified =
    (session && session.latest_terminal_receipt_verified === true) ||
    (latestActivity && latestActivity.terminal_receipt_verified === true);
  const sourceFresh = Number.isFinite(lastObservedMs) && nowMs - lastObservedMs <= SOURCE_FRESH_MS;
  const sourceAvailable = session && session.source_available !== false;

  if (declaredRunning && sourceFresh && sourceAvailable) {
    return { liveness: 'active', status: 'running', lastObservedMs, updatedMs };
  }
  // An interactive session sits at zero running activities between ExampleCo's turns.
  // Its last activity is `completed` and carries a verified receipt, but the
  // session itself is still open and the plane is still observing its source.
  // Calling that "terminal" is how a live watcher session reads as finished.
  // Fresh observation plus an available source means open and idle, not over.
  if (sourceFresh && sourceAvailable) {
    return { liveness: 'idle', status: 'open', lastObservedMs, updatedMs };
  }
  if (declaredRunning) {
    // Claims running, but nothing observed recently. Stale evidence, say so.
    return { liveness: 'last_seen', status: 'running', lastObservedMs, updatedMs };
  }
  // A verified terminal receipt stays terminal regardless of age.
  return {
    liveness: terminalVerified ? 'terminal' : 'last_seen',
    status: String((session && session.status) || 'recent').toLowerCase(),
    lastObservedMs,
    updatedMs,
  };
}

/**
 * Read the local session-cloud projection and return spine-shaped session
 * records for the voice status path.
 *
 * Pure local read. Returns [] rather than throwing when the projection is
 * missing or unreadable, so a cold host degrades to the old evidence set instead
 * of failing the call.
 */
function readVoiceSessionCloudRecords({
  dataDir = process.env.SECONDBRAIN_DATA_DIR || path.join(process.cwd(), 'data'),
  nowMs = Date.now(),
  limit = DEFAULT_SESSION_LIMIT,
  recentMs = RECENT_SESSION_MS,
  projection = null,
} = {}) {
  let plane = projection;
  if (!plane) {
    try {
      plane = readSessionProjection({ dataDir });
    } catch {
      return [];
    }
  }
  if (!plane || typeof plane !== 'object') return [];

  const sessions = plane.sessions && typeof plane.sessions === 'object' ? plane.sessions : {};
  const allActivities =
    plane.activities && typeof plane.activities === 'object' ? Object.values(plane.activities) : [];

  const bySessionKey = new Map();
  for (const activity of allActivities) {
    if (!activity || !activity.session_id) continue;
    const key = `${activity.provider}:${activity.session_id}`;
    if (!bySessionKey.has(key)) bySessionKey.set(key, []);
    bySessionKey.get(key).push(activity);
  }

  const records = [];
  for (const [key, session] of Object.entries(sessions)) {
    if (!session || !session.session_id) continue;
    const activities = (bySessionKey.get(key) || []).sort(
      (a, b) => parseTs(a.updated_at, a.occurred_at) - parseTs(b.updated_at, b.occurred_at),
    );
    // A session's own identity is its main-kind work. Subagent activities are
    // counted but never define the session, and never make it a child.
    const mainActivities = activities.filter(
      (a) => String(a.source_kind || 'main').toLowerCase() === 'main',
    );
    const subagentCount = activities.length - mainActivities.length;
    const latestActivity =
      mainActivities[mainActivities.length - 1] || activities[activities.length - 1] || null;

    const { liveness, status, lastObservedMs, updatedMs } = deriveLiveness(
      session,
      latestActivity,
      nowMs,
    );
    const sortTs = Number.isFinite(updatedMs) ? updatedMs : lastObservedMs;
    if (liveness !== 'active' && Number.isFinite(sortTs) && nowMs - sortTs > recentMs) continue;

    const title = speakableTitle(session, mainActivities);
    const detail = firstMeaningful(
      session.latest_result_summary,
      latestActivity && latestActivity.result_summary,
      latestActivity && latestActivity.progress_summary,
    );

    records.push({
      id: `session-cloud:${session.provider}:${session.session_id}`,
      sessionId: session.session_id,
      provider: session.provider,
      origin: providerOrigin(session.provider),
      kind: 'action',
      title,
      prompt: title,
      resultSummary: detail,
      detail,
      status,
      liveness,
      updatedAt: isoOrNull(session.updated_at || (latestActivity && latestActivity.updated_at)),
      lastObservedAt: isoOrNull(
        session.last_observed_at || (latestActivity && latestActivity.last_observed_at),
      ),
      sourceAvailable: session.source_available !== false,
      // Structural, from the plane. Never inferred from prose.
      sourceKind: 'main',
      parentSessionId: (latestActivity && latestActivity.parent_session_id) || null,
      activityCount: Number(session.activity_count || activities.length) || activities.length,
      activeActivityCount: Number(session.active_activity_count || 0),
      subagentActivityCount: subagentCount,
      terminalReceiptVerified: session.latest_terminal_receipt_verified === true,
      // Matching corpus and deep-probe material.
      topicText: topicText(session, mainActivities),
      dialogue: dialogueTurns(mainActivities),
      _source: 'session-cloud',
      _sortTs: Number.isFinite(sortTs) ? sortTs : 0,
    });
  }

  records.sort((a, b) => b._sortTs - a._sortTs);
  return records.slice(0, limit);
}

module.exports = {
  readVoiceSessionCloudRecords,
  // exported for tests and for callers that need the same liveness vocabulary
  deriveLiveness,
  speakableTitle,
  topicText,
  isOwnerPromptText,
  SOURCE_FRESH_MS,
  RECENT_SESSION_MS,
};
