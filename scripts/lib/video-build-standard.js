'use strict';

/**
 * One production standard for owner-triggered video builds.
 *
 * ExampleCo 2026-09-23: "I wanted opus 5.5 medium quality, why are we having two
 * different standards?" Every dashboard build (Approve for clip queue, Build
 * with feedback, Reject and regen) is produced by a model session on EC2 that
 * follows the video-production skill and the approved benchmark-motion method.
 * The deterministic ffmpeg builder (scripts/build-viral-clip.js composite
 * path) survives only as a labeled fallback when that session fails; it is
 * never substituted silently.
 *
 * This module owns the two labels, how a manifest row or proposal records
 * which one produced its bytes, and the owner-visible card wording.
 */

const MODEL_SESSION = 'model-session';
const DETERMINISTIC_FALLBACK = 'deterministic-fallback';
const BUILD_STANDARDS = Object.freeze([MODEL_SESSION, DETERMINISTIC_FALLBACK]);

// A script build that was not started by the spine fallback (a hand run, an
// old repair command) is still the lower standard and says so.
const DIRECT_SCRIPT_REASON = 'script build run directly, not through the model session';

function normalizeBuildStandard(value) {
  const v = String(value || '').trim();
  if (!BUILD_STANDARDS.includes(v)) {
    throw new Error(`unknown video build standard: ${JSON.stringify(v)}`);
  }
  return v;
}

/**
 * Stamp the standard onto a manifest row (or proposal) in place. A model build
 * clears any earlier fallback label so a rebuilt row cannot keep advertising
 * the old one.
 */
function stampBuildStandard(entry, { standard, model = '', effort = '', taskId = '', fallbackReason = '' } = {}) {
  if (!entry || typeof entry !== 'object') return entry;
  const s = normalizeBuildStandard(standard);
  entry.build_standard = s;
  entry.build_task_id = String(taskId || '') || null;
  if (s === MODEL_SESSION) {
    entry.build_model = String(model || '') || null;
    entry.build_effort = String(effort || '') || null;
    delete entry.build_fallback_reason;
  } else {
    entry.build_model = null;
    entry.build_effort = null;
    entry.build_fallback_reason = String(fallbackReason || DIRECT_SCRIPT_REASON).slice(0, 400);
  }
  return entry;
}

/** Owner-visible label, or '' for rows that predate the standard. */
function buildStandardLabel(row = {}) {
  const standard = String((row && (row.build_standard || row.built_build_standard)) || '');
  if (standard === DETERMINISTIC_FALLBACK) {
    const reason = String(row.build_fallback_reason || row.built_build_fallback_reason || DIRECT_SCRIPT_REASON);
    return `FALLBACK build: deterministic script, not the Opus model session. Reason: ${reason}`;
  }
  if (standard === MODEL_SESSION) {
    const model = row.build_model || row.built_build_model || '';
    const effort = row.build_effort || row.built_build_effort || '';
    return `Built by the model session${model ? ` (${model}${effort ? ` / ${effort}` : ''})` : ''}`;
  }
  return '';
}

module.exports = {
  BUILD_STANDARDS,
  DETERMINISTIC_FALLBACK,
  DIRECT_SCRIPT_REASON,
  MODEL_SESSION,
  buildStandardLabel,
  normalizeBuildStandard,
  stampBuildStandard,
};
