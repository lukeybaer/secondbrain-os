'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { nameJudgeArtifactCurrent } = require('./jev-name-judge.js');

function readJson(file, fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function normalizedTarget(value) {
  return String(value || '')
    .replace(/^unknown:/, '')
    .trim()
    .toLowerCase();
}

function speakerJevTargets(speaker) {
  return [
    ...(Array.isArray(speaker?.acoustic_unknown_ids) ? speaker.acoustic_unknown_ids : []),
    speaker?.speaker_id,
  ]
    .map(normalizedTarget)
    .filter((value, index, values) =>
      /^unknown_voice_ecapa_/.test(value) && values.indexOf(value) === index,
    );
}

function substantiveUnknownSpeaker(speaker) {
  if (!speaker || speaker.person_id) return false;
  // A substantive diarized track without a durable acoustic id is missing
  // upstream voiceprint coverage. It must keep Jev coverage unavailable,
  // rather than disappearing from the denominator and letting the card turn
  // green before the acoustic producer has finished the call.
  const words = Number(speaker.word_count || 0);
  return !(
    speaker.small_or_late_joiner === true &&
    Number.isFinite(words) &&
    words > 0 &&
    words <= 12
  );
}

function currentSourceRevision(dataDir, otid, cache) {
  if (cache.has(otid)) return cache.get(otid);
  const enriched = readJson(path.join(dataDir, 'otter', 'enriched', `${otid}.json`));
  const revision = String(enriched?.source_revision || enriched?.source_revision_hash || '')
    .trim()
    .toLowerCase();
  cache.set(otid, revision);
  return revision;
}

function loadJevCallReviewIndex({ dataDir, fsApi = fs } = {}) {
  const byCall = new Map();
  const sourceRevisionCache = new Map();
  const dir = path.join(dataDir || '', 'life-archive', 'voiceprints', 'llm-name-judges');
  let names = [];
  try {
    names = fsApi.readdirSync(dir);
  } catch {
    return byCall;
  }
  for (const name of names) {
    if (!/^name-judge-.*\.json$/i.test(name) || name === 'name-judge-latest.json') continue;
    const report = readJson(path.join(dir, name), fsApi);
    if (
      !report ||
      !String(report.judge_provider || '').split('+').includes('jev') ||
      !nameJudgeArtifactCurrent(report)
    ) {
      continue;
    }
    const generatedMs = Date.parse(String(report.generated_at || ''));
    const summaries = new Map(
      (Array.isArray(report.target_summaries) ? report.target_summaries : []).map((row) => [
        normalizedTarget(row?.target),
        row,
      ]),
    );
    for (const judgment of report?.judged?.targets || []) {
      const target = normalizedTarget(judgment?.target);
      const summary = summaries.get(target);
      if (!target || summary?.coverage_complete !== true || judgment?.coverage_complete !== true) {
        continue;
      }
      for (const rawOtid of summary.scoped_otids || []) {
        const otid = String(rawOtid || '').trim();
        if (!otid) continue;
        const recordedRevision = String(
          judgment?.source_revision_by_otid?.[otid] ||
            summary?.source_revision_by_otid?.[otid] ||
            report?.source_revision_by_otid?.[otid] ||
            '',
        )
          .trim()
          .toLowerCase();
        const liveRevision = currentSourceRevision(dataDir, otid, sourceRevisionCache);
        if (!recordedRevision || !liveRevision || recordedRevision !== liveRevision) continue;
        if (!byCall.has(otid)) byCall.set(otid, new Map());
        const prior = byCall.get(otid).get(target);
        if (prior && Number(prior.generatedMs || 0) > Number(generatedMs || 0)) continue;
        byCall.get(otid).set(target, {
          target,
          bestName: String(judgment.best_name || '').trim(),
          generatedMs: Number.isFinite(generatedMs) ? generatedMs : 0,
          sourceRevision: recordedRevision || liveRevision || '',
          method: report.judge_method,
        });
      }
    }
  }
  return byCall;
}

function applyJevCallReviews(calls, reviewIndex) {
  const stats = {
    eligibleSpeakerRows: 0,
    reviewedSpeakerRows: 0,
    acceptedSpeakerRows: 0,
    abstainedSpeakerRows: 0,
    missingSpeakerRows: 0,
    acceptedNames: 0,
  };
  const names = new Set();
  const reviewedCalls = (Array.isArray(calls) ? calls : []).map((call) => {
    const otid = String(call?.otid || call?.id || '').trim();
    const judgments = reviewIndex instanceof Map ? reviewIndex.get(otid) : null;
    const callStats = {
      eligibleSpeakerRows: 0,
      reviewedSpeakerRows: 0,
      acceptedSpeakerRows: 0,
      abstainedSpeakerRows: 0,
      missingSpeakerRows: 0,
    };
    const speakers = (Array.isArray(call?.speakers) ? call.speakers : []).map((speaker) => {
      const copied = { ...(speaker || {}) };
      if (!substantiveUnknownSpeaker(copied)) return copied;
      const targets = speakerJevTargets(copied);
      if (!targets.length) {
        callStats.eligibleSpeakerRows += 1;
        callStats.missingSpeakerRows += 1;
        return copied;
      }
      callStats.eligibleSpeakerRows += 1;
      const rows = targets.map((target) => judgments?.get(target)).filter(Boolean);
      if (rows.length !== targets.length) {
        callStats.missingSpeakerRows += 1;
        return copied;
      }
      callStats.reviewedSpeakerRows += 1;
      copied.jev_name_reviewed = true;
      delete copied.name_hypothesis;
      delete copied.hypothesis_confidence;
      delete copied.hypothesis_evidence_count;
      delete copied.hypothesis_source;
      delete copied.hypothesis_matched_durable_ids;
      const accepted = [...new Set(rows.map((row) => row.bestName).filter(Boolean))];
      if (accepted.length === 1) {
        copied.name_hypothesis = accepted[0];
        copied.hypothesis_source = rows[0].method;
        callStats.acceptedSpeakerRows += 1;
        names.add(accepted[0].toLowerCase());
      } else {
        callStats.abstainedSpeakerRows += 1;
      }
      return copied;
    });
    const coverageStatus =
      callStats.missingSpeakerRows === 0 ? 'available' : 'unavailable';
    for (const key of Object.keys(callStats)) stats[key] += callStats[key];
    return {
      ...(call || {}),
      speakers,
      jevNameReview: { ...callStats, coverageStatus },
    };
  });
  stats.acceptedNames = names.size;
  stats.coverageStatus = stats.missingSpeakerRows === 0 ? 'available' : 'unavailable';
  return { calls: reviewedCalls, stats };
}

function jevReviewStatsForCalls(calls) {
  const stats = {
    eligibleSpeakerRows: 0,
    reviewedSpeakerRows: 0,
    acceptedSpeakerRows: 0,
    abstainedSpeakerRows: 0,
    missingSpeakerRows: 0,
  };
  for (const call of Array.isArray(calls) ? calls : []) {
    const row = call?.jevNameReview || {};
    for (const key of Object.keys(stats)) stats[key] += Number(row[key] || 0);
  }
  stats.coverageStatus = stats.missingSpeakerRows === 0 ? 'available' : 'unavailable';
  return stats;
}

module.exports = {
  applyJevCallReviews,
  jevReviewStatsForCalls,
  loadJevCallReviewIndex,
  speakerJevTargets,
  substantiveUnknownSpeaker,
};
