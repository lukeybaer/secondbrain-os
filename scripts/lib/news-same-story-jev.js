'use strict';

// Jev same-story check for the news cards (owner decision).
//
// A candidate headline is a REPEAT only when it reports the same specific
// story or event as a headline delivered in yesterday's briefing for the same
// card ("Fed holds rates" again). A new story on the same broad subject with
// new facts is NOT a repeat. This replaces the word-overlap yesterday block
// and the topic-word rule, which dropped too many good stories.
//
// Order-sensitive decision: every batch runs forward and reversed (the
// reversed pass reverses candidate order, prior order and every Choice
// criterion list) and a repeat needs agreement with min probability >= 0.90
// (the lane-4 convention in jev-decision-gate.js). Anything unsettled is KEPT.
//
// Privacy and spend: only headline text, source name and date go to Jev. No
// URLs, bodies or private context. Calls go through oneDecision on the
// existing decision-control lane, so existing Jev control-plane caps apply;
// no new spend lane is added.
//
// Jev down (budget refusal, network, malformed answer): fall back to exact
// canonical-URL and exact normalized-title blocking only, and report the card
// as degraded. Degraded dedup never fails a card.

const {
  oneDecision,
  choiceProbability,
  reversedQuestions,
  DEFAULT_CONFIDENCE,
} = require('./jev-decision-gate.js');
const { canonicalNewsUrl, normalizedStoryTitle } = require('./news-story-identity.js');

const SAME_STORY_SURFACE = 'news-same-story-yesterday';
const SAME_STORY_CONFIDENCE = DEFAULT_CONFIDENCE;
const SAME_STORY_BATCH = 8;
const PRIOR_HEADLINE_LIMIT = 30;

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function shiftDay(date, deltaDays) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + deltaDays);
  return value.toISOString().slice(0, 10);
}

// Headlines delivered in yesterday's briefing for one card.
function yesterdayHeadlines(priorStories = [], { cardId, date } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return [];
  const yesterday = shiftDay(date, -1);
  return (priorStories || [])
    .filter((row) => row && row.date === yesterday && (!cardId || row.cardId === cardId) && row.title)
    .slice(0, PRIOR_HEADLINE_LIMIT);
}

// Free, deterministic, always on: exact URL or exact normalized title.
function exactRepeat(candidate, priorHeadlines = []) {
  const url = canonicalNewsUrl(candidate.url || candidate.link || '');
  const title = normalizedStoryTitle(candidate.title);
  for (const prior of priorHeadlines) {
    const priorUrl = canonicalNewsUrl(prior.url || '');
    if (url && priorUrl && url === priorUrl) return prior;
    if (title && title === normalizedStoryTitle(prior.title)) return prior;
  }
  return null;
}

function sameStoryQuestions(candidateIds, priorIds) {
  const criteria = { none: 'Not the same specific story or event as any prior headline.' };
  for (const id of priorIds) criteria[id] = `The same specific story or event as prior headline ${id}.`;
  return Object.fromEntries(
    candidateIds.map((id) => [
      `same_${id}`,
      {
        type: 'choice',
        instructions:
          `Is candidate headline ${id} the SAME SPECIFIC STORY OR EVENT as one of the headlines delivered yesterday? ` +
          'Choose that prior headline only when both report the same underlying development (for example, the Fed holding rates reported again). ' +
          'A new story on the same broad subject, or the same subject with new facts, is NOT the same story: choose none.',
        criteria,
      },
    ]),
  );
}

function sameStoryState(candidates, priors) {
  return {
    candidates: candidates.map((row) => ({
      id: row.id,
      headline: clean(row.title, 300),
      source: clean(row.source, 120),
      date: clean(row.date, 32),
    })),
    yesterday_headlines: priors.map((row) => ({
      id: row.id,
      headline: clean(row.title, 300),
      source: clean(row.source, 120),
      date: clean(row.date, 32),
    })),
  };
}

