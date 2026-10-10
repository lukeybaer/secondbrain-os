'use strict';

const crypto = require('node:crypto');

const { newsStoriesDuplicate, normalizedStoryTitle } = require('./news-story-identity.js');

// ExampleCo, 2026-09-16: twenty tries a day, not eight.
//
// Eight was a cap on ADMITTED attempts, not on churn. The same-story,
// same-tactic refusal below already stops repeated work on one story. On the
// night of 2026-09-15 into 2026-09-16 the AI & TECH card spent all eight units
// on eight DIFFERENT stories between 23:01 and 23:03 CT, five of those
// write-ups failed for provider reasons, and the card was then frozen at five
// of ten for the rest of the day with twenty-one unused fresh candidates in its
// own pool. US froze at six, World at two.
const DEFAULT_MAX_ATTEMPTS_PER_CARD = 20;
const LEDGER_SCHEMA = 'secondbrain.news-attempt-ledger.v1';

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

function compactText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function materialEvidence(item = {}) {
  return compactText(
    item.sourceText || item.bodyText || item.articleText || item.fullText || item.description || '',
  );
}

function materialAttemptShape(cardKey, item = {}, context = {}) {
  const title = String(item.publisherTitle || item.title || '').trim();
  const evidence = materialEvidence(item);
  return {
    cardKey: String(cardKey || ''),
    storyTitle: normalizedStoryTitle(title),
    evidenceHash: evidence ? sha256(evidence) : '',
    tactic: compactText(context.tactic || 'canonical-package-from-article-body'),
    priorRejection: compactText(context.priorRejection || ''),
    sourceVersion: compactText(context.sourceVersion || ''),
    codeVersion: compactText(context.codeVersion || ''),
    verifierVersion: compactText(context.verifierVersion || ''),
  };
}

function materialAttemptFingerprint(cardKey, item = {}, context = {}) {
  return sha256(JSON.stringify(materialAttemptShape(cardKey, item, context)));
}

function createNewsAttemptLedger({ maxAttemptsPerCard = DEFAULT_MAX_ATTEMPTS_PER_CARD } = {}) {
  const cap = Math.max(1, Math.min(DEFAULT_MAX_ATTEMPTS_PER_CARD, Number(maxAttemptsPerCard) || 0));
  return {
    schema: LEDGER_SCHEMA,
    maxAttemptsPerCard: cap,
    cards: {},
  };
}

function cardLedger(ledger, cardKey) {
  if (!ledger || ledger.schema !== LEDGER_SCHEMA) {
    throw new Error('news attempt admission requires a canonical attempt ledger');
  }
  const key = String(cardKey || '').trim();
  if (!key) throw new Error('news attempt admission requires cardKey');
  if (!ledger.cards[key]) {
    ledger.cards[key] = { attempted: 0, refused: 0, attempts: [], refusals: [] };
  }
  return ledger.cards[key];
}

function substantiallySameAttempt(prior = {}, item = {}, shape = {}) {
  if (String(prior.fingerprint || '') === sha256(JSON.stringify(shape))) return true;
  const sameStory = newsStoriesDuplicate(
    { title: prior.storyTitle || prior.sourceTitle, url: '' },
    { title: item.publisherTitle || item.title || '', url: '' },
  );
  if (!sameStory) return false;
  return (
    String(prior.tactic || '') === String(shape.tactic || '') &&
    String(prior.priorRejection || '') === String(shape.priorRejection || '')
  );
}

function mergeNewsAttemptLedgers(
  ledgers = [],
  { maxAttemptsPerCard = DEFAULT_MAX_ATTEMPTS_PER_CARD } = {},
) {
  const merged = createNewsAttemptLedger({ maxAttemptsPerCard });
  for (const ledger of Array.isArray(ledgers) ? ledgers : []) {
    if (!ledger || ledger.schema !== LEDGER_SCHEMA) continue;
    for (const [cardKey, sourceCard] of Object.entries(ledger.cards || {})) {
      const target = cardLedger(merged, cardKey);
      for (const row of Array.isArray(sourceCard && sourceCard.attempts)
        ? sourceCard.attempts
        : []) {
        const item = { title: row.storyTitle || row.sourceTitle || '' };
        const shape = {
          cardKey,
          storyTitle: normalizedStoryTitle(item.title),
          evidenceHash: String(row.evidenceHash || ''),
          tactic: String(row.tactic || ''),
          priorRejection: String(row.priorRejection || ''),
          sourceVersion: String(row.sourceVersion || ''),
          codeVersion: String(row.codeVersion || ''),
          verifierVersion: String(row.verifierVersion || ''),
        };
        if (target.attempts.some((prior) => substantiallySameAttempt(prior, item, shape))) continue;
        target.attempts.push({
          ...row,
          storyTitle: shape.storyTitle,
          priorRejection: shape.priorRejection,
        });
      }
      target.attempted = target.attempts.length;
    }
  }
  return merged;
}

