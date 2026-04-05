#!/usr/bin/env node
/**
 * LinkedIn Video Producer v2
 * - Full-screen face (no box), properly synced audio/video
 * - Camera cuts between face and screen for visual interest
 * - Smart cut timing hides WhatsApp popups (no freeze frames needed)
 * - AILifeHacks branding
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APPDATA = process.env.APPDATA;
const MAIN_REC = path.join(APPDATA, 'secondbrain/data/studio/recordings/rec_1775401953554');
const INTRO_REC = path.join(APPDATA, 'secondbrain/data/studio/recordings/rec_1775402621691');
const WORK = path.join(APPDATA, 'secondbrain/data/studio/recordings/linkedin_v2');
const LOGO = 'C:/Users/luked/secondbrain/ailifehacks-logo.png';
const FONT = 'C\\:/Windows/Fonts/arialbd.ttf';
const FONT_REG = 'C\\:/Windows/Fonts/arial.ttf';
const W = 1920,
  H = 1080,
  FPS = 30;

// Audio timing (same as v1)
const INTRO_TRIM_START = 1.2;
const INTRO_TRIM_DUR = 4.0;
const MAIN_TRIM_START = 2.5;
const MAIN_TRIM_END = 112.0;
const THANKYOU_START = 122.0;
const THANKYOU_DUR = 2.5;
const MAIN_OFFSET = INTRO_TRIM_DUR - MAIN_TRIM_START; // 1.5

// Edit Decision List: camera cuts
// combined_time → main_time = combined_time - 1.5 (for main portion)
// 'face' = full-screen side camera, 'screen' = screen share + face PIP
// Popups at main 16.5-21, 76.5-80.5, 96.5-100.5 — cuts timed to avoid them!
const EDL = [
  { type: 'text', start: 0, dur: 4.0 }, // Hook text card
  { type: 'face', start: 4, dur: 9.5 }, // "OK so I've built a second brain"
  { type: 'screen', start: 13.5, dur: 2.5 }, // First slide (clean before popup1)
  { type: 'face', start: 16, dur: 6.5 }, // COVERS POPUP 1
  { type: 'screen', start: 22.5, dur: 12.5 }, // scattered + command center
  { type: 'face', start: 35, dur: 7 }, // "never forgets, free open source"
  { type: 'screen', start: 42, dur: 13 }, // knowledge graph
  { type: 'face', start: 55, dur: 7 }, // "real brain"
  { type: 'screen', start: 62, dur: 16 }, // alive + ask anything (ends before popup2)
  { type: 'face', start: 78, dur: 9 }, // COVERS POPUP 2. "it acts, phone calls"
  { type: 'screen', start: 87, dur: 11 }, // capabilities + Amy (ends before popup3)
  { type: 'face', start: 98, dur: 9 }, // COVERS POPUP 3. "act on goals"
  { type: 'screen', start: 107, dur: 6.5 }, // closing slides
  { type: 'outro', start: 113.5, dur: 2.5 }, // AILifeHacks branding
];

// Emphasis words for captions
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

function run(cmd, label) {
  console.log(`> ${label}...`);
  try {
    execSync(cmd, { stdio: 'pipe', timeout: 600000 });
    console.log('  OK');
  } catch (e) {
    const err = e.stderr?.toString() || '';
    console.error(
      '  FAIL:',
      err
        .split('\n')
        .filter((l) => l.trim())
        .slice(-5)
        .join('\n'),
    );
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
}

function main() {
  console.log('=== LinkedIn Video Producer v2 ===\n');
  fs.mkdirSync(WORK, { recursive: true });

  const src = {
    screen: path.join(MAIN_REC, 'screen.mp4'),
    side: path.join(MAIN_REC, 'side.mp4'),
    introAudio: path.join(INTRO_REC, 'audio_intro.wav'),
    mainAudio: path.join(MAIN_REC, 'audio_main.wav'),
  };

  // ═══ PASS 1: Audio (same as v1) ═══
  console.log('=== Audio Splice ===');
  const aPaths = {
    introTrim: path.join(WORK, 'a_intro.wav'),
    mainBody: path.join(WORK, 'a_main.wav'),
    thankYou: path.join(WORK, 'a_thanks.wav'),
    concat: path.join(WORK, 'a_concat.txt'),
    raw: path.join(WORK, 'a_raw.wav'),
    norm: path.join(WORK, 'a_norm.wav'),
  };

  run(
    `ffmpeg -y -i "${src.introAudio}" -ss ${INTRO_TRIM_START} -t ${INTRO_TRIM_DUR} -c:a pcm_s16le -ar 48000 "${aPaths.introTrim}"`,
    'Trim intro',
  );
  run(
    `ffmpeg -y -i "${src.mainAudio}" -ss ${MAIN_TRIM_START} -t ${MAIN_TRIM_END - MAIN_TRIM_START} -c:a pcm_s16le -ar 48000 "${aPaths.mainBody}"`,
    'Trim main',
  );
  run(
    `ffmpeg -y -i "${src.mainAudio}" -ss ${THANKYOU_START} -t ${THANKYOU_DUR} -c:a pcm_s16le -ar 48000 "${aPaths.thankYou}"`,
    'Trim thanks',
  );

  fs.writeFileSync(
    aPaths.concat,
    [
      `file '${wp(aPaths.introTrim)}'`,
      `file '${wp(aPaths.mainBody)}'`,
      `file '${wp(aPaths.thankYou)}'`,
    ].join('\n'),
  );

  run(`ffmpeg -y -f concat -safe 0 -i "${aPaths.concat}" -c copy "${aPaths.raw}"`, 'Concat');
  run(
    `ffmpeg -y -i "${aPaths.raw}" -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 -c:a pcm_s16le "${aPaths.norm}"`,
    'Normalize',
  );
  const totalDur = dur(aPaths.norm);
  console.log(`  Audio: ${totalDur.toFixed(1)}s\n`);

  // ═══ PASS 2: Render Each Segment ═══
  console.log('=== Render Segments ===');
  const segFiles = [];

  for (let i = 0; i < EDL.length; i++) {
    const seg = EDL[i];
    const outFile = path.join(WORK, `seg_${String(i).padStart(2, '0')}.mp4`);
    segFiles.push(outFile);
    const mainTime = seg.start - MAIN_OFFSET; // main_time for this segment

    if (seg.type === 'text') {
      // Text hook card with AILifeHacks logo
      run(
        [
          `ffmpeg -y -i "${LOGO}"`,
          `-filter_complex "`,
          `color=c=#0a0a1a:s=${W}x${H}:d=${seg.dur}:r=${FPS}[bg];`,
          `[0:v]scale=120:-1[logo];`,
          `[bg][logo]overlay=W-w-30:25:eof_action=repeat[l1];`,
          `[l1]drawtext=fontfile='${FONT}':text='Do you want to':fontsize=60:fontcolor=white:x=(w-text_w)/2:y=h/2-100:enable='between(t\\,0.3\\,${seg.dur})',`,
          `drawtext=fontfile='${FONT}':text='never forget anything':fontsize=60:fontcolor=#00FF88:x=(w-text_w)/2:y=h/2-20:enable='between(t\\,0.6\\,${seg.dur})',`,
          `drawtext=fontfile='${FONT}':text='ever again?':fontsize=60:fontcolor=white:x=(w-text_w)/2:y=h/2+60:enable='between(t\\,0.9\\,${seg.dur})'[out]`,
          `"`,
          `-map "[out]" -c:v libx264 -preset fast -crf 16 -pix_fmt yuv420p -an -t ${seg.dur} "${outFile}"`,
        ].join(' '),
        `Seg ${i}: text card`,
      );
    } else if (seg.type === 'face') {
      // Full-screen face: scale 640x480 → crop to 1920x1080
      run(
        [
          `ffmpeg -y -ss ${mainTime} -t ${seg.dur} -i "${src.side}"`,
          `-i "${LOGO}"`,
          `-filter_complex "`,
          `[0:v]scale=1920:-1,crop=${W}:${H},fps=${FPS},setpts=PTS-STARTPTS[face];`,
          `[1:v]scale=80:-1,format=yuva420p,colorchannelmixer=aa=0.5[logo];`,
          `[face][logo]overlay=W-w-15:12:eof_action=repeat[out]`,
          `"`,
          `-map "[out]" -c:v libx264 -preset fast -crf 16 -pix_fmt yuv420p -an -t ${seg.dur} "${outFile}"`,
        ].join(' '),
        `Seg ${i}: face (${seg.dur}s from main ${mainTime.toFixed(1)}s)`,
      );
    } else if (seg.type === 'screen') {
      // Screen share with face PIP + logo
      const pipSize = 220;
      run(
        [
          `ffmpeg -y -ss ${mainTime} -t ${seg.dur} -i "${src.screen}"`,
          `-ss ${mainTime} -t ${seg.dur} -i "${src.side}"`,
          `-i "${LOGO}"`,
          `-filter_complex "`,
          `[0:v]fps=${FPS},setpts=PTS-STARTPTS[scr];`,
          `[1:v]scale=${pipSize}:-1,fps=${FPS},setpts=PTS-STARTPTS[pip];`,
          `[pip]pad=w=iw+6:h=ih+6:x=3:y=3:color=white[pipb];`,
          `[2:v]scale=80:-1,format=yuva420p,colorchannelmixer=aa=0.5[logo];`,
          `[scr][pipb]overlay=W-w-15:H-h-15[sp];`,
          `[sp][logo]overlay=W-w-15:12:eof_action=repeat[out]`,
          `"`,
          `-map "[out]" -c:v libx264 -preset fast -crf 16 -pix_fmt yuv420p -an -t ${seg.dur} "${outFile}"`,
        ].join(' '),
        `Seg ${i}: screen+PIP (${seg.dur}s from main ${mainTime.toFixed(1)}s)`,
      );
    } else if (seg.type === 'outro') {
      // AILifeHacks branding outro
      run(
        [
          `ffmpeg -y -i "${LOGO}"`,
          `-filter_complex "`,
          `color=c=#0a0a1a:s=${W}x${H}:d=${seg.dur}:r=${FPS}[bg];`,
          `[0:v]scale=200:-1[logo];`,
          `[bg][logo]overlay=(W-w)/2:(H/2-h-40):eof_action=repeat[l1];`,
          `[l1]drawtext=fontfile='${FONT}':text='AI Life Hacks by Lukey Baer':fontsize=34:fontcolor=white:x=(w-text_w)/2:y=h/2+40:enable='gte(t\\,0.2)',`,
          `drawtext=fontfile='${FONT_REG}':text='youtube.com/@AILifeHacksbyLukeyBaer':fontsize=22:fontcolor=#00FF88:x=(w-text_w)/2:y=h/2+85:enable='gte(t\\,0.5)',`,
          `drawtext=fontfile='${FONT_REG}':text='Subscribe for more':fontsize=20:fontcolor=white@0.7:x=(w-text_w)/2:y=h/2+115:enable='gte(t\\,0.8)'[out]`,
          `"`,
          `-map "[out]" -c:v libx264 -preset fast -crf 16 -pix_fmt yuv420p -an -t ${seg.dur} "${outFile}"`,
        ].join(' '),
        `Seg ${i}: outro`,
      );
    }
  }

  // ═══ PASS 3: Concat All Segments ═══
  console.log('\n=== Concat Segments ===');
  const concatList = path.join(WORK, 'v_concat.txt');
  fs.writeFileSync(concatList, segFiles.map((f) => `file '${wp(f)}'`).join('\n'));
  const concatVideo = path.join(WORK, 'v_concat.mp4');
  run(
    `ffmpeg -y -f concat -safe 0 -i "${concatList}" -c copy "${concatVideo}"`,
    'Concat all segments',
  );

  // ═══ PASS 4: Captions ═══
  console.log('\n=== Captions ===');
  const introWords = JSON.parse(
    fs.readFileSync(path.join(INTRO_REC, 'transcript_intro.json'), 'utf8'),
  ).words;
  const mainWords = JSON.parse(
    fs.readFileSync(path.join(MAIN_REC, 'transcript_main.json'), 'utf8'),
  ).words;

  const words = [];
  const gapRemoved = THANKYOU_START - MAIN_TRIM_END;

  for (const w of introWords) {
    words.push({ word: w.word, start: w.start - INTRO_TRIM_START, end: w.end - INTRO_TRIM_START });
  }
  for (const w of mainWords) {
    if (w.start < MAIN_TRIM_START) continue;
    if (w.start < MAIN_TRIM_END) {
      words.push({ word: w.word, start: w.start + MAIN_OFFSET, end: w.end + MAIN_OFFSET });
    } else if (w.start >= THANKYOU_START) {
      words.push({
        word: w.word,
        start: w.start + MAIN_OFFSET - gapRemoved,
        end: w.end + MAIN_OFFSET - gapRemoved,
      });
    }
  }

  // Generate ASS subtitles
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
    ass += `Dialogue: 0,${fmtAss(t0)},${fmtAss(t1)},${style},,0,0,0,,${display}\n`;
  }
  fs.writeFileSync(assPath, ass);
  console.log(`  ASS: ${words.length} words`);

  // Apply captions + fades
  const assEsc = wp(assPath).replace(':', '\\:');
  const captioned = path.join(WORK, 'v_captioned.mp4');
  run(
    [
      `ffmpeg -y -i "${concatVideo}"`,
      `-vf "ass='${assEsc}',fade=in:st=0:d=0.5,fade=out:st=${(totalDur - 1).toFixed(1)}:d=1"`,
      `-c:v libx264 -preset slow -crf 14 -pix_fmt yuv420p -an "${captioned}"`,
    ].join(' '),
    'Apply captions + fades',
  );

  // ═══ PASS 5: Final Mux ═══
  console.log('\n=== Final Mux ===');
  const finalOut = path.join(WORK, 'final_linkedin.mp4');
  run(
    [
      `ffmpeg -y -i "${captioned}" -i "${aPaths.norm}"`,
      `-c:v copy -c:a aac -b:a 192k -af "afade=out:st=${(totalDur - 1.5).toFixed(1)}:d=1.5" -t ${totalDur.toFixed(2)} -shortest "${finalOut}"`,
    ].join(' '),
    'Mux video + audio',
  );

  // Also copy to Desktop
  const desktop = 'C:/Users/luked/Desktop/SecondBrain_LinkedIn.mp4';
  fs.copyFileSync(finalOut, desktop);

  const outDur = dur(finalOut);
  const sz = fs.statSync(finalOut).size;
  console.log(`\n=== DONE ===`);
  console.log(
    `Duration: ${Math.floor(outDur / 60)}:${String(Math.floor(outDur % 60)).padStart(2, '0')}`,
  );
  console.log(`Size: ${(sz / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Desktop: ${desktop}`);
}

function fmtAss(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

main();
