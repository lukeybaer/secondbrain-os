#!/usr/bin/env node
// Podcast clipping skill, canonical implementation.
//
// Takes a viral-tech-clip proposal (any long-form interview / podcast / keynote
// source with a timestamp range and a transcript) and produces a 9:16 vertical
// short with the locked v5 layout:
//
//   y=0    -> 400    top hook band (3-line drawtext, purple-cow claim)
//   y=420  -> 1230   talking-head video 1080x810 (cropped 1.33:1, scaled up)
//   y=1240 -> 1380   karaoke caption strip (Hormozi/MrBeast white default,
//                    green active word, yellow on top-20% emphasis)
//   y=1400 -> 1820   B-roll fill 1080x420 (default Minecraft parkour) during
//                    speaker audio; replaced by payoff drawtext at t>=clip_end
//   y=1870           source attribution
//
// Locked 2026-05-13 after Luke posted v5 to AILifeHacksByLukeyBaer and said
// "lock in this format." Skill spec: skills/content/podcast-clip.md.
// Tests: scripts/__tests__/build-viral-clip.test.js.
//
// Usage:
//   node scripts/build-viral-clip.js --id <proposalId> [--date YYYY-MM-DD]
//
// Required on PATH: ffmpeg, ffprobe, python (yt_dlp module).
// Music library: content-review/pending/_music_approved/*.mp3
// Caption helper: src/main/empire/caption_aurora.py (called via python).

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const BUILD_DIR = path.join(REPO, 'data', 'viral-clip-builds');
const PENDING_DIR = path.join(REPO, 'content-review', 'pending');
const MUSIC_DIR = path.join(PENDING_DIR, '_music_approved');
const CAPTION_AURORA = path.join(REPO, 'src', 'main', 'empire', 'caption_aurora.py');

// 2026-05-25 Luke: YouTube blocks datacenter IPs on yt-dlp with
// "Sign in to confirm you're not a bot." A one-time cookies export
// from Luke's signed-in Chrome lives at this path on EC2 (mode 600,
// ec2-user only). Every yt_dlp invocation below must pass --cookies
// or the build fails with the bot-check error. Re-export the cookies
// roughly every 60 days before the session token rotates.
const YT_DLP_COOKIES = process.env.YT_DLP_COOKIES || '/opt/secondbrain/.yt-dlp-cookies.txt';

// 2026-05-25 Luke (Path 1): YouTube's SABR streaming now requires a
// PoToken (Proof-of-Origin Token) for the googlevideo CDN data fetch,
// on top of cookies. Cookies alone get past the bot-check but the
// actual download 403s. The bgutil-ytdlp-pot-provider Docker sidecar
// runs on EC2 at 127.0.0.1:4416 and mints PoTokens on demand; the
// matching yt-dlp plugin bgutil-ytdlp-pot-provider==1.0.0 auto-
// discovers it. The extractor-args below tell the plugin which URL to
// hit. See memory/reference_yt_dlp_youtube_block_2026_05.md.
const YT_DLP_POT_PROVIDER = process.env.YT_DLP_POT_PROVIDER || 'http://127.0.0.1:4416';
const YT_DLP_POT_EXTRACTOR_ARG = `youtubepot-bgutilhttp:base_url=${YT_DLP_POT_PROVIDER}`;

// EC2 (Amazon Linux 2023) only exposes `python3`; Windows / dev boxes
// usually have `python`. Resolve once at startup so spawnSync gets a
// real binary instead of crashing with status=null ("python exited null").
const PYTHON_BIN = (() => {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  for (const bin of ['python3', 'python']) {
    const probe = spawnSync(bin, ['--version'], { stdio: 'ignore' });
    if (probe.status === 0) return bin;
  }
  return 'python3'; // last-ditch default; will surface a real error if missing
})();

// Default B-roll: "Minecraft Parkour Gameplay No Copyright" (3.6M views,
// explicitly licensed for reuse). Slice from minute 5 for steady action.
const DEFAULT_BROLL = {
  url: 'https://www.youtube.com/watch?v=u7kdVe8q5zs',
  startSec: 300,
  label: 'minecraft-parkour',
};
const BROLL_PRESETS = {
  minecraft: DEFAULT_BROLL,
  'minecraft-parkour': DEFAULT_BROLL,
  // Add subway-surfers, satisfying-cubes, etc. as future presets here.
};

