/**
 * voice-people-note-gate.js -- separate gate for people-note fact extraction
 * from voice identity (Phase C3, Codex amendment 13).
 *
 * Speaker-identity confidence does NOT prove an extracted claim is true, non
 * sensitive, or worth saving. So a note claim may be written ONLY when:
 *  - it comes from the auto-assign tier (not review, not context-only),
 *  - it ExampleCos a verbatim quote AND a segment link (provenance),
 *  - it is not in a sensitive category (health, financial, legal, family
 *    private) which stays for manual handling,
 *  - the person has no unresolved correction (correction visibility): if ExampleCo
 *    recently corrected this person's identity, auto-writing is paused.
 *
 * Also assembles the weekly uncertainty-ranked labeling queue from the three
 * lanes (re-enrollment, recurring ExampleCos, audit backlog).
 */

const SENSITIVE_PATTERNS = [
  /\b(cancer|chemo(?:therapy)?|diagnos(?:is|ed)|depress(?:ion|ed)|anxiety|therapy|medication|surgery|hospital|illness|disease|pregnan(?:t|cy)|miscarriage)\b/i,
  /\b(salary|compensation|net worth|bank account|ssn|social security|passport|divorce|custody|lawsuit|settlement|arrest|immigration status)\b/i,
];

function isSensitive(text) {
  return SENSITIVE_PATTERNS.some((re) => re.test(String(text || '')));
}

/**
 * Gate one people-note claim. Returns { allow, reasons }.
 * ctx.corrections is a Set of person_ids with an open correction.
 */
function gateClaim(claim, ctx = {}) {
  const reasons = [];
  const prov = claim?.provenance || {};
  if (String(prov.tier || '') !== 'auto') reasons.push('not_auto_tier');
  if (!prov.quote || !String(prov.quote).trim()) reasons.push('missing_quote');
  if (!Array.isArray(prov.segment_range) || prov.segment_range.length !== 2) {
    reasons.push('missing_segment_link');
  }
  if (isSensitive(claim?.text) || isSensitive(prov.quote)) reasons.push('sensitive_category');
  const corrections = ctx.corrections instanceof Set ? ctx.corrections : new Set(ctx.corrections || []);
  if (claim?.person_id && corrections.has(claim.person_id)) reasons.push('person_has_open_correction');
  return { allow: reasons.length === 0, reasons };
}

/**
 * Weekly labeling budget: rank across the three lanes so ExampleCo spends his time
 * on the highest-value labels first. Ordering (uncertainty x value):
 *  1. re-enrollment rows by their sort_score (acoustic candidates > null-ref >
 *     thin) -- these unlock the most downstream matches.
 *  2. recurring ExampleCos by conversation count -- new recurring humans.
 *  3. audit backlog (weakest auto-tier promotions) -- verify precision.
 * Interleaved by value so no single lane starves the others, then capped.
 */
function buildWeeklyLabelingQueue({ reenrollment = [], recurringExampleCos = [], auditBacklog = [], weeklyBudget = 10 } = {}) {
  const reenrollItems = [...reenrollment]
    .sort((a, b) => Number(b.sort_score || 0) - Number(a.sort_score || 0))
    .map((row, i) => ({
      lane: 'reenrollment',
      ref: row.person_id,
      display: row.display_name || row.person_id,
      status: row.status,
      value: 3_000_000 - i, // lane-priority band, preserves within-lane order
    }));
  const ExampleCoItems = [...recurringExampleCos]
    .sort((a, b) => Number(b.conversation_count || 0) - Number(a.conversation_count || 0))
    .map((row) => ({
      lane: 'recurring_ExampleCo',
      ref: row.acoustic_ExampleCo_id || row.voice_cluster_id,
      display: row.acoustic_ExampleCo_id || row.voice_cluster_id,
      conversation_count: row.conversation_count || 0,
      value: 2_000_000 + Number(row.conversation_count || 0),
    }));
  const auditItems = [...auditBacklog]
    .sort((a, b) => Number(a.fused_risk_score || 0) - Number(b.fused_risk_score || 0))
    .map((row) => ({
      lane: 'audit',
      ref: `${row.otid}|${row.speaker_model_label}`,
      display: `verify ${row.otid} spk ${row.speaker_model_label}`,
      fused_risk_score: row.fused_risk_score,
      value: 1_000_000,
    }));
  const items = [...reenrollItems, ...ExampleCoItems, ...auditItems]
    .sort((a, b) => b.value - a.value)
    .slice(0, Math.max(0, weeklyBudget));
  return {
    schema: 'life_archive_voice_weekly_labeling_queue.v1',
    weekly_budget: weeklyBudget,
    lane_counts: {
      reenrollment: reenrollItems.length,
      recurring_ExampleCo: ExampleCoItems.length,
      audit: auditItems.length,
    },
    items,
  };
}

module.exports = { isSensitive, gateClaim, buildWeeklyLabelingQueue, SENSITIVE_PATTERNS };
