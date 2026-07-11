/**
 * voice-enrollment-quarantine.js -- enrollment print hygiene (Phase C3 of
 * dev-plans/voiceprint-matching-audit-2026-07-11.html, Codex amendment 11).
 *
 * Human-confirmed clips are enrollment-grade. Auto-assigned clips go into a
 * quarantined candidate pool and graduate into a person's reference set ONLY
 * after audit, with enough net speech, direction-consistent with the existing
 * centroid (same voice, but not a near-duplicate that adds nothing), and not an
 * outlier. This is the poisoning defense: one confident wrong auto-assign can
 * never self-reinforce into the print.
 */

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

const DEFAULTS = {
  minNetSpeech: 10,
  minConsistency: 0.6, // must be the same voice as the existing centroid
  maxConsistency: 0.999, // but not a near-duplicate that adds no information
};

/**
 * Decide whether a quarantined candidate clip may graduate into the reference
 * set. Returns { graduate, reasons, consistency }.
 */
function evaluateGraduation(candidate, referenceCentroid, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const reasons = [];
  if (!candidate?.audited) reasons.push('not_audited');
  const net = Number(candidate?.net_speech_seconds || 0);
  if (net < opts.minNetSpeech) reasons.push('below_net_speech');
  const consistency = Array.isArray(candidate?.vector) && Array.isArray(referenceCentroid)
    ? cosine(candidate.vector, referenceCentroid)
    : 0;
  if (consistency < opts.minConsistency) reasons.push('direction_inconsistent_outlier');
  else if (consistency > opts.maxConsistency) reasons.push('duplicate_no_new_info');
  return { graduate: reasons.length === 0, reasons, consistency: Number(consistency.toFixed(6)) };
}

/**
 * Partition a candidate pool into enrollment-grade vs quarantined. A clip is
 * enrollment-grade if it is human-confirmed (source ExampleCo_confirmed / manual),
 * or if it is auto-assigned AND graduates the audit gate above. Everything else
 * stays quarantined with its blocking reasons.
 */
function partitionEnrollmentPool(pool, referenceCentroid, options = {}) {
  const enrollment_grade = [];
  const quarantined = [];
  for (const clip of pool || []) {
    const source = String(clip?.source || '');
    if (source === 'ExampleCo_confirmed' || source === 'manual' || source === 'human_confirmed') {
      enrollment_grade.push({ ...clip, graduation: { graduate: true, reasons: ['human_confirmed'] } });
      continue;
    }
    const verdict = evaluateGraduation(clip, referenceCentroid, options);
    if (verdict.graduate) enrollment_grade.push({ ...clip, graduation: verdict });
    else quarantined.push({ ...clip, graduation: verdict });
  }
  return { enrollment_grade, quarantined };
}

module.exports = { cosine, evaluateGraduation, partitionEnrollmentPool, DEFAULTS };