function resolveFont(boldCandidates, regularCandidates) {
  for (const c of boldCandidates) if (fs.existsSync(c)) return c;
  for (const c of regularCandidates) if (fs.existsSync(c)) return c;
  return null;
}

const FONT_BOLD_RAW = resolveFont(
  [
    'C:/Windows/Fonts/arialbd.ttf',
    '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ],
  [],
);
const FONT_REGULAR_RAW = resolveFont(
  [
    'C:/Windows/Fonts/arial.ttf',
    '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ],
  [],
);
if (!FONT_BOLD_RAW || !FONT_REGULAR_RAW) {
  throw new Error('podcast-clip skill: no bold or regular font found on this host');
}
function fontForFilter(p) {
  return p.replace(/^([A-Za-z])\:/, '$1\\:');
}
const FONT_BOLD = fontForFilter(FONT_BOLD_RAW);
const FONT_REGULAR = fontForFilter(FONT_REGULAR_RAW);

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
      args[k] = v;
    }
  }
  return args;
}

function todayKeyCT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function loadProposal(args) {
  const date = args.date || todayKeyCT();
  const file = args.proposal || path.join(REPO, 'data', 'agent', 'viral-tech-clips', date + '.json');
  if (!fs.existsSync(file)) throw new Error('proposal file not found: ' + file);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = state.proposals || [];
  const id = args.id;
  if (!id) throw new Error('--id required');
  const p = list.find((it) => it.id === id);
  if (!p) throw new Error('proposal id not in file: ' + id);
  return { proposal: p, statePath: file, state, date };
}

function parseTimestampRange(s) {
  // 2026-05-25 Luke: proposal generator emits approx_timestamp as
  // MM:SS-MM:SS for timestamps under an hour (chapter timestamps
  // copied straight from YouTube). The old parser only matched
  // HH:MM:SS-HH:MM:SS, which failed 3 approvals silently. Accept
  // both forms and convert each side independently.
  const str = String(s || '');
  const parseOne = (t) => {
    const hms = t.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
    if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
    const ms = t.match(/^(\d{1,2}):(\d{2})$/);
    if (ms) return Number(ms[1]) * 60 + Number(ms[2]);
    return null;
  };
  // Split on " to " or "-" between the two timestamps; tolerate spaces.
  const parts = str.trim().split(/\s*(?:to|-)\s*/i).filter(Boolean);
  if (parts.length !== 2) throw new Error('approx_timestamp does not parse: ' + s);
  const startSec = parseOne(parts[0].trim());
  const endSec = parseOne(parts[1].trim());
  if (startSec === null || endSec === null) {
    throw new Error('approx_timestamp does not parse: ' + s);
  }
  return { startSec, endSec };
}

function fmtTs(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
  if (r.status !== 0) throw new Error(cmd + ' exited ' + r.status);
  return r;
}

function pickMusic(proposal) {
  const fb = String(proposal.feedback || '').toLowerCase();
  const insight = String(proposal.insight || '').toLowerCase();
  const all = fs.existsSync(MUSIC_DIR) ? fs.readdirSync(MUSIC_DIR).filter((f) => f.endsWith('.mp3')) : [];
  if (!all.length) throw new Error('no music in ' + MUSIC_DIR);
  const explicit = all.find((f) => fb.includes(f.replace('.mp3', '')));
  if (explicit) return explicit;
  const moodMap = [
    [/values?|free|open|principle|ethic|honest/, 'hopeful_piano.mp3'],
    [/scale|massive|billion|infrastructure|run.*world/, 'epic_orchestral.mp3'],
    [/code|engineer|build|architecture|software/, 'tech_futuristic.mp3'],
    [/money|founder|deal|startup|business/, 'motivational_trap.mp3'],
    [/mystery|secret|hidden|unknown/, 'mystery_ambient.mp3'],
  ];
  for (const [rx, name] of moodMap) {
    if (rx.test(insight) && all.includes(name)) return name;
  }
  return all.includes('hopeful_piano.mp3') ? 'hopeful_piano.mp3' : all[0];
}

function pickBroll(proposal) {
  const fb = String(proposal.feedback || '');
  const m = fb.match(/broll[:=]\s*([\w-]+)/i);
  const key = m ? m[1].toLowerCase() : 'minecraft';
  return BROLL_PRESETS[key] || DEFAULT_BROLL;
}

