/**
 * regen-feedback-directives.js
 *
 * E6 2026-06-12 (ExampleCo gap, short002_wrongskill): the reject-and-regen loop
 * persisted ExampleCo's note ("Boring footage, not enough visual effects"),
 * triggered a regen, and ran the LLM interpreter -- then dropped everything
 * at the hand-off into the actual build, and the final gate had no rule
 * class for the note, so a substantively identical video promoted back to
 * pending_approval with the note cleared.
 *
 * This module is the single, unit-testable translation layer between
 * rejection notes and the build/verify machinery:
 *
 *   buildRegenDirectives(history) -> string[]
 *       Pure. Turns rejection notes into concrete production directives.
 *       Every non-empty note yields at least one directive (unmapped notes
 *       get a quote-the-note fallback directive; no silent drops).
 *
 *   mapNotesToCriteria(history, { allCriteria }) -> { criteria, unmappedNotes, flaggedAll }
 *       Pure. Data-driven note-keyword -> rubric-criteria mapping.
 *       Conservative: a note that matches no rule flags ALL criteria.
 *
 *   verifyImprovement({ history, priorScores, newScores, thresholds }) -> { ok, failures, ... }
 *       Pure given inputs. The mechanical post-regen check: every implicated
 *       criterion must (a) be scored at all (fail closed otherwise), and
 *       (b) improve vs the rejected version when a prior score exists, or
 *       (c) clear the rubric threshold when it does not.
 *
 *   resolveRejectionContext({ manifestEntry, historyCount, historyError })
 *       Pure. Fail-loud contract: a flagged video whose rejection history
 *       cannot be found/loaded must NOT be regenerated blind.
 *
 *   loadRejectionRows(id, { rejectionsPath }) -> rows
 *       Thin reader over content-review/rejections.jsonl filtered by id.
 *
 * Consumed by scripts/auto-regen-rejected-videos.js (runner),
 * scripts/lib/interpret-rejection-into-spec-overrides.js (prompt assembly),
 * and scripts/verify-rejection-tokens-in-artifact.js (the existing gate).
 * Memory rules: feedback_regen_must_translate_rejection_into_build_param_changes.md,
 * feedback_regen_must_verify_artifact_changed.md, feedback_rubric_is_the_gate_not_brightness.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readRejectionsJsonl } = require('./rejected-video-feedback.js');

const REPO = path.resolve(__dirname, '..', '..');
const THRESHOLDS_CANDIDATES = [
  path.join(REPO, 'data', 'agent', 'video-quality-thresholds.json'),
  '/opt/secondbrain/data/agent/video-quality-thresholds.json',
];

// Floor applied when a criterion has no entry in the thresholds file
// (e.g. music_presence / numbered_overlays, which are gate-only criteria).
const DEFAULT_FLOOR = 50;

// Fallback criteria list when the thresholds JSON is unreadable. Matches the
// shorts platform keys in data/agent/video-quality-thresholds.json. Fail
// closed: an unmapped note must still implicate the full rubric even when
// the thresholds file is missing.
const FALLBACK_CRITERIA = [
  'resolution',
  'clarity',
  'lighting',
  'color_grading',
  'framing',
  'transitions',
  'volume_levels',
  'background_noise',
  'voice_clarity',
  'music_mix',
  'pacing',
  'hook_strength',
  'retention_curve',
  'emotional_arc',
  'cta_placement',
  'codec_quality',
  'bitrate',
  'caption_readability',
  'thumbnail_appeal',
  'format_fit',
  'trending_topic_alignment',
  'hashtag_relevance',
  'camera_stability',
  'audio_dynamics',
  'scene_variety',
  'audio_edges',
  'thumbnail_first_frame',
];

// Data-driven note translation. Each rule maps a rejection-note keyword
// pattern to (a) concrete production directives the rebuild must satisfy and
// (b) the rubric criteria the post-regen gate must re-verify. Keep patterns
// category-shaped (the class of complaint), never pinned to one incident's
// literal wording (feedback_frugal_regression_tests.md).
const DIRECTIVE_RULES = [
  {
    name: 'visual_boredom',
    pattern:
      /boring|bland|dull|static\b|not\s+enough\s+(?:visual|effects?|motion|action)|visual\s+effects?|no\s+(?:video\s+)?diversity|same\s+(?:shots?|clip|footage|video)|repetitive|generic\s+(?:footage|b-?roll|stock)|(?:one|same)\s+video\s+the\s+whole\s+time|same\s+the\s+whole\s+time/i,
    directives: [
      'Raise visual energy: render motion overlays/animations at HIGH density (at least one visual event every 3 seconds, not a single outro event).',
      'Replace the stock footage: fetch NEW clips with different search queries and do not reuse any previously downloaded clip file.',
      'Cut between visually distinct scenes at least every 3-4 seconds so no single clip dominates the video.',
    ],
    criteria: ['scene_variety', 'transitions'],
  },
  {
    name: 'numbered_overlays',
    pattern: /number(?:ed|ing)?|step\s*\d|tools?\s+up\s+top|item\s+\d/i,
    directives: [
      'Render bold numbered overlays ("1.", "2.", ...) at the top of the screen, timed to the moment the narration names each item.',
    ],
    criteria: ['numbered_overlays'],
  },
  {
    name: 'music',
    pattern: /music|background\s+(?:music|audio|track)/i,
    directives: [
      'Mix an approved music bed under the narration (clearly audible, ducked below the voice) and verify the final track actually contains music.',
    ],
    criteria: ['music_presence'],
  },
  {
    name: 'audio_voice',
    pattern:
      /\b(?:audio|voice|narration|sound|crackl\w*|muffled|silen(?:t|ce)|volume|cuts?\s+off)\b/i,
    directives: [
      'Re-render the narration audio: regenerate TTS if degraded, de-ess and loudness-normalize, and verify no crackle, clipping, or mid-word cutoffs at the start or end.',
    ],
    criteria: ['voice_clarity', 'volume_levels', 'audio_edges'],
  },
  {
    name: 'thumbnail',
    pattern: /thumbnail|cover\s+image/i,
    directives: [
      'Regenerate the thumbnail with a fresh cinematic background and a readable headline; do not reuse the rejected thumbnail file.',
    ],
    criteria: ['thumbnail_appeal'],
  },
  {
    name: 'thumbnail_first_frame',
    pattern: /thumbnail.*first.*frame|thumbnail.*0\.1|thumbnail.*beginning/i,
    directives: [
      'Open the video on the approved thumbnail as the literal first decoded frame so the share preview matches the thumbnail.',
    ],
    criteria: ['thumbnail_first_frame'],
  },
  {
    name: 'pacing',
    pattern: /\bpacing\b|too\s+slow|too\s+fast|drags?\b|dragging|too\s+long|rushed/i,
    directives: [
      'Tighten pacing: trim dead air, shorten the script where it drags, and keep scene cuts frequent enough to hold retention.',
    ],
    criteria: ['pacing', 'retention_curve'],
  },
  {
    name: 'captions',
    pattern: /caption|subtitle|\bsync\b|word\s+timing|on-?screen\s+text/i,
    directives: [
      'Re-render word-aligned captions so on-screen text tracks the narration exactly; verify readability (size, contrast, 4-9 words per cue).',
    ],
    criteria: ['caption_readability'],
  },
  {
    name: 'hook',
    pattern: /\bhook\b|\bopening\b|first\s+(?:3|three)\s+seconds|\bintro\b/i,
    directives: [
      'Rebuild the first 3 seconds: stronger opening line, voice starting immediately, high-contrast opening visual.',
    ],
    criteria: ['hook_strength'],
  },
];

function noteText(row) {
  if (row == null) return '';
  if (typeof row === 'string') return row;
  return String(row.note || '');
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.map(noteText).filter((t) => t.trim());
}

// Pure: rejection notes -> concrete production directives. Every non-empty
// note contributes; a note matching no rule gets a quote-the-note fallback
// directive so feedback is never silently dropped.
function buildRegenDirectives(history) {
  const notes = normalizeHistory(history);
  const out = [];
  const seen = new Set();
  const add = (d) => {
    if (!seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  };
  for (const note of notes) {
    const matched = DIRECTIVE_RULES.filter((r) => r.pattern.test(note));
    if (matched.length === 0) {
      add(
        `Directly address this rejection and make it verifiable: "${note.trim()}" -- change the production inputs (script, footage, overlays, audio mix) so the dimension described is materially different from the rejected version.`,
      );
      continue;
    }
    for (const rule of matched) rule.directives.forEach(add);
  }
  return out;
}

// Pure: rejection notes -> implicated rubric criteria. Conservative: a note
// that matches no rule flags ALL criteria for re-check (we cannot scope what
// we cannot parse, so everything must be re-verified).
function mapNotesToCriteria(history, opts = {}) {
  const notes = normalizeHistory(history);
  const all =
    Array.isArray(opts.allCriteria) && opts.allCriteria.length
      ? opts.allCriteria
      : Object.keys(loadRubricThresholds(opts.platform || 'shorts'));
  const set = new Set();
  const unmappedNotes = [];
  let flaggedAll = false;
  for (const note of notes) {
    const matched = DIRECTIVE_RULES.filter((r) => r.pattern.test(note));
    if (matched.length === 0) {
      unmappedNotes.push(note);
      flaggedAll = true;
      continue;
    }
    for (const rule of matched) rule.criteria.forEach((c) => set.add(c));
  }
  if (flaggedAll) for (const c of all) set.add(c);
  return { criteria: [...set], unmappedNotes, flaggedAll };
}

function loadRubricThresholds(platform = 'shorts') {
  for (const p of THRESHOLDS_CANDIDATES) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      const t = parsed && parsed.platforms && parsed.platforms[platform];
      if (t && typeof t === 'object') return t;
    } catch {
      /* try next candidate */
    }
  }
  // Fail closed: ExampleCo floors default to DEFAULT_FLOOR but the criteria
  // list stays complete so unmapped notes still implicate the full rubric.
  const fallback = {};
  for (const c of FALLBACK_CRITERIA) fallback[c] = DEFAULT_FLOOR;
  return fallback;
}

