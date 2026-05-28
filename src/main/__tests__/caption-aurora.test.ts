/**
 * caption-aurora.test.ts
 *
 * Locks the 2026-04-30 caption pipeline structure. Why this test
 * exists: a previous build shipped 6 videos with ZERO captions; a
 * second build shipped them with burned-in captions only, so the
 * caption-readability rubric scored 46 because it could not find an
 * embedded subtitle stream or a sidecar .srt. Both forms must ship.
 *
 * The test does NOT call ffmpeg; it locks the source-code structure
 * so the next session cannot silently undo the fix.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CAPTION_PY = path.join(REPO_ROOT, 'src', 'main', 'empire', 'caption_aurora.py');

describe('caption-aurora -- karaoke captions on Shorts', () => {
  it('caption_aurora.py entry point exists', () => {
    expect(fs.existsSync(CAPTION_PY)).toBe(true);
  });

  it('writes a sidecar .srt next to the captioned mp4 (rubric: caption-readability finds it)', () => {
    const src = fs.readFileSync(CAPTION_PY, 'utf8');
    expect(src).toMatch(/def transcript_to_srt/);
    expect(src).toMatch(/sidecar_srt\s*=\s*out_path\.with_suffix\("\.srt"\)/);
    expect(src).toMatch(/sidecar_srt\.write_text/);
  });

  it('embeds a mov_text subtitle stream in the mp4 alongside burned captions', () => {
    const src = fs.readFileSync(CAPTION_PY, 'utf8');
    // The single ffmpeg call burns the ASS via -vf subtitles= AND
    // muxes the SRT in via -c:s mov_text. Both forms must ship.
    expect(src).toMatch(/-c:s/);
    expect(src).toMatch(/mov_text/);
    expect(src).toMatch(/-vf",\s*f"subtitles=/);
    // burn_captions must accept an srt_path parameter and pass it as
    // a second -i input to ffmpeg.
    expect(src).toMatch(/def burn_captions\([\s\S]*?srt_path:\s*Path/);
    expect(src).toMatch(/"-i",\s*str\(srt_path\.resolve\(\)\)/);
  });

  it('uses ASS karaoke colors: white default, green active, yellow emphasis', () => {
    const src = fs.readFileSync(CAPTION_PY, 'utf8');
    // BGR + alpha hex codes. Don't change these without a memory note.
    expect(src).toMatch(/COLOR_WHITE\s*=\s*"&H00FFFFFF"/);
    expect(src).toMatch(/COLOR_GREEN\s*=\s*"&H0000FF00"/);
    expect(src).toMatch(/COLOR_YELLOW\s*=\s*"&H0000FFFF"/);
  });

  it('per-word Dialogue lines: each line colors a different word, spans that word\'s voicing window', () => {
    const src = fs.readFileSync(CAPTION_PY, 'utf8');
    // The "active word colored, others white" pattern. Without this,
    // the karaoke effect collapses to whole-line color.
    expect(src).toMatch(/active_color\s*=\s*COLOR_YELLOW\s+if\s+w\.get\("emphasis"\)\s+else\s+COLOR_GREEN/);
    expect(src).toMatch(/Dialogue:\s*0,\{fmt_time\(start\)/);
  });

  it('audio_offset shifts caption timing for prepended thumbnail card', () => {
    const src = fs.readFileSync(CAPTION_PY, 'utf8');
    // When video_aurora prepends the 2.5s thumbnail card, captions
    // must wait 2.5s before the first word. Locked in fmt_time uses
    // start + audio_offset, end + audio_offset.
    expect(src).toMatch(/start\s*=\s*w\["start"\]\s*\+\s*audio_offset/);
  });

  it('Windows ffmpeg subtitles filter quirk: cwd into ass dir + bare filename', () => {
    const src = fs.readFileSync(CAPTION_PY, 'utf8');
    // Absolute Windows paths with colons trip ffmpeg's subtitle
    // parser. Workaround: cwd=ass_path.parent + reference by filename.
    expect(src).toMatch(/work_dir\s*=\s*ass_path\.parent/);
    expect(src).toMatch(/cwd=str\(work_dir\)/);
    expect(src).toMatch(/rel_ass\s*=\s*ass_path\.name/);
  });

  it('strips filler words from caption display (uh, um, etc.)', () => {
    const src = fs.readFileSync(CAPTION_PY, 'utf8');
    expect(src).toMatch(/STRIP_WORDS\s*=\s*\{[^}]*"uh"/);
    expect(src).toMatch(/STRIP_WORDS\s*=\s*\{[^}]*"um"/);
  });

  it('chunks 3-4 words per block (Hormozi/MrBeast cadence)', () => {
    const src = fs.readFileSync(CAPTION_PY, 'utf8');
    expect(src).toMatch(/MAX_WORDS_PER_CHUNK\s*=\s*4/);
    expect(src).toMatch(/MAX_CHARS_PER_CHUNK\s*=\s*22/);
  });
});

describe('caption-aurora -- result includes sidecar SRT path for downstream rubric', () => {
  it('render() returns sidecar_srt path so the rubric can pick it up', () => {
    const src = fs.readFileSync(CAPTION_PY, 'utf8');
    // run-quality-check.py accepts --srt-file. video_aurora reads
    // result["sidecar_srt"] and passes it. Without this in the result
    // dict, the rubric falls back to embedded-stream detection only.
    expect(src).toMatch(/"sidecar_srt":\s*str\(sidecar_srt\)/);
    expect(src).toMatch(/"srt_size_bytes":\s*sidecar_srt\.stat\(\)\.st_size/);
  });
});