function admitNewsAttempt(ledger, cardKey, item = {}, context = {}, now = new Date()) {
  const card = cardLedger(ledger, cardKey);
  const shape = materialAttemptShape(cardKey, item, context);
  const fingerprint = sha256(JSON.stringify(shape));
  const sourceTitle = String(item.publisherTitle || item.title || '')
    .trim()
    .slice(0, 300);
  const prior = card.attempts.find((row) => substantiallySameAttempt(row, item, shape));
  if (prior) {
    const refusal = {
      at: now.toISOString(),
      reason: 'substantially-same-attempt',
      fingerprint,
      priorFingerprint: prior.fingerprint,
      sourceTitle,
    };
    card.refused += 1;
    card.refusals.push(refusal);
    return { admitted: false, ...refusal };
  }
  if (card.attempted >= ledger.maxAttemptsPerCard) {
    const refusal = {
      at: now.toISOString(),
      reason: 'attempt-budget-exhausted',
      fingerprint,
      sourceTitle,
    };
    card.refused += 1;
    card.refusals.push(refusal);
    return { admitted: false, ...refusal };
  }
  const attempt = {
    at: now.toISOString(),
    fingerprint,
    sourceTitle,
    storyTitle: shape.storyTitle,
    evidenceHash: shape.evidenceHash,
    tactic: shape.tactic,
    priorRejection: shape.priorRejection,
    sourceVersion: shape.sourceVersion,
    codeVersion: shape.codeVersion,
    verifierVersion: shape.verifierVersion,
    outcome: 'in-flight',
  };
  card.attempted += 1;
  card.attempts.push(attempt);
  return { admitted: true, fingerprint, attemptNumber: card.attempted };
}

function settleNewsAttempt(ledger, cardKey, fingerprint, outcome) {
  const card = cardLedger(ledger, cardKey);
  const attempt = card.attempts.find((row) => row.fingerprint === fingerprint);
  if (attempt) attempt.outcome = String(outcome || 'unknown');
  return attempt || null;
}

function compactNewsAttemptLedger(ledger) {
  return {
    schema: LEDGER_SCHEMA,
    maxAttemptsPerCard:
      Number(ledger && ledger.maxAttemptsPerCard) || DEFAULT_MAX_ATTEMPTS_PER_CARD,
    cards: Object.fromEntries(
      Object.entries((ledger && ledger.cards) || {}).map(([key, card]) => [
        key,
        {
          attempted: Number(card.attempted) || 0,
          refused: Number(card.refused) || 0,
          attempts: (card.attempts || []).map((row) => ({
            fingerprint: row.fingerprint,
            sourceTitle: row.sourceTitle,
            storyTitle: row.storyTitle,
            evidenceHash: row.evidenceHash,
            tactic: row.tactic,
            priorRejection: row.priorRejection,
            sourceVersion: row.sourceVersion,
            codeVersion: row.codeVersion,
            verifierVersion: row.verifierVersion,
            outcome: row.outcome,
          })),
          refusals: (card.refusals || []).map((row) => ({
            reason: row.reason,
            fingerprint: row.fingerprint,
            priorFingerprint: row.priorFingerprint || '',
            sourceTitle: row.sourceTitle,
          })),
        },
      ]),
    ),
  };
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS_PER_CARD,
  LEDGER_SCHEMA,
  admitNewsAttempt,
  compactNewsAttemptLedger,
  createNewsAttemptLedger,
  materialAttemptFingerprint,
  materialAttemptShape,
  mergeNewsAttemptLedgers,
  settleNewsAttempt,
  substantiallySameAttempt,
};
