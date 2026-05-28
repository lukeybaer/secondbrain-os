/**
 * video-aurora-pipeline.test.ts
 *
 * Locks the 2026-04-29 evening fix: autonomous video assembler that
 * replaces the EC2 video build with a local Pexels + ffmpeg pipeline,
 * verified by the existing video content gate.
 *
 * The test does NOT call Pexels (no network from CI). It locks the
 * source-code structure: the entry point exists, the auto-regen
 * script routes video_needs_regen through it, the SKILL.md is
 * present with the right shape, and a list of known regressions
 * (User-Agent header, absolute POSIX concat paths, ultrafast preset
 * for performance, brightness eq for dark stock content) cannot be
 * silently undone.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const AURORA_PY = path.join(REPO_ROOT, 'src', 'main', 'empire', 'video_aurora.py');
const AUTO_REGEN = path.join(REPO_ROOT, 'scripts', 'auto-regen-rejected-videos.js');
const SKILL_MD = path.join(REPO_ROOT, 'scheduled-tasks', 'video-aurora', 'SKILL.md');
const VIDEO_GATE = path.join(REPO_ROOT, 'scripts', 'check-video-content-not-blank.py');

describe('video-aurora -- autonomous video assembler', () => {
  it('video_aurora.py entry point exists', () => {
    expect(fs.existsSync(AURORA_PY)).toBe(true);
  });

  it('uses Pexels with a Mozilla User-Agent header (regression: bare urllib gets 403)', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    // Without User-Agent: Pexels returns 403 silently and
    // fetch_clips_for_video returns 0 clips, the script returns
    // ok=False with stage=pexels. Locking this header in.
    expect(src).toMatch(/User-Agent/);
    expect(src).toMatch(/Mozilla/);
    expect(src).toMatch(/api\.pexels\.com/);
    expect(src).toMatch(/orientation=portrait/);
  });

  it('verifies output via the video content gate before claiming success', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    expect(src).toMatch(/check-video-content-not-blank\.py/);
    expect(src).toMatch(/def verify_video/);
    expect(fs.existsSync(VIDEO_GATE)).toBe(true);
  });

  it('uses absolute POSIX paths in the concat list (regression: relative paths broke ffmpeg)', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    // ffmpeg -f concat resolves entries relative to the LIST FILE'S
    // directory, not the cwd. Using clip.resolve().as_posix() makes
    // the entries absolute so the concat survives any cwd change.
    expect(src).toMatch(/clip\.resolve\(\)\.as_posix\(\)/);
  });

  it('lifts shadows on every Pexels segment (regression: dark stock content failed the gate)', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    // 2026-04-29 evening: 5 of 6 first-pass rebuilds came back with
    // mean_lum < 60 because the "ai" and "drama" Pexels keywords
    // pulled dim server-room and night-storm content. Brightness eq
    // (gamma=1.30 + brightness=0.04 + saturation=1.20 + contrast=1.05)
    // pushes mean_lum into the 60-180 range without overexposing.
    expect(src).toMatch(/eq=gamma=1\.30/);
    expect(src).toMatch(/saturation=1\.20/);
    expect(src).toMatch(/brightness=0\.04/);
  });

  it('uses ultrafast preset for fast prep (regression: 17 segs at -preset fast took 700s+)', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    // -preset fast made each 3s segment encode take 30-90s on this
    // box (Pexels 4K input requires heavy decode-then-scale work).
    // ultrafast cuts per-segment encode to 5-10s; total prep stage
    // for a 17-segment video drops from 12 minutes to under 2.
    const prepClipBlock = src.match(/def prep_clip[\s\S]*?return r\.returncode/);
    expect(prepClipBlock).toBeTruthy();
    expect(prepClipBlock![0]).toMatch(/-preset[^\n]*ultrafast/);
    const concatBlock = src.match(/def concat_clips[\s\S]*?return r\.returncode/);
    expect(concatBlock).toBeTruthy();
    expect(concatBlock![0]).toMatch(/-preset[^\n]*ultrafast/);
  });

  it('THUMBNAIL_CARD_DURATION is 0 (no silent intro) but the offset path stays wired for opt-in callers', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    // Locked 2026-04-30 from Luke's rejection feedback ("awkward silence
    // at the beginning"). The card is opt-in via raising the constant;
    // when it's 0, the intro plays narration over the first Pexels clip
    // straight away. The -itsoffset codepath stays wired so a future
    // session that re-enables the card has working audio sync.
    expect(src).toMatch(/-itsoffset/);
    expect(src).toMatch(/THUMBNAIL_CARD_DURATION\s*=\s*0\.0/);
  });

  it('topic detection uses word boundaries on short keywords (regression: earn matched learned)', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    // Same regression as thumbnail-aurora -- a kids "Robot Who
    // Learned to Dream" title got matched by the money rule because
    // /earn/ matched inside "learned". Word boundaries fix it.
    expect(src).toMatch(/\\bearn/);
    expect(src).toMatch(/\\bva\\b/);
    expect(src).toMatch(/\\bai\\b/);
    // Kids rule must be FIRST in TOPIC_RULES so it wins ties with
    // the money/AI rules.
    const topicRulesBlock = src.match(/TOPIC_RULES\s*=\s*\[[\s\S]*?\n\]/);
    expect(topicRulesBlock).toBeTruthy();
    const firstRule = topicRulesBlock![0].split('(r"')[1] || '';
    expect(firstRule.toLowerCase()).toMatch(/kid|child|robot|elephant|whale|dragon/);
  });

  it('cuts every ~3 seconds (the rubric finding from openclaw research)', () => {
    const src = fs.readFileSync(AURORA_PY, 'utf8');
    // Cuts every 2-3s is the #1 lever for view-through on Shorts.
    // n_cuts = max(4, round(audio_dur / TARGET_CUT_SECONDS)).
    expect(src).toMatch(/TARGET_CUT_SECONDS\s*=\s*3\.0/);
    expect(src).toMatch(/max\(4,\s*int\(round\(body_dur\s*\/\s*TARGET_CUT_SECONDS\)\)\)/);
  });
});

describe('video-aurora -- wired into the regen loop', () => {
  it('auto-regen-rejected-videos.js calls video_aurora.py for video rebuilds', () => {
    const src = fs.readFileSync(AUTO_REGEN, 'utf8');
    expect(src).toMatch(/video_aurora\.py/);
    expect(src).toMatch(/regenVideoLocally/);
  });

  it('video_needs_regen block: EC2-first probe + local fallback, no direct ec2-build-from-queue.py call', () => {
    const src = fs.readFileSync(AUTO_REGEN, 'utf8');
    // The if-block guarded by `if (v.video_needs_regen)` must contain:
    // - canRegenViaEc2() probe (uses EC2 skill stack when SSH available)
    // - regenVideoLocally (local fallback when EC2 unavailable)
    // The regex stops at the first line with exactly 6 leading spaces + }
    // which is the outer closing brace of the 6-space-indented block.
    const videoBlockMatch = src.match(/if\s*\(\s*v\.video_needs_regen\s*\)\s*\{[\s\S]*?\n {6}\}/);
    expect(videoBlockMatch).toBeTruthy();
    const videoBlock = videoBlockMatch![0];
    expect(videoBlock).toMatch(/canRegenViaEc2/);
    expect(videoBlock).toMatch(/regenVideoLocally/);
    // Negative assertion: the old direct ec2-build-from-queue.py call must
    // NOT live inside the video_needs_regen block.
    expect(videoBlock).not.toMatch(/ec2-build-from-queue\.py/);
  });

  it('regenVideoLocally passes the four required args + optional thumbnail', () => {
    const src = fs.readFileSync(AUTO_REGEN, 'utf8');
    // The four core args -- id, title, channel, source, out -- and
    // an optional --thumb when the thumbnail file exists. If any of
    // these is dropped, video_aurora.py exits with argparse error.
    expect(src).toMatch(/'--id'/);
    expect(src).toMatch(/'--title'/);
    expect(src).toMatch(/'--channel'/);
    expect(src).toMatch(/'--source'/);
    expect(src).toMatch(/'--out'/);
    expect(src).toMatch(/'--thumb'/);
  });

  it('regenVideoLocally drives the rubric-gated v2 path when a transcript is on disk (regression: 2026-04-30 rejection auto-regen used legacy v1 and shipped uncaptioned rebuilds)', () => {
    const src = fs.readFileSync(AUTO_REGEN, 'utf8');
    // When `<id>_transcript.json` exists, the regen MUST pass --transcript
    // and --rubric-gate so it runs the same standard as the manual batch.
    expect(src).toMatch(/_transcript\.json/);
    expect(src).toMatch(/'--transcript'/);
    expect(src).toMatch(/'--rubric-gate'/);
    expect(src).toMatch(/'--platform'/);
    expect(src).toMatch(/'--max-iterations'/);
  });

  it('rubric-gated regen only promotes to pending_approval when the rubric clears (regression: legacy promotion was based on mtime + brightness gate)', () => {
    const src = fs.readFileSync(AUTO_REGEN, 'utf8');
    expect(src).toMatch(/rubric_pass/);
    // The pass branch must set status=pending_approval AND record the
    // rubric data; the fail branch must keep status=video_rejected.
    expect(src).toMatch(/regen_status\s*=\s*['"]rubric_passed['"]/);
    expect(src).toMatch(/regen_status\s*=\s*['"]rubric_failed['"]/);
    // Negative assertion: when the rubric fails, video_needs_regen is
    // re-set so the next loop picks it up; status does NOT get promoted.
    expect(src).toMatch(/v\.video_needs_regen\s*=\s*true/);
  });

  it('auroraVideoResult is hoisted (let) outside the if-block so the rubric-gate promotion path can reference it (regression: scope bug killed promotion on 2026-04-30 regen)', () => {
    const src = fs.readFileSync(AUTO_REGEN, 'utf8');
    // The variable must be declared with `let` BEFORE the
    // `if (v.video_needs_regen)` block so the post-build promotion
    // logic can reference it. Const-inside-if was the bug; this lock
    // prevents regression.
    expect(src).toMatch(/let\s+auroraVideoResult\s*=\s*null/);
  });

  it('auto-transcribes when the transcript is missing so the rubric-gate path can run (regression: 2026-05-01 nine_free_ai_tools_2026 rejection "no video diversity" fell through to legacy v1 because no transcript was on disk)', () => {
    const src = fs.readFileSync(AUTO_REGEN, 'utf8');
    expect(src).toMatch(/transcribe_word_level\.py/);
    expect(src).toMatch(/transcript missing for/);
    // After the transcribe step, hasTranscript is re-set so the regen
    // can take the rubric-gated v2 path.
    expect(src).toMatch(/hasTranscript\s*=\s*true/);
  });
});

describe('video-aurora -- skill + documentation', () => {
  it('scheduled-tasks/video-aurora/SKILL.md exists and documents the contract', () => {
    expect(fs.existsSync(SKILL_MD)).toBe(true);
    const skill = fs.readFileSync(SKILL_MD, 'utf8');
    expect(skill).toMatch(/^---\r?\nname:\s*video-aurora\r?\n/);
    expect(skill).toMatch(/Pexels/i);
    expect(skill).toMatch(/check-video-content-not-blank\.py/);
    expect(skill).toMatch(/User-Agent/);
    expect(skill).toMatch(/2\.5s/); // thumbnail card duration
    expect(skill).toMatch(/cuts every.*3s/i);
  });

  it('SKILL.md lists the anti-patterns we have actually hit', () => {
    const skill = fs.readFileSync(SKILL_MD, 'utf8');
    // Future sessions need to see these explicitly so they do not
    // un-fix something on their next pass.
    expect(skill).toMatch(/Anti-patterns/i);
    expect(skill).toMatch(/relative paths/i);
    expect(skill).toMatch(/-c copy/);
    expect(skill).toMatch(/User-Agent/);
  });
});
