// telegram-context-window.js
//
// E2 (Amy overhaul, 2026-06-12): askAmy used a hardcoded loadRecentTurns(8)
// window, so "what about the other one" or a Telegram reply to a week-old
// message got a context-blind answer. This module is the pure window
// selector: the caller fetches a LARGER raw slice of the conversation log
// (newest last, the loadRecentTurns output order) and this trims it
// intelligently:
//
//  - normal message: the default recent window (8 turns)
//  - short follow-up ("and?", "did it work?", "what about the other one"):
//    expand toward maxTurns
//  - references an earlier topic (token overlap with turns OLDER than the
//    default window): expand toward maxTurns
//  - Telegram reply (replyToText provided): the replied-to turn and its
//    neighbors are ALWAYS included, regardless of age; when the replied-to
//    text is not in the slice at all, a synthetic context turn ExampleCos it
//  - maxChars is a hard budget over the sum of turn texts, dropping the
//    oldest non-mandatory turns first
//
// Pure: no I/O, fully unit-testable.

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'is',
  'are',
  'was',
  'were',
  'be',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'as',
  'by',
  'it',
  'this',
  'that',
  'i',
  'you',
  'we',
  'do',
  'did',
  'done',
  'can',
  'will',
  'so',
  'my',
  'me',
  'amy',
  'please',
  'thanks',
  'ok',
  'okay',
  'yes',
  'no',
  'how',
  'what',
  'when',
  'about',
  'your',
  'just',
  'now',
  'get',
  'got',
  'up',
  'out',
]);

function tokens(text) {
  return (
    String(text || '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) || []
  ).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Short follow-ups lean on prior context by definition. Category detection:
// very short messages, question fragments, and continuation openers.
const FOLLOW_UP_RE =
  /^(and\b|so\b|then\b|also\b|but\b|what about\b|how about\b|did (it|that|they|the)\b|does (it|that|the)\b|is (it|that|the)\b|was (it|that)\b|any (luck|update|news|progress)\b|what happened\b|the other one\b|that one\b|same (one|thing)\b|still\b|again\b)/i;

function isShortFollowUp(message) {
  const t = String(message || '').trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words <= 3) return true;
  if (words <= 5 && /\?\s*$/.test(t)) return true;
  return FOLLOW_UP_RE.test(t);
}

// True when the message shares meaningful tokens with turns OLDER than the
// default window but NOT with the recent window: a strong signal the user is
// reaching back to an earlier topic.
function referencesOlderTopic(message, turnsNewestLast, defaultTurns) {
  const turns = Array.isArray(turnsNewestLast) ? turnsNewestLast : [];
  if (turns.length <= defaultTurns) return false;
  const msgTokens = tokens(message);
  if (!msgTokens.length) return false;
  const older = turns.slice(0, turns.length - defaultTurns);
  const recent = turns.slice(-defaultTurns);
  const olderText = older
    .map((t) => (t && t.text) || '')
    .join(' ')
    .toLowerCase();
  const recentText = recent
    .map((t) => (t && t.text) || '')
    .join(' ')
    .toLowerCase();
  let hits = 0;
  for (const tok of msgTokens) {
    if (olderText.includes(tok) && !recentText.includes(tok)) hits++;
  }
  return hits >= 1;
}

// Locate the replied-to turn in the slice by text containment (Telegram gives
// us the replied-to TEXT, not a log offset). Returns the index or -1.
function findRepliedTurnIndex(turnsNewestLast, replyToText) {
  const needle = String(replyToText || '').trim();
  if (!needle) return -1;
  const probe = needle.slice(0, 120).toLowerCase();
  for (let i = turnsNewestLast.length - 1; i >= 0; i--) {
    const text = String((turnsNewestLast[i] && turnsNewestLast[i].text) || '').toLowerCase();
    if (!text) continue;
    if (text.includes(probe) || probe.includes(text.slice(0, 120))) return i;
  }
  return -1;
}

// selectConversationWindow(allTurnsNewestLast, message, opts)
//   allTurnsNewestLast: [{ role: 'user'|'assistant', text }] chronological
//   (oldest first, newest last; the loadRecentTurns output order).
// Returns the trimmed window, chronological, total text <= maxChars.
function selectConversationWindow(allTurnsNewestLast, message, opts = {}) {
  const { defaultTurns = 8, maxTurns = 40, maxChars = 6000, replyToText = '' } = opts;
  const turns = (Array.isArray(allTurnsNewestLast) ? allTurnsNewestLast : []).filter(
    (t) => t && typeof t.text === 'string' && t.text.trim(),
  );
  if (!turns.length && !replyToText) return [];

  const expand =
    isShortFollowUp(message) ||
    referencesOlderTopic(message, turns, defaultTurns) ||
    Boolean(String(replyToText || '').trim());

  let selected = expand ? turns.slice(-maxTurns) : turns.slice(-defaultTurns);

  // Reply context is mandatory: the replied-to turn plus its immediate
  // neighbors, regardless of how old they are within the raw slice.
  const mandatory = new Set();
  if (String(replyToText || '').trim()) {
    const idx = findRepliedTurnIndex(turns, replyToText);
    if (idx >= 0) {
      for (const t of turns.slice(Math.max(0, idx - 1), Math.min(turns.length, idx + 2))) {
        mandatory.add(t);
      }
    } else {
      // Replied-to message predates the raw slice: synthesize the context so
      // the model still sees what ExampleCo is replying to.
      const synthetic = {
        role: 'assistant',
        text: '[earlier message ExampleCo is replying to] ' + String(replyToText).slice(0, 1000),
      };
      mandatory.add(synthetic);
      selected = [synthetic, ...selected];
    }
  }
  for (const t of mandatory) {
    if (!selected.includes(t)) selected = [t, ...selected];
  }
  // Restore chronological order (synthetic/mandatory turns keep slice order).
  const orderOf = new Map(turns.map((t, i) => [t, i]));
  selected.sort(
    (a, b) => (orderOf.has(a) ? orderOf.get(a) : -1) - (orderOf.has(b) ? orderOf.get(b) : -1),
  );

  // Hard character budget: keep mandatory turns first, then fill newest-first.
  // Never mutates caller turns: a trimmed mandatory turn is replaced by a copy.
  const replacements = new Map();
  const chosen = new Set();
  let used = 0;
  for (const t of selected) {
    if (!mandatory.has(t)) continue;
    const cost = t.text.length;
    if (used + cost > maxChars) {
      // Even mandatory context bows to the absolute budget: trim a copy.
      const room = Math.max(0, maxChars - used);
      if (room > 40) {
        chosen.add(t);
        replacements.set(t, { role: t.role, text: t.text.slice(0, room) });
        used += room;
      }
      continue;
    }
    chosen.add(t);
    used += cost;
  }
  for (let i = selected.length - 1; i >= 0; i--) {
    const t = selected[i];
    if (chosen.has(t)) continue;
    const cost = t.text.length;
    if (used + cost > maxChars) continue;
    chosen.add(t);
    used += cost;
  }

  return selected.filter((t) => chosen.has(t)).map((t) => replacements.get(t) || t);
}

module.exports = {
  selectConversationWindow,
  isShortFollowUp,
  referencesOlderTopic,
  findRepliedTurnIndex,
};