function generateHookLines(proposal) {
  const fb = String(proposal.feedback || '');
  const m = fb.match(/hook[:=]\s*(.+?)(?:\s*\|\s*closing[:=]|\s*\|\s*broll[:=]|\s*\|\s*music[:=]|$)/i);
  if (m) return m[1].trim().toUpperCase().split(/\s*\|\s*/);
  const sd = String(proposal.short_description || proposal.insight || 'WAIT WHAT')
    .replace(/[.!?]+$/, '').toUpperCase();
  const words = sd.split(/\s+/);
  if (words.length <= 6) return [sd];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

function generateClosingLines(proposal) {
  const fb = String(proposal.feedback || '');
  const m = fb.match(/closing[:=]\s*(.+?)(?:\s*\|\s*hook[:=]|\s*\|\s*broll[:=]|\s*\|\s*music[:=]|$)/i);
  if (m) return m[1].trim().toUpperCase().split(/\s*\|\s*/);
  return ['VALUES OVER NOISE.', 'Source: ' + (proposal.source || 'attribution')];
}

function escapeDrawtext(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/,/g, '\\,');
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
}

function downloadRange(sourceUrl, startSec, endSec, outNoExt) {
  const padStart = Math.max(0, startSec - 10);
  const padEnd = endSec + 10;
  const rawMp4 = outNoExt + '.mp4';
  const vtt = outNoExt + '.en.vtt';
  // 2026-05-25 Luke: YouTube blocks EC2 datacenter IPs from fetching
  // video data regardless of cookies/PoToken/headless. The download
  // must happen on a residential IP (Luke's PC) and the mp4 + vtt
  // get scp'd into this stage dir. If the artifacts are already
  // present, skip the yt_dlp call entirely. This lets a PC-side
  // pre-fetch + EC2-side build coexist.
  if (fs.existsSync(rawMp4)) {
    console.log('[clip] downloadRange skip-fetch: ' + rawMp4 + ' already present');
    return { rawMp4, vtt: fs.existsSync(vtt) ? vtt : null, sourceOffset: padStart };
  }
  run(PYTHON_BIN, ['-m', 'yt_dlp',
    '--cookies', YT_DLP_COOKIES,
    '--extractor-args', YT_DLP_POT_EXTRACTOR_ARG,
    '--download-sections', `*${fmtTs(padStart)}-${fmtTs(padEnd)}`,
    '-f', 'bv*[height<=1080]+ba/b', '--merge-output-format', 'mp4',
    '-o', outNoExt + '.%(ext)s', sourceUrl,
  ]);
  run(PYTHON_BIN, ['-m', 'yt_dlp',
    '--cookies', YT_DLP_COOKIES,
    '--extractor-args', YT_DLP_POT_EXTRACTOR_ARG,
    '--skip-download', '--write-subs', '--write-auto-subs',
    '--sub-lang', 'en', '--sub-format', 'vtt',
    '--download-sections', `*${fmtTs(padStart)}-${fmtTs(padEnd)}`,
    '-o', outNoExt + '.%(ext)s', sourceUrl,
  ]);
  return { rawMp4, vtt, sourceOffset: padStart };
}

function downloadBroll(broll, durSec, outNoExt) {
  const padEnd = broll.startSec + durSec + 5;
  // Skip-fetch guard, same rationale as downloadRange above.
  const brollMp4 = outNoExt + '.mp4';
  const brollWebm = outNoExt + '.webm';
  if (fs.existsSync(brollMp4) || fs.existsSync(brollWebm)) {
    const present = fs.existsSync(brollMp4) ? brollMp4 : brollWebm;
    console.log('[clip] downloadBroll skip-fetch: ' + present + ' already present');
    return present;
  }
  run(PYTHON_BIN, ['-m', 'yt_dlp',
    '--cookies', YT_DLP_COOKIES,
    '--extractor-args', YT_DLP_POT_EXTRACTOR_ARG,
    '--download-sections', `*${fmtTs(broll.startSec)}-${fmtTs(padEnd)}`,
    '-f', 'bv*[height<=1080]/b',
    '--merge-output-format', 'mp4',
    '-o', outNoExt + '.%(ext)s', broll.url,
  ]);
  // yt-dlp falls through to webm when no audio merge happens. Look for either.
  const candidates = [outNoExt + '.mp4', outNoExt + '.webm'];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error('B-roll download produced no file');
  return found;
}

