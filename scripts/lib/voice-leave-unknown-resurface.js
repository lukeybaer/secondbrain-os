'use strict';

// LEAVE-UNKNOWN IS A PAUSE, NOT A TOMBSTONE (ExampleCo, 2026-08-24, voice review
// surface).
//
//   "If I leave someone unknown, bring them back up if they appear on another
//    call."
//
// When ExampleCo presses "Leave unknown" he is saying "I cannot place this voice
// from what you have shown me", not "never ask me again". The decision is a
// receipt about the EVIDENCE HE SAW, so it expires the moment the evidence
// changes. A new call carrying that same acoustic identity is new evidence:
// more speech, more context, possibly a name said out loud. The identity
// becomes reviewable again, with its updated call count.
//
// WHAT THIS REPLACES. The previous rule was a 24-hour timer: a leave-unknown
// stayed suppressed unless `last_seen` was more than 24h past the decision. Two
// things were wrong with it. First, it is a clock, not an event: a call landing
// 20 minutes after ExampleCo's decision left the voice silently suppressed even
// though brand-new speech existed. Second, it silently resurfaced voices that
// had NO new call at all, whenever a stale `last_seen` happened to sit more
// than a day after the action timestamp. Both directions were wrong, so this
// module grades the actual question instead: HAS A NEW CALL LANDED SINCE ExampleCo
// DECIDED?
//
// EVIDENCE PRECEDENCE, strongest first:
//   1. Call count. Decisions written after this rule landed record
//      `callCountAtDecision`. A current count strictly greater than the count
//      ExampleCo saw is unambiguous proof of a new call, immune to clock skew and to
//      an unset or backfilled `last_seen`.
//   2. Last-seen timestamp. Older ledger rows carry no call count (verified on
//      the live ledger: all 17 pre-existing `dont_know` rows lack the field).
//      For those, a `last_seen` strictly after the decision time means a call
//      containing this identity landed after ExampleCo decided. No grace window: the
//      whole point is that ANY new appearance brings the voice back.
//   3. Neither available. Stay suppressed. Absence of evidence is not evidence
//      of a new call, and inventing a resurface would put a voice back in front
//      of ExampleCo that he already dismissed with nothing new to show him.
//
// This module is intentionally pure and has no I/O, so both the render path and
// the queue builder can share one definition and cannot drift apart.

const LEAVE_UNKNOWN_STATUS = 'left_unknown_by_ExampleCo';

// Decisions recorded BEFORE this instant cannot carry a baseline, because the
// fields that hold one (`call_count_at_decision`, `otids_at_decision`) ship with
// this change. Only those decisions may use the legacy one-time return below.
//
// Codex adversarial review 2026-08-24: without an explicit cutoff the legacy
// branch would also swallow a MODERN decision whose baseline is missing because
// something malformed or dropped it, and silently resurface it. After the
// cutover a null baseline is a defect, not a legacy row, so it fails closed.
const LEGACY_BASELINE_CUTOFF_MS = Date.parse('2026-08-25T02:00:00.000Z');

