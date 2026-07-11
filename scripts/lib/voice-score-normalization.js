/**
 * voice-score-normalization.js -- adaptive score normalization (AS-Norm) and a
 * binned logistic calibrator for the voiceprint resolver (Phase B2 of
 * dev-plans/voiceprint-matching-audit-2026-07-11.html, Codex amendments 7-8).
 *
 * Why: a fixed raw-cosine threshold drifts with utterance duration, channel,
 * and cohort similarity. AS-Norm rescales each trial against its most
 * competitive impostor cohort; the calibrator maps scores to probabilities so
 * the operating point is an audited precision target, not a hand-picked
 * cosine. The decision gate is precision-first: the legacy raw gate keeps
 * working unchanged, and the calibrated path can only ADD accepts that clear
 * the probability gate plus raw safety floors.
 *
 * Cohort purity (Codex amendment 8): callers pass per-trial exclusions
 * (same-call otids); the normalizer itself drops cohort entries that are
 * near-duplicates of either trial side (cosine >= NEAR_DUPLICATE_COSINE), so a
 * cohort contaminated with the trial speaker cannot distort the statistics.
 */

const NEAR_DUPLICATE_COSINE = 0.9;

function cosine(a, b) {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  const n = Math.min(a?.length || 0, b?.length || 0);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

function topKStats(scores, k) {
  const top = [...scores].sort((a, b) => b - a).slice(0, Math.max(1, k));
  const mean = top.reduce((sum, v) => sum + v, 0) / top.length;
  const variance = top.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / top.length;
  return { mean, std: Math.sqrt(Math.max(variance, 1e-6)) };
}

/**
 * Build an AS-Norm normalizer over a cohort of {id, otids, vector} entries.
 * normalize(rawScore, enrollVec, testVec, {excludeOtids, excludeIds}) returns
 * the symmetric adaptive z-score: mean of the enroll-side and test-side
 * normalizations against the top-K most competitive eligible cohort entries.
 */
function buildNormalizer(cohort, options = {}) {
  const topK = Math.max(1, Number(options.topK || 100));
  const entries = (cohort || []).filter((row) => Array.isArray(row?.vector) && row.vector.length);
  let lastTrialIds = [];
  function eligibleFor(enrollVec, testVec, opts = {}) {
    const excludeOtids = opts.excludeOtids || new Set();
    const excludeIds = opts.excludeIds || new Set();
    const out = [];
    for (const row of entries) {
      if (excludeIds.has(row.id)) continue;
      if ((row.otids || []).some((otid) => excludeOtids.has(otid))) continue;
      if (cosine(row.vector, enrollVec) >= NEAR_DUPLICATE_COSINE) continue;
      if (cosine(row.vector, testVec) >= NEAR_DUPLICATE_COSINE) continue;
      out.push(row);
    }
    return out;
  }
  return {
    cohortSize: entries.length,
    lastTrialCohortIds: () => lastTrialIds,
    normalize(rawScore, enrollVec, testVec, opts = {}) {
      const eligible = eligibleFor(enrollVec, testVec, opts);
      lastTrialIds = eligible.map((row) => row.id);
      if (eligible.length < 5) return null; // too thin to normalize honestly
      const enrollScores = eligible.map((row) => cosine(enrollVec, row.vector));
      const testScores = eligible.map((row) => cosine(testVec, row.vector));
      const e = topKStats(enrollScores, topK);
      const t = topKStats(testScores, topK);
      return 0.5 * ((rawScore - e.mean) / e.std + (rawScore - t.mean) / t.std);
    },
  };
}

/**
 * Fit a 1-feature logistic regression P(genuine | score) from binned
 * genuine/impostor histograms via deterministic gradient descent. Bins are
 * rows {score, genuine, impostor} where counts act as sample weights.
 */
function fitLogisticBinned(bins, options = {}) {
  const iterations = Number(options.iterations || 4000);
  const learningRate = Number(options.learningRate || 0.5);
  let w0 = 0;
  let w1 = 0;
  const rows = (bins || []).filter(
    (row) => Number(row.genuine || 0) + Number(row.impostor || 0) > 0,
  );
  const total = rows.reduce(
    (sum, row) => sum + Number(row.genuine || 0) + Number(row.impostor || 0),
    0,
  );
  if (!rows.length || !total) return { weights: { intercept: 0, score: 0 }, trained: false };
  for (let iter = 0; iter < iterations; iter += 1) {
    let g0 = 0;
    let g1 = 0;
    for (const row of rows) {
      const x = Number(row.score || 0);
      const p = 1 / (1 + Math.exp(-(w0 + w1 * x)));
      const genuine = Number(row.genuine || 0);
      const impostor = Number(row.impostor || 0);
      // gradient of weighted log-loss: (p - y) summed with counts as weights
      g0 += (p - 1) * genuine + p * impostor;
      g1 += ((p - 1) * genuine + p * impostor) * x;
    }
    w0 -= (learningRate * g0) / total;
    w1 -= (learningRate * g1) / total;
  }
  return {
    weights: { intercept: Number(w0.toFixed(8)), score: Number(w1.toFixed(8)) },
    trained: true,
  };
}

function logisticProbability(model, score) {
  const w = model?.weights || {};
  if (!model?.trained && !w.score) return null;
  return 1 / (1 + Math.exp(-(Number(w.intercept || 0) + Number(w.score || 0) * Number(score))));
}

/**
 * Precision-first decision gate (Codex amendments 3/7): the legacy raw gate
 * (score + margin) always works; a calibrated probability can only ADD an
 * accept when it clears the probability operating point AND the raw safety
 * floors (min raw score floor + the unchanged margin gate). Returns
 * {accept, path: 'raw_gate'|'calibrated_gate'|'rejected', reasons}.
 */
function decideMatch({ rawScore, rawMargin, probability, ops }) {
  const o = ops || {};
  const rawGate =
    Number(rawScore) >= Number(o.raw_score_gate ?? 0.56) &&
    Number(rawMargin) >= Number(o.raw_margin_gate ?? 0.06);
  if (rawGate) return { accept: true, path: 'raw_gate', reasons: ['raw_score_and_margin'] };
  const probOk =
    probability != null && Number(probability) >= Number(o.calibrated_probability_gate ?? 0.99);
  const floorOk = Number(rawScore) >= Number(o.calibrated_min_raw_floor ?? 0.45);
  const marginOk = Number(rawMargin) >= Number(o.raw_margin_gate ?? 0.06);
  if (probOk && floorOk && marginOk) {
    return {
      accept: true,
      path: 'calibrated_gate',
      reasons: ['calibrated_probability', 'raw_floor', 'margin_gate'],
    };
  }
  return { accept: false, path: 'rejected', reasons: [] };
}

module.exports = {
  cosine,
  topKStats,
  buildNormalizer,
  fitLogisticBinned,
  logisticProbability,
  decideMatch,
  NEAR_DUPLICATE_COSINE,
};