function buildTalkingHead(rawPath, offsetSec, durSec, tailSec, outPath) {
  // 1080x810 (1.33:1) from 16:9 source via horizontal center crop + scale.
  // tpad freezes the last frame for the payoff tail.
  run('ffmpeg', [
    '-y', '-ss', String(offsetSec), '-t', String(durSec), '-i', rawPath,
    '-vf', `crop=1440:1080:240:0,scale=1080:810:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=${tailSec}`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-af', `apad=pad_dur=${tailSec}`,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', String(durSec + tailSec),
    outPath,
  ]);
}

function buildBrollLower(brollPath, durSec, outPath) {
  run('ffmpeg', [
    '-y', '-i', brollPath,
    '-vf', 'crop=iw:ih*0.42:0:ih*0.45,scale=1080:420:flags=lanczos,setsar=1',
    '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-t', String(durSec), outPath,
  ]);
}

function vttCuesInRange(vttPath, clipStartSec, clipDurSec) {
  if (!fs.existsSync(vttPath)) return [];
  const lines = fs.readFileSync(vttPath, 'utf8').split(/\r?\n/);
  const cues = [];
  let cur = null;
  for (const ln of lines) {
    const m = ln.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
    if (m) {
      const startAbs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
      const endAbs = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
      cur = { startAbs, endAbs, text: [] };
      cues.push(cur);
    } else if (cur && ln.trim() && !/^WEBVTT/.test(ln) && !/^NOTE/.test(ln)) {
      cur.text.push(ln.trim());
    }
  }
  const clipEnd = clipStartSec + clipDurSec;
  return cues
    .filter((c) => c.endAbs > clipStartSec && c.startAbs < clipEnd)
    .map((c) => ({
      start: Math.max(0, c.startAbs - clipStartSec),
      end: Math.min(clipDurSec, c.endAbs - clipStartSec),
      text: c.text.join(' ').replace(/^- /, ''),
    }));
}

function distributeWordTimings(cues) {
  // VTT gives line-level timing only. Approximate word-level by distributing
  // duration linearly. Good enough for the karaoke sweep effect when real
  // word-level Whisper output is not available.
  const out = [];
  for (const cue of cues) {
    const tokens = cue.text.split(/\s+/).filter((t) => t.length > 0);
    if (!tokens.length) continue;
    const perWord = (cue.end - cue.start) / tokens.length;
    tokens.forEach((tok, i) => {
      out.push({
        word: tok,
        start: cue.start + i * perWord,
        end: cue.start + (i + 1) * perWord,
      });
    });
  }
  return out;
}

function flagEmphasis(words) {
  // Top-20% emphasis. Heuristic: surprise nouns, numbers, money terms,
  // contrastive words. The full skill (when LLM word-scoring is wired) lives
  // in feedback_captions_emphasize_twenty_percent.md.
  const EMPHASIS_PATTERNS = [
    /\bmillions?\b/i, /\bdollars?\b/i, /\bbillions?\b/i,
    /\brepeatedly\b/i, /\bfree\b/i, /\bads?\b/i, /\bzero\b/i, /\byears?\b/i,
    /\bvlc\b/i, /\bffmpeg\b/i, /\bopen.?source\b/i,
    /\bleaving\b/i, /\btable\b/i, /\binsane\b/i, /\bnever\b/i, /\balways\b/i,
    /\bworld\b/i, /\bevery(one|body)?\b/i,
  ];
  const FILLERS = new Set(['the','a','an','is','are','was','were','be','been','of','in','on','at','to','for','and','or','but','if','that','this','it','you','i','we','they','he','she','so','as','jb','goes','take','me','through','the']);
  let emCount = 0;
  for (const w of words) {
    const tok = w.word.replace(/[.,!?;:]/g, '').toLowerCase();
    if (FILLERS.has(tok)) { w.emphasis = false; continue; }
    w.emphasis = EMPHASIS_PATTERNS.some((rx) => rx.test(w.word));
    if (w.emphasis) emCount++;
  }
  // If emphasis rate is way off, the captions still look fine; an emphasis-free
  // chunk just shows green-active sweep. The 15-25% target is a guideline.
  return { words, emphasisRate: words.length ? emCount / words.length : 0 };
}