function parseTime(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

// A durable per-call identity set. Counts are NOT monotonic: a recluster can
// add one call and drop another, leaving the count identical while the identity
// genuinely appeared on a new call. Set ADDITION is the real event ExampleCo
// described, so when both sides are known it outranks the count.
function parseOtids(value) {
  if (!Array.isArray(value)) return null;
  const out = new Set(value.map((v) => String(v || '').trim()).filter(Boolean));
  return out.size ? out : null;
}

function parseCount(value) {
  // `Number(null)` and `Number('')` are both 0, so a missing count would
  // otherwise masquerade as a real "zero calls" reading and win precedence over
  // the last-seen fallback. Absent must stay absent.
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Decide whether a leave-unknown decision still suppresses this identity.
 *
 * @param {object} input
 * @param {string} input.decidedAt      ISO timestamp of the leave-unknown action.
 * @param {number|null} [input.callCountAtDecision]  Calls ExampleCo saw when deciding.
 * @param {number|null} [input.currentCallCount]     Calls the identity carries now.
 * @param {string} [input.lastSeen]     Most recent call timestamp for the identity.
 * @returns {{suppressed: boolean, reason: string, evidence: string}}
 */
function leaveUnknownSuppression({
  decidedAt = '',
  callCountAtDecision = null,
  currentCallCount = null,
  otidsAtDecision = null,
  currentOtids = null,
  lastSeen = '',
} = {}) {
  const decidedMs = parseTime(decidedAt);
  if (!decidedMs) {
    // A decision with no readable timestamp cannot be compared against
    // anything. Fail toward ExampleCo's last explicit instruction and stay quiet.
    return {
      suppressed: true,
      reason: 'undated_decision',
      evidence:
        'the leave-unknown decision carries no readable timestamp, so no new call can be proven',
    };
  }

  // 1. Call-identity set. Immune to a recluster that swaps one call for another.
  const decidedOtids = parseOtids(otidsAtDecision);
  const nowOtids = parseOtids(currentOtids);
  if (decidedOtids && nowOtids) {
    const added = [...nowOtids].filter((otid) => !decidedOtids.has(otid));
    if (added.length) {
      return {
        suppressed: false,
        reason: 'new_call_by_otid_set',
        evidence: `${added.length} call${added.length === 1 ? '' : 's'} carrying this voice landed after ExampleCo left it unknown`,
      };
    }
    return {
      suppressed: true,
      reason: 'no_new_call_by_otid_set',
      evidence: 'every call carrying this voice was already present when ExampleCo left it unknown',
    };
  }

  const decidedCount = parseCount(callCountAtDecision);
  const nowCount = parseCount(currentCallCount);
  if (decidedCount !== null && nowCount !== null) {
    if (nowCount > decidedCount) {
      return {
        suppressed: false,
        reason: 'new_call_by_count',
        evidence: `this voice was on ${decidedCount} call${decidedCount === 1 ? '' : 's'} when ExampleCo left it unknown and is on ${nowCount} now`,
      };
    }
    return {
      suppressed: true,
      reason: 'no_new_call_by_count',
      evidence: `still ${nowCount} call${nowCount === 1 ? '' : 's'}, the same count ExampleCo saw when he left it unknown`,
    };
  }

  // ORDER NOTE, Codex adversarial review 2026-08-24 asked for the last-seen
  // fallback to be restricted to pre-cutover decisions so a post-cutover null
  // baseline always fails closed. Declined deliberately, and here is why.
  //
  // `lastSeen` is not a baseline; it is independent source-of-truth evidence
  // from the call record. When it is strictly later than the decision, a call
  // carrying this voice genuinely landed AFTER ExampleCo passed on it. That is
  // exactly the event he described, and it is provable without any baseline. The
  // fail-closed guard exists for the case where we know NOTHING, not to discard
  // real evidence we do have.
  //
  // Failing closed here would keep a voice silent that we can prove reappeared,
  // which is the original defect ExampleCo reported. The cutover guard still fires
  // whenever last-seen is absent, which is the actual "cannot grade" case.
  const lastSeenMs = parseTime(lastSeen);
  if (lastSeenMs) {
    if (lastSeenMs > decidedMs) {
      return {
        suppressed: false,
        reason: 'new_call_by_last_seen',
        evidence: `this voice was heard again at ${new Date(lastSeenMs).toISOString()}, after ExampleCo left it unknown at ${new Date(decidedMs).toISOString()}`,
      };
    }
    return {
      suppressed: true,
      reason: 'no_new_call_by_last_seen',
      evidence: `this voice has not been heard since ExampleCo left it unknown at ${new Date(decidedMs).toISOString()}`,
    };
  }

  // LEGACY DECISIONS, no recoverable baseline.
  //
  // Every leave-unknown recorded before `callCountAtDecision` existed carries no
  // baseline, and the recluster rebuild route has no per-call timestamp either
  // (its clusters carry `otids` and members, no dates). Historical receipts can
  // therefore lack a baseline even when a current cluster remains active.
  //
  // Holding these suppressed would be the exact permanent silence ExampleCo rejected,
  // for precisely the people he already told us about. So when we can see the
  // identity is STILL ACTIVE (the rebuild handed us a current call count) but
  // cannot prove what ExampleCo saw, surface it once. He reviews it with its real
  // current count, and that decision banks a proper baseline, so this branch
  // can never fire twice for the same identity. A bounded one-time review of a
  // dozen voices beats twelve voices silently disappearing forever.
  //
  // This is NOT the same as having no evidence at all. A caller that supplies
  // nothing (a programming error) must never flood the queue, so that case
  // still fails closed below.
  if (nowCount !== null && decidedMs < LEGACY_BASELINE_CUTOFF_MS) {
    return {
      suppressed: false,
      reason: 'legacy_decision_no_baseline',
      evidence: `this voice is on ${nowCount} call${nowCount === 1 ? '' : 's'} now, and the earlier leave-unknown recorded no call count to compare against, so it returns once for review`,
    };
  }

  // Post-cutover, a decision with no baseline is a DEFECT, not a legacy row.
  // Failing closed keeps a dropped or malformed baseline from silently
  // resurfacing voices ExampleCo already dismissed.
  if (nowCount !== null) {
    return {
      suppressed: true,
      reason: 'missing_baseline_after_cutover',
      evidence:
        'this decision was recorded after the baseline cutover but carries no call count, so it cannot be graded and stays suppressed pending repair',
    };
  }

  return {
    suppressed: true,
    reason: 'no_new_call_evidence',
    evidence:
      'no call count and no last-heard timestamp are recorded, so a new call cannot be proven',
  };
}

/**
 * Convenience wrapper for render paths that only need the review status string.
 * Returns LEAVE_UNKNOWN_STATUS while suppressed and '' (unreviewed, i.e. back
 * in ExampleCo's queue) once a new call has landed.
 */
function leaveUnknownReviewStatus(input) {
  return leaveUnknownSuppression(input).suppressed ? LEAVE_UNKNOWN_STATUS : '';
}

module.exports = {
  LEAVE_UNKNOWN_STATUS,
  LEGACY_BASELINE_CUTOFF_MS,
  leaveUnknownSuppression,
  leaveUnknownReviewStatus,
};
