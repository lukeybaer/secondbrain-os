#!/usr/bin/env node
/**
 * process-rejection-into-rubric.js
 *
 * Locked 2026-04-30. ExampleCo's rule: "rubric should always be updated to
 * keep up with my feedback." This script is the audit/expansion mechanism
 * that turns rejection feedback into rubric updates so the same defect
 * cannot ship silently a second time.
 *
 * For each new rejection in rejections.jsonl:
 *   1. Look up the rejected video's rubric scores (if scored).
 *   2. Heuristic-classify the rejection note into a defect bucket.
 *   3. Decide whether existing rubric criteria already would have caught
 *      it -- and if so, whether thresholds need bumping.
 *   4. If no existing criterion catches it, write to
 *      data/agent/rubric-expansion-queue.jsonl so the next Amy session
 *      builds an analyzer for it.
 *   5. Log the analysis to data/agent/rubric-feedback-loop.jsonl for
 *      audit.
 *
 * This is intentionally a DETECTION + QUEUEING tool, not an auto-rubric-
 * editor. The actual rubric tool authoring still requires a session to
 * write the analyzer (analyze-audio-edges.py was the first example).
 * What this script gives us is the GAP DETECTION -- the moment ExampleCo
 * rejects with feedback the rubric didn't catch, we know about it.
 *
 * Run after every rejection (the empire:rejectVideo IPC handler can
 * spawn it alongside the auto-regen) or as a sweep cron.
 *
 * Usage:
 *   node scripts/process-rejection-into-rubric.js [--id <video_id>]
 *     [--all]   # scan all rejections, not just unprocessed
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const REJECTIONS = path.join(REPO, 'content-review', 'rejections.jsonl');
const MANIFEST = path.join(REPO, 'content-review', 'pending', 'manifest.json');
const EXPANSION_QUEUE = path.join(REPO, 'data', 'agent', 'rubric-expansion-queue.jsonl');
const FEEDBACK_LOG = path.join(REPO, 'data', 'agent', 'rubric-feedback-loop.jsonl');
const PROCESSED_MARKER = path.join(REPO, 'data', 'agent', 'rejection-processed.json');

// Defect buckets keyed to rubric criteria that should catch them.
// When ExampleCo writes "audio is too quiet", that's the volume_levels criterion.
// When he writes "shaky", that's camera_stability. The keyword patterns are
// intentionally permissive -- the goal is "this rubric criterion is the
// right home for this feedback," not exact match.
const DEFECT_BUCKETS = [
  {
    bucket: 'audio_edges',
    criterion: 'audio_edges',
    keywords: [/awkward silence/i, /silen(ce|t) at (the )?(start|beginning)/i, /cuts? off/i, /mid-?word/i, /truncat/i, /abrupt(ly)? end/i],
    why: "rejection feedback maps to the analyze-audio-edges tool (leading silence + trailing truncation)",
  },
  {
    bucket: 'audio_loudness',
    criterion: 'volume_levels',
    keywords: [/too quiet/i, /too loud/i, /volume/i, /can('t| not) hear/i, /muffled/i],
    why: "rejection feedback maps to the volume_levels criterion",
  },
  {
    bucket: 'voice_clarity',
    criterion: 'voice_clarity',
    keywords: [/voice (is|sounds)/i, /robotic/i, /mumbl/i, /unclear/i, /hard to understand/i, /accent/i],
    why: "rejection feedback maps to the voice_clarity criterion",
  },
  {
    bucket: 'music_mix',
    criterion: 'music_mix',
    keywords: [/music (too|drowns)/i, /background.*loud/i, /track.*loud/i, /sidechain/i, /ducking/i],
    why: "rejection feedback maps to the music_mix criterion",
  },
  {
    bucket: 'caption_readability',
    criterion: 'caption_readability',
    keywords: [/captions?/i, /subtitle/i, /text.*screen/i, /reading too fast/i, /can('t| not) read/i, /missed (the )?word/i],
    why: "rejection feedback maps to the caption_readability criterion",
  },
  {
    bucket: 'pacing',
    criterion: 'pacing',
    keywords: [/too slow/i, /too fast/i, /pacing/i, /drag/i, /rushed/i, /boring intro/i],
    why: "rejection feedback maps to the pacing criterion",
  },
  {
    bucket: 'hook',
    criterion: 'hook_strength',
    keywords: [/hook/i, /first (3|three) seconds/i, /opening/i, /didn('t| not) grab/i, /skipped past/i],
    why: "rejection feedback maps to the hook_strength criterion",
  },
  {
    bucket: 'thumbnail_first_frame',
    criterion: 'thumbnail_first_frame',
    keywords: [/thumbnail.*first.*frame/i, /thumbnail.*beginning/i, /thumbnail.*0\.1/i, /first image in the video/i, /thumbnail.*at.*start/i, /first.*0\.1\s*s/i],
    why: "rejection feedback maps to the analyze-thumbnail-first-frame tool (thumbnail must be the first 0.1s frame)",
  },
  {
    bucket: 'thumbnail',
    criterion: 'thumbnail_appeal',
    keywords: [/thumbnail/i, /preview image/i, /clickbait/i, /image is/i],
    why: "rejection feedback maps to the thumbnail_appeal criterion",
  },
  {
    bucket: 'scene_variety',
    criterion: 'scene_variety',
    keywords: [/same shots?/i, /repetitive/i, /b-?roll.*sam/i, /screensaver/i, /no relevance/i, /generic/i, /stock/i],
    why: "rejection feedback maps to the scene_variety criterion",
  },
  {
    bucket: 'lighting',
    criterion: 'lighting',
    keywords: [/dark/i, /lighting/i, /can('t| not) see/i, /too dim/i, /washed out/i],
    why: "rejection feedback maps to the lighting criterion",
  },
  {
    bucket: 'camera_stability',
    criterion: 'camera_stability',
    keywords: [/shaky/i, /jittery/i, /unstable/i, /motion sickness/i, /handheld/i],
    why: "rejection feedback maps to the camera_stability criterion",
  },
];

function loadJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

function appendJsonl(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
}

function loadProcessed() {
  if (!fs.existsSync(PROCESSED_MARKER)) return { processedKeys: [] };
  try { return JSON.parse(fs.readFileSync(PROCESSED_MARKER, 'utf8')); }
  catch { return { processedKeys: [] }; }
}

function saveProcessed(state) {
  fs.mkdirSync(path.dirname(PROCESSED_MARKER), { recursive: true });
  fs.writeFileSync(PROCESSED_MARKER, JSON.stringify(state, null, 2), 'utf8');
}

function classify(note) {
  const lower = (note || '').toLowerCase();
  const matches = [];
  for (const b of DEFECT_BUCKETS) {
    for (const re of b.keywords) {
      if (re.test(note)) {
        matches.push({ bucket: b.bucket, criterion: b.criterion, why: b.why, matched_pattern: re.source });
        break;
      }
    }
  }
  return matches;
}

function analyzeRejection(rejection, manifest) {
  const note = rejection.note || '';
  const target = rejection.target || 'video';
  const id = rejection.id;
  const matches = classify(note);
  const video = (manifest.videos || []).find((v) => v.id === id);
  const scores = (video && video.rubric_scores) || {};

  const findings = [];

  if (matches.length === 0) {
    // No existing criterion matches -- this is a new defect. Queue an
    // expansion (a future Amy session will build an analyzer for it).
    findings.push({
      kind: 'new_criterion_needed',
      reason: "no existing rubric criterion's keywords matched the feedback",
      proposed_analyzer: `analyze-${id}-${target}-defect.py`,
    });
  } else {
    for (const m of matches) {
      const observed = scores[m.criterion];
      const observedScore = typeof observed === 'object' ? observed.score : observed;
      if (observedScore == null) {
        findings.push({
          kind: 'criterion_match_unscored',
          criterion: m.criterion,
          why: m.why,
          recommendation: `the ${m.criterion} tool exists but did not score this video; verify the rubric ran on this build`,
        });
      } else if (observedScore >= 70) {
        findings.push({
          kind: 'tool_scored_high_but_ExampleCo_rejected',
          criterion: m.criterion,
          observed_score: observedScore,
          why: m.why,
          recommendation: `the ${m.criterion} tool scored ${observedScore} but ExampleCo still rejected -- the tool's detection logic needs to be tightened (false positive on detection, or score is gaming an easy threshold)`,
        });
      } else {
        findings.push({
          kind: 'tool_scored_low_threshold_too_lax',
          criterion: m.criterion,
          observed_score: observedScore,
          why: m.why,
          recommendation: `the ${m.criterion} tool already scored this low (${observedScore}); the threshold must be raised so future builds with this score get rejected automatically`,
        });
      }
    }
  }

  return {
    id,
    rejected_at: rejection.rejectedAt,
    note: note.slice(0, 200),
    target,
    classified_buckets: matches.map((m) => m.bucket),
    rubric_scores_at_rejection: scores ? Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, typeof v === 'object' ? v.score : v])) : null,
    findings,
    processed_at: new Date().toISOString(),
  };
}

function main() {
  const args = process.argv.slice(2);
  const idIdx = args.indexOf('--id');
  const filterId = idIdx >= 0 ? args[idIdx + 1] : null;
  const all = args.includes('--all');

  const rejections = loadJsonl(REJECTIONS);
  const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { videos: [] };
  const processed = loadProcessed();
  const processedSet = new Set(processed.processedKeys || []);

  const targets = rejections.filter((r) => {
    if (filterId && r.id !== filterId) return false;
    const key = `${r.id}|${r.rejectedAt}`;
    if (!all && processedSet.has(key)) return false;
    return true;
  });

  if (targets.length === 0) {
    console.log('no new rejections to process');
    return;
  }

  console.log(`processing ${targets.length} rejection(s)`);
  let newExpansions = 0;
  let lacxThresholds = 0;

  for (const r of targets) {
    const analysis = analyzeRejection(r, manifest);
    appendJsonl(FEEDBACK_LOG, analysis);
    for (const f of analysis.findings) {
      if (f.kind === 'new_criterion_needed') {
        appendJsonl(EXPANSION_QUEUE, {
          id: r.id,
          rejected_at: r.rejectedAt,
          note: r.note,
          proposed_analyzer: f.proposed_analyzer,
          reason: f.reason,
          queued_at: new Date().toISOString(),
        });
        newExpansions++;
      } else if (f.kind === 'tool_scored_low_threshold_too_lax') {
        lacxThresholds++;
      }
    }
    console.log(`- ${r.id}: ${analysis.findings.length} finding(s); buckets: ${analysis.classified_buckets.join(', ') || '(none matched)'}`);
    processedSet.add(`${r.id}|${r.rejectedAt}`);
  }

  saveProcessed({ processedKeys: Array.from(processedSet) });
  console.log(`new analyzer expansions queued: ${newExpansions}`);
  console.log(`thresholds-too-lax findings: ${lacxThresholds}`);
  console.log(`audit log: ${FEEDBACK_LOG}`);
  if (newExpansions > 0) {
    console.log(`expansion queue: ${EXPANSION_QUEUE}`);
  }
}

if (require.main === module) {
  main();
}