function generateKaraokeAss(words, marginV, fontsize, outAssPath) {
  const transcriptJson = outAssPath + '.transcript.json';
  fs.writeFileSync(transcriptJson, JSON.stringify({ words }));
  const py = [
    'import sys, json, re',
    `sys.path.insert(0, '${path.dirname(CAPTION_AURORA).replace(/\\/g, '/')}')`,
    'from caption_aurora import transcript_to_ass, detect_font',
    `data = json.load(open(r'${transcriptJson}'))`,
    `ass = transcript_to_ass(data['words'], font=detect_font(), fontsize=${fontsize})`,
    `ass = re.sub(r',7,3,2,60,60,\\d+,1', ',7,3,2,60,60,${marginV},1', ass)`,
    `open(r'${outAssPath}', 'w', encoding='utf-8').write(ass)`,
    "print(f\"karaoke ass {len(data['words'])} words\")",
  ].join('\n');
  run(PYTHON_BIN, ['-c', py]);
  return outAssPath;
}

function compositePodcastClip({
  talkingHeadPath, brollPath, captionsAssPath, musicPath,
  hookLines, closingLines,
  clipDur, tailDur, totalDur,
  outPath,
}) {
  const hookFilters = (() => {
    const layout = [
      { y: 70,  size: 82,  color: 'white' },
      { y: 150, size: 180, color: '#FFD93D' },
      { y: 340, size: 66,  color: '#FF6B6B' },
      { y: 410, size: 60,  color: 'white' },
    ];
    return hookLines.slice(0, 4).map((line, i) => {
      const L = layout[i];
      return `drawtext=text='${escapeDrawtext(line)}':fontfile='${FONT_BOLD}':fontsize=${L.size}:fontcolor=${L.color}:x=(w-text_w)/2:y=${L.y}`;
    }).join(',');
  })();
  const closingDrawtexts = (() => {
    const yBase = 1500;
    const yStep = 120;
    const palette = ['#FFD93D', 'white', '#FF6B6B'];
    return closingLines.slice(0, 3).map((line, i) =>
      `drawtext=text='${escapeDrawtext(line)}':enable='gte(t\\,${clipDur})':fontfile='${FONT_BOLD}':fontsize=88:fontcolor=${palette[i] || 'white'}:x=(w-text_w)/2:y=${yBase + i * yStep}`
    ).join(',');
  })();
  const brollOffPoint = clipDur - 0.2; // disappear just before payoff appears
  const filter = `
    [3:v][0:v]overlay=x=0:y=420:eof_action=endall[withHead];
    [withHead][1:v]overlay=x=0:y=1400:enable='lt(t\\,${brollOffPoint})'[withMine];
    [withMine]${hookFilters},
              subtitles=${path.basename(captionsAssPath)},
              ${closingDrawtexts},
              drawtext=text='Source\\: long-form interview':fontfile='${FONT_REGULAR}':fontsize=34:fontcolor=#999999:x=(w-text_w)/2:y=1870[v];
    [2:a]volume='if(between(t,0,${clipDur}),0.12,0.55)':eval=frame,afade=t=in:st=0:d=0.3,afade=t=out:st=${(totalDur - 0.5).toFixed(2)}:d=0.5,atrim=0:${totalDur}[music];
    [0:a][music]amix=inputs=2:duration=first:dropout_transition=0:weights='1.0 1.0'[a]
  `;
  // subtitles= filter resolves relative paths from cwd, so cd into the
  // captions directory for the call.
  const capDir = path.dirname(captionsAssPath);
  run('ffmpeg', [
    '-y',
    '-i', path.resolve(talkingHeadPath),
    '-i', path.resolve(brollPath),
    '-i', path.resolve(musicPath),
    '-f', 'lavfi', '-i', `color=c=#0a0a14:s=1080x1920:d=${totalDur}:r=30`,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', String(totalDur),
    path.resolve(outPath),
  ], { cwd: capDir });
}