// Same score-extraction semantics as verify-rejection-tokens-in-artifact.js.
function scoreOf(scores, criterion) {
  if (!scores || typeof scores !== 'object') return null;
  const v = scores[criterion];
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof v.score === 'number') return v.score;
  return null;
}

/**
 * The mechanical post-regen verification (feedback_rubric_is_the_gate):
 * every criterion implicated by the rejection notes must be scored on the
 * regenerated artifact (fail closed when unscored), must improve vs the
 * rejected version when a prior score exists, and must clear the rubric
 * threshold when it does not.
 */
function verifyImprovement({
  history,
  priorScores = null,
  newScores = null,
  thresholds = null,
  platform = 'shorts',
} = {}) {
  const th =
    thresholds && typeof thresholds === 'object' ? thresholds : loadRubricThresholds(platform);
  const mapping = mapNotesToCriteria(history, { allCriteria: Object.keys(th), platform });
  const failures = [];
  for (const criterion of mapping.criteria) {
    const next = scoreOf(newScores, criterion);
    const prior = scoreOf(priorScores, criterion);
    if (next == null) {
      failures.push({
        criterion,
        observed: null,
        prior,
        reason: `rejection implicated ${criterion} but the regenerated artifact was not scored on it (cannot verify improvement; failing closed)`,
      });
      continue;
    }
    if (prior != null) {
      if (!(next > prior)) {
        failures.push({
          criterion,
          observed: next,
          prior,
          reason: `${criterion} did not improve vs the rejected version (prior ${prior}, regen ${next})`,
        });
      }
      continue;
    }
    const floor = typeof th[criterion] === 'number' ? th[criterion] : DEFAULT_FLOOR;
    if (next < floor) {
      failures.push({
        criterion,
        observed: next,
        prior: null,
        floor,
        reason: `${criterion} scored ${next}, below the rubric threshold ${floor} (no prior score to compare against)`,
      });
    }
  }
  return {
    ok: failures.length === 0,
    implicated: mapping.criteria,
    unmappedNotes: mapping.unmappedNotes,
    flaggedAll: mapping.flaggedAll,
    failures,
  };
}

