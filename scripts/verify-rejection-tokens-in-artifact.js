#!/usr/bin/env node
/**
 * verify-rejection-tokens-in-artifact.js
 *
 * Locked 2026-05-03 from the recurring "rebuild_did_not_address_rejection"
 * pattern. ExampleCo rejected nine_free_ai_tools_2026 four times in a row for
 * the same defects ("number them like I said", "tools up top", "no video
 * diversity", "thumbnail as first frame", "more video editing", "same
 * issue why didn't you do it") and the auto-regen flagged it
 * rubric_passed each time because the build pipeline never actually
 * addressed the rejection. The rubric ran its own checks but the
 * rejection note was the source of truth, and nothing tied the two
 * together.
 *
 * This script is the final gate AFTER rubric_passed and BEFORE the
 * manifest flips to pending_approval. It reads the latest rejection
 * note for the video, extracts actionable tokens via regex, and
 * cross-checks whether the rebuilt artifact's rubric_scores actually
 * cleared the criteria those tokens demand.
 *
 * Usage:
 *   node scripts/verify-rejection-tokens-in-artifact.js --id <video_id>
 *
 * Behavior:
 *   - All required tokens cleared:  exit 0, no manifest changes.
 *   - Any required token failed:    write back to manifest.json with
 *     regen_status='rebuild_did_not_address_rejection' plus a
 *     regen_unaddressed_rejection reason, exit 1.
 *   - Idempotent: running twice with the same state produces the same
 *     result.
 */
const fs = require('fs');
const path = require('path');
// E6 2026-06-12: improvement verification. The 4 TOKEN_RULES regex classes
// missed whole rejection categories ("Boring footage, not enough visual
// effects" fired zero rules, so the gate was a no-op and an unchanged video
// promoted). evaluate() now ALSO maps every rejection note onto rubric
// criteria (data-driven, conservative: unmapped notes flag ALL criteria)
// and requires those criteria to improve vs the rejected version, or clear
// the rubric threshold when no prior score exists. Unscored implicated
// criteria fail closed.
const regenFeedback = require('./lib/regen-feedback-directives.js');

const REPO = path.resolve(__dirname, '..');
const REJECTIONS = path.join(REPO, 'content-review', 'rejections.jsonl');
const MANIFEST = path.join(REPO, 'content-review', 'pending', 'manifest.json');

// Each entry maps a regex pattern (matched against the rejection note)
// to a rubric criterion that MUST score at or above the floor for the
// rebuild to count as addressing the rejection. The floor is the gate
// per the prompt spec; if the criterion isn't scored at all, that's
// also a failure (we cannot confirm the rebuild addressed it).
const TOKEN_RULES = [
  {
    name: 'numbered_overlays',
    pattern: /number(?:ed|ing)?|step\s*\d|tools?\s+up\s+top|item\s+\d/i,
    criterion: 'numbered_overlays',
    floor: 70,
    why: 'rejection cited numbering/steps/tools-up-top; numbered_overlays must clear 70',
  },
  {
    name: 'music_presence',
    pattern: /music|background\s+(?:music|audio|track)|crackl/i,
    criterion: 'music_presence',
    floor: 70,
    why: 'rejection cited music/background audio; music_presence must clear 70',
  },
  {
    name: 'thumbnail_first_frame',
    pattern: /thumbnail.*first.*frame|thumbnail.*0\.1|thumbnail.*beginning/i,
    criterion: 'thumbnail_first_frame',
    floor: 70,
    why: 'rejection cited thumbnail-first-frame rule; thumbnail_first_frame must clear 70',
  },
  {
    name: 'scene_variety',
    pattern: /\bno\s+(?:video\s+)?diversity|same\s+shots|repetitive|generic/i,
    criterion: 'scene_variety',
    floor: 60,
    why: 'rejection cited variety/diversity/repetition; scene_variety must clear 60',
  },
];

function loadJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) {
    return { manifest: { videos: [] }, raw: null };
  }
  const raw = fs.readFileSync(MANIFEST, 'utf8');
  return { manifest: JSON.parse(raw), raw };
}

function saveManifest(manifest) {
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

// Pure: newest rejection row wins. The Electron IPC writer stamps
// rejectedAt; the EC2 dashboard writer stamps ts. Sorting on rejectedAt
// alone made every dashboard row sort as '' so the gate could resolve the
// OLDEST row as "latest" (E6 2026-06-12).
function pickLatestRejection(rows) {
  const all = (rows || []).filter(Boolean);
  if (!all.length) return null;
  const stamp = (r) => String(r.rejectedAt || r.ts || '');
  all.sort((a, b) => stamp(b).localeCompare(stamp(a)));
  return all[0];
}

function latestRejectionFor(videoId) {
  const all = loadJsonl(REJECTIONS).filter(
    (r) => r && r.id === videoId && (r.target || 'video') === 'video',
  );
  return pickLatestRejection(all);
}

function scoreOf(rubricScores, criterion) {
  if (!rubricScores || typeof rubricScores !== 'object') return null;
  const v = rubricScores[criterion];
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof v.score === 'number') return v.score;
  return null;
}