function main() {
  const args = parseArgs(process.argv);
  const { proposal, statePath, state } = loadProposal(args);
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(PENDING_DIR, { recursive: true });

  const { startSec, endSec: proposedEndSec } = parseTimestampRange(proposal.approx_timestamp);
  let endSec = proposedEndSec;
  let clipDur = endSec - startSec;
  const tailDur = 2.0;
  let totalDur = clipDur + tailDur;

  const slug = slugify(proposal.source + '_' + proposal.id);
  const stage = path.join(BUILD_DIR, proposal.id);
  fs.mkdirSync(stage, { recursive: true });
  const rawNoExt = path.join(stage, 'raw');

  console.log(`[clip] source ${fmtTs(startSec)} to ${fmtTs(endSec)} (${clipDur}s clip + ${tailDur}s tail)`);
  const dl = downloadRange(proposal.source_url, startSec, endSec, rawNoExt);

  // 2026-05-25 Luke flagged on the Otter feature-backlog feedback session
  // that clips were always cut off mid-word. Snap the end timestamp to the
  // nearest sentence boundary using the freshly downloaded VTT, within a
  // 5-second tolerance, so we never publish a mid-word hard cut. Updates
  // the shared endSec/clipDur/totalDur in place so downstream ffmpeg
  // builds (talking head, broll, captions, composite) all use the snapped
  // window.
  try {
    const snap = require('./lib/snap-clip-to-sentence-boundary.js');
    if (dl && dl.vtt) {
      const cues = snap.parseVtt(dl.vtt);
      const snapped = snap.snapEndToSentenceBoundary({ cues, startSec, endSec, tolerance: 5 });
      if (snapped.endSec !== endSec) {
        const delta = (snapped.endSec - endSec).toFixed(2);
        console.log(`[clip] snap-to-sentence: ${snapped.reason}; endSec ${fmtTs(endSec)} -> ${fmtTs(snapped.endSec)} (${delta >= 0 ? '+' : ''}${delta}s); cue tail: "${snapped.cueText || ''}"`);
        endSec = snapped.endSec;
        clipDur = endSec - startSec;
        totalDur = clipDur + tailDur;
      }
    }
  } catch (snapErr) {
    console.warn('[clip] snap-to-sentence failed, falling back to proposal end:', snapErr.message);
  }

  const broll = pickBroll(proposal);
  console.log(`[clip] B-roll: ${broll.label} from ${broll.url}`);
  const brollRawNoExt = path.join(stage, 'broll');
  const brollRaw = downloadBroll(broll, totalDur, brollRawNoExt);

  console.log('[clip] talking head -> 1080x810 with horizontal crop');
  const talkingHead = path.join(stage, 'talking_head.mp4');
  buildTalkingHead(dl.rawMp4, startSec - dl.sourceOffset, clipDur, tailDur, talkingHead);

  console.log('[clip] B-roll -> 1080x420 lower band');
  const brollLower = path.join(stage, 'broll_lower.mp4');
  buildBrollLower(brollRaw, totalDur, brollLower);

  console.log('[clip] generating karaoke captions');
  const cues = vttCuesInRange(dl.vtt, startSec, clipDur);
  const words = distributeWordTimings(cues);
  const flagged = flagEmphasis(words);
  console.log(`[clip] caption words: ${flagged.words.length}, emphasis rate ${(flagged.emphasisRate * 100).toFixed(0)}%`);
  const captionsAss = path.join(stage, 'captions.ass');
  if (flagged.words.length > 0) {
    generateKaraokeAss(flagged.words, 560, 100, captionsAss);
  } else {
    // Fallback: empty captions file, ffmpeg subtitles filter accepts it
    fs.writeFileSync(captionsAss, '[Script Info]\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\n[Events]\n');
  }

  const hookLines = generateHookLines(proposal);
  const closingLines = generateClosingLines(proposal);
  const musicFile = pickMusic(proposal);
  const musicPath = path.join(MUSIC_DIR, musicFile);

  console.log(`[clip] hook: ${JSON.stringify(hookLines)}`);
  console.log(`[clip] closing: ${JSON.stringify(closingLines)}`);
  console.log(`[clip] music: ${musicFile}`);

  const finalLocal = path.join(stage, slug + '.mp4');
  compositePodcastClip({
    talkingHeadPath: talkingHead,
    brollPath: brollLower,
    captionsAssPath: captionsAss,
    musicPath,
    hookLines,
    closingLines,
    clipDur,
    tailDur,
    totalDur,
    outPath: finalLocal,
  });

  const finalDest = path.join(PENDING_DIR, slug + '.mp4');
  fs.copyFileSync(finalLocal, finalDest);

  const meta = {
    id: slug,
    proposalId: proposal.id,
    sourceUrl: proposal.clip_url || proposal.source_url,
    sourceTitle: proposal.source_title,
    sourceTimestampRange: proposal.approx_timestamp,
    format: '9:16',
    resolution: '1080x1920',
    durationSeconds: Math.round(totalDur),
    layout: 'v5-locked-2026-05-13',
    channel: 'AILifeHacksByLukeyBaer',
    status: 'pending_review',
    hookLines, closingLines,
    musicBed: musicFile,
    musicVolumeMap: `0.12 under speaker (0-${clipDur}s), 0.55 over payoff (${clipDur}-${totalDur}s)`,
    brollSource: broll.label,
    captionsWords: flagged.words.length,
    emphasisRate: flagged.emphasisRate,
    description: `${proposal.insight || ''}\n\nSource: ${proposal.source || ''}\nFull episode: ${proposal.source_url}`,
    tags: [proposal.source, 'tech', 'short'].filter(Boolean),
    fairUseNotes: `Clip is ${clipDur}s out of source. Transformative use (purple-cow hook, karaoke captions, B-roll, vertical reformat). Source link in description. Content ID will likely fingerprint the source audio and redirect monetization to the rights holder.`,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(PENDING_DIR, slug + '.json'), JSON.stringify(meta, null, 2));
  proposal.built_at = meta.builtAt;
  proposal.built_artifact = path.relative(REPO, finalDest);
  proposal.built_layout = meta.layout;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log('[clip] DONE: ' + finalDest);

  // 2026-05-24 Luke ask: queue the built clip in the unified Video
  // Approval Queue so it shows up alongside short000-short0NN entries.
  try {
    const manifestPath = path.join(PENDING_DIR, 'manifest.json');
    const videoFile = path.basename(finalDest);
    const thumbFile = videoFile.replace(/\.mp4$/i, '_thumb.jpg');
    appendBuiltClipToManifest(manifestPath, proposal, videoFile, thumbFile);
    console.log('[clip] queued in Video Approval Queue: ' + manifestPath);
  } catch (e) {
    console.warn('[clip] manifest append failed (clip still built, just not queued): ' + e.message);
  }
}

