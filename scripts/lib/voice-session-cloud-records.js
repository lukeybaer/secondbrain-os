'use strict';

// Voice-side reader for the receipted session cloud plane.
//
// 2026-08-16 owner one call: the owner asked "how's that session going where
// we're trying to optimize the token spend" and check_spine answered "I don't
// see an active or recent ... session". His overnight watcher session
// (claude:de51ab1a) had been working eleven minutes earlier, and its record was
// sitting in this host's own projection.json the whole time. handleCheckSpineVoice
// only ever read the EC2-local task dir plus the Codex thread mirror, so every
// Claude session on the owner's PC was invisible to the phone.
//
// This module turns that projection into spine-shaped records. Three rules keep
// it safe on the voice provider webhook path and honest in what it claims:
//
//   1. Local file read only. No network, and deliberately NOT querySessionCloud,
//      whose FTS subprocess (session-cloud-query.js) can take ~20 s and would eat
//      the whole webhook budget on a probe-0 status question.
//   2. Parent vs subagent comes from the structural `source_kind` /
//      `parent_session_id` the plane already records, never from prompt prose.
//      dispatch-delivery.js:496 documents why: reading raw text made a parent
//      session vanish because the owner's own text discussed "agent-subagent" spend.
//   3. Liveness is derived, not copied. `running` plus a stale `last_observed_at`
//      is reported as last-seen evidence, never as current activity.

const path = require('path');
const { readVoiceProjection } = require('./session-cloud-plane');

// A session is only spoken of as currently active if the plane observed its
// source inside this window. Matches the 20 min liveness horizon already used by
// sessionStatusSnapshot in session-cloud-query.js.
const SOURCE_FRESH_MS = 20 * 60 * 1000;
// How far back a session stays worth naming as "recent" on a status question.
const RECENT_SESSION_MS = 24 * 60 * 60 * 1000;
// Sessions the owner started himself stay findable for a week. 2026-10-14: he asked
// about a named session from the evening before; it sat at rank 380 of 408 behind automated Codex runs and was cut.
const OWNER_RECENT_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
// Per-session dialogue turns retained for deep probes. Sessions run to hundreds
// of activities; the voice path only ever speaks a handful.
const MAX_DIALOGUE_TURNS = 12;
// Hard ceiling on sessions returned, newest first, so a growing plane cannot
// slow the webhook down.
const DEFAULT_SESSION_LIMIT = 40;
// The owner's own sessions have their own, larger ceiling: a busy week runs to ~50
// of them, and automated runs must never push one out of reach.
const OWNER_SESSION_LIMIT = 150;

