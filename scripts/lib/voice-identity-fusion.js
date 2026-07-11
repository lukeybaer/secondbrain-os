/**
 * voice-identity-fusion.js -- Bayesian fusion of calibrated acoustic evidence
 * with capped context priors, plus the 3-tier decision gate (Phase C2 of
 * dev-plans/voiceprint-matching-audit-2026-07-11.html).
 *
 * Non-negotiable rules encoded here (Codex amendments 3/12/15):
 * 1. Context NEVER creates acoustic identity. A track with no acoustic evidence
 *    can reach at most the review tier flagged context-only; it can never
 *    auto-assign. Context only MODULATES an existing acoustic candidate, so it
 *    can lift a near-miss into auto or pull a weak match down.
 * 2. The fused number is an UNCERTIFIED RISK SCORE. It is never called a
 *    probability, and coverage is reported separately, until the rolling
 *    precision audit certifies the operating point (voice-precision-audit.js).
 * 3. Blocked priors (circular / voice-derived-from-target) are excluded from
 *    the sum but retained in provenance.
 */

const { sumPriors } = require('./voice-context-priors');

function sigmoid(x) {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function logit(p) {
  const clamped = Math.min(1 - 1e-9, Math.max(1e-9, Number(p)));
  return Math.log(clamped / (1 - clamped));
}

/**
 * Combine one candidate's calibrated acoustic probability with its capped prior
 * log-odds. Returns the fused risk score plus the two component log-odds.
 * When no calibrated probability exists, the acoustic LLR is null and the
 * caller must treat the candidate as context-only (rule 1).
 */
function fuseCandidate({ acousticProbability, priorLogOdds = 0 }) {
  const acousticLlr = acousticProbability == null ? null : logit(acousticProbability);
  const priorLlr = Number(priorLogOdds || 0);
  if (acousticLlr == null) {
    // No acoustic evidence: the risk score reflects context alone, but the gate
    // (below) forbids this from ever auto-assigning.
    return { fused_risk_score: sigmoid(priorLlr), acoustic_llr: null, prior_llr: priorLlr };
  }
  const fusedLlr = acousticLlr + priorLlr;
  return { fused_risk_score: sigmoid(fusedLlr), acoustic_llr: acousticLlr, prior_llr: priorLlr };
}

/**
 * The 3-tier gate. auto requires acoustic evidence AND fused >= auto_gate AND
 * net speech >= floor. review is the middle band (or an auto candidate held
 * back by thin speech). A context-only candidate can never exceed review.
 */
function decideTier({ fused, netSpeechSeconds, hasAcousticEvidence, ops }) {
  const autoGate = Number(ops?.auto_gate ?? 0.999);
  const reviewFloor = Number(ops?.review_floor ?? 0.9);
  const minNetSpeech = Number(ops?.min_net_speech_seconds ?? 10);
  const reasons = [];
  if (!hasAcousticEvidence) {
    reasons.push('no_acoustic_evidence_context_only');
    // Context-only: at most review, and only if the context risk is high.
    if (Number(fused) >= reviewFloor) return { tier: 'review', reasons };
    return { tier: 'ExampleCo', reasons };
  }
  const speechOk = netSpeechSeconds == null || Number(netSpeechSeconds) >= minNetSpeech;
  if (Number(fused) >= autoGate) {
    if (speechOk) return { tier: 'auto', reasons: ['acoustic_evidence', 'fused_above_gate', 'net_speech_ok'] };
    reasons.push('below_net_speech_floor');
    return { tier: 'review', reasons };
  }
  if (Number(fused) >= reviewFloor) {
    reasons.push('fused_in_review_band');
    return { tier: 'review', reasons };
  }
  reasons.push('fused_below_review_floor');
  return { tier: 'ExampleCo', reasons };
}

/**
 * Fuse one track: pick the acoustic candidate (best match), apply that
 * candidate's context priors, decide the tier, and emit full provenance.
 * priorRows are C1 evidence rows; only rows for the acoustic candidate person
 * modulate the score (context cannot introduce a different person).
 */
function fuseTrack({ target, acoustic, netSpeechSeconds, priorRows = [], ops }) {
  const acousticPersonId = acoustic?.person_id || null;
  const hasAcousticEvidence = Boolean(
    acousticPersonId && (acoustic.probability != null || acoustic.score != null),
  );
  // Candidate under evaluation: the acoustic match if any, else the strongest
  // context-only hypothesis (which can never auto-assign).
  const rowsForAcoustic = priorRows.filter(
    (row) => row.candidate_person_id && row.candidate_person_id === acousticPersonId,
  );
  const priorSum = sumPriors(rowsForAcoustic);
  const priorsApplied = rowsForAcoustic.filter((row) => !row.blocked);
  const priorsBlocked = priorRows.filter((row) => row.blocked);

  let candidatePersonId = acousticPersonId;
  let candidateDisplayName = acoustic?.display_name || null;
  let contextOnly = false;
  if (!hasAcousticEvidence) {
    // Strongest context-only hypothesis, for review surfacing only.
    const byPerson = new Map();
    for (const row of priorRows) {
      if (row.blocked || !row.candidate_person_id) continue;
      byPerson.set(row.candidate_person_id, (byPerson.get(row.candidate_person_id) || 0) + Number(row.log_odds || 0));
    }
    const top = [...byPerson.entries()].sort((a, b) => b[1] - a[1])[0] || null;
    candidatePersonId = top ? top[0] : null;
    contextOnly = true;
  }

  const fusion = fuseCandidate({
    acousticProbability: acoustic?.probability ?? null,
    priorLogOdds: hasAcousticEvidence ? priorSum : sumPriors(priorRows.filter((r) => r.candidate_person_id === candidatePersonId)),
  });
  const decision = decideTier({
    fused: fusion.fused_risk_score,
    netSpeechSeconds,
    hasAcousticEvidence,
    ops,
  });

  return {
    target,
    candidate_person_id: candidatePersonId,
    display_name: candidateDisplayName,
    tier: decision.tier,
    context_only: contextOnly,
    fused_risk_score: Number(fusion.fused_risk_score.toFixed(6)),
    score_kind: 'uncertified_risk_score',
    provenance: {
      acoustic: {
        person_id: acousticPersonId,
        score: acoustic?.score ?? null,
        margin: acoustic?.margin ?? null,
        probability: acoustic?.probability ?? null,
        llr: fusion.acoustic_llr,
        has_acoustic_evidence: hasAcousticEvidence,
      },
      prior_llr: Number(fusion.prior_llr.toFixed(6)),
      priors_applied: priorsApplied.map((row) => ({
        term: row.term,
        log_odds: row.log_odds,
        independence: row.independence,
        quote: row.provenance?.quote || '',
        source: row.provenance?.source || '',
      })),
      priors_blocked: priorsBlocked.map((row) => ({
        term: row.term,
        blocked_reason: row.blocked_reason || '',
      })),
      net_speech_seconds: netSpeechSeconds ?? null,
      reasons: decision.reasons,
    },
  };
}

module.exports = { sigmoid, logit, fuseCandidate, decideTier, fuseTrack };
