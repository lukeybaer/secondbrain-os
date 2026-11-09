'use strict';

// read_session: the drill-in behind check_spine. Owner decision: "my goal is
// to be able to dialogue with her on the development we're doing. so she
// should be able to pull the whole prompt in/output transcript if required and
// intelligently speak to that." check_spine says which session; this hands the
// voice model what the owner asked that session and what it answered, so it can
// answer his question about it in its own words.

const { readVoiceProjection, readFullProjectionCached } = require('./session-cloud-plane');
const { sessionOwnerPrompts, sessionIntent, stripImageMarkers, isOwnerPromptText } = require('./voice-session-cloud-records');

const READING_MAX_CHARS = 6000;
const TURN_MAX_CHARS = 1200;
const PROMPTS_MAX = 8;
const PROMPTS_SHARE = 0.3;

const FIRST_RE = /\b(first|1st|former)\b/i;
const SECOND_RE = /\b(second|2nd|other)\b/i;
const THIRD_RE = /\b(third|3rd)\b/i;
const LAST_RE = /\b(last|latter)\b/i;
// Words that only point back at what Amy just said ("yes, the second one",
// "read me that"). Anything else is a topic, so "the first quarter report" is
// looked up, never read as a pick.
const SELECTION_WORDS = new Set(
  (
    'the that this one session yes yeah yep right correct ok okay sure please i mean read me it ' +
    'open pull up go ahead same no um uh so first second third 1st 2nd 3rd former latter other last'
  ).split(' '),
);
const MISSING = "I can't find that session's record anymore. Which one do you mean?";

function isSelectionOnly(words) {
  return (String(words).toLowerCase().match(/[a-z0-9]+/g) || []).every((w) => SELECTION_WORDS.has(w));
}

// Which session the owner means. A pure pick ("the second one", "yes, that one")
// resolves against the sessions the last answer offered, then the session the
// call already pinned; anything else is a fresh lookup by his words. A lookup
// that is still a close call returns that answer's question instead of
// guessing. Ids are record ids, the form the call cursor pins.
function resolveSessionForReading({ ask = '', records = [], pickIds = [], lastSessionId = null, lookup = null } = {}) {
  const words = String(ask || '').trim();
  const found = (id) => {
    const record = records.find((r) => r && r.id === id) || null;
    return record ? { record } : { record: null, ask: MISSING };
  };
  const offered = (Array.isArray(pickIds) ? pickIds : []).filter(Boolean);
  if (isSelectionOnly(words)) {
    if (offered.length > 2 && THIRD_RE.test(words)) return found(offered[2]);
    if (offered.length > 1 && LAST_RE.test(words)) return found(offered[offered.length - 1]);
    if (offered.length > 1 && SECOND_RE.test(words)) return found(offered[1]);
    if (offered.length && FIRST_RE.test(words)) return found(offered[0]);
    if (offered.length === 1) return found(offered[0]);
    // A fresh choice outranks whatever was read before it.
    if (offered.length > 2) return { record: null, ask: 'Which one do you mean, the first, the second, or the third?' };
    if (offered.length > 1) return { record: null, ask: 'Which of the two do you mean, the first or the second?' };
    if (lastSessionId) return found(lastSessionId);
    return { record: null, ask: 'Which session do you mean?' };
  }
  if (typeof lookup === 'function') {
    const pick = {};
    const speech = lookup(words, pick);
    const ids = Array.isArray(pick.sessionIds) ? pick.sessionIds : [];
    if (pick.confident && ids.length === 1) return found(ids[0]);
    if (ids.length > 1) return { record: null, ask: speech, pickIds: ids };
  }
  return { record: null, ask: `I can't tell which session you mean by ${words}. Which one?` };
}

// Codex rows carry epoch seconds or ms where Claude rows carry ISO strings.
function tsOf(activity) {
  const v = activity.updated_at || activity.occurred_at;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  return Date.parse(v || '') || 0;
}

