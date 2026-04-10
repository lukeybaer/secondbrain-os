#!/usr/bin/env node
/**
 * LinkedIn Video Producer v3
 * - Starts with face (no text card)
 * - Front camera (NexiGo 1280x720) as primary
 * - Flips to side camera for visual interest
 * - Screen share segments with face PIP
 * - Word-by-word captions with green emphasis
 * - AILifeHacks branding
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APPDATA = process.env.APPDATA;
const REC = path.join(APPDATA, 'secondbrain/data/studio/recordings/rec_1775441664748');
const WORK = path.join(APPDATA, 'secondbrain/data/studio/recordings/linkedin_v3');
const LOGO = 'C:/Users/luked/secondbrain/ailifehacks-logo.png';
const FONT = 'C\\:/Windows/Fonts/arialbd.ttf';
const FONT_REG = 'C\\:/Windows/Fonts/arial.ttf';
// 16:9 for LinkedIn — preserves full screen share without cropping
const W = 1920,
  H = 1080;
const W16 = 1920,
  H16 = 1080;
const FPS = 30;

// Source files
const SRC = {
  front: path.join(REC, 'front.mp4'), // NexiGo 1280x720 — primary, 77s
  side: path.join(REC, 'side.mp4'), // Integrated 640x480 — secondary, 112s
  screen: path.join(REC, 'screen.mp4'), // 1920x1080 + audio, 114s
};

// Edit Decision List
// front camera is primary (NexiGo 1280x720)
// side camera when Luke looks that way or for variety
// screen when showing slides/demos
// front only has 77s of footage, so after ~75s use side as face cam
const EDL = [
  // Open with front face — "My friends, I built an AI that's like making calls for me"
  { type: 'front', start: 0, end: 7.3 },
  // "So in the next 60 seconds, you're going to get a quick rundown" — still front
  { type: 'front', start: 7.3, end: 12.4 },
  // "because I'm cool like that" — flip to side for the swagger moment
  { type: 'side', start: 12.4, end: 15.5 },
  // "So yeah, built a second brain, it never forgets" — front
  { type: 'front', start: 15.5, end: 22 },
  // Screen share starts here and STAYS — Luke in PIP box
  // Front camera dies at ~77s so switch PIP to side camera at 75s
  { type: 'screen', start: 22, end: 75, pipCam: 'front' },
  { type: 'screen', start: 75, end: 106.5, pipCam: 'side' },
  // Outro card
  { type: 'outro', start: 106.5, end: 109.5 },
];

// Emphasis words for captions
const EMPHASIS = new Set([
  'ai',
  'built',
  'free',
  'never',
  'forgets',
  'forget',
  'anything',
  'everything',
  'brain',
  'second',
  'amazing',
  'future',
  'everyone',
  'agent',
  'enjoy',
  'cool',
  'calls',
  'acts',
  'works',
  'scattered',
  'control',
  'memory',
  'knowledge',
  'pizza',
  'dental',
  'accountant',
  'google',
  'repo',
  'open',
  'source',
  'pull',
  'requests',
  'giving',
  'world',
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

function fmtAss(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function main() {
  console.log('=== LinkedIn Video Producer v3 ===\n');
  fs.mkdirSync(WORK, { recursive: true });

  // ═══ PASS 1: Extract & normalize audio from screen recording ═══
  console.log('=== Audio ===');
  const audioRaw = path.join(WORK, 'audio_raw.wav');
  const audioNorm = path.join(WORK, 'audio_norm.wav');

  // Trim audio to match the EDL range
  const audioStart = EDL[0].start;
  const audioEnd = EDL[EDL.length - 1].end;
  const totalDur = audioEnd - audioStart;

  run(
    `ffmpeg -y -i "${SRC.screen}" -ss ${audioStart} -t ${totalDur} -vn -c:a pcm_s16le -ar 48000 "${audioRaw}"`,
    'Extract audio',
  );
  run(
    `ffmpeg -y -i "${audioRaw}" -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 -c:a pcm_s16le "${audioNorm}"`,
    'Normalize audio',
  );
  const actualAudioDur = dur(audioNorm);
  console.log(`  Audio: ${actualAudioDur.toFixed(1)}s\n`);

  // ═══ PASS 2: Render each segment (LinkedIn 4:5) ═══
  console.log('=== Render Segments (LinkedIn 4:5) ===');
  const segFiles = [];

  for (let i = 0; i < EDL.length; i++) {
    const seg = EDL[i];
    const segDur = seg.end - seg.start;
    const outFile = path.join(WORK, `seg_${String(i).padStart(2, '0')}.mp4`);
    segFiles.push(outFile);

    if (seg.type === 'front' && i === 0) {
      // FIRST segment: front face + animated logo lower-third intro
      // Logo fades in at bottom-left with text, dark bar behind it, fades out at 5s
      // Corner logo fades in after lower-third fades out
      run(
        [
          `ffmpeg -y -ss ${seg.start} -t ${segDur} -i "${SRC.front}"`,
          `-i "${LOGO}" -i "${LOGO}"`,
          `-filter_complex "`,
          `[0:v]scale=${W}:-1,crop=${W}:${H},fps=${FPS},setpts=PTS-STARTPTS[face];`,

          // Lower-third logo: fade in 0.3-1s, hold, fade out 5-6s
          `[1:v]scale=140:-1,format=yuva420p,fade=in:st=0.3:d=0.7:alpha=1,fade=out:st=5:d=1:alpha=1[logolt];`,

          // Corner logo: fade in starting at 5s
          `[2:v]scale=100:-1,format=yuva420p,fade=in:st=5:d=1:alpha=1[logocorner];`,

          // Dark lower-third bar
          `[face]drawbox=y=ih-180:w=iw:h=180:color=black@0.55:t=fill:enable='between(t\\,0.3\\,6)'[fb];`,

          // Overlay lower-third logo (slide in via x expression)
          `[fb][logolt]overlay=x='min(50\\,-200+250*min((t-0.3)/0.5\\,1))':y=H-165:enable='between(t\\,0.3\\,6)'[fl];`,

          // Text: channel name + tagline
          `[fl]drawtext=fontfile='${FONT}':text='AI Life Hacks':fontsize=42:fontcolor=white:x=210:y=h-158:enable='between(t\\,0.6\\,5.8)',`,
          `drawtext=fontfile='${FONT_REG}':text='by Lukey Baer':fontsize=26:fontcolor=#00FF88:x=210:y=h-110:enable='between(t\\,0.8\\,5.8)'[ft];`,

          // Corner logo persists
          `[ft][logocorner]overlay=W-w-20:15:eof_action=repeat[out]`,
          `"`,
          `-map "[out]" -c:v libx264 -preset fast -crf 16 -pix_fmt yuv420p -an -t ${segDur} "${outFile}"`,
        ].join(' '),
        `Seg ${i}: front face + logo intro (${segDur.toFixed(1)}s @ ${seg.start}s)`,
      );
    } else if (seg.type === 'front') {
      // Full-screen front face: NexiGo 1280x720 → scale to fill 1920x1080
      run(
        [
          `ffmpeg -y -ss ${seg.start} -t ${segDur} -i "${SRC.front}"`,
          `-i "${LOGO}"`,
          `-filter_complex "`,
          `[0:v]scale=${W}:-1,crop=${W}:${H},fps=${FPS},setpts=PTS-STARTPTS[face];`,
          `[1:v]scale=100:-1,format=yuva420p,colorchannelmixer=aa=0.5[logo];`,
          `[face][logo]overlay=W-w-20:15:eof_action=repeat[out]`,
          `"`,
          `-map "[out]" -c:v libx264 -preset fast -crf 16 -pix_fmt yuv420p -an -t ${segDur} "${outFile}"`,
        ].join(' '),
        `Seg ${i}: front face (${segDur.toFixed(1)}s @ ${seg.start}s)`,
      );
    } else if (seg.type === 'side') {
      // Full-screen side face: Integrated 640x480 → scale to fill 1920x1080
      run(
        [
          `ffmpeg -y -ss ${seg.start} -t ${segDur} -i "${SRC.side}"`,
          `-i "${LOGO}"`,
          `-filter_complex "`,
          `[0:v]scale=${W}:-1,crop=${W}:${H},fps=${FPS},setpts=PTS-STARTPTS[face];`,
          `[1:v]scale=100:-1,format=yuva420p,colorchannelmixer=aa=0.5[logo];`,
          `[face][logo]overlay=W-w-20:15:eof_action=repeat[out]`,
          `"`,
          `-map "[out]" -c:v libx264 -preset fast -crf 16 -pix_fmt yuv420p -an -t ${segDur} "${outFile}"`,
        ].join(' '),
        `Seg ${i}: side face (${segDur.toFixed(1)}s @ ${seg.start}s)`,
      );
    } else if (seg.type === 'screen') {
      // Screen share with face PIP
      const pipCam = seg.pipCam || (seg.start < 75 ? 'front' : 'side');
      const pipSrc = pipCam === 'front' ? SRC.front : SRC.side;
      const pipLabel = pipCam;
      const pipSize = 320;
      run(
        [
          `ffmpeg -y -ss ${seg.start} -t ${segDur} -i "${SRC.screen}"`,
          `-ss ${seg.start} -t ${segDur} -i "${pipSrc}"`,
          `-i "${LOGO}"`,
          `-filter_complex "`,
          `[0:v]scale=${W}:${H},fps=${FPS},setpts=PTS-STARTPTS[scr];`,
          `[1:v]scale=${pipSize}:-1,fps=${FPS},setpts=PTS-STARTPTS[pip];`,
          `[pip]pad=w=iw+6:h=ih+6:x=3:y=3:color=white[pipb];`,
          `[2:v]scale=100:-1,format=yuva420p,colorchannelmixer=aa=0.5[logo];`,
          `[scr][pipb]overlay=W-w-20:H-h-20[sp];`,
          `[sp][logo]overlay=W-w-20:15:eof_action=repeat[out]`,
          `"`,
          `-map "[out]" -c:v libx264 -preset fast -crf 16 -pix_fmt yuv420p -an -t ${segDur} "${outFile}"`,
        ].join(' '),
        `Seg ${i}: screen+${pipLabel} PIP (${segDur.toFixed(1)}s @ ${seg.start}s)`,
      );
    } else if (seg.type === 'outro') {
      // AILifeHacks branding outro
      const outroDur = seg.end - seg.start;
      run(
        [
          `ffmpeg -y -i "${LOGO}"`,
          `-filter_complex "`,
          `color=c=#0a0a1a:s=${W}x${H}:d=${outroDur}:r=${FPS}[bg];`,
          `[0:v]scale=200:-1[logo];`,
          `[bg][logo]overlay=(W-w)/2:(H/2-h-40):eof_action=repeat[l1];`,
          `[l1]drawtext=fontfile='${FONT}':text='AI Life Hacks by Lukey Baer':fontsize=34:fontcolor=white:x=(w-text_w)/2:y=h/2+40:enable='gte(t\\,0.2)',`,
          `drawtext=fontfile='${FONT_REG}':text='youtube.com/@AILifeHacksbyLukeyBaer':fontsize=22:fontcolor=#00FF88:x=(w-text_w)/2:y=h/2+85:enable='gte(t\\,0.5)',`,
          `drawtext=fontfile='${FONT_REG}':text='Subscribe for more':fontsize=20:fontcolor=white@0.7:x=(w-text_w)/2:y=h/2+115:enable='gte(t\\,0.8)'[out]`,
          `"`,
          `-map "[out]" -c:v libx264 -preset fast -crf 16 -pix_fmt yuv420p -an -t ${outroDur} "${outFile}"`,
        ].join(' '),
        `Seg ${i}: outro`,
      );
    }
  }

  // ═══ PASS 3: Concat all segments ═══
  console.log('\n=== Concat Segments ===');
  const concatList = path.join(WORK, 'v_concat.txt');
  fs.writeFileSync(concatList, segFiles.map((f) => `file '${wp(f)}'`).join('\n'));
  const concatVideo = path.join(WORK, 'v_concat.mp4');
  run(
    `ffmpeg -y -f concat -safe 0 -i "${concatList}" -c copy "${concatVideo}"`,
    'Concat all segments',
  );

  // ═══ PASS 4: Word-by-word captions ═══
  console.log('\n=== Captions ===');
  const recording = JSON.parse(fs.readFileSync(path.join(REC, 'recording.json'), 'utf8'));
  const rawWords = recording.transcript.words;

  // Filter words to our EDL time range
  const words = rawWords.filter((w) => w.start >= EDL[0].start && w.end <= EDL[EDL.length - 1].end);

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
Style: Default,Arial,58,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,2,10,10,60,1
Style: Emphasis,Arial,58,&H0088FF00,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,2,10,10,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const display = w.word.replace(/["\\':\\%$,\[\](){}@/#&\u2014]/g, '').trim();
    if (!display) continue;
    const t0 = Math.max(0, w.start - EDL[0].start);
    const t1 =
      i + 1 < words.length
        ? Math.min(words[i + 1].start - EDL[0].start, totalDur)
        : Math.min(w.end - EDL[0].start + 0.5, totalDur);
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

  // ═══ PASS 5: Final mux ═══
  console.log('\n=== Final Mux ===');
  const finalLinkedIn = path.join(WORK, 'final_linkedin.mp4');
  run(
    [
      `ffmpeg -y -i "${captioned}" -i "${audioNorm}"`,
      `-c:v copy -c:a aac -b:a 192k -af "afade=out:st=${(totalDur - 1.5).toFixed(1)}:d=1.5" -t ${totalDur.toFixed(2)} -shortest "${finalLinkedIn}"`,
    ].join(' '),
    'Mux LinkedIn video + audio',
  );

  // Copy to Desktop
  const desktop = 'C:/Users/luked/Desktop/SecondBrain_LinkedIn_v3.mp4';
  fs.copyFileSync(finalLinkedIn, desktop);

  const outDur = dur(finalLinkedIn);
  const sz = fs.statSync(finalLinkedIn).size;
  console.log(`\n✅ DONE: ${desktop}`);
  console.log(`   Duration: ${outDur.toFixed(1)}s`);
  console.log(`   Size: ${(sz / 1024 / 1024).toFixed(1)} MB`);

  // ═══ PASS 6: YouTube 16:9 version ═══
  console.log('\n=== YouTube 16:9 ===');
  // Re-render segments at 1920x1080 would be expensive.
  // Instead, letterbox the LinkedIn version into 16:9.
  const finalYT = path.join(WORK, 'final_youtube.mp4');
  run(
    [
      `ffmpeg -y -i "${finalLinkedIn}"`,
      `-vf "scale=-1:${H16},pad=${W16}:${H16}:(ow-iw)/2:0:black"`,
      `-c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -c:a copy "${finalYT}"`,
    ].join(' '),
    'YouTube 16:9 letterbox',
  );

  const ytDesktop = 'C:/Users/luked/Desktop/SecondBrain_YouTube_v3.mp4';
  fs.copyFileSync(finalYT, ytDesktop);
  console.log(`   YouTube: ${ytDesktop}`);
}

main();
