#!/usr/bin/env node
/**
 * LinkedIn Video Producer — SecondBrain Studio
 * Multi-pass approach for robustness:
 *   Pass 1: Audio splice & normalize
 *   Pass 2: Face intro segment
 *   Pass 3: Screen segment (popup removal + face PIP + logo)
 *   Pass 4: Outro segment
 *   Pass 5: Concat video segments
 *   Pass 6: Add word-by-word captions via SRT
 *   Pass 7: Final composite (video + audio)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
const APPDATA = process.env.APPDATA;
const MAIN_REC = path.join(APPDATA, 'secondbrain/data/studio/recordings/rec_1775401953554');
const INTRO_REC = path.join(APPDATA, 'secondbrain/data/studio/recordings/rec_1775402621691');
const WORK = path.join(APPDATA, 'secondbrain/data/studio/recordings/linkedin_production');
const LOGO = 'C:/Users/luked/secondbrain/pm-strategies-logo.png';
const FONT = 'C\\:/Windows/Fonts/arialbd.ttf';
const FONT_REG = 'C\\:/Windows/Fonts/arial.ttf';

const W = 1920,
  H = 1080,
  FPS = 30;

// Timing constants
const INTRO_TRIM_START = 1.2;
const INTRO_TRIM_DUR = 4.0;
const MAIN_TRIM_START = 2.5;
const MAIN_TRIM_END = 112.0;
const THANKYOU_START = 122.0;
const THANKYOU_DUR = 2.5;
const FACE_DUR = 5.5; // Face-only intro duration in final video
const SCREEN_SKIP = 12.0; // Skip first 12s of screen recording (Studio UI)

// WhatsApp popup times in ORIGINAL screen recording (verified frame-by-frame)
// freeze_at = clean frame time to use as replacement
const POPUPS = [
  { s: 16.5, e: 21.0, freeze_at: 16.0 },
  { s: 76.5, e: 80.5, freeze_at: 76.0 },
  { s: 96.5, e: 100.5, freeze_at: 96.0 },
  { s: 116.5, e: 120.0, freeze_at: 116.0 },
];

const EMPHASIS = new Set([
  'million',
  'billion',
  'free',
  'viral',
  'hack',
  'views',
  'money',
  'banned',
  'first',
  'zero',
  'never',
  'always',
  'secret',
  'real',
  'quit',
  'ethics',
  'paid',
  'lost',
  'wrong',
  'nine',
  'bitcoin',
  'crypto',
  'ai',
  'claude',
  'everyone',
  'nobody',
  'question',
  'thousands',
  'second',
  'brain',
  'forgets',
  'forget',
  'anything',
  'knowledge',
  'graph',
  'phone',
  'calls',
  'executive',
  'assistant',
  'open',
  'source',
  'goals',
  'acts',
  'remember',
  'remembers',
  'download',
  'repo',
  'enjoy',
  'everything',
  'alive',
  'command',
  'center',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────
function run(cmd, label) {
  console.log(`\n> ${label}...`);
  try {
    execSync(cmd, { stdio: 'pipe', timeout: 600000 });
    console.log(`  OK`);
  } catch (e) {
    const err = e.stderr?.toString() || '';
    // Extract last 5 non-empty lines from stderr for useful error info
    const lines = err
      .split('\n')
      .filter((l) => l.trim())
      .slice(-5)
      .join('\n');
    console.error(`  FAIL:\n${lines}`);
    throw e;
  }
}

function dur(f) {
  return parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${f}"`,
      { encoding: 'utf8' },
    ).trim(),
  );
}

function wp(p) {
  return p.replace(/\\/g, '/');
} // Windows path → forward slashes

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  console.log('=== LinkedIn Video Producer ===\n');
  fs.mkdirSync(WORK, { recursive: true });

  const src = {
    mainScreen: path.join(MAIN_REC, 'screen.mp4'),
    mainSide: path.join(MAIN_REC, 'side.mp4'),
    introSide: path.join(INTRO_REC, 'side.mp4'),
    mainAudio: path.join(MAIN_REC, 'audio_main.wav'),
    introAudio: path.join(INTRO_REC, 'audio_intro.wav'),
  };

  // ═══ PASS 1: Audio ═══
  console.log('\n=== PASS 1: Audio Splice ===');
  const audio = {
    introTrim: path.join(WORK, 'a_intro.wav'),
    mainBody: path.join(WORK, 'a_main.wav'),
    thankYou: path.join(WORK, 'a_thanks.wav'),
    concat: path.join(WORK, 'a_concat.txt'),
    raw: path.join(WORK, 'a_raw.wav'),
    norm: path.join(WORK, 'a_norm.wav'),
  };

  run(
    `ffmpeg -y -i "${src.introAudio}" -ss ${INTRO_TRIM_START} -t ${INTRO_TRIM_DUR} -c:a pcm_s16le -ar 48000 "${audio.introTrim}"`,
    'Trim intro',
  );
  run(
    `ffmpeg -y -i "${src.mainAudio}" -ss ${MAIN_TRIM_START} -t ${MAIN_TRIM_END - MAIN_TRIM_START} -c:a pcm_s16le -ar 48000 "${audio.mainBody}"`,
    'Trim main body',
  );
  run(
    `ffmpeg -y -i "${src.mainAudio}" -ss ${THANKYOU_START} -t ${THANKYOU_DUR} -c:a pcm_s16le -ar 48000 "${audio.thankYou}"`,
    'Trim thank-you',
  );

  fs.writeFileSync(
    audio.concat,
    [
      `file '${wp(audio.introTrim)}'`,
      `file '${wp(audio.mainBody)}'`,
      `file '${wp(audio.thankYou)}'`,
    ].join('\n'),
  );

  run(`ffmpeg -y -f concat -safe 0 -i "${audio.concat}" -c copy "${audio.raw}"`, 'Concat audio');
  run(
    `ffmpeg -y -i "${audio.raw}" -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 -c:a pcm_s16le "${audio.norm}"`,
    'Normalize',
  );

  const totalDur = dur(audio.norm);
  console.log(`  Total audio: ${totalDur.toFixed(1)}s`);

  // ═══ PASS 2: Face Intro Segment ═══
  console.log('\n=== PASS 2: Face Intro ===');
  const faceOut = path.join(WORK, 'v_face.mp4');

  // Use MAIN recording's side camera (intro side camera was misaligned)
  // Centered on dark bg with logo + lower third
  run(
    [
      `ffmpeg -y`,
      `-i "${src.mainSide}"`,
      `-i "${LOGO}"`,
      `-filter_complex "`,
      `color=c=#0a0a1a:s=${W}x${H}:d=${FACE_DUR}:r=${FPS}[bg];`,
      `[0:v]trim=start=0:duration=${FACE_DUR},setpts=PTS-STARTPTS,scale=960:-1,fps=${FPS}[face];`,
      `[1:v]scale=160:-1[logo];`,
      `[bg][face]overlay=(W-w)/2:(H-h)/2:eof_action=repeat[f1];`,
      `[f1][logo]overlay=W-w-30:25:eof_action=repeat[f2];`,
      `[f2]drawtext=fontfile='${FONT}':text='Luke Baer':fontsize=40:fontcolor=white:borderw=2:bordercolor=black:x=60:y=h-140:enable='between(t\\,1\\,${FACE_DUR})',`,
      `drawtext=fontfile='${FONT_REG}':text='VP Data Science & Analytics':fontsize=28:fontcolor=white@0.8:borderw=1:bordercolor=black:x=60:y=h-95:enable='between(t\\,1\\,${FACE_DUR})'[out]`,
      `"`,
      `-map "[out]" -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -an -t ${FACE_DUR} "${faceOut}"`,
    ].join(' '),
    'Render face intro',
  );

  // ═══ PASS 3: Screen + PIP Segment ═══
  console.log('\n=== PASS 3: Screen + PIP ===');

  // First, extract freeze frames (from verified clean times)
  const freezes = [];
  for (let i = 0; i < POPUPS.length; i++) {
    const ff = path.join(WORK, `freeze${i}.png`);
    if (POPUPS[i].s - SCREEN_SKIP < 100) {
      // Only if within our screen portion
      run(
        `ffmpeg -y -ss ${POPUPS[i].freeze_at} -i "${src.mainScreen}" -frames:v 1 "${ff}"`,
        `Freeze frame ${i + 1} (clean at ${POPUPS[i].freeze_at}s)`,
      );
      freezes.push({
        file: ff,
        relStart: POPUPS[i].s - SCREEN_SKIP,
        relEnd: POPUPS[i].e - SCREEN_SKIP,
      });
    }
  }

  const screenDur = MAIN_TRIM_END - SCREEN_SKIP; // 100s of screen content

  // Build screen segment with popup removal and face PIP
  // Approach: multi-step overlays
  // Step 3a: Trim screen + add popup freeze overlays
  const screenClean = path.join(WORK, 'v_screen_clean.mp4');

  // Build overlay chain for popups
  let popupFilters = `[0:v]fps=${FPS},trim=duration=${screenDur},setpts=PTS-STARTPTS[s0]`;
  let lastLabel = 's0';
  let inputIdx = 1; // 0=screen, 1+=freeze frames

  for (let i = 0; i < freezes.length; i++) {
    const f = freezes[i];
    const nextLabel = `s${i + 1}`;
    popupFilters += `; [${inputIdx}:v]scale=${W}:${H}[ff${i}]`;
    popupFilters += `; [${lastLabel}][ff${i}]overlay=0:0:enable='between(t\\,${f.relStart.toFixed(1)}\\,${f.relEnd.toFixed(1)})'[${nextLabel}]`;
    lastLabel = nextLabel;
    inputIdx++;
  }

  const freezeInputs = freezes.map((f) => `-i "${f.file}"`).join(' ');
  run(
    [
      `ffmpeg -y -ss ${SCREEN_SKIP} -i "${src.mainScreen}" ${freezeInputs}`,
      `-filter_complex "${popupFilters}"`,
      `-map "[${lastLabel}]" -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -an -t ${screenDur} "${screenClean}"`,
    ].join(' '),
    'Clean screen (remove popups)',
  );

  // Step 3b: Add face PIP + logo watermark
  const screenPip = path.join(WORK, 'v_screen_pip.mp4');
  const sideStart = MAIN_TRIM_START + FACE_DUR - (INTRO_TRIM_DUR - MAIN_TRIM_START); // Sync side camera
  // Actually: at combined video time FACE_DUR, main audio is at time FACE_DUR - 1.5 = 4.0
  // Side camera should be at ~4.0s to be in sync
  const pipSideStart = FACE_DUR - (INTRO_TRIM_DUR - MAIN_TRIM_START); // 5.5 - 1.5 = 4.0

  run(
    [
      `ffmpeg -y -i "${screenClean}"`,
      `-ss ${pipSideStart} -i "${src.mainSide}"`,
      `-i "${LOGO}"`,
      `-filter_complex "`,
      `[1:v]scale=200:-1,fps=${FPS},trim=duration=${screenDur},setpts=PTS-STARTPTS[pip];`,
      `[pip]pad=w=iw+6:h=ih+6:x=3:y=3:color=white[pipb];`,
      `[2:v]scale=100:-1,format=yuva420p,colorchannelmixer=aa=0.5[wm];`,
      `[0:v][pipb]overlay=W-w-15:H-h-15[sp];`,
      `[sp][wm]overlay=W-w-15:12[out]`,
      `"`,
      `-map "[out]" -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -an -t ${screenDur} "${screenPip}"`,
    ].join(' '),
    'Add face PIP + logo',
  );

  // ═══ PASS 4: Outro Segment ═══
  console.log('\n=== PASS 4: Outro ===');
  const outroDur = totalDur - FACE_DUR - screenDur;
  const outroOut = path.join(WORK, 'v_outro.mp4');

  if (outroDur > 0.5) {
    // Clean dark background outro with PM Strategies branding
    run(
      [
        `ffmpeg -y -i "${LOGO}"`,
        `-filter_complex "`,
        `color=c=#0a0a1a:s=${W}x${H}:d=${outroDur.toFixed(2)}:r=${FPS}[bg];`,
        `[0:v]scale=280:-1[logo];`,
        `[bg][logo]overlay=(W-w)/2:(H/2-h-60):enable='gte(t\\,0.3)'[l1];`,
        `[l1]drawtext=fontfile='${FONT}':text='PM Strategies with Luke Baer':fontsize=38:fontcolor=white:x=(w-text_w)/2:y=h/2+30:enable='gte(t\\,0.5)',`,
        `drawtext=fontfile='${FONT_REG}':text='github.com/lukeybaer/secondbrain-os':fontsize=24:fontcolor=#00FF88:x=(w-text_w)/2:y=h/2+80:enable='gte(t\\,0.8)',`,
        `drawtext=fontfile='${FONT_REG}':text='Follow for more':fontsize=22:fontcolor=white@0.7:x=(w-text_w)/2:y=h/2+115:enable='gte(t\\,1.2)'[out]`,
        `"`,
        `-map "[out]" -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -an -t ${outroDur.toFixed(2)} "${outroOut}"`,
      ].join(' '),
      'Render outro',
    );
  }

  // ═══ PASS 5: Concat Video Segments ═══
  console.log('\n=== PASS 5: Concat Video ===');
  const concatVideo = path.join(WORK, 'v_concat.mp4');
  const concatList = path.join(WORK, 'v_concat.txt');

  const segments = [`file '${wp(faceOut)}'`, `file '${wp(screenPip)}'`];
  if (outroDur > 0.5) segments.push(`file '${wp(outroOut)}'`);
  fs.writeFileSync(concatList, segments.join('\n'));

  run(`ffmpeg -y -f concat -safe 0 -i "${concatList}" -c copy "${concatVideo}"`, 'Concat video');

  // ═══ PASS 6: Generate & Apply Captions ═══
  console.log('\n=== PASS 6: Captions ===');

  // Load transcripts
  const introWords = JSON.parse(
    fs.readFileSync(path.join(INTRO_REC, 'transcript_intro.json'), 'utf8'),
  ).words;
  const mainWords = JSON.parse(
    fs.readFileSync(path.join(MAIN_REC, 'transcript_main.json'), 'utf8'),
  ).words;

  // Build combined word list with adjusted timestamps
  const words = [];
  const mainOffset = INTRO_TRIM_DUR - MAIN_TRIM_START; // 1.5
  const gapRemoved = THANKYOU_START - MAIN_TRIM_END; // 10.0

  for (const w of introWords) {
    words.push({ word: w.word, start: w.start - INTRO_TRIM_START, end: w.end - INTRO_TRIM_START });
  }
  for (const w of mainWords) {
    if (w.start < MAIN_TRIM_START) continue;
    if (w.start < MAIN_TRIM_END) {
      words.push({ word: w.word, start: w.start + mainOffset, end: w.end + mainOffset });
    } else if (w.start >= THANKYOU_START) {
      words.push({
        word: w.word,
        start: w.start + mainOffset - gapRemoved,
        end: w.end + mainOffset - gapRemoved,
      });
    }
  }

  // Generate SRT file
  const srtPath = path.join(WORK, 'captions.srt');
  let srt = '';
  let idx = 1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const display = w.word.replace(/["\\':\\%$,\[\](){}@/#&\u2014]/g, '').trim();
    if (!display) continue;

    const t0 = Math.max(0, w.start);
    const t1 =
      i + 1 < words.length
        ? Math.min(words[i + 1].start, totalDur)
        : Math.min(w.end + 0.5, totalDur);
    if (t1 - t0 < 0.1) continue;

    srt += `${idx}\n${formatSrtTime(t0)} --> ${formatSrtTime(t1)}\n${display}\n\n`;
    idx++;
  }
  fs.writeFileSync(srtPath, srt);
  console.log(`  SRT: ${idx - 1} entries`);

  // Apply captions using ASS subtitles for green emphasis control
  // Generate ASS file with styled words
  const assPath = path.join(WORK, 'captions.ass');
  let ass = `[Script Info]
Title: LinkedIn Captions
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,68,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,2,10,10,60,1
Style: Emphasis,Arial,68,&H0088FF00,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,2,10,10,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const display = w.word.replace(/["\\':\\%$,\[\](){}@/#&\u2014]/g, '').trim();
    if (!display) continue;

    const t0 = Math.max(0, w.start);
    const t1 =
      i + 1 < words.length
        ? Math.min(words[i + 1].start, totalDur)
        : Math.min(w.end + 0.5, totalDur);
    if (t1 - t0 < 0.1) continue;

    const cleanLower = display.toLowerCase().replace(/[.,!?;:]/g, '');
    const style = EMPHASIS.has(cleanLower) ? 'Emphasis' : 'Default';

    ass += `Dialogue: 0,${formatAssTime(t0)},${formatAssTime(t1)},${style},,0,0,0,,${display}\n`;
  }

  fs.writeFileSync(assPath, ass);

  // Apply subtitles
  const captioned = path.join(WORK, 'v_captioned.mp4');
  // Use the ASS file path escaped for FFmpeg (colons and backslashes)
  const assEscaped = wp(assPath).replace(/:/g, '\\:').replace(/'/g, "\\'");

  run(
    [
      `ffmpeg -y -i "${concatVideo}"`,
      `-vf "ass='${assEscaped}'"`,
      `-c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -an "${captioned}"`,
    ].join(' '),
    'Apply captions',
  );

  // ═══ PASS 7: Final Composite ═══
  console.log('\n=== PASS 7: Final Composite ===');
  const final = path.join(WORK, 'final_linkedin.mp4');

  run(
    [
      `ffmpeg -y -i "${captioned}" -i "${audio.norm}"`,
      `-c:v copy -c:a aac -b:a 192k -shortest -t ${totalDur.toFixed(2)} "${final}"`,
    ].join(' '),
    'Mux video + audio',
  );

  // Verify
  const outDur = dur(final);
  const outSize = fs.statSync(final).size;
  console.log(`\n=== DONE ===`);
  console.log(
    `  Duration: ${Math.floor(outDur / 60)}:${String(Math.floor(outDur % 60)).padStart(2, '0')}`,
  );
  console.log(`  Size: ${(outSize / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  Output: ${final}`);
}

function formatSrtTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function formatAssTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

main();