// Over budget keeps the opening and the end, where a reply puts its
// conclusion, and drops the middle.
function clean(text, max) {
  const s = stripImageMarkers(
    String(text || '')
      .replace(/<(system-reminder|task-notification)>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/\*\*|__|`/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.35)).replace(/\s+\S*$/, '');
  const tail = s.slice(-Math.floor(max * 0.6)).replace(/^\S*\s+/, '');
  return `${head} ... ${tail}`;
}

// The session's turns, oldest first: each of the owner's prompts and what the
// session reported back. Consecutive repeats collapse, since every tool step
// in a turn re-reports the same summary.
function sessionTurns(activities) {
  const turns = [];
  const push = (who, text, at) => {
    if (!text) return;
    const last = turns[turns.length - 1];
    if (last && last.who === who && last.text === text) return;
    turns.push({ who, text, at });
  };
  for (const a of activities) {
    const at = a.occurred_at || a.updated_at || '';
    const prompt = clean(a.prompt_summary, TURN_MAX_CHARS);
    if (prompt && isOwnerPromptText(prompt)) push('The owner', prompt, at);
    push('Session', clean(a.result_summary || a.progress_summary, TURN_MAX_CHARS), at);
  }
  return turns;
}

// The reading handed to the voice model: what the session is, what the owner wants
// from it, his prompts, then as many of the newest turns as fit, in order.
function sessionReadingText({ record, projection, question = '', maxChars = READING_MAX_CHARS } = {}) {
  if (!record) return '';
  const key = `${record.provider}:${record.sessionId}`;
  const session = (projection && projection.sessions && projection.sessions[key]) || {};
  const activities = Object.values((projection && projection.activities) || {})
    .filter((a) => a && a.provider === record.provider && a.session_id === record.sessionId)
    .filter((a) => String(a.source_kind || 'main').toLowerCase() === 'main')
    .sort((a, b) => tsOf(a) - tsOf(b));
  const status = record.liveness === 'active' || record.liveness === 'idle' ? 'still open' : record.status || 'finished';
  const head = [
    `Session: ${clean(record.sessionTitle || record.title, 200)} (${status}, last update ${record.updatedAt || 'unknown'}).`,
    question ? `The owner's question about it: ${clean(question, 400)}` : '',
    sessionIntent(session) ? `What the owner wants from it (latest recap): ${clean(sessionIntent(session), 700)}` : '',
  ].filter(Boolean);
  // The first prompt says how the session started; the latest say where it is.
  // Capped so a long session's prompt list never crowds out the transcript.
  const all = sessionOwnerPrompts(session, activities);
  const picked = all.length > PROMPTS_MAX ? [all[0], ...all.slice(-(PROMPTS_MAX - 1))] : all;
  const prompts = picked.map((p) => clean(p, 200));
  if (prompts.length) {
    const line = `The owner's prompts, oldest first${picked.length < all.length ? `, first and latest ${picked.length} of ${all.length}` : ''}: ${prompts.map((p) => `"${p}"`).join(' | ')}`;
    head.push(clean(line, Math.floor(maxChars * PROMPTS_SHARE)));
  }
  let budget = maxChars - head.join('\n').length - 40;
  const turns = sessionTurns(activities);
  const kept = [];
  for (let i = turns.length - 1; i >= 0 && budget > 80; i -= 1) {
    const line = `${turns[i].who}: ${turns[i].text}`;
    const fitted = line.length <= budget ? line : `${line.slice(0, budget).replace(/\s+\S*$/, '')} ...`;
    kept.unshift(fitted);
    budget -= fitted.length + 1;
  }
  const omitted = turns.length - kept.length;
  return [
    ...head,
    kept.length
      ? `Transcript${omitted > 0 ? `, newest ${kept.length} of ${turns.length} turns` : ''}:`
      : 'Transcript: none readable here, so answer only from the prompts above and say the replies are not available.',
    ...kept,
  ]
    .join('\n')
    .slice(0, maxChars);
}

// The first projection that holds this session, so a stale copy in an earlier
// directory cannot hide it. The cached voice copy answers almost every read; a
// session older than its window falls through to the full projection.
function readProjectionFrom(dataDirs = [], sessionKey = '') {
  for (const read of [readVoiceProjection, readFullProjectionCached]) {
    for (const dir of dataDirs) {
      try {
        const projection = read({ dataDir: dir });
        const sessions = (projection && projection.sessions) || {};
        if (sessionKey ? sessions[sessionKey] : Object.keys(sessions).length) return projection;
      } catch {
        /* next candidate */
      }
    }
  }
  return null;
}

module.exports = {
  READING_MAX_CHARS,
  resolveSessionForReading,
  sessionReadingText,
  sessionTurns,
  readProjectionFrom,
};