/**
 * Fail-loud contract (requirement 3): a video flagged for regen whose
 * rejection feedback cannot be located must NOT be rebuilt blind.
 *   - history load error -> fail loud (we KNOW rejections may exist but
 *     cannot read them).
 *   - flagged video with zero ledger rows AND no manifest note -> fail loud
 *     (nothing to regenerate FROM; a blind rebuild reships the defect).
 * A manifest note with zero ledger rows is fine (content-gate demotions
 * write the note without a ledger row); the note is the context.
 */
function resolveRejectionContext({
  manifestEntry = {},
  historyCount = 0,
  historyError = null,
} = {}) {
  if (historyError) {
    const msg = historyError && historyError.message ? historyError.message : String(historyError);
    return {
      ok: false,
      failLoud: true,
      reason: `rejection history unavailable (${msg.slice(0, 160)}); refusing to regenerate blind`,
    };
  }
  const manifestNote = String(
    manifestEntry.video_rejection_note || manifestEntry.thumbnail_rejection_note || '',
  ).trim();
  const flagged =
    manifestEntry.video_needs_regen === true ||
    manifestEntry.thumbnail_needs_regen === true ||
    ['rejected', 'video_rejected', 'thumbnail_rejected'].includes(manifestEntry.status);
  if (flagged && historyCount === 0 && !manifestNote) {
    return {
      ok: false,
      failLoud: true,
      reason:
        'video has rejections recorded (flagged for regen) but no rejection note or history row could be found; refusing to regenerate blind',
    };
  }
  return { ok: true, failLoud: false, reason: '' };
}

// Rows from content-review/rejections.jsonl for one video id. Throws are
// swallowed by readRejectionsJsonl (returns []), so callers that need the
// fail-loud contract should pass a missing-file probe via resolveRejectionContext
// with historyError when the path exists but is unreadable.
function loadRejectionRows(id, opts = {}) {
  const rows = readRejectionsJsonl(opts.rejectionsPath);
  return rows.filter((r) => r && r.id === id);
}

module.exports = {
  DIRECTIVE_RULES,
  DEFAULT_FLOOR,
  FALLBACK_CRITERIA,
  buildRegenDirectives,
  mapNotesToCriteria,
  loadRubricThresholds,
  verifyImprovement,
  resolveRejectionContext,
  loadRejectionRows,
  scoreOf,
};
