const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const WORK = path.join(
  process.env.APPDATA,
  'secondbrain/data/studio/recordings/linkedin_production',
);
const concat = path.join(WORK, 'v_concat.mp4');
const audio = path.join(WORK, 'a_norm.wav');
const assRaw = path.join(WORK, 'captions.ass');
const ass = assRaw.replace(/\\/g, '/').replace(':', '\\:');
const hq = path.join(WORK, 'v_captioned_hq.mp4');
const finalOut = path.join(WORK, 'final_linkedin_hq.mp4');

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

// Step 1: Apply captions + fade transitions (higher quality CRF 14, preset slow)
run(
  `ffmpeg -y -i "${concat}" -vf "ass='${ass}',fade=in:st=0:d=0.5,fade=out:st=113:d=1" -c:v libx264 -preset slow -crf 14 -pix_fmt yuv420p -an "${hq}"`,
  'Apply captions + fades (HQ)',
);

// Step 2: Mux video + audio with audio fade out, trim to 114s
run(
  `ffmpeg -y -i "${hq}" -i "${audio}" -c:v copy -c:a aac -b:a 192k -af "afade=out:st=112.5:d=1.5" -t 114 -shortest "${finalOut}"`,
  'Mux video + audio (final)',
);

// Verify
const dur = execSync(
  `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${finalOut}"`,
  { encoding: 'utf8' },
).trim();
const sz = fs.statSync(finalOut).size;
console.log(`\n=== Final Output ===`);
console.log(`Duration: ${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}`);
console.log(`Size: ${(sz / 1024 / 1024).toFixed(1)} MB`);
console.log(`Bitrate: ${Math.round((sz * 8) / dur / 1000)} kbps`);
console.log(`Path: ${finalOut}`);