// opts (E6 2026-06-12):
//   history     -> rejection rows/notes driving the improvement check
//                  (defaults to [rejection]).
//   priorScores -> rubric scores of the artifact ExampleCo rejected, when known.
//   thresholds  -> criterion -> floor map (defaults to
//                  data/agent/video-quality-thresholds.json, shorts).
function evaluate(video, rejection, opts = {}) {
  if (!rejection || !rejection.note) {
    return { ok: true, fired: [], failures: [], reason: 'no rejection note to verify against' };
  }
  const note = String(rejection.note || '');
  const rubricScores =
    video.regen_video_metrics && video.regen_video_metrics.rubric_scores
      ? video.regen_video_metrics.rubric_scores
      : video.rubric_scores || null;

  const fired = [];
  const failures = [];
  for (const rule of TOKEN_RULES) {
    if (!rule.pattern.test(note)) continue;
    fired.push(rule.name);
    const score = scoreOf(rubricScores, rule.criterion);
    const passed = typeof score === 'number' && score >= rule.floor;
    if (!passed) {
      failures.push({
        rule: rule.name,
        criterion: rule.criterion,
        floor: rule.floor,
        observed: score,
        why: rule.why,
        reason:
          score == null
            ? `rejection note matched /${rule.pattern.source}/ but rubric did not score ${rule.criterion} (cannot verify the rebuild addressed it)`
            : `rejection note matched /${rule.pattern.source}/ requires ${rule.criterion} >= ${rule.floor} but observed ${score}`,
      });
    }
  }

  // E6: improvement verification over the criteria implicated by the
  // rejection notes. Conservative: an unmapped note implicates ALL rubric
  // criteria; an implicated criterion that was never scored fails closed.
  const history = Array.isArray(opts.history) && opts.history.length ? opts.history : [rejection];
  const improvement = regenFeedback.verifyImprovement({
    history,
    priorScores: opts.priorScores || null,
    newScores: rubricScores,
    thresholds: opts.thresholds || null,
  });
  for (const f of improvement.failures) {
    // De-dup against TOKEN_RULES failures on the same criterion so the
    // manifest reason stays readable.
    if (!failures.some((existing) => existing.criterion === f.criterion)) {
      failures.push({ rule: 'improvement', ...f });
    }
  }

  return {
    ok: failures.length === 0,
    fired,
    failures,
    implicated: improvement.implicated,
    flagged_all_criteria: improvement.flaggedAll,
    note: note.slice(0, 200),
    rejected_at: rejection.rejectedAt || rejection.ts,
  };
}

function findVideo(manifest, id) {
  const videos = manifest.videos || [];
  return videos.find((v) => v.id === id) || null;
}

function main() {
  const args = process.argv.slice(2);
  const idIdx = args.indexOf('--id');
  if (idIdx < 0 || !args[idIdx + 1]) {
    console.error('usage: verify-rejection-tokens-in-artifact.js --id <video_id>');
    process.exit(2);
  }
  const id = args[idIdx + 1];

  const { manifest } = loadManifest();
  const video = findVideo(manifest, id);
  if (!video) {
    console.error(`video not found in manifest: ${id}`);
    process.exit(2);
  }

  const rejection = latestRejectionFor(id);
  if (!rejection) {
    console.log(`no prior video rejection for ${id}; nothing to verify`);
    process.exit(0);
  }

  // Full per-video history (any target) drives the improvement check; the
  // latest video-target rejection drives the legacy token rules.
  const history = loadJsonl(REJECTIONS).filter((r) => r && r.id === id);
  const result = evaluate(video, rejection, { history });
  if (result.ok) {
    console.log(
      `verify-rejection-tokens: ${id} OK (rules fired: ${result.fired.join(', ') || 'none'})`,
    );
    process.exit(0);
  }

  // Write back to manifest with the failure reason so the auto-regen
  // loop knows the rebuild did not address the prior rejection.
  const reasons = result.failures.map((f) => f.reason);
  video.regen_status = 'rebuild_did_not_address_rejection';
  video.regen_unaddressed_rejection = reasons.join('; ');
  video.regen_unaddressed_rejection_details = result.failures;
  video.regen_unaddressed_rejection_at = new Date().toISOString();
  // Also flip status back so the entry doesn't sit as pending_approval
  // when we know the rebuild missed the spec.
  if (video.status === 'pending_approval') {
    video.status = 'video_rejected';
  }
  // Re-flag for the next regen cycle.
  video.video_needs_regen = true;

  saveManifest(manifest);

  console.error(`verify-rejection-tokens: ${id} FAILED -- ${reasons.join('; ')}`);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { evaluate, latestRejectionFor, pickLatestRejection, scoreOf, TOKEN_RULES };