async function decideBatch(batch, priors, { decide, deps }) {
  const candidateIds = batch.map((row) => row.id);
  const priorIds = priors.map((row) => row.id);
  const forwardQuestions = sameStoryQuestions(candidateIds, priorIds);
  const first = await decide({
    state: sameStoryState(batch, priors),
    questions: forwardQuestions,
    surface: SAME_STORY_SURFACE,
    deps,
  });
  const reversedBatch = batch.slice().reverse();
  const reversedPriors = priors.slice().reverse();
  const second = await decide({
    state: sameStoryState(reversedBatch, reversedPriors),
    questions: reversedQuestions(
      sameStoryQuestions(candidateIds.slice().reverse(), priorIds.slice().reverse()),
    ),
    surface: `${SAME_STORY_SURFACE}:reversed`,
    deps,
  });
  const out = new Map();
  for (const row of batch) {
    const a = first && first.answers && first.answers[`same_${row.id}`];
    const b = second && second.answers && second.answers[`same_${row.id}`];
    if (!a || !b) throw Object.assign(new Error('Jev same-story answer missing'), { code: 'jev_incomplete_answer' });
    const choice = String(a.choice || '');
    const reversedChoice = String(b.choice || '');
    // Agreement means both passes name the SAME answer: the same yesterday
    // headline, or none. Two passes naming different priors is an
    // order-dependent match, so the candidate stays (peer review 2026-11-03:
    // a false repeat drops a story, the exact failure S-1 fixes). Each pass
    // must clear 0.90.
    const agreement = Boolean(choice && reversedChoice && choice === reversedChoice);
    const minProbability = agreement ? Math.min(choiceProbability(a, choice), choiceProbability(b, reversedChoice)) : 0;
    const settled = agreement && minProbability >= SAME_STORY_CONFIDENCE;
    const prior = settled && choice !== 'none' ? priors.find((p) => p.id === choice) : null;
    out.set(row.id, { repeat: Boolean(prior), prior: prior || null, minProbability, settled });
  }
  return out;
}

// Returns Map(candidateId -> { repeat, prior, method }) plus card-level
// degraded state. `candidates` need { id, title, url?, source?, date? }.
async function judgeAgainstYesterday({
  candidates = [],
  priorHeadlines = [],
  decide = oneDecision,
  deps = {},
  batchSize = SAME_STORY_BATCH,
  jevAvailable = () => true,
  onJevFailure = () => {},
} = {}) {
  const priors = priorHeadlines.map((row, index) => ({ ...row, id: `y${index + 1}` }));
  const decisions = new Map();
  const pending = [];
  for (const candidate of candidates) {
    const exact = exactRepeat(candidate, priors);
    if (exact) decisions.set(candidate.id, { repeat: true, prior: exact, method: 'exact' });
    else pending.push(candidate);
  }
  let degraded = false;
  let degradedReason = '';
  if (!priors.length) {
    for (const row of pending) decisions.set(row.id, { repeat: false, prior: null, method: 'no-prior' });
    return { decisions, degraded, degradedReason };
  }
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    if (jevAvailable()) {
      try {
        const answered = await decideBatch(batch, priors, { decide, deps });
        for (const row of batch) decisions.set(row.id, { ...answered.get(row.id), method: 'jev' });
        continue;
      } catch (error) {
        degradedReason = `${(error && error.code) || 'jev_error'}: ${clean(error && error.message, 160)}`;
        onJevFailure(error);
      }
    }
    degraded = true;
    if (!degradedReason) degradedReason = 'jev_unavailable';
    for (const row of batch) decisions.set(row.id, { repeat: false, prior: null, method: 'exact-only-degraded' });
  }
  return { decisions, degraded, degradedReason };
}

module.exports = {
  SAME_STORY_SURFACE,
  SAME_STORY_CONFIDENCE,
  SAME_STORY_BATCH,
  yesterdayHeadlines,
  exactRepeat,
  judgeAgainstYesterday,
};
