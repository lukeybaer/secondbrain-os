'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readReportEvents } = require('./overnight-report-event-ledger.js');

const CANDIDATE_SCHEMA = 'watcher-learning-candidate@1';
const PROMOTION_SCHEMA = 'watcher-learning-promotion@1';
const OBSERVATION_SCHEMA = 'overnight-watch-observation@2';
const TERMINAL_DEFECT_ASSERTION = 'terminal-defect-event';

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function candidateIdentity(row) {
  const promotionBound = Boolean(row.assertionType && row.eventId);
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        date: row.date,
        ...(promotionBound
          ? { assertionType: row.assertionType, eventId: row.eventId }
          : {
              key: row.key,
              expectedMechanism: row.expectedMechanism,
              observedBreak: row.observedBreak,
              canonicalEvidence: row.canonicalEvidence,
            }),
      }),
    )
    .digest('hex');
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

function promotionPath(dataDir) {
  return path.join(dataDir, 'agent', 'watcher-learning-promotions.jsonl');
}

function observationPath(dataDir) {
  return path.join(dataDir, 'agent', 'overnight-watch-observations.jsonl');
}

function promoteWatcherLearningCandidates({
  dataDir,
  date,
  candidateFile,
  nowMs = Date.now(),
} = {}) {
  const day = String(date || '').slice(0, 10);
  if (!dataDir || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error('watcher learning promotion requires dataDir and YYYY-MM-DD date');
  }
  const promotionsFile = promotionPath(dataDir);
  const prior = readJsonl(promotionsFile);
  const processed = new Set(prior.map((row) => row.candidateIdentity).filter(Boolean));
  const events = readReportEvents({ dataDir, date: day }).rows;
  const eventsById = new Map(events.map((row) => [row.eventId, row]));
  const candidates = readJsonl(
    candidateFile || path.join(dataDir, 'agent', 'watcher-learning-candidates.jsonl'),
  ).filter((row) => row && row.schema === CANDIDATE_SCHEMA && row.date === day);
  const results = [];

  for (const candidate of candidates) {
    const identity = candidateIdentity(candidate);
    if (processed.has(identity)) continue;
    const event = eventsById.get(String(candidate.eventId || ''));
    const verified = Boolean(
      candidate.assertionType === TERMINAL_DEFECT_ASSERTION &&
      event &&
      event.terminal === true &&
      event.countsAsDefect === true &&
      ['blocked', 'stale', 'failed'].includes(String(event.outcome || '')),
    );
    const ts = new Date(nowMs).toISOString();
    const promotion = {
      schema: PROMOTION_SCHEMA,
      ts,
      date: day,
      candidateIdentity: identity,
      candidateKey: String(candidate.key || '').slice(0, 120),
      assertionType: String(candidate.assertionType || ''),
      eventId: String(candidate.eventId || ''),
      status: verified ? 'promoted' : 'rejected',
      reason: verified
        ? 'canonical terminal lifecycle event independently proves the registered assertion'
        : 'candidate does not resolve to a same-date canonical terminal defect event',
    };
    appendJsonl(promotionsFile, promotion);
    processed.add(identity);

    if (verified) {
      const subject = String(event.subjectId || 'unknown work unit');
      const component = String(event.sourceComponent || event.kind || 'watcher component');
      appendJsonl(observationPath(dataDir), {
        schema: OBSERVATION_SCHEMA,
        ts,
        date: day,
        kind: 'learning',
        key: `verified-event-${event.eventId.slice(0, 20)}`,
        title: `Verified lifecycle break for ${subject}`.slice(0, 180),
        detail:
          `Expected ${component} to close ${subject} with acceptance evidence; ` +
          `the canonical lifecycle event ended ${event.outcome}/${event.state}.`,
        evidence:
          `Canonical event ${event.eventId}; source run ${event.sourceRunId || 'unavailable'}; ` +
          `timestamp ${event.ts}.`,
        source: 'trusted-watcher-candidate-promoter',
        candidateIdentity: identity,
      });
    }
    results.push(promotion);
  }

  return {
    checked: candidates.length,
    processed: results.length,
    promoted: results.filter((row) => row.status === 'promoted').length,
    rejected: results.filter((row) => row.status === 'rejected').length,
    promotionsFile,
  };
}

module.exports = {
  TERMINAL_DEFECT_ASSERTION,
  candidateIdentity,
  promoteWatcherLearningCandidates,
  promotionPath,
};