// 2026-05-24 Luke ask: built viral clips must land in the unified Video
// Approval Queue (content-review/pending/manifest.json) so they appear
// alongside short000-short0NN entries for final approval. Before this,
// the build wrote content-review/pending/<slug>.{mp4,json} but never
// touched manifest.json, so approved viral clips were invisible to the
// dashboard queue. Idempotent: re-running the build on the same id
// updates the existing entry rather than duplicating it.
function appendBuiltClipToManifest(manifestPath, proposal, videoFile, thumbnailFile) {
  const id = String(proposal.id || '').trim();
  if (!id) throw new Error('proposal.id required');
  let manifest = { videos: [] };
  try { manifest = JSON.parse(require('fs').readFileSync(manifestPath, 'utf8')); }
  catch { /* missing or unreadable -- start fresh */ }
  if (!Array.isArray(manifest.videos)) manifest.videos = [];
  const ix = manifest.videos.findIndex((v) => v && v.id === id);
  const title = proposal.insight || proposal.source_title || id;
  const channel = proposal.youtube_channel || 'AILifeHacks';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const entry = {
    ...(ix >= 0 ? manifest.videos[ix] : {}),
    id,
    title: String(title).slice(0, 180),
    channel,
    status: 'pending_approval',
    source: 'viral_clip',
    video_file: videoFile,
    thumbnail_file: thumbnailFile,
    source_url: proposal.source_url || proposal.source_page_url || '',
    generated_date: today,
    synced_at: new Date().toISOString(),
    video_needs_regen: false,
    thumbnail_needs_regen: false,
  };
  if (ix >= 0) manifest.videos[ix] = entry;
  else manifest.videos.push(entry);
  try { require('fs').mkdirSync(path.dirname(manifestPath), { recursive: true }); } catch { /* fine */ }
  require('fs').writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return entry;
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('[clip] FAIL:', e.message); process.exit(1); }
}

module.exports = {
  parseTimestampRange,
  generateHookLines,
  generateClosingLines,
  slugify,
  pickMusic,
  pickBroll,
  distributeWordTimings,
  flagEmphasis,
  appendBuiltClipToManifest,
};