// Prompt text captured from a blocked Stop hook is machinery talking to itself,
// not the owner stating a topic. It must never become a session's spoken identity.
// Harness boilerplate is the same category: compaction continuations, slash
// command wrappers, local-command caveats, background-task notifications, and
// interrupt markers (2026-10-14: a compacted session was titled "This session
// is being continued from a previous conversation").
const HOOK_FEEDBACK_RE =
  /^\s*(stop hook feedback|\[[\w-]+\]\s*BLOCKED|system-reminder|<system-reminder>|this session is being continued from a previous conversation|<command-(?:name|message|args)>|<local-command-(?:stdout|stderr|caveat)>|caveat: the messages below were generated|<task-notification>|\[request interrupted by user|the user hasn't heard from you|base directory for this skill:|tool loaded\b|#{1,6}\s+page contract\b)/i;
// Hashtag commands the owner types (#b, #otter, #learn) identify a session as well as
// its words do. Indexed as tags so "the hashtag b session" finds it.
const HASHTAG_RE = /(?:^|[\s(])#([a-z][\w-]{0,30})\b/gi;

// Hashtag shorthands the owner uses for a kind of work, so the spoken name of that
// work finds a session that was only ever started with the tag.
const HASHTAG_TOPICS = {
  '#j': 'job search job applications',
  '#b': 'nightly briefing retrospective and fixes',
  '#otter': 'recorder note',
  '#learn': 'lesson learned',
  '#gap': 'regression gap fix',
  '#ppl': 'people contacts update',
  '#inbox': 'inbox email scan',
  '#mail': 'inbox email scan',
};

// Pasted screenshots arrive as "[Image #1]" markers or bare image file paths.
// Neither is something the owner would say, so neither may name a session.
// Paths may be quoted or contain spaces ("C:\path\to\Screen Shot.png").
const IMAGE_MARKER_RE =
  /\[Image[^\]]*\]|["'][^"'\n]*\.(?:png|jpe?g|gif|webp|bmp)["']|(?:[A-Za-z]:)?[\\/][^\n"']*?\.(?:png|jpe?g|gif|webp|bmp)\b|\S+\.(?:png|jpe?g|gif|webp|bmp)\b/gi;

function stripImageMarkers(text) {
  return String(text || '').replace(IMAGE_MARKER_RE, ' ').replace(/\s+/g, ' ').trim();
}

// Who started the session. The producer records it from structure the client
// writes (Claude entrypoint, Codex originator). Sessions recorded before that
// field existed fall back on the provider: on this PC Codex runs are the
// automated fleet and Claude sessions are the owner's. A recorded 'unknown' stays
// unknown: shown by default, but ranked after the owner's own sessions.
function sessionInitiator(session, activities) {
  const recorded = firstMeaningful(
    session && session.initiator,
    ...[...activities].reverse().map((a) => a && a.initiator),
  );
  if (recorded === 'owner' || recorded === 'automated' || recorded === 'unknown') {
    return { initiator: recorded, initiatorSource: 'recorded' };
  }
  const provider = String((session && session.provider) || '').toLowerCase();
  return { initiator: provider === 'codex' ? 'automated' : 'owner', initiatorSource: 'provider_default' };
}

function hashtagsFrom(texts) {
  const tags = new Set();
  for (const text of texts) {
    for (const m of String(text || '').matchAll(HASHTAG_RE)) tags.add(`#${m[1].toLowerCase()}`);
  }
  return [...tags];
}

function isOwnerPromptText(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return !HOOK_FEEDBACK_RE.test(s);
}

// Harness text appended to a prompt ("Tool loaded. <system-reminder> ...") is
// cut off before the owner test; what remains must still be the owner's words.
const HARNESS_TAIL_RE = /<(?:system-reminder|task-notification)>[\s\S]*$/i;

function ownerPromptText(text) {
  const s = stripImageMarkers(String(text || '').replace(HARNESS_TAIL_RE, ' '));
  return s && isOwnerPromptText(s) ? s : '';
}

function ownerPromptTexts(activities) {
  return (activities || []).map((a) => ownerPromptText(a && a.prompt_summary)).filter(Boolean);
}

// The owner's prompts from both places they are recorded, oldest first: the digest
// the producer reads from the whole transcript (it survives the harness text
// that hid "#b" from the live turns) and the live turns since. Said once each.
function sessionOwnerPrompts(session, mainActivities) {
  const items = [];
  for (const p of Array.isArray(session && session.owner_prompts) ? session.owner_prompts : []) {
    const text = ownerPromptText(p && p.text);
    if (text) items.push({ at: parseTs(p.at), text });
  }
  for (const a of mainActivities || []) {
    const text = ownerPromptText(a && a.prompt_summary);
    if (text) items.push({ at: parseTs(a.occurred_at, a.updated_at), text });
  }
  items.sort((a, b) => (Number.isFinite(a.at) ? a.at : 0) - (Number.isFinite(b.at) ? b.at : 0));
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.text.toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item.text);
  }
  return out;
}

// The latest compaction recap of what the owner wants from the session, without
// the "Earlier (finished)" history when it marks a current ask.
function sessionIntent(session) {
  const intent = String((session && session.intent) || '').replace(/\s+/g, ' ').trim();
  const current = intent.search(/\bcurrent\b[^:]{0,40}:/i);
  return current > 0 ? intent.slice(current).replace(/^current[^:]{0,40}:\s*/i, '') : intent;
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

// The app titles a session from its first prompt, so one opened with a bare
// hashtag command is titled "B" or "J": a tag, not a name. On the 2026-10-27
// owner call three sessions were all spoken as "B", and the owner could not tell
// which one was fixing PRIVATE_NAME's voice clusters.
function isTagOnlyTitle(title) {
  const words = String(title || '')
    .replace(HASHTAG_RE, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return words.length <= 2;
}

// "B" came from "#b", so the tag's topic is the best name left for a session
// with no words of its own yet.
function titleTagTopic(title) {
  const t = String(title || '')
    .trim()
    .toLowerCase();
  const tag = t.startsWith('#') ? t.split(/\s+/)[0] : /^[a-z]{1,2}$/.test(t) ? `#${t}` : '';
  return HASHTAG_TOPICS[tag] || '';
}

// A prompt's own words, without the hashtag commands that opened it.
function wordsBeyondTags(text) {
  return String(text || '')
    .replace(HASHTAG_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The plane's session.title is a workspace slug ("C--Users-owner-... Claude
// session"), which tells the owner nothing on a phone call. What identifies a session
// to him is what he asked it to do. Prefer the app title when it is a name, then
// the opening owner prompt, the hashtag's topic, the most recent substantive
// summary, and only then the slug.
function speakableTitle(session, mainActivities) {
  // The name the owner gave the session in the app is how he refers to it, unless
  // the app only echoed his hashtag command back as the name.
  const named = stripImageMarkers(session && session.session_title);
  if (named && !isTagOnlyTitle(named)) return named;
  const ownerPrompts = sessionOwnerPrompts(session, mainActivities);
  const opening = ownerPrompts.map(wordsBeyondTags).find((text) => text.length > 2);
  if (opening) return opening;
  const topic =
    titleTagTopic(named) ||
    hashtagsFrom(ownerPrompts)
      .map((tag) => HASHTAG_TOPICS[tag])
      .find(Boolean);
  if (topic) return topic;
  const latestSummary = [...mainActivities]
    .reverse()
    .find((a) => firstMeaningful(a.result_summary, a.progress_summary));
  if (latestSummary) {
    return firstMeaningful(latestSummary.result_summary, latestSummary.progress_summary);
  }
  const stored = String((session && session.title) || '').trim();
  return isOwnerPromptText(stored) ? stored : `${session && session.provider} session`;
}

// Everything the owner could plausibly say about this session, in one string, so the
// existing lexical scorer can match on what was actually discussed rather than
// on a title he has never seen. This is what lets "the token spend session"
// reach a session whose stored title is a workspace slug.
// Deliberately NOT the whole transcript. Matching over every word a session ever
// said makes the scorer promiscuous: across hundreds of turns almost any query
// finds a third of its terms somewhere and wins. Measured on the live projection,
// a full-dialogue corpus matched "stadium seat map rebuild" to a session about
// booking a restaurant. What identifies a session is what the owner ASKED it to do,
// plus where it currently stands, so the corpus is his prompts and the last few
// summaries, bounded. Full dialogue stays available for deep probes below.
const TOPIC_TEXT_MAX = 3000;
const TOPIC_SUMMARY_TURNS = 3;
const TOPIC_SUMMARY_MAX = 300;
const TOPIC_RESERVED_PROMPTS = 4;

const TOPIC_INTENT_MAX = 500;

function topicText(session, mainActivities) {
  const ownerPrompts = sessionOwnerPrompts(session, mainActivities);
  const recentSummaries = mainActivities
    .slice(-TOPIC_SUMMARY_TURNS)
    .map((a) => firstMeaningful(a.result_summary, a.progress_summary));
  const tagTopics = hashtagsFrom(ownerPrompts)
    .map((tag) => HASHTAG_TOPICS[tag])
    .filter(Boolean);
  // Newest prompts first, after the opening one. The corpus is capped, and a
  // session that runs for days asks about many things: oldest-first kept only
  // its first afternoon. 2026-10-28 owner call: the owner quoted the prompt he gave
  // a three-day session the evening before ("first one claims top viral tech
  // is missing"), and it had been cut from the corpus, so nothing matched it.
  // The newest few prompts go ahead of the summaries, and each summary is
  // capped and said once, so one long report cannot push them out (Codex
  // review 75aced3ef77b: a 2,400-character summary cut the newest prompt).
  const [opening, ...later] = ownerPrompts;
  const newestFirst = later.slice().reverse();
  const clip = (text, max) => String(text || '').slice(0, max);
  const summaries = [...new Set(
    [(session && session.latest_result_summary) || '', ...recentSummaries.slice().reverse()]
      .map((text) => clip(text, TOPIC_SUMMARY_MAX))
      .filter(Boolean),
  )];
  return [
    (session && session.session_title) || '',
    ...tagTopics,
    clip(session && session.intent, TOPIC_INTENT_MAX),
    ...newestFirst.slice(0, TOPIC_RESERVED_PROMPTS).map((text) => clip(text, TOPIC_SUMMARY_MAX)),
    ...summaries,
    ...(opening ? [opening] : []),
    ...newestFirst.slice(TOPIC_RESERVED_PROMPTS),
  ]
    .filter(Boolean)
    .map(stripImageMarkers)
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
  // An interactive session sits at zero running activities between the owner's turns.
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

// The owner's own sessions are the default view (owner decision). Automated runs
// join on a deeper probe, or when he asks about background work by name.
const AUTOMATED_SESSION_QUERY_RE =
  /\b(automated|automation|automatic|system|background|codex|fleet|cron|scheduled|overnight|job runs?|batch|reviews?|all sessions|every session|everything running)\b/i;

function sessionVoiceInclude({ query = '', probeLevel = 0 } = {}) {
  if (Number(probeLevel) >= 1) return 'all';
  return AUTOMATED_SESSION_QUERY_RE.test(String(query || '')) ? 'all' : 'owner';
}

// Words that say nothing about WHICH session the owner means.
const TITLE_QUERY_STOP = new Set(
  [
    'the a an and or of on in for to with about from my our your that this these those it its is was were be been',
    'how what whats when where which who why did does do doing done go going went gone get got status update',
    'session sessions thread threads chat chats conversation one work working worked today yesterday tonight',
    'morning afternoon evening night last earlier recent latest current there here any some going on tell me',
    'give quick summary progress happen happened happening result results',
  ]
    .join(' ')
    .split(/\s+/),
);

function titleStem(word) {
  return String(word || '')
    .toLowerCase()
    .replace(/(?:ing|ed|es|s)$/, '');
}

function titleWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !TITLE_QUERY_STOP.has(w))
    .map(titleStem)
    .filter((w) => w.length >= 3);
}

/**
 * The owner names a session the way the app shows it ("the planning session" for
 * "Quarterly planning"). Before any freshness ranking, pick the one owner session
 * whose app title shares the most distinctive words with what he asked; ties go
 * to the newest. Returns null when no title shares a word, so the general
 * lookup still handles everything else.
 */
// Spoken words that mean the same thing as a title word ("search" can name an
// "applications" session). Stems on both sides.
const TITLE_SYNONYMS = {
  search: ['application', 'apply', 'hunt'],
  hunt: ['application', 'search'],
  apply: ['application'],
  email: ['mail', 'inbox'],
  mail: ['email', 'inbox'],
  call: ['phone', 'voice'],
  phone: ['call', 'voice'],
};

function titleCovers(titleSet, word) {
  return titleSet.has(word) || (TITLE_SYNONYMS[word] || []).some((alt) => titleSet.has(alt));
}

function matchOwnerSessionByTitle(records, query) {
  const asked = new Set(titleWords(query));
  if (!asked.size) return null;
  const scored = [];
  for (const record of records || []) {
    if (!record || record.initiator !== 'owner' || !record.sessionTitle) continue;
    const titleSet = new Set(titleWords(record.sessionTitle));
    const hits = [...asked].filter((w) => titleCovers(titleSet, w)).length;
    // At least half of what he said must be in the title, so one shared word
    // ("seat") cannot pull a long, different question onto the wrong session.
    if (!hits || hits * 2 < asked.size) continue;
    scored.push({ record, hits, title: record.sessionTitle.trim().toLowerCase() });
  }
  if (!scored.length) return null;
  const top = Math.max(...scored.map((s) => s.hits));
  const leaders = scored.filter((s) => s.hits === top).sort((a, b) => b.record._sortTs - a.record._sortTs);
  // A partial match shared by differently titled sessions is a guess; leave it
  // to the general ranking. Same title (a reopened thread) goes to the newest.
  if (top < asked.size && new Set(leaders.map((s) => s.title)).size > 1) return null;
  return leaders[0].record;
}

// A session the owner names (or the one a "go deeper" follow-up is still on) is the
// whole evidence set, so another task or thread can never outrank it.
function pinNamedSession({ records, cloudSessions, rawQuery, query, fromCursor, priorSessionId } = {}) {
  const sessions = cloudSessions || [];
  let named = null;
  if (fromCursor) {
    named = priorSessionId ? sessions.find((r) => r && r.id === priorSessionId) || null : null;
  } else if (rawQuery) {
    named = matchOwnerSessionByTitle(sessions, rawQuery);
  }
  if (!named) return { records: records || [], query, sessionId: null };
  return { records: [named], query: named.sessionTitle, sessionId: named.id };
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
  ownerLimit = OWNER_SESSION_LIMIT,
  recentMs = RECENT_SESSION_MS,
  ownerRecentMs = OWNER_RECENT_SESSION_MS,
  // 'owner' (default): only sessions the owner started. 'all': automated runs too,
  // for a deeper probe or an explicit ask about background work.
  include = 'owner',
  projection = null,
} = {}) {
  const includeAutomated = include === 'all';
  let plane = projection;
  if (!plane) {
    try {
      plane = readVoiceProjection({ dataDir });
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
    const { initiator, initiatorSource } = sessionInitiator(session, activities);
    if (initiator === 'automated' && !includeAutomated) continue;
    const windowMs = initiator === 'owner' ? Math.max(recentMs, ownerRecentMs) : recentMs;
    if (liveness !== 'active' && Number.isFinite(sortTs) && nowMs - sortTs > windowMs) continue;

    const title = speakableTitle(session, mainActivities);
    const ownerPrompts = sessionOwnerPrompts(session, mainActivities);
    // A tag echoed back as the app title ("B") is nothing the owner would say, so it
    // is not a name he can pin a session by.
    const appTitle = stripImageMarkers(session.session_title);
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
      initiator,
      initiatorSource,
      sessionTitle: isTagOnlyTitle(appTitle) ? '' : appTitle,
      kind: 'action',
      title,
      prompt: title,
      resultSummary: detail,
      detail,
      status,
      liveness,
      updatedAt: isoOrNull(session.updated_at || (latestActivity && latestActivity.updated_at)),
      // When the session started, so "yesterday" can leave out one begun today.
      firstActivityAt: isoOrNull(
        session.started_at ||
          session.created_at ||
          (mainActivities[0] && (mainActivities[0].occurred_at || mainActivities[0].updated_at)),
      ),
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
      tags: hashtagsFrom(ownerPrompts),
      // What the owner asked, for "you mean the one where you asked..." and drill-in.
      intent: sessionIntent(session),
      ownerPrompts: ownerPrompts.slice(-6),
      lastPrompt: ownerPrompts.map(wordsBeyondTags).filter((t) => t.length > 2).pop() || '',
      dialogue: dialogueTurns(mainActivities),
      _source: 'session-cloud',
      _sortTs: Number.isFinite(sortTs) ? sortTs : 0,
    });
  }

  // The owner's own sessions first, then unknown, then automated; newest first in each.
  const rank = { owner: 0, unknown: 1 };
  records.sort((a, b) => (rank[a.initiator] ?? 2) - (rank[b.initiator] ?? 2) || b._sortTs - a._sortTs);
  const owned = records.filter((r) => r.initiator === 'owner').slice(0, ownerLimit);
  const rest = records.filter((r) => r.initiator !== 'owner').slice(0, limit);
  return [...owned, ...rest];
}

module.exports = {
  readVoiceSessionCloudRecords,
  // exported for tests and for callers that need the same liveness vocabulary
  deriveLiveness,
  speakableTitle,
  isTagOnlyTitle,
  topicText,
  sessionOwnerPrompts,
  sessionIntent,
  isOwnerPromptText,
  hashtagsFrom,
  sessionInitiator,
  matchOwnerSessionByTitle,
  pinNamedSession,
  sessionVoiceInclude,
  stripImageMarkers,
  SOURCE_FRESH_MS,
  RECENT_SESSION_MS,
  OWNER_RECENT_SESSION_MS,
};
