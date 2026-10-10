#!/usr/bin/env node
// Podcast clipping skill, canonical implementation.
//
// Takes a viral-tech-clip proposal (any long-form interview / podcast / keynote
// source with a timestamp range and a transcript) and produces a 9:16 vertical
// short in one of two selectable Examplechannel narrator themes. Both preserve
// authentic source footage and share the approved two-line editorial header, glowing
// outline logo, lightning transition, gentle water-wind cue, and captions.
//
//   narrator-in-a-box      framed speaker on a softly treated source backdrop
//   narrator-not-in-a-box  full-page speaker with restrained overlays
//
// The boxed theme is the default. Skill spec: skills/content/podcast-clip.md.
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
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  applyVideoTextFitGate,
  createVideoTextFitReceipt,
} = require('./lib/video-text-fit-receipt.js');
const { writeDirectiveFidelityReceipt } = require('./lib/directive-fidelity-receipt.js');
const {
  TEXT_FIT_VIEWPORT,
  TEXT_FIT_SAFE_RECT,
  renderedPixelBounds,
} = require('./lib/video-text-fit-layers.js');
const {
  DEFAULT_VIRAL_CLIP_THEME,
  VIRAL_CLIP_LOGO_WIDTH,
  VIRAL_CLIP_THEME_VERSION,
  VIRAL_CLIP_THEMES,
  normalizeViralClipTheme,
} = require('./lib/viral-clip-themes.js');
const {
  DEFAULT_BRIDGE_SECONDS,
  resolveClipSegments,
  planWovenTimeline,
  bridgeOverlayDialogues,
  offsetWords,
} = require('./lib/viral-clip-segments.js');
const {
  resolveBuildDirective,
  buildDirectiveReceipt,
} = require('./lib/viral-clip-build-directive.js');

const {
  DETERMINISTIC_FALLBACK,
  DIRECT_SCRIPT_REASON,
  MODEL_SESSION,
  stampBuildStandard,
} = require('./lib/video-build-standard.js');
const {
  isVideoDeleted,
  isVideoHeld,
  failVideoMissingFinalRelease,
  releaseVideoMissingFinalHold,
} = require('./lib/video-delete-state.js');

const BENCHMARK_MOTION_STYLE_REFERENCE =
  'skills/work/video-production/references/examplechannel-benchmark-motion.md';

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const BUILD_DIR = path.join(REPO, 'data', 'viral-clip-builds');
const PENDING_DIR = path.join(REPO, 'content-review', 'pending');
const MUSIC_DIR = path.join(PENDING_DIR, '_music_approved');
const MINIMUM_PLAUSIBLE_SOURCE_BYTES = 64 * 1024;
const DEFAULT_MUSIC_GAIN = 0.075;
// ExampleCo, 2026-09-25, on the approved PRIVATE_NAME short: "the music is hardly
// audible at first - the level at the end is the level we want the whole time."
// The Time master climbs about 11 dB (about -30 to -19 LUFS) over its first
// minute, so a constant gain left the opening nearly silent. Level the bed to
// its end loudness before the constant gain; measured flat within 1.5 dB.
const MUSIC_BED_LEVEL_FILTER = 'loudnorm=I=-20:LRA=2:TP=-2';
// Scoped to the track it was measured on; other tracks keep their calibrated
// constant gains until they are measured the same way.
const MUSIC_BED_LEVELED_FILES = new Set(['hans_zimmer_time_inception.mp3']);

const APPROVED_MUSIC_GAIN_BY_FILE = Object.freeze({
  'hans_zimmer_time_inception.mp3': 1.5,
});
const LOGO_HALO_INSET = 18;
// Prefer ordinary HTTPS media for bounded source cuts. YouTube HLS manifests
// can resolve successfully through the authenticated relay and then stall
// before the first media fragment, while direct video/audio URLs remain
// seekable and deterministic. Keep HLS and muxed formats as fallbacks.
const YT_DLP_SOURCE_FORMAT =
  'bv*[height<=1080][protocol^=http]+ba[protocol^=http]/bv*[height<=1080]+ba/b';
// Second, changed-input attempt. On 2026-09-03 the direct HTTPS path opened the
// googlevideo stream through the relay and then delivered zero bytes for more
// than twenty minutes on two consecutive builds of the same 36-second section,
// while the HLS rendition of that section downloaded 4 MB in 41 seconds.
// Neither protocol family is reliable on its own, so every source fetch is
// time-bounded and a stalled attempt hands off to the other family in its own
// scratch directory, never a blind rerun of the same command. The HLS selector
// is strictly HLS (Codex 2026-09-03): a generic tail would let the "hls"
// attempt silently retry direct HTTPS while the receipt claimed HLS.
const YT_DLP_SOURCE_FORMAT_HLS =
  'bv*[height<=1080][protocol*=m3u8]+ba[protocol*=m3u8]/b[protocol*=m3u8]';
const SOURCE_FETCH_MIN_TIMEOUT_MS =
  Number(process.env.VIRAL_CLIP_SOURCE_FETCH_TIMEOUT_MS) > 0
    ? Number(process.env.VIRAL_CLIP_SOURCE_FETCH_TIMEOUT_MS)
    : 240000;
const SOURCE_FETCH_MAX_TIMEOUT_MS = 20 * 60 * 1000;
// A healthy section fetch runs near real time through the proxy (36 s of
// media in 41 s on 2026-09-03), so six seconds of budget per media second is
// generous for a long valid section while a zero-byte stall is still cut off
// at the floor.
const SOURCE_FETCH_MS_PER_MEDIA_SECOND = 6000;

function sourceFetchTimeoutMs(sectionSeconds) {
  const media = Number(sectionSeconds);
  const scaled = Number.isFinite(media) && media > 0 ? media * SOURCE_FETCH_MS_PER_MEDIA_SECOND : 0;
  return Math.min(SOURCE_FETCH_MAX_TIMEOUT_MS, Math.max(SOURCE_FETCH_MIN_TIMEOUT_MS, scaled));
}

function sourceFetchAttempts(sectionSeconds) {
  const timeoutMs = sourceFetchTimeoutMs(sectionSeconds);
  return [
    { label: 'direct-https', format: YT_DLP_SOURCE_FORMAT, dir: 'fetch-direct-https', timeoutMs },
    { label: 'hls', format: YT_DLP_SOURCE_FORMAT_HLS, dir: 'fetch-hls', timeoutMs },
  ];
}

const CAPTION_AURORA = path.join(REPO, 'src', 'main', 'empire', 'caption_aurora.py');
const EXAMPLECHANNEL_OUTLINE_LOGO = path.join(
  REPO,
  'skills',
  'work',
  'video-production',
  'assets',
  'examplechannel-outline-logo.png',
);

function buildThemeRenderPlan(themeValue) {
  const theme = normalizeViralClipTheme(themeValue);
  const definition = VIRAL_CLIP_THEMES[theme];
  return {
    ...definition,
    theme,
    version: VIRAL_CLIP_THEME_VERSION,
    logoWidth: VIRAL_CLIP_LOGO_WIDTH,
    header: 'two-line-clean-editorial',
    transitionVisual: 'cyan-magenta-lightning',
    transitionSound: 'gentle-water-wind',
  };
}

// Cloud source acquisition is proxy-first. The selected provider is prepaid,
// capped at $5, and must have auto-recharge disabled. The historical cookie jar
// remains an explicit legacy fallback during rollout, but proxy mode never
// attaches ExampleCo's owner YouTube session to yt-dlp.
const YT_DLP_COOKIES_MASTER = process.env.YT_DLP_COOKIES || '/opt/secondbrain/.yt-dlp-cookies.txt';
const {
  redactSensitiveText,
  resolveViralSourceAuth,
  safeSourceAuthSummary,
  withYtDlpSourceAuth,
} = require('./lib/viral-source-auth.js');

function currentSourceAuth() {
  return resolveViralSourceAuth(process.env);
}

// 2026-05-25 ExampleCo (Path 1): YouTube's SABR streaming now requires a
// PoToken (Proof-of-Origin Token) for the googlevideo CDN data fetch,
// on top of cookies. Cookies alone get past the bot-check but the
// actual download 403s. The bgutil-ytdlp-pot-provider Docker sidecar
// runs on EC2 at 127.0.0.1:4416 and mints PoTokens on demand; the
// matching yt-dlp plugin bgutil-ytdlp-pot-provider==1.3.1 auto-
// discovers it. The extractor-args below tell the plugin which URL to
// hit. See memory/reference_yt_dlp_youtube_block_2026_05.md.
const YT_DLP_POT_PROVIDER = process.env.YT_DLP_POT_PROVIDER || 'http://127.0.0.1:4416';
const YT_DLP_POT_EXTRACTOR_ARG = `youtubepot-bgutilhttp:base_url=${YT_DLP_POT_PROVIDER}`;

// Current yt-dlp YouTube extraction needs an external JavaScript challenge
// runtime. Keep the production runtime isolated from SecondBrain's Node/PM2
// runtime: EC2 carries a checksum-verified Deno binary in the user-local bin.
// Node remains a developer fallback only when it meets yt-dlp's >=22 floor.
function resolveYtDlpJsRuntime() {
  if (process.env.YT_DLP_JS_RUNTIME) return process.env.YT_DLP_JS_RUNTIME;
  const ec2Deno = '/home/ec2-user/.local/bin/deno';
  if (fs.existsSync(ec2Deno)) return `deno:${ec2Deno}`;
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (Number.isFinite(nodeMajor) && nodeMajor >= 22) return `node:${process.execPath}`;
  return '';
}

const YT_DLP_JS_RUNTIME = resolveYtDlpJsRuntime();

// Centralize all yt-dlp networking here. Proxy credentials live in a private
// temporary config, not argv. Legacy mode still stages a per-invocation cookie
// copy because yt-dlp rewrites any jar it receives.
function runYtDlp(buildArgs, opts = {}) {
  if (!YT_DLP_JS_RUNTIME) {
    throw new Error(
      'source video download failed: yt-dlp requires Deno >=2.3 or Node >=22; set YT_DLP_JS_RUNTIME',
    );
  }
  const sourceAuth = currentSourceAuth();
  return withYtDlpSourceAuth(
    sourceAuth,
    YT_DLP_COOKIES_MASTER,
    ({ networkArgs, externalDownloaderArgs = [], networkEnv, redactValues }) =>
      run(
        PYTHON_BIN,
        [
          '-m',
          'yt_dlp',
          ...networkArgs,
          ...externalDownloaderArgs,
          '--js-runtimes',
          YT_DLP_JS_RUNTIME,
          '--extractor-args',
          YT_DLP_POT_EXTRACTOR_ARG,
          ...buildArgs,
        ],
        {
          ...opts,
          env: { ...process.env, ...(opts.env || {}), ...networkEnv },
          redactValues,
        },
      ),
  );
}

// Prefer a supported explicit interpreter on EC2. Generic `python3` can still
// resolve to 3.9, which cannot install current yt-dlp releases. Windows / dev
// boxes usually have `python`. Resolve once so spawnSync gets a real binary.
const PYTHON_BIN = (() => {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  for (const bin of ['python3.12', 'python3.11', 'python3', 'python']) {
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
      const v = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
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
  const file =
    args.proposal || path.join(REPO, 'data', 'agent', 'viral-tech-clips', date + '.json');
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
  // 2026-05-25 ExampleCo: proposal generator emits approx_timestamp as
  // MM:SS-MM:SS for timestamps under an hour (chapter timestamps
  // copied straight from YouTube). The old parser only matched
  // HH:MM:SS-HH:MM:SS, which failed 3 approvals silently. Accept
  // both forms and convert each side independently.
  const str = String(s || '');
  const parseOne = (t) => {
    const hms = t.match(/^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d{1,3})?)$/);
    if (hms) {
      return Number((Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3])).toFixed(3));
    }
    const ms = t.match(/^(\d{1,2}):(\d{2}(?:\.\d{1,3})?)$/);
    if (ms) return Number((Number(ms[1]) * 60 + Number(ms[2])).toFixed(3));
    return null;
  };
  // Split on " to " or "-" between the two timestamps; tolerate spaces.
  const parts = str
    .trim()
    .split(/\s*(?:to|-)\s*/i)
    .filter(Boolean);
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

// 2026-08-24 ExampleCo ("fix the video"): run() inherited stderr and threw only
// `cmd + ' exited ' + status`, so the durable build_failed receipt on the
// manifest row read "python3 exited 1" and nothing else. The actual cause of
// the two-day stuck clip was a yt-dlp bot-check refusal printed on stderr and
// thrown away with the process. An exit code is not a diagnosis: capture
// stderr, still echo it live so the log is unchanged, and carry its tail into
// the thrown error so the receipt names the real blocker. failureLabel says
// WHICH step died; this says WHY.
const CAPTURED_STDERR_CHARS = 400;
const CAPTURED_STDERR_LOG_CHARS = 64 * 1024;

function stderrTail(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // Prefer the lines a human would read first; yt-dlp and ffmpeg both mark the
  // fatal line, and the rest is progress noise.
  const flagged = lines.filter((line) => /^(?:ERROR|error:|fatal)/i.test(line));
  const chosen = flagged.length ? flagged : lines.slice(-3);
  return chosen.join(' | ').slice(0, CAPTURED_STDERR_CHARS);
}

function stderrForLog(text) {
  const value = String(text || '');
  if (value.length <= CAPTURED_STDERR_LOG_CHARS) return value;
  const prefix = `[stderr truncated to final ${CAPTURED_STDERR_LOG_CHARS} characters]\n`;
  return prefix + value.slice(-(CAPTURED_STDERR_LOG_CHARS - prefix.length));
}

function run(cmd, args, opts = {}) {
  const { failureLabel = '', redactValues = [], spawnSyncImpl = spawnSync, ...spawnOpts } = opts;
  const r = spawnSyncImpl(cmd, args, {
    stdio: ['ignore', 'inherit', 'pipe'],
    encoding: 'utf8',
    // Codex 2026-08-24: piping stderr means it is buffered, and the default 1MB
    // ceiling would kill an otherwise-good build on verbose yt-dlp/ffmpeg
    // output. Give it room, and treat a spawn-level error as a real failure
    // instead of reading status off a process that never ran.
    maxBuffer: 64 * 1024 * 1024,
    ...spawnOpts,
  });
  if (r.error && spawnOpts.detached && r.pid && process.platform !== 'win32') {
    // spawnSync's timeout kills only the direct child. A detached child leads
    // its own process group, so the group id is the pid; kill the group to
    // take a stalled ffmpeg descendant with it and wait briefly for it to go.
    try {
      process.kill(-r.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(-r.pid, 0);
      } catch {
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  const captured = typeof r.stderr === 'string' ? r.stderr : '';
  const safeCaptured = redactSensitiveText(captured, redactValues);
  // Keep the full redacted buffer for diagnosis below, but bound its replay.
  // Test runners and other parents may capture this stream over IPC; replaying
  // megabytes can stall them even though the child itself already exited.
  const safeLog = stderrForLog(safeCaptured);
  if (safeLog) process.stderr.write(safeLog);
  if (r.error) {
    const prefix = failureLabel ? failureLabel + ': ' : '';
    throw new Error(
      redactSensitiveText(prefix + cmd + ' failed to run: ' + r.error.message, redactValues),
    );
  }
  if (r.status !== 0) {
    const prefix = failureLabel ? failureLabel + ': ' : '';
    const tail = stderrTail(safeCaptured);
    throw new Error(prefix + cmd + ' exited ' + r.status + (tail ? ': ' + tail : ''));
  }
  return r;
}

function createApprovalThumbnail(videoPath, thumbnailPath, { runner = run } = {}) {
  if (!fs.existsSync(videoPath)) throw new Error('approval thumbnail source video missing');
  fs.mkdirSync(path.dirname(thumbnailPath), { recursive: true });
  runner(
    'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=360:-2',
      '-q:v',
      '2',
      thumbnailPath,
    ],
    { failureLabel: 'approval thumbnail generation failed' },
  );
  const stat = fs.statSync(thumbnailPath);
  if (!stat.isFile() || stat.size < 1024) {
    throw new Error('approval thumbnail generation produced an invalid artifact');
  }
  return thumbnailPath;
}

function selectMusicFromNames(proposal, availableNames) {
  const fb = String(proposal.feedback || '').toLowerCase();
  const insight = String(proposal.insight || '').toLowerCase();
  const all = Array.isArray(availableNames) ? availableNames : [];
  if (!all.length) throw new Error('no music in ' + MUSIC_DIR);
  const explicit = all.find((f) => fb.includes(f.replace('.mp3', '')));
  if (explicit) return explicit;
  if (/\bactual viral song\b|\breal viral song\b|\brecognizable viral song\b/.test(fb)) {
    if (all.includes('hans_zimmer_time_inception.mp3')) {
      return 'hans_zimmer_time_inception.mp3';
    }
  }
  if (/\bmore viral\b|\bviral (?:track|music|one|sound)\b/.test(fb)) {
    if (all.includes('motivational_trap.mp3')) return 'motivational_trap.mp3';
  }
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

function resolveClipTailSeconds(proposal) {
  if (!proposal || proposal.tail_seconds == null || proposal.tail_seconds === '') return 2;
  const value = Number(proposal.tail_seconds);
  if (!Number.isFinite(value) || value < 0 || value > 5) {
    throw new Error('tail_seconds must be between 0 and 5');
  }
  return value;
}

function shouldSnapClipEnd(proposal) {
  return !proposal || proposal.snap_end_to_sentence_boundary !== false;
}

function resolveMusicGain(proposal, musicFile) {
  if (proposal && proposal.music_gain != null && proposal.music_gain !== '') {
    const explicit = Number(proposal.music_gain);
    if (!Number.isFinite(explicit) || explicit < 0.01 || explicit > 3) {
      throw new Error('music_gain must be between 0.01 and 3');
    }
    return explicit;
  }
  // Per-asset overrides are owner-reviewed against the clean master. The
  // generic bed made this approved commercial master inaudible in review.
  return APPROVED_MUSIC_GAIN_BY_FILE[musicFile] || DEFAULT_MUSIC_GAIN;
}

function resolveLogoPosition(proposal) {
  const explicit = String(proposal?.logo_position || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (explicit) {
    if (explicit === 'top-left') return 'top-left';
    if (explicit === 'default' || explicit === 'theme-default') return 'theme-default';
    throw new Error(
      'logo_position must be top-left or theme-default (default is lower-right for full-page clips)',
    );
  }
  return 'theme-default';
}

function resolveLogoPlacement(themeValue, logoPosition) {
  const plan = buildThemeRenderPlan(themeValue);
  if (logoPosition === 'top-left') {
    // The halo also remains inside the 54 px title-safe rectangle.
    return {
      position: 'top-left',
      x: TEXT_FIT_SAFE_RECT.left + LOGO_HALO_INSET,
      y: TEXT_FIT_SAFE_RECT.top + LOGO_HALO_INSET,
      width: plan.logoWidth,
    };
  }
  if (logoPosition !== 'theme-default') {
    throw new Error('logo position must be top-left or theme-default');
  }
  return {
    position: 'theme-default',
    x: plan.fullBleedSource
      ? TEXT_FIT_SAFE_RECT.right - LOGO_HALO_INSET - plan.logoWidth
      : Math.round((TEXT_FIT_VIEWPORT.width - plan.logoWidth) / 2),
    y: plan.fullBleedSource ? 1750 : 1205,
    width: plan.logoWidth,
  };
}

function pickMusic(proposal) {
  const all = fs.existsSync(MUSIC_DIR)
    ? fs.readdirSync(MUSIC_DIR).filter((f) => f.endsWith('.mp3'))
    : [];
  return selectMusicFromNames(proposal, all);
}

function pickBroll(proposal) {
  const fb = String(proposal.feedback || '');
  const m = fb.match(/broll[:=]\s*([\w-]+)/i);
  const key = m ? m[1].toLowerCase() : 'minecraft';
  return BROLL_PRESETS[key] || DEFAULT_BROLL;
}

// Thesis-first packaging (ExampleCo 2026-10-01): a proposal carries a linted
// YouTube title that names the speaker and the claim. Use it for the upload
// title and the opening label instead of the raw insight or chapter label.
function packagedTitle(proposal) {
  const title = String((proposal && proposal.youtube_title) || '').trim();
  if (proposal && proposal.thesis && !(proposal.youtube_title_ok && title)) {
    // A thesis-first proposal never falls back to the insight or a chapter
    // label (Codex deploy review). Legacy proposals without a thesis keep
    // their prior title path.
    throw new Error(`thesis proposal ${proposal.id || ''} has no lint-passing youtube_title`);
  }
  return proposal && proposal.youtube_title_ok && title ? title : '';
}

function generateHookLines(proposal) {
  const fb = String(proposal.feedback || '').replace(/[’]/g, "'");
  const m = fb.match(
    /hook[:=]\s*(.+?)(?:\s*\|\s*closing[:=]|\s*\|\s*broll[:=]|\s*\|\s*music[:=]|$)/i,
  );
  if (m)
    return m[1]
      .trim()
      .toUpperCase()
      .split(/\s*\|\s*/);
  const natural = fb.match(/(?<!don't )(?<!do not )(?<!never )\bstart with\s+["“]([^"”]+)["”]/i);
  if (natural) return [natural[1].trim().toUpperCase()];
  const sd = String(packagedTitle(proposal) || proposal.insight || proposal.short_description || 'WAIT WHAT')
    .replace(/[.!?]+$/, '')
    .toUpperCase();
  const words = sd.split(/\s+/);
  if (words.length <= 5) return [sd];
  const lineCount = words.length > 10 ? 4 : words.length > 6 ? 3 : 2;
  const perLine = Math.ceil(words.length / lineCount);
  return Array.from({ length: lineCount }, (_, index) =>
    words.slice(index * perLine, (index + 1) * perLine).join(' '),
  ).filter(Boolean);
}

function attributionLabel(proposal) {
  return (
    [proposal.youtube_channel, proposal.source]
      .map((value) => String(value || '').trim())
      .find(Boolean) || 'attribution'
  );
}

function generateClosingLines(proposal) {
  const fb = String(proposal.feedback || '');
  const m = fb.match(
    /closing[:=]\s*(.+?)(?:\s*\|\s*hook[:=]|\s*\|\s*broll[:=]|\s*\|\s*music[:=]|$)/i,
  );
  if (m)
    return m[1]
      .trim()
      .toUpperCase()
      .split(/\s*\|\s*/);
  // "VALUES OVER NOISE." was a phrase ExampleCo rejected; winners end on the payoff
  // line with no slogan card (2026-10-01 research), so only the credit remains.
  const defaults = ['Source: ' + attributionLabel(proposal)];
  const forbidden = Array.from(
    fb.matchAll(/\b(?:do not|don't|never) say\s+["“]?([^,"”]+?)["”]?(?=,|\.|;|$)/gi),
    (match) => match[1].trim().replace(/[.!?]+$/, '').toUpperCase(),
  );
  return defaults.filter((line) => !forbidden.some((phrase) => line.toUpperCase().includes(phrase)));
}

// A rejection fix that names an explicit hook/closing override in
// proposal.feedback is exactly the class of directive the
// rejection_directive_fidelity rubric criterion exists for: a human named
// a production fact (source-lineage, speaker identity, exact wording) that
// pixels alone can't verify. When such an override is present, measure
// whether the requested text actually landed in the burned-in overlay and
// return honest pass/fail assertions describing what was checked.
function buildFeedbackDirectiveAssertions(proposal, themeOverlayAssPath, measurements = {}) {
  const fb = String(proposal.feedback || '').replace(/[’]/g, "'");
  const hookMatch = fb.match(
    /hook[:=]\s*(.+?)(?:\s*\|\s*closing[:=]|\s*\|\s*broll[:=]|\s*\|\s*music[:=]|$)/i,
  );
  const closingMatch = fb.match(
    /closing[:=]\s*(.+?)(?:\s*\|\s*hook[:=]|\s*\|\s*broll[:=]|\s*\|\s*music[:=]|$)/i,
  );
  const naturalHook = fb.match(/(?<!don't )(?<!do not )(?<!never )\bstart with\s+["“]([^"”]+)["”]/i);
  const forbiddenOpening = fb.match(/(?:don't|do not|never) start with\s+["“]([^"”]+)["”]/i);
  const benchmarkNames = /(?:show|include|display).*model names.*benchmark|benchmark.*model names/i.test(fb);
  const forbidden = Array.from(
    fb.matchAll(/\b(?:do not|don't|never) say\s+["“]?([^,"”]+?)["”]?(?=,|\.|;|$)/gi),
    (match) => match[1].trim().replace(/[.!?]+$/, '').toUpperCase(),
  );
  const fullScreen = /\bfull[- ]screen\b|\bnot in (?:a )?box\b/i.test(fb);
  if (!hookMatch && !closingMatch && !naturalHook && !forbiddenOpening && !benchmarkNames && !forbidden.length && !fullScreen) return [];

  const assText = fs.readFileSync(themeOverlayAssPath, 'utf8');
  const assLines = assText.split('\n');
  const assertions = [];

  const checkOverride = (id, label, rawOverride) => {
    const expected = rawOverride
      .trim()
      .toUpperCase()
      .split(/\s*\|\s*/)[0];
    const matchLine = assLines.find((line) => line.includes(expected));
    assertions.push({
      id,
      description: `Rejection-requested ${label} "${expected}" is burned into the final overlay`,
      passed: Boolean(matchLine),
      method: 'ass_overlay_text_match',
      evidence: matchLine
        ? matchLine.trim()
        : `no dialogue line in ${path.basename(themeOverlayAssPath)} contains "${expected}"`,
    });
  };

  if (hookMatch) checkOverride('hook_directive_override', 'headline', hookMatch[1]);
  if (!hookMatch && naturalHook) checkOverride('hook_directive_override', 'headline', naturalHook[1]);
  if (naturalHook || forbiddenOpening) {
    assertions.push({
      id: 'spoken_opening',
      description: 'Opening feedback must be verified against final encoded speech, not headline text',
      passed: measurements.spoken_opening?.passed === true,
      method: 'final_encode_transcript',
      evidence: measurements.spoken_opening?.evidence || 'No final-encode speech verification supplied',
      verification: measurements.spoken_opening?.verification || null,
    });
  }
  if (benchmarkNames) {
    assertions.push({
      id: 'benchmark_model_names',
      description: 'Source model names and benchmark values remain readable together in decoded frames',
      passed: measurements.benchmark_model_names?.passed === true,
      method: 'decoded_source_label_regions',
      evidence: measurements.benchmark_model_names?.evidence || 'No decoded benchmark label verification supplied',
      verification: measurements.benchmark_model_names?.verification || null,
    });
  }
  if (closingMatch) checkOverride('closing_directive_override', 'closing text', closingMatch[1]);
  for (const [index, phrase] of forbidden.entries()) {
    const present = assText.toUpperCase().includes(phrase);
    assertions.push({
      id: `forbidden_phrase_${index + 1}`,
      description: `Rejection-forbidden phrase "${phrase}" is absent from the final overlay`,
      passed: !present,
      method: 'ass_overlay_text_absence',
      evidence: present ? `theme overlay still contains "${phrase}"` : `theme overlay contains no "${phrase}"`,
    });
  }
  if (fullScreen) {
    const theme = normalizeViralClipTheme(proposal.video_theme);
    assertions.push({
      id: 'full_screen_not_boxed',
      description: 'Rejection-requested full-screen source layout has no speaker box',
      passed: theme === 'narrator-not-in-a-box',
      method: 'closed_theme_render_plan',
      evidence: `resolved theme=${theme}; speakerFrame=${buildThemeRenderPlan(theme).speakerFrame}`,
    });
  }

  return assertions;
}

function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,');
}

function fittedFontSize(line, preferred, maxWidth = 980) {
  // Montserrat ExtraBold's all-caps average is materially wider than the
  // generic 0.62em estimate, especially for M, W, and H. The conservative
  // estimate keeps centered hook copy inside the 1080 px canvas even when a
  // line is dominated by wide capitals.
  const estimatedGlyphWidth = Math.max(1, String(line || '').length) * 0.78;
  return Math.max(44, Math.min(preferred, Math.floor(maxWidth / estimatedGlyphWidth)));
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function writeSourceAcquisitionReceipt(outNoExt, receipt) {
  const receiptPath = outNoExt + '.source-acquisition.json';
  const tempPath = receiptPath + '.tmp-' + process.pid;
  fs.writeFileSync(tempPath, JSON.stringify(receipt, null, 2));
  fs.renameSync(tempPath, receiptPath);
  return receiptPath;
}

function sourceAcquisitionReceipt({
  outNoExt,
  sourceUrl,
  status,
  error = '',
  rawMp4 = '',
  attempt = '',
}) {
  const auth = currentSourceAuth();
  if (status === 'succeeded') {
    if (
      !rawMp4 ||
      !fs.existsSync(rawMp4) ||
      fs.statSync(rawMp4).size < MINIMUM_PLAUSIBLE_SOURCE_BYTES
    ) {
      throw new Error('source acquisition exited without a plausible media artifact');
    }
  }
  const receipt = {
    schemaVersion: 1,
    status,
    sourceUrl,
    sourceAuth: safeSourceAuthSummary(auth),
    cloudRenderer: process.env.AWS_EXECUTION_ENV || process.env.EC2_HOME ? 'ec2' : process.platform,
    acquiredAt: new Date().toISOString(),
  };
  if (rawMp4 && fs.existsSync(rawMp4)) {
    const stats = fs.statSync(rawMp4);
    receipt.media = {
      file: path.basename(rawMp4),
      bytes: stats.size,
      sha256: sha256File(rawMp4),
    };
  }
  if (attempt) receipt.fetchAttempt = attempt;
  if (error) receipt.error = scrubBuildError(error);
  const receiptPath = writeSourceAcquisitionReceipt(outNoExt, receipt);
  return { ...receipt, receiptPath };
}

// A staged raw.mp4 may be reused only when no receipt contradicts it: a
// receipt for a different source URL or a failed acquisition means the bytes
// are not this proposal's section. Legacy artifacts without a receipt stay
// reusable (recorded as reused-unverified), as before.
function reusableSourceArtifact(outNoExt, sourceUrl) {
  let prior;
  try {
    prior = JSON.parse(fs.readFileSync(outNoExt + '.source-acquisition.json', 'utf8'));
  } catch {
    return true;
  }
  if (!prior || typeof prior !== 'object') return true;
  if (prior.status === 'failed') return false;
  if (prior.sourceUrl && sourceUrl && prior.sourceUrl !== sourceUrl) return false;
  return true;
}

function downloadRange(sourceUrl, startSec, endSec, outNoExt, { runner = runYtDlp } = {}) {
  const padStart = Math.max(0, startSec - 10);
  const padEnd = endSec + 10;
  const rawMp4 = outNoExt + '.mp4';
  const vtt = outNoExt + '.en.vtt';
  // EC2 is the canonical build target. Reuse already staged bytes only as an
  // interrupted-build resume optimization; never infer from this guard that
  // acquisition belongs on ExampleCo's PC. A block must be proved against the real
  // EC2 target with staged cookies and PoToken attached.
  if (fs.existsSync(rawMp4) && fs.statSync(rawMp4).size < MINIMUM_PLAUSIBLE_SOURCE_BYTES) {
    console.warn('[clip] removing implausibly small interrupted source artifact');
    fs.rmSync(rawMp4, { force: true });
    fs.rmSync(rawMp4 + '.part', { force: true });
  }
  if (fs.existsSync(rawMp4) && !reusableSourceArtifact(outNoExt, sourceUrl)) {
    console.warn('[clip] discarding staged source whose receipt is failed or for another URL');
    fs.rmSync(rawMp4, { force: true });
    fs.rmSync(rawMp4 + '.part', { force: true });
    // Captions belong to the same discarded acquisition (Codex 2026-09-03): a
    // surviving VTT would otherwise pair old captions with the replacement media.
    fs.rmSync(vtt, { force: true });
  }
  if (fs.existsSync(rawMp4)) {
    console.log('[clip] downloadRange skip-fetch: ' + rawMp4 + ' already present');
    const priorReceiptPath = outNoExt + '.source-acquisition.json';
    let sourceAcquisition;
    try {
      const prior = JSON.parse(fs.readFileSync(priorReceiptPath, 'utf8'));
      sourceAcquisition = {
        ...prior,
        receiptPath: priorReceiptPath,
        reusedAt: new Date().toISOString(),
      };
    } catch {
      sourceAcquisition = sourceAcquisitionReceipt({
        outNoExt,
        sourceUrl,
        status: 'reused-unverified',
        rawMp4,
      });
    }
    return {
      rawMp4,
      vtt: fs.existsSync(vtt) ? vtt : null,
      sourceOffset: padStart,
      sourceAcquisition,
    };
  }
  const failures = [];
  for (const attempt of sourceFetchAttempts(padEnd - padStart)) {
    // Every attempt owns a scratch directory (Codex 2026-09-03): yt-dlp
    // fragments, .ytdl state, .part files, and subtitles from a killed attempt
    // must never be resumable by the next one, and only verified outputs are
    // promoted onto the canonical raw.* names.
    const attemptDir = path.join(path.dirname(outNoExt), attempt.dir);
    fs.rmSync(attemptDir, { recursive: true, force: true });
    fs.mkdirSync(attemptDir, { recursive: true });
    const attemptNoExt = path.join(attemptDir, 'raw');
    const attemptMp4 = attemptNoExt + '.mp4';
    try {
      console.log(
        `[clip] source fetch attempt ${attempt.label} (bounded to ${Math.round(attempt.timeoutMs / 1000)}s)`,
      );
      runner(
        [
          '--download-sections',
          `*${fmtTs(padStart)}-${fmtTs(padEnd)}`,
          '-f',
          attempt.format,
          '--merge-output-format',
          'mp4',
          '--write-subs',
          '--write-auto-subs',
          '--sub-lang',
          'en',
          '--sub-format',
          'vtt',
          '-o',
          attemptNoExt + '.%(ext)s',
          sourceUrl,
        ],
        {
          failureLabel: `source video download failed (${attempt.label})`,
          timeout: attempt.timeoutMs,
          killSignal: 'SIGKILL',
          detached: process.platform !== 'win32',
        },
      );
      if (
        !fs.existsSync(attemptMp4) ||
        fs.statSync(attemptMp4).size < MINIMUM_PLAUSIBLE_SOURCE_BYTES
      ) {
        throw new Error('attempt exited without a plausible media artifact');
      }
      // Promote subtitles first, media last, so a failure between the two
      // never leaves canonical media behind for a later skip-fetch to reuse.
      const attemptVtt = attemptNoExt + '.en.vtt';
      let promotedVtt = false;
      if (!fs.existsSync(vtt) && fs.existsSync(attemptVtt)) {
        fs.renameSync(attemptVtt, vtt);
        promotedVtt = true;
      }
      fs.renameSync(attemptMp4, rawMp4);
      let sourceAcquisition;
      try {
        sourceAcquisition = sourceAcquisitionReceipt({
          outNoExt,
          sourceUrl,
          status: 'succeeded',
          rawMp4,
          attempt: attempt.label,
        });
      } catch (receiptError) {
        // Nothing promoted by this attempt may outlive its failed receipt.
        fs.rmSync(rawMp4, { force: true });
        if (promotedVtt) fs.rmSync(vtt, { force: true });
        throw receiptError;
      }
      fs.rmSync(attemptDir, { recursive: true, force: true });
      return { rawMp4, vtt, sourceOffset: padStart, sourceAcquisition };
    } catch (error) {
      failures.push(`${attempt.label}: ${error.message}`);
      console.warn(`[clip] source fetch via ${attempt.label} failed: ${error.message}`);
      fs.rmSync(attemptDir, { recursive: true, force: true });
    }
  }
  const error = new Error(
    'source video download failed after every bounded attempt: ' + failures.join(' | '),
  );
  try {
    sourceAcquisitionReceipt({
      outNoExt,
      sourceUrl,
      status: 'failed',
      error,
      rawMp4,
    });
  } catch (receiptError) {
    console.warn('[clip] could not write source-acquisition receipt: ' + receiptError.message);
  }
  throw error;
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
  runYtDlp(
    [
      '--download-sections',
      `*${fmtTs(broll.startSec)}-${fmtTs(padEnd)}`,
      '-f',
      'bv*[height<=1080]/b',
      '--merge-output-format',
      'mp4',
      '-o',
      outNoExt + '.%(ext)s',
      broll.url,
    ],
    { failureLabel: 'B-roll download failed' },
  );
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
    '-y',
    '-ss',
    String(offsetSec),
    '-t',
    String(durSec),
    '-i',
    rawPath,
    '-vf',
    `crop=1440:1080:240:0,scale=1080:810:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=${tailSec}`,
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-af',
    `apad=pad_dur=${tailSec}`,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-t',
    String(durSec + tailSec),
    outPath,
  ]);
}

function normalizeFaceFocusPlan(value, durSec) {
  // No plan means the historical center cover crop. `main()` normalizes the
  // proposal field once (undefined -> []) and hands that result to
  // buildFaceAwareFullBleedFilter, which normalizes again; an empty array is
  // therefore the same "no plan" answer and must never be rejected. ExampleCo's
  // 2026-09-03 Andrew Ng narrator-not-in-a-box build died on exactly this
  // double pass with "face focus plan must be a non-empty array".
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value) && value.length === 0) return [];
  let input = value;
  if (typeof value === 'string') {
    try {
      input = JSON.parse(value);
    } catch {
      throw new Error('face focus plan must be valid JSON');
    }
  }
  if (!Array.isArray(input) || !input.length) {
    throw new Error('face focus plan must be a non-empty array');
  }
  const duration = Number(durSec);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('face focus duration must be positive');
  }
  const normalized = input
    .map((segment) => ({
      start: Number(segment && segment.start),
      end: Number(segment && segment.end),
      focusX: Number(segment && segment.focusX),
    }))
    .sort((a, b) => a.start - b.start);
  for (let index = 0; index < normalized.length; index += 1) {
    const segment = normalized[index];
    const prior = normalized[index - 1];
    if (
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      !Number.isFinite(segment.focusX) ||
      segment.start < 0 ||
      segment.end <= segment.start ||
      segment.end > duration + 0.001 ||
      segment.focusX < 0 ||
      segment.focusX > 1 ||
      (prior && segment.start < prior.end - 0.001)
    ) {
      throw new Error('face focus plan contains an overlapping or unsafe segment');
    }
  }
  if (normalized[0].start > 0) {
    normalized.unshift({ start: 0, end: normalized[0].start, focusX: normalized[0].focusX });
  }
  for (let index = 1; index < normalized.length; index += 1) {
    const prior = normalized[index - 1];
    const segment = normalized[index];
    if (segment.start > prior.end) {
      normalized.splice(index, 0, {
        start: prior.end,
        end: segment.start,
        focusX: prior.focusX,
      });
      index += 1;
    }
  }
  const last = normalized[normalized.length - 1];
  if (last.end < duration) {
    normalized.push({ start: last.end, end: duration, focusX: last.focusX });
  }
  return normalized;
}

function ffmpegNumber(value) {
  return Number(value.toFixed(3)).toString();
}

function buildFaceAwareFullBleedFilter({ durSec, tailSec, faceFocusPlan }) {
  const plan = normalizeFaceFocusPlan(faceFocusPlan, durSec);
  const baseScale = 'scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos';
  // Input-side -ss/-t cuts can finish up to two output frames before the audio
  // duration because source timestamps are not guaranteed to align to 30 fps.
  // Give tpad two frames of headroom; the output-side -t still trims the mux to
  // the exact requested duration.
  const frameSafeTailSec = ffmpegNumber(tailSec + 2 / 30);
  if (!plan.length) {
    return `${baseScale},crop=1080:1920,setsar=1,eq=contrast=1.025:saturation=1.035,tpad=stop_mode=clone:stop_duration=${frameSafeTailSec}`;
  }
  let focusExpression = ffmpegNumber(plan[plan.length - 1].focusX);
  for (let index = plan.length - 1; index >= 0; index -= 1) {
    const segment = plan[index];
    focusExpression = `if(gte(t,${ffmpegNumber(segment.start)})*lt(t,${ffmpegNumber(segment.end)}),${ffmpegNumber(segment.focusX)},${focusExpression})`;
  }
  return (
    `${baseScale},` +
    `crop=1080:1920:x='(in_w-out_w)*(${focusExpression})':y='(in_h-out_h)/2',` +
    'setsar=1,' +
    // zoompan does not propagate EOF padding added downstream. Pad the decoded
    // portrait frames first so the animated filter emits real video frames for
    // the branded payoff tail instead of leaving an audio-only MP4 suffix.
    `tpad=stop_mode=clone:stop_duration=${frameSafeTailSec},` +
    "zoompan=z='1.018+0.010*sin(on/97)':" +
    "x='max(0,min(iw-iw/zoom,iw/2-(iw/zoom/2)+8*sin(on/143)))':" +
    "y='max(0,min(ih-ih/zoom,ih/2-(ih/zoom/2)+5*cos(on/181)))':" +
    'd=1:s=1080x1920:fps=30,' +
    'eq=contrast=1.025:saturation=1.035'
  );
}

function buildFullBleedSource(rawPath, offsetSec, durSec, tailSec, outPath, options = {}) {
  // The full-page theme deliberately uses the authentic source as the entire
  // canvas. An optional timed face plan follows opposite-side interview shots;
  // without one, the historical center cover crop remains unchanged.
  const filter = buildFaceAwareFullBleedFilter({
    durSec,
    tailSec,
    faceFocusPlan: options.faceFocusPlan,
  });
  run('ffmpeg', [
    '-y',
    '-ss',
    String(offsetSec),
    '-t',
    String(durSec),
    '-i',
    rawPath,
    '-vf',
    filter,
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-af',
    `apad=pad_dur=${tailSec}`,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-t',
    String(durSec + tailSec),
    outPath,
  ]);
}

function buildBrollLower(brollPath, durSec, outPath) {
  run('ffmpeg', [
    '-y',
    '-i',
    brollPath,
    '-vf',
    'crop=iw:ih*0.42:0:ih*0.45,scale=1080:420:flags=lanczos,setsar=1',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-t',
    String(durSec),
    outPath,
  ]);
}

function buildAuthenticLower(sourcePath, startSec, clipDurSec, tailSec, outPath) {
  run('ffmpeg', [
    '-y',
    '-ss',
    String(startSec),
    '-i',
    sourcePath,
    '-t',
    String(clipDurSec),
    '-vf',
    `crop=iw:ih*0.39:0:ih*0.305,scale=1080:420:flags=lanczos,setsar=1,eq=contrast=1.04:saturation=1.05,tpad=stop_mode=clone:stop_duration=${tailSec}`,
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-t',
    String(clipDurSec + tailSec),
    outPath,
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
      text: cleanVttText(c.text.join(' ')).replace(/^- /, ''),
    }));
}

function vttTimestampSeconds(raw) {
  const m = String(raw || '').match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

function cleanVttText(raw) {
  return String(raw || '')
    .replace(/<\/?c(?:\.[^>]*)?>/gi, '')
    .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/(^|\s)>+\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedCaptionToken(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, '');
}

function rollingTranscriptWords(cues) {
  const transcript = [];
  const timed = [];
  for (const cue of cues) {
    const tokens = String(cue.text || '')
      .split(/\s+/)
      .filter(Boolean);
    if (!tokens.length) continue;
    const normalized = tokens.map(normalizedCaptionToken);
    let overlap = Math.min(transcript.length, normalized.length);
    while (overlap > 0) {
      const tail = transcript.slice(-overlap).map((entry) => normalizedCaptionToken(entry.word));
      if (tail.every((token, index) => token === normalized[index])) break;
      overlap--;
    }
    const additions = tokens.slice(overlap);
    if (!additions.length) continue;
    const perWord = Math.max(0.01, cue.end - cue.start) / additions.length;
    additions.forEach((word, index) => {
      const entry = {
        word,
        start: cue.start + index * perWord,
        end: Math.min(cue.end, cue.start + (index + 1) * perWord),
      };
      transcript.push(entry);
      timed.push(entry);
    });
  }
  return timed;
}

// YouTube's auto-caption VTT is a rolling transcript. It repeats cumulative
// plain-text cues every 10 ms and embeds the real word boundaries as timestamp
// tags inside the cue text. Treating every cue as new prose produces duplicate
// captions and leaks tags such as "</c><00:00:03.120>" into the video. Prefer
// the timestamped lines when they exist, and use ordinary cue distribution only
// for conventional VTT files.
function vttWordsInRange(vttPath, clipStartSec, clipDurSec) {
  if (!vttPath || !fs.existsSync(vttPath)) return [];
  const raw = fs.readFileSync(vttPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const clipEnd = clipStartSec + clipDurSec;
  const inlineWords = [];
  let cueStart = null;
  let cueEnd = null;

  for (const line of lines) {
    const timing = line.match(/(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/);
    if (timing) {
      cueStart = vttTimestampSeconds(timing[1]);
      cueEnd = vttTimestampSeconds(timing[2]);
      continue;
    }
    if (cueStart === null || cueEnd === null || !/<\d{2}:\d{2}:\d{2}\.\d{3}>/.test(line)) continue;
    if (cueEnd <= clipStartSec || cueStart >= clipEnd) continue;

    const parts = line.split(/(<\d{2}:\d{2}:\d{2}\.\d{3}>)/g).filter(Boolean);
    let segmentStart = cueStart;
    for (let i = 0; i < parts.length; i++) {
      const taggedAt = parts[i].match(/^<(\d{2}:\d{2}:\d{2}\.\d{3})>$/);
      if (taggedAt) {
        segmentStart = vttTimestampSeconds(taggedAt[1]);
        continue;
      }
      const text = cleanVttText(parts[i]);
      if (!text) continue;
      let segmentEnd = cueEnd;
      for (let j = i + 1; j < parts.length; j++) {
        const nextTag = parts[j].match(/^<(\d{2}:\d{2}:\d{2}\.\d{3})>$/);
        if (nextTag) {
          segmentEnd = vttTimestampSeconds(nextTag[1]);
          break;
        }
      }
      const tokens = text.split(/\s+/).filter(Boolean);
      const duration = Math.max(0.01, segmentEnd - segmentStart);
      tokens.forEach((word, index) => {
        const startAbs = segmentStart + (duration * index) / tokens.length;
        const endAbs = segmentStart + (duration * (index + 1)) / tokens.length;
        if (endAbs <= clipStartSec || startAbs >= clipEnd) return;
        inlineWords.push({
          word,
          start: Math.max(0, startAbs - clipStartSec),
          end: Math.min(clipDurSec, endAbs - clipStartSec),
        });
      });
    }
  }

  if (inlineWords.length > 0) {
    // The inline stream is already the chronological word sequence. Never
    // reconcile it to whole rolling cues: an overlapping cue can contain
    // pre-roll words, and a repeated token (for example an early "of" and a
    // later "of") can otherwise be paired across several seconds. That makes
    // ASS events non-monotonic and leaves stale text onscreen. Keep the exact
    // inline order, discard repeated/invalid intervals, and clamp a tiny VTT
    // overlap to the prior word boundary.
    const ordered = [];
    let priorEnd = 0;
    for (const entry of inlineWords) {
      const rawStart = Number(entry.start);
      const end = Number(entry.end);
      if (!Number.isFinite(rawStart) || !Number.isFinite(end) || end <= rawStart) continue;
      // More than a frame of backwards motion is not a rounding seam; it is
      // a repeated rolling fragment and must be discarded, not stretched
      // forward into a second caption event.
      if (rawStart < priorEnd - 0.05) continue;
      const start = Math.max(priorEnd, rawStart);
      if (end <= start) continue;
      const prior = ordered[ordered.length - 1];
      if (
        prior &&
        normalizedCaptionToken(prior.word) === normalizedCaptionToken(entry.word) &&
        Math.abs(prior.start - start) < 0.02 &&
        Math.abs(prior.end - end) < 0.02
      ) {
        continue;
      }
      ordered.push({ ...entry, start, end });
      priorEnd = end;
    }
    return ordered;
  }
  return distributeWordTimings(vttCuesInRange(vttPath, clipStartSec, clipDurSec));
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
    /\bmillions?\b/i,
    /\bdollars?\b/i,
    /\bbillions?\b/i,
    /\brepeatedly\b/i,
    /\bfree\b/i,
    /\bads?\b/i,
    /\bzero\b/i,
    /\byears?\b/i,
    /\bvlc\b/i,
    /\bffmpeg\b/i,
    /\bopen.?source\b/i,
    /\bleaving\b/i,
    /\btable\b/i,
    /\binsane\b/i,
    /\bnever\b/i,
    /\balways\b/i,
    /\bworld\b/i,
    /\bevery(one|body)?\b/i,
  ];
  const FILLERS = new Set([
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'of',
    'in',
    'on',
    'at',
    'to',
    'for',
    'and',
    'or',
    'but',
    'if',
    'that',
    'this',
    'it',
    'you',
    'i',
    'we',
    'they',
    'he',
    'she',
    'so',
    'as',
    'jb',
    'goes',
    'take',
    'me',
    'through',
    'the',
  ]);
  let emCount = 0;
  for (const w of words) {
    const tok = w.word.replace(/[.,!?;:]/g, '').toLowerCase();
    if (FILLERS.has(tok)) {
      w.emphasis = false;
      continue;
    }
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
    'print(f"karaoke ass {len(data[\'words\'])} words")',
  ].join('\n');
  run(PYTHON_BIN, ['-c', py], { failureLabel: 'karaoke caption generation failed' });
  return outAssPath;
}

function assTimestamp(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = Math.floor(value % 60);
  const cs = Math.floor((value - Math.floor(value)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function generateThemeOverlayAss({
  theme,
  hookLines,
  closingLines,
  attribution,
  clipDur,
  totalDur,
  bridges = [],
  outAssPath,
}) {
  const title = escapeAssText(hookLines[0] || 'AI INTELLIGENCE');
  const closing = escapeAssText(closingLines[0] || 'FIELD INTELLIGENCE');
  const titleSize = fittedFontSize(title, 72, 820);
  const end = assTimestamp(totalDur);
  const payoffStart = assTimestamp(Math.max(0, clipDur - 0.08));
  const payoffEnd = assTimestamp(Math.min(totalDur, clipDur + 0.48));
  const boltPath = 'm 15 0 l 94 0 l 58 72 l 116 72 l 0 220 l 35 113 l -10 113 l 15 0';
  const rows = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,DejaVu Sans,24,&H00F8FBFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,8,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 2,0:00:00.00,${end},Default,,0,0,0,,{\\an8\\pos(540,60)\\fnDejaVu Sans\\fs18\\b1\\fsp9\\1c&H009DEFFF&\\3c&H009DEFFF&\\bord1\\blur4\\shad0\\fad(220,0)}AI INTELLIGENCE`,
    `Dialogue: 3,0:00:00.00,${end},Default,,0,0,0,,{\\an8\\pos(540,94)\\fnDejaVu Serif\\fs${titleSize}\\b1\\fsp2\\1c&H00F8F7F2&\\3c&H00CF6FFF&\\bord5\\blur8\\shad0\\fad(220,0)}${title}`,
    `Dialogue: 3,0:00:00.00,${end},Default,,0,0,0,,{\\an2\\pos(540,1840)\\fnDejaVu Sans\\fs24\\b0\\fsp1\\1c&H00D8D8D8&\\3c&H00101010&\\bord2\\shad0}Source: ${escapeAssText(attribution)}`,
    `Dialogue: 5,0:00:00.00,0:00:00.52,Default,,0,0,0,,{\\an5\\pos(540,1030)\\p1\\fad(20,120)\\fscx80\\fscy80\\t(0,160,\\fscx138\\fscy138)\\frz-9\\c&H00FFFFFF&\\3c&H00FFE35A&}${boltPath}`,
    `Dialogue: 4,0:00:00.00,0:00:00.55,Default,,0,0,0,,{\\an5\\pos(540,1030)\\p1\\fad(15,150)\\fscx118\\fscy118\\frz7\\blur9\\alpha&H7A&\\c&H00FF72F5&}${boltPath}`,
    totalDur > clipDur + 0.01
      ? `Dialogue: 5,${payoffStart},${payoffEnd},Default,,0,0,0,,{\\an5\\pos(540,1030)\\p1\\fad(20,120)\\fscx80\\fscy80\\t(0,160,\\fscx138\\fscy138)\\frz-9\\c&H00FFFFFF&\\3c&H00FFE35A&}${boltPath}`
      : '',
    totalDur > clipDur + 0.01
      ? `Dialogue: 4,${payoffStart},${payoffEnd},Default,,0,0,0,,{\\an5\\pos(540,1030)\\p1\\fad(15,150)\\fscx118\\fscy118\\frz7\\blur9\\alpha&H7A&\\c&H00FF72F5&}${boltPath}`
      : '',
    totalDur > clipDur + 0.01
      ? `Dialogue: 6,${assTimestamp(clipDur)},${end},Default,,0,0,0,,{\\an5\\pos(540,1110)\\fnDejaVu Sans\\fs52\\b1\\fsp2\\1c&H00F8F7F2&\\3c&H00CF6FFF&\\bord4\\blur3\\shad0\\fad(160,250)}${closing}`
      : '',
    // Woven multi-segment shorts (ExampleCo 2026-09-23): one motion-graphics
    // interstitial per bridge, in the approved benchmark motion grammar.
    ...bridgeOverlayDialogues(bridges),
  ].filter(Boolean);
  fs.writeFileSync(outAssPath, rows.join('\n'));
  return outAssPath;
}

function compositePodcastClip({
  theme,
  talkingHeadPath,
  fullBleedPath,
  captionsAssPath,
  themeOverlayAssPath,
  logoPath = EXAMPLECHANNEL_OUTLINE_LOGO,
  musicPath,
  musicGain,
  logoPosition,
  clipDur,
  totalDur,
  transitionCueSecs = [],
  outPath,
  runner = run,
}) {
  const plan = buildThemeRenderPlan(theme);
  if (!fs.existsSync(logoPath)) throw new Error('Examplechannel outline logo missing: ' + logoPath);
  if (!Number.isFinite(Number(musicGain))) throw new Error('musicGain is required');
  const themeAss = path.basename(themeOverlayAssPath);
  const captionsAss = path.basename(captionsAssPath);
  const logoPlacement = resolveLogoPlacement(theme, logoPosition);
  const logoX = logoPlacement.x;
  const logoY = logoPlacement.y;
  const sourceAudio = plan.fullBleedSource ? '[1:a]' : '[0:a]';
  const videoComposition = plan.fullBleedSource
    ? `
      [1:v]drawbox=x=0:y=0:w=1080:h=155:color=black@0.30:t=fill,
            drawbox=x=0:y=1715:w=1080:h=205:color=black@0.20:t=fill[canvas];
      [canvas]subtitles=${themeAss},subtitles=${captionsAss}[branded]`
    : `
      [1:v]boxblur=22:3,eq=brightness=-0.25:saturation=1.12[backdrop];
      [0:v]scale=1000:750:flags=lanczos,pad=1008:758:4:4:color=#FFE669[framed];
      [backdrop][framed]overlay=x=36:y=350:shortest=1[canvas];
      [canvas]subtitles=${themeAss},subtitles=${captionsAss}[branded]`;
  const payoffDelayMs = Math.max(0, Math.round(clipDur * 1000));
  // Every woven interstitial gets the same water-wind cue as the opening and
  // payoff transitions; a single-range clip keeps the historical two cues.
  const bridgeCueDelaysMs = (transitionCueSecs || [])
    .map((sec) => Math.round(Number(sec) * 1000))
    .filter((ms) => Number.isFinite(ms) && ms > 0);
  const cueDelaysMs = [40, payoffDelayMs, ...bridgeCueDelaysMs];
  const cueLabels = cueDelaysMs.map((_ms, index) => `[w${index + 1}]`);
  const cueDelayed = cueDelaysMs.map((_ms, index) => `[wd${index + 1}]`);
  const cueDelayFilters = cueDelaysMs
    .map((ms, index) => `${cueLabels[index]}adelay=${ms}:all=1${cueDelayed[index]};`)
    .join('\n    ');
  const filter = `
    ${videoComposition};
    [2:v]split=2[logo-source][logo-glow-source];
    [logo-glow-source]scale=${plan.logoWidth + 36}:-1:flags=lanczos,format=rgba,
          gblur=sigma=14:steps=3,colorchannelmixer=aa=0.74[logo-glow];
    [logo-source]scale=${plan.logoWidth}:-1:flags=lanczos,format=rgba,colorchannelmixer=aa=0.98[logo];
    [branded][logo-glow]overlay=x=${logoX - LOGO_HALO_INSET}:y=${logoY - LOGO_HALO_INSET}:format=auto:shortest=1[glowing];
    [glowing][logo]overlay=x=${logoX}:y=${logoY}:format=auto:shortest=1[v];
    [3:a]${MUSIC_BED_LEVELED_FILES.has(path.basename(String(musicPath || ""))) ? `${MUSIC_BED_LEVEL_FILTER},` : ""}aresample=48000,highpass=f=110,lowpass=f=9000,volume=${musicGain},
          afade=t=in:st=0:d=0.8,afade=t=out:st=${Math.max(0, totalDur - 0.8).toFixed(2)}:d=0.8,atrim=0:${totalDur}[music];
    [4:a]highpass=f=260,lowpass=f=7600,volume=0.22,
          afade=t=in:st=0:d=0.10,afade=t=out:st=0.25:d=0.37[wind];
    [5:a]highpass=f=1100,lowpass=f=9800,volume=0.10,
          afade=t=in:st=0:d=0.06,afade=t=out:st=0.20:d=0.42[water];
    [wind][water]amix=inputs=2:duration=longest:normalize=0,
          aecho=0.75:0.20:22:0.10,asplit=${cueDelaysMs.length}${cueLabels.join('')};
    ${cueDelayFilters}
    ${sourceAudio}[music]${cueDelayed.join('')}amix=inputs=${cueDelaysMs.length + 2}:duration=first:normalize=0,
          loudnorm=I=-16:TP=-1.5:LRA=9[a]
  `;
  // subtitles= filter resolves relative paths from cwd, so cd into the
  // captions directory for the call.
  const capDir = path.dirname(captionsAssPath);
  runner(
    'ffmpeg',
    [
      '-y',
      '-i',
      path.resolve(talkingHeadPath),
      '-i',
      path.resolve(fullBleedPath),
      '-loop',
      '1',
      '-framerate',
      '30',
      '-i',
      path.resolve(logoPath),
      '-i',
      path.resolve(musicPath),
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=color=pink:amplitude=0.12:sample_rate=48000:d=0.62',
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=color=white:amplitude=0.055:sample_rate=48000:d=0.62',
      '-filter_complex',
      filter,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-b:v',
      '4500k',
      '-minrate',
      '4500k',
      '-maxrate',
      '4500k',
      '-bufsize',
      '9M',
      '-x264-params',
      'nal-hrd=cbr:filler=1',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-movflags',
      '+faststart',
      '-t',
      String(totalDur),
      path.resolve(outPath),
    ],
    { cwd: capDir },
  );
}

function ffmpegFilterPath(filePath) {
  return String(path.resolve(filePath))
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

function renderTextOnlyBounds(filter, { atSec = 0, cwd } = {}) {
  const sampleAt = Math.max(0, Number(atSec) || 0);
  const duration = Math.max(0.2, sampleAt + 0.1);
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=${TEXT_FIT_VIEWPORT.width}x${TEXT_FIT_VIEWPORT.height}:d=${duration}:r=30`,
      '-ss',
      sampleAt.toFixed(3),
      '-vf',
      `${filter},format=rgb24`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    {
      cwd,
      encoding: null,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg text-only measurement failed (${result.status}): ${String(result.stderr || '').trim()}`,
    );
  }
  return renderedPixelBounds(result.stdout);
}

function safeMeasuredElement(id, text, rect) {
  if (!rect) throw new Error(`text-only measurement found no rendered pixels for ${id}`);
  return {
    id,
    text,
    rect,
    clippingAncestors: [
      {
        key: 'delivery-title-safe-area',
        rect: TEXT_FIT_SAFE_RECT,
        clientWidth: TEXT_FIT_SAFE_RECT.width,
        clientHeight: TEXT_FIT_SAFE_RECT.height,
        scrollWidth: TEXT_FIT_SAFE_RECT.width,
        scrollHeight: TEXT_FIT_SAFE_RECT.height,
        overflowX: 'hidden',
        overflowY: 'hidden',
      },
    ],
  };
}

function assTimeSeconds(value) {
  const match = String(value || '')
    .trim()
    .match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const fraction = Number(`0.${match[4] || '0'}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + fraction;
}

function assDialogueSamples(captionsAssPath) {
  if (!captionsAssPath || !fs.existsSync(captionsAssPath)) return [];
  const samples = [];
  for (const line of fs.readFileSync(captionsAssPath, 'utf8').split(/\r?\n/)) {
    if (!/^Dialogue:/i.test(line)) continue;
    const fields = line.replace(/^Dialogue:\s*/i, '').split(',');
    if (fields.length < 10) continue;
    const start = assTimeSeconds(fields[1]);
    const end = assTimeSeconds(fields[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const text = fields
      .slice(9)
      .join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    samples.push({ atSec: start + (end - start) / 2, text: text || 'karaoke captions' });
  }
  const seen = new Set();
  return samples.filter((sample) => {
    const key = Math.round(sample.atSec * 1000);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildFfmpegTextFitSamples({
  captionsAssPath,
  themeOverlayAssPath,
  theme = DEFAULT_VIRAL_CLIP_THEME,
  hookLines,
  closingLines,
  attribution = 'attribution',
  clipDur,
  totalDur,
  logoPosition,
  bridges = [],
}) {
  const drawtextBounds = ({ id, text, fontPath, fontSize, y }) => {
    const filter =
      `drawtext=text='${escapeDrawtext(text)}':fontfile='${ffmpegFilterPath(fontPath)}':` +
      `fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=${y}`;
    return safeMeasuredElement(id, text, renderTextOnlyBounds(filter));
  };
  let startElements;
  let endElements;
  if (themeOverlayAssPath) {
    const plan = buildThemeRenderPlan(theme);
    const logoPlacement = resolveLogoPlacement(theme, logoPosition);
    const themeFilter = `subtitles='${ffmpegFilterPath(themeOverlayAssPath)}'`;
    const startAt = Math.min(0.25, Math.max(0, Number(totalDur || 0) / 2));
    const endAt = Math.max(0, Number(totalDur || 0) - 0.2);
    const logoLeft = logoPlacement.x;
    const logoTop = logoPlacement.y;
    const logoHeight = Math.round((plan.logoWidth * 1265) / 1244);
    const logoElement = safeMeasuredElement('brand-logo', 'Examplechannel glowing logo', {
      left: logoLeft,
      top: logoTop,
      right: logoLeft + plan.logoWidth,
      bottom: logoTop + logoHeight,
      width: plan.logoWidth,
      height: logoHeight,
    });
    startElements = [
      safeMeasuredElement(
        'theme-overlay-start',
        `${plan.header}; ${plan.transitionVisual}; Source: ${attribution}`,
        renderTextOnlyBounds(themeFilter, {
          atSec: startAt,
          cwd: path.dirname(themeOverlayAssPath),
        }),
      ),
      logoElement,
    ];
    endElements = [
      safeMeasuredElement(
        'theme-overlay-end',
        `${closingLines.join(' ')}; Source: ${attribution}`,
        renderTextOnlyBounds(themeFilter, {
          atSec: endAt,
          cwd: path.dirname(themeOverlayAssPath),
        }),
      ),
      logoElement,
    ];
  } else {
    const hookLayout = [
      { y: 70, size: 82 },
      { y: 150, size: 180 },
      { y: 340, size: 66 },
      { y: 410, size: 60 },
    ];
    startElements = hookLines.slice(0, 4).map((line, index) =>
      drawtextBounds({
        id: `hook-${index + 1}`,
        text: line,
        fontPath: FONT_BOLD_RAW,
        fontSize: fittedFontSize(line, hookLayout[index].size),
        y: hookLayout[index].y,
      }),
    );
    const sourceElement = drawtextBounds({
      id: 'source-attribution',
      text: 'Source: ' + attribution,
      fontPath: FONT_REGULAR_RAW,
      fontSize: 34,
      y: 1820,
    });
    startElements.push(sourceElement);
    endElements = closingLines.slice(0, 3).map((line, index) =>
      drawtextBounds({
        id: `closing-${index + 1}`,
        text: line,
        fontPath: FONT_BOLD_RAW,
        fontSize: fittedFontSize(line, 88),
        y: 1500 + index * 120,
      }),
    );
    endElements.push(sourceElement);
  }

  const samples = [
    { atMs: 0, phase: 'timeline-start', elements: startElements },
    {
      atMs: Math.max(0, Math.round(Number(totalDur || 0) * 1000) - 34),
      phase: 'timeline-end',
      elements: endElements,
    },
  ];
  if (themeOverlayAssPath) {
    // Every woven interstitial is measured after its scale-in settles and
    // before its fade-out, so the bridge text proves it fits the safe area.
    const themeFilter = `subtitles='${ffmpegFilterPath(themeOverlayAssPath)}'`;
    for (const [index, bridge] of (bridges || []).entries()) {
      const atSec = bridge.outStart + Math.min(0.6, (bridge.outEnd - bridge.outStart) * 0.5);
      samples.push({
        atMs: Math.round(atSec * 1000),
        phase: 'timeline-sample',
        elements: [
          safeMeasuredElement(
            `bridge-${index + 1}`,
            String(bridge.text || ''),
            renderTextOnlyBounds(themeFilter, { atSec, cwd: path.dirname(themeOverlayAssPath) }),
          ),
        ],
      });
    }
  }
  const captionsFilter = `subtitles='${ffmpegFilterPath(captionsAssPath)}'`;
  for (const [index, caption] of assDialogueSamples(captionsAssPath).entries()) {
    const rect = renderTextOnlyBounds(captionsFilter, {
      atSec: caption.atSec,
      cwd: path.dirname(captionsAssPath),
    });
    if (!rect) {
      throw new Error(`caption event ${index + 1} rendered no measurable pixels`);
    }
    samples.push({
      atMs: Math.round(caption.atSec * 1000),
      phase: 'timeline-sample',
      elements: [safeMeasuredElement(`captions-${index + 1}`, caption.text, rect)],
    });
  }
  if (!(Number(clipDur) >= 0)) throw new Error('clip duration is invalid for text-fit proof');
  return samples;
}

// Motion-graphics interstitial plate: the last frame of the previous segment,
// blurred, dimmed, and pushed in slowly, with a silent audio track so the
// concat keeps every stream aligned. The bridge text, rail, and sheen are
// drawn on top by the theme overlay (bridgeOverlayDialogues).
function buildBridgeClip({ fromClip, durSec, width, height, outPath, runner = run }) {
  const still = outPath.replace(/\.mp4$/i, '') + '_still.png';
  runner('ffmpeg', ['-y', '-loglevel', 'error', '-sseof', '-0.2', '-i', fromClip, '-frames:v', '1', '-update', '1', still], {
    failureLabel: 'bridge still extraction failed',
  });
  const frames = Math.max(2, Math.round(Number(durSec) * 30));
  runner(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-loop',
      '1',
      '-framerate',
      '30',
      '-t',
      String(durSec),
      '-i',
      still,
      '-f',
      'lavfi',
      '-t',
      String(durSec),
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-filter_complex',
      `[0:v]scale=${width}:${height}:flags=lanczos,setsar=1,` +
        `zoompan=z='1+0.05*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=30,` +
        'gblur=sigma=9,eq=brightness=-0.10:saturation=1.10,format=yuv420p[v]',
      '-map',
      '[v]',
      '-map',
      '1:a',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-t',
      String(durSec),
      outPath,
    ],
    { failureLabel: 'bridge interstitial render failed' },
  );
  return outPath;
}

// Joins segment and bridge clips in timeline order. Every input is normalized
// to 30 fps, square pixels, yuv420p, and 48 kHz stereo so sources recorded at
// different rates cannot drift or fail the concat.
function concatWovenClips(clipPaths, outPath, { runner = run } = {}) {
  const inputs = [];
  const norm = [];
  const pairs = [];
  clipPaths.forEach((clip, index) => {
    inputs.push('-i', path.resolve(clip));
    norm.push(
      `[${index}:v]fps=30,setsar=1,format=yuv420p[v${index}]`,
      `[${index}:a]aresample=48000,aformat=channel_layouts=stereo[a${index}]`,
    );
    pairs.push(`[v${index}][a${index}]`);
  });
  const filter = `${norm.join(';')};${pairs.join('')}concat=n=${clipPaths.length}:v=1:a=1[v][a]`;
  runner(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      ...inputs,
      '-filter_complex',
      filter,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      path.resolve(outPath),
    ],
    { failureLabel: 'woven segment concat failed' },
  );
  return outPath;
}

function wovenBuildReceipt({ mode, segments, bridges }) {
  const rows = (segments || []).map((segment) => ({
    index: segment.index,
    role: segment.role || '',
    proposedRange: [segment.proposedStartSec, segment.proposedEndSec],
    builtRange: [segment.startSec, segment.endSec],
    startBoundary: segment.startSnap ? segment.startSnap.reason : 'not snapped',
    endBoundary: segment.endSnap ? segment.endSnap.reason : 'not snapped',
    completeSentenceBoundaries: Boolean(
      segment.startSnap &&
        segment.startSnap.sentenceStart === true &&
        segment.endSnap &&
        /sentence end/.test(segment.endSnap.reason || ''),
    ),
    proposedSays: segment.says || '',
    spokenText: segment.spokenText || '',
  }));
  return {
    assembly: mode === 'woven' ? 'woven-multi-segment' : 'single-range',
    styleReference: BENCHMARK_MOTION_STYLE_REFERENCE,
    segments: rows,
    allSegmentsSentenceBounded: rows.length > 0 && rows.every((r) => r.completeSentenceBoundaries),
    interstitials: (bridges || []).map((bridge) => ({
      text: bridge.text,
      outStart: bridge.outStart,
      outEnd: bridge.outEnd,
      ordinal: bridge.ordinal,
      of: bridge.of,
      style: 'benchmark-motion interstitial',
      audioCue: 'water-wind',
    })),
  };
}

function buildDirectiveForBuild(proposal, machineAssertions = []) {
  return buildDirectiveReceipt(resolveBuildDirective(proposal), machineAssertions);
}

// Acquires, sentence-snaps, and renders each woven segment, renders one
// interstitial plate per gap, and assembles the woven full-page and (boxed
// theme) talking-head timelines.
function prepareWovenSource({ proposal, segments, renderPlan, stage, tailDur }) {
  // Resolve beside this script, not through SECONDBRAIN_ROOT, so the code and
  // its helper always come from the same release.
  const snap = require('./lib/snap-clip-to-sentence-boundary.js');
  const built = [];
  segments.forEach((segment, i) => {
    const isLast = i === segments.length - 1;
    const rawNoExt = path.join(stage, `raw-seg${i + 1}`);
    console.log(
      `[clip] woven segment ${i + 1}/${segments.length} (${segment.role}) ${fmtTs(segment.startSec)} to ${fmtTs(segment.endSec)}`,
    );
    const dl = downloadRange(proposal.source_url, segment.startSec, segment.endSec, rawNoExt);
    const cues = dl.vtt ? snap.parseVtt(dl.vtt) : [];
    let startSec = segment.startSec;
    let endSec = segment.endSec;
    const startSnap = snap.snapStartToSentenceBoundary({ cues, startSec, tolerance: 3 });
    if (startSnap.startSec < endSec - 4) startSec = startSnap.startSec;
    const endSnap = snap.snapEndToSentenceBoundary({ cues, startSec, endSec, tolerance: 4 });
    endSec = endSnap.endSec;
    const segDur = Number((endSec - startSec).toFixed(3));
    console.log(
      `[clip] segment ${i + 1} boundaries: start ${startSnap.reason}, end ${endSnap.reason}; ${fmtTs(startSec)} to ${fmtTs(endSec)}`,
    );
    const segTail = isLast ? tailDur : 0;
    const fullBleed = path.join(stage, `full_bleed_seg${i + 1}.mp4`);
    buildFullBleedSource(dl.rawMp4, startSec - dl.sourceOffset, segDur, segTail, fullBleed, {
      faceFocusPlan: [],
    });
    let talkingHead = null;
    if (renderPlan.speakerFrame) {
      talkingHead = path.join(stage, `talking_head_seg${i + 1}.mp4`);
      buildTalkingHead(dl.rawMp4, startSec - dl.sourceOffset, segDur, segTail, talkingHead);
    }
    const words = vttWordsInRange(dl.vtt, startSec, segDur);
    built.push({
      ...segment,
      proposedStartSec: segment.startSec,
      proposedEndSec: segment.endSec,
      startSec,
      endSec,
      startSnap,
      endSnap,
      fullBleed,
      talkingHead,
      words,
      spokenText: words.map((w) => w.word).join(' '),
      sourceAcquisition: dl.sourceAcquisition,
    });
  });

  const timeline = planWovenTimeline(built, {
    bridgeSeconds: DEFAULT_BRIDGE_SECONDS,
    tailSeconds: tailDur,
  });
  const fullBleedParts = [];
  const talkingParts = [];
  const words = [];
  for (const entry of timeline.entries) {
    if (entry.kind === 'segment') {
      const seg = built.find((b) => b.index === entry.index);
      fullBleedParts.push(seg.fullBleed);
      if (seg.talkingHead) talkingParts.push(seg.talkingHead);
      words.push(...offsetWords(seg.words, entry.outStart));
    } else {
      const prev = built[built.findIndex((b) => b.index === entry.index) - 1];
      const bridgeDur = Number((entry.outEnd - entry.outStart).toFixed(3));
      fullBleedParts.push(
        buildBridgeClip({
          fromClip: prev.fullBleed,
          durSec: bridgeDur,
          width: 1080,
          height: 1920,
          outPath: path.join(stage, `bridge_full_${entry.ordinal}.mp4`),
        }),
      );
      if (prev.talkingHead) {
        talkingParts.push(
          buildBridgeClip({
            fromClip: prev.talkingHead,
            durSec: bridgeDur,
            width: 1080,
            height: 810,
            outPath: path.join(stage, `bridge_talking_${entry.ordinal}.mp4`),
          }),
        );
      }
    }
  }
  const fullBleed = concatWovenClips(fullBleedParts, path.join(stage, 'full_bleed_source.mp4'));
  const talkingHead = renderPlan.speakerFrame
    ? concatWovenClips(talkingParts, path.join(stage, 'talking_head.mp4'))
    : fullBleed;
  return {
    fullBleed,
    talkingHead,
    words,
    clipDur: timeline.speechEndSec,
    totalDur: timeline.totalDur,
    bridges: timeline.bridges,
    faceFocusPlan: [],
    sourceAcquisitions: built.map((b) => b.sourceAcquisition).filter(Boolean),
    wovenReceipt: wovenBuildReceipt({ mode: 'woven', segments: built, bridges: timeline.bridges }),
    sourceRangeLabel: built.map((b) => `${fmtTs(b.startSec)}-${fmtTs(b.endSec)}`).join(', '),
    builtSegments: built.map((b) => ({
      role: b.role,
      approx_timestamp: `${fmtTs(b.startSec)}-${fmtTs(b.endSec)}`,
      says: b.says,
      bridge_before: b.bridge,
    })),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const { proposal, statePath, state } = loadProposal(args);
  const theme = normalizeViralClipTheme(args.theme || proposal.video_theme);
  const renderPlan = buildThemeRenderPlan(theme);
  proposal.video_theme = theme;
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  if (!fs.existsSync(EXAMPLECHANNEL_OUTLINE_LOGO)) {
    throw new Error('approved Examplechannel outline logo missing: ' + EXAMPLECHANNEL_OUTLINE_LOGO);
  }
  // Validate every proposal-controlled render knob before source acquisition
  // or encoding so an invalid value fails before expensive work begins.
  const musicFile = pickMusic(proposal);
  const musicGain = resolveMusicGain(proposal, musicFile);
  const logoPosition = resolveLogoPosition(proposal);

  const tailDur = resolveClipTailSeconds(proposal);
  // Woven segments (ExampleCo 2026-09-23) fail closed here, before any source
  // acquisition; a legacy single-range proposal resolves to one segment.
  const resolvedSegments = resolveClipSegments(proposal, {
    durationSeconds: Number(proposal.durationSeconds) || 0,
  });
  const ownerDirective = resolveBuildDirective(proposal);
  if (ownerDirective) {
    console.log(`[clip] REQUIRED owner build directive: "${ownerDirective.text}"`);
  }

  const slug = slugify(proposal.source + '_' + proposal.id);
  const stage = path.join(BUILD_DIR, proposal.id);
  fs.mkdirSync(stage, { recursive: true });

  let dl;
  let fullBleed;
  let talkingHead;
  let words;
  let clipDur;
  let totalDur;
  let faceFocusPlan;
  let woven = null;
  console.log(`[clip] theme ${theme} (${renderPlan.version})`);
  if (resolvedSegments.mode === 'woven') {
    console.log(
      `[clip] woven argument: ${resolvedSegments.segments.length} complete-sentence segments with motion-graphics interstitials (${BENCHMARK_MOTION_STYLE_REFERENCE})`,
    );
    woven = prepareWovenSource({
      proposal,
      segments: resolvedSegments.segments,
      renderPlan,
      stage,
      tailDur,
    });
    ({ fullBleed, talkingHead, words, clipDur, totalDur, faceFocusPlan } = woven);
    dl = { sourceAcquisition: woven.sourceAcquisitions[0] || null };
    console.log('[clip] generating karaoke captions');
  } else {
    const { startSec, endSec: proposedEndSec } = parseTimestampRange(proposal.approx_timestamp);
    let endSec = proposedEndSec;
    clipDur = endSec - startSec;
    totalDur = clipDur + tailDur;

    const rawNoExt = path.join(stage, 'raw');

    console.log(
      `[clip] source ${fmtTs(startSec)} to ${fmtTs(endSec)} (${clipDur}s clip + ${tailDur}s tail)`,
    );
    dl = downloadRange(proposal.source_url, startSec, endSec, rawNoExt);

    // 2026-05-25 ExampleCo flagged on the Otter feature-backlog feedback session
    // that clips were always cut off mid-word. Snap the end timestamp to the
    // nearest sentence boundary using the freshly downloaded VTT, within a
    // 5-second tolerance, so we never publish a mid-word hard cut. Updates
    // the shared endSec/clipDur/totalDur in place so downstream ffmpeg
    // builds (talking head, broll, captions, composite) all use the snapped
    // window.
    try {
      const snap = require(path.join(REPO, 'scripts', 'lib', 'snap-clip-to-sentence-boundary.js'));
      if (dl && dl.vtt && shouldSnapClipEnd(proposal)) {
        const cues = snap.parseVtt(dl.vtt);
        const snapped = snap.snapEndToSentenceBoundary({ cues, startSec, endSec, tolerance: 5 });
        if (snapped.endSec !== endSec) {
          const delta = (snapped.endSec - endSec).toFixed(2);
          console.log(
            `[clip] snap-to-sentence: ${snapped.reason}; endSec ${fmtTs(endSec)} -> ${fmtTs(snapped.endSec)} (${delta >= 0 ? '+' : ''}${delta}s); cue tail: "${snapped.cueText || ''}"`,
          );
          endSec = snapped.endSec;
          clipDur = endSec - startSec;
          totalDur = clipDur + tailDur;
        }
      }
    } catch (snapErr) {
      console.warn('[clip] snap-to-sentence failed, falling back to proposal end:', snapErr.message);
    }

    console.log('[clip] authentic source footage -> 1080x1920 full-page canvas');
    fullBleed = path.join(stage, 'full_bleed_source.mp4');
    faceFocusPlan = renderPlan.fullBleedSource
      ? normalizeFaceFocusPlan(proposal.face_focus_plan, clipDur)
      : [];
    buildFullBleedSource(dl.rawMp4, startSec - dl.sourceOffset, clipDur, tailDur, fullBleed, {
      faceFocusPlan,
    });

    talkingHead = fullBleed;
    if (renderPlan.speakerFrame) {
      console.log('[clip] narrator-in-a-box speaker panel -> 1000x750 inside editorial frame');
      talkingHead = path.join(stage, 'talking_head.mp4');
      buildTalkingHead(dl.rawMp4, startSec - dl.sourceOffset, clipDur, tailDur, talkingHead);
    } else {
      console.log('[clip] narrator-not-in-a-box -> full-page person, no speaker panel or B-roll');
    }

    console.log('[clip] generating karaoke captions');
    words = vttWordsInRange(dl.vtt, startSec, clipDur);
  }
  const flagged = flagEmphasis(words);
  console.log(
    `[clip] caption words: ${flagged.words.length}, emphasis rate ${(flagged.emphasisRate * 100).toFixed(0)}%`,
  );
  const captionsAss = path.join(stage, 'captions.ass');
  if (flagged.words.length > 0) {
    generateKaraokeAss(flagged.words, renderPlan.fullBleedSource ? 300 : 330, 92, captionsAss);
  } else {
    // Fallback: empty captions file, ffmpeg subtitles filter accepts it
    fs.writeFileSync(
      captionsAss,
      '[Script Info]\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\n[Events]\n',
    );
  }

  const hookLines = generateHookLines(proposal);
  const attribution = attributionLabel(proposal);
  const closingLines = generateClosingLines(proposal);
  const musicPath = path.join(MUSIC_DIR, musicFile);
  const musicUsageScope = String(proposal.music_usage_scope || 'approved-registry');

  console.log(`[clip] hook: ${JSON.stringify(hookLines)}`);
  console.log(`[clip] closing: ${JSON.stringify(closingLines)}`);
  console.log(`[clip] music: ${musicFile}`);
  console.log(`[clip] music gain: ${musicGain}`);
  console.log(`[clip] logo position: ${logoPosition}`);

  const themeOverlayAss = path.join(stage, 'theme-overlay.ass');
  generateThemeOverlayAss({
    theme,
    hookLines,
    closingLines,
    attribution,
    clipDur,
    totalDur,
    bridges: woven ? woven.bridges : [],
    outAssPath: themeOverlayAss,
  });

  const finalLocal = path.join(stage, slug + '.mp4');
  compositePodcastClip({
    theme,
    talkingHeadPath: talkingHead,
    fullBleedPath: fullBleed,
    captionsAssPath: captionsAss,
    themeOverlayAssPath: themeOverlayAss,
    musicPath,
    musicGain,
    logoPosition,
    clipDur,
    totalDur,
    transitionCueSecs: woven ? woven.bridges.map((bridge) => bridge.outStart) : [],
    outPath: finalLocal,
  });

  const finalDest = path.join(PENDING_DIR, slug + '.mp4');
  fs.copyFileSync(finalLocal, finalDest);
  const thumbnailDest = finalDest.replace(/\.mp4$/i, '_thumb.jpg');
  createApprovalThumbnail(finalDest, thumbnailDest);
  try {
    const textFit = createVideoTextFitReceipt({
      videoPath: finalDest,
      viewport: TEXT_FIT_VIEWPORT,
      durationMs: Math.round(totalDur * 1000),
      samples: buildFfmpegTextFitSamples({
        captionsAssPath: captionsAss,
        themeOverlayAssPath: themeOverlayAss,
        theme,
        hookLines,
        closingLines,
        attribution,
        clipDur,
        totalDur,
        logoPosition,
        bridges: woven ? woven.bridges : [],
      }),
    });
    console.log(
      `[clip] text-fit receipt ${textFit.receipt.passed ? 'passed' : 'failed'}: ${textFit.receiptPath}`,
    );
  } catch (error) {
    console.warn(`[clip] text-fit measurement failed closed: ${error.message}`);
  }

  let directiveAssertions = [];
  try {
    directiveAssertions = buildFeedbackDirectiveAssertions(proposal, themeOverlayAss);
    if (directiveAssertions.length) {
      const receiptPath = writeDirectiveFidelityReceipt({
        videoPath: finalDest,
        assertions: directiveAssertions,
        feedback: proposal.feedback,
      });
      const allPassed = directiveAssertions.every((a) => a.passed);
      console.log(
        `[clip] directive-fidelity receipt ${allPassed ? 'passed' : 'FAILED'}: ${receiptPath}`,
      );
    }
  } catch (error) {
    console.warn(`[clip] directive-fidelity receipt failed closed: ${error.message}`);
  }
  // ExampleCo 2026-09-23 "Build with feedback": the owner's note is a required
  // directive bound into the build receipt. Free text no assertion measures
  // stays owner-review-required rather than being reported as verified.
  const buildDirective = buildDirectiveForBuild(proposal, directiveAssertions);
  if (buildDirective) {
    console.log(`[clip] owner build directive verification: ${buildDirective.verification}`);
  }

  const meta = {
    id: slug,
    proposalId: proposal.id,
    sourceUrl: proposal.clip_url || proposal.source_url,
    sourceTitle: proposal.source_title,
    sourceTimestampRange: woven ? woven.sourceRangeLabel : proposal.approx_timestamp,
    assembly: woven ? woven.wovenReceipt : wovenBuildReceipt({ mode: 'single', segments: [], bridges: [] }),
    buildDirective,
    format: '9:16',
    resolution: '1080x1920',
    durationSeconds: Math.round(totalDur),
    layout: renderPlan.version,
    videoTheme: theme,
    themeVersion: renderPlan.version,
    themeTreatment: renderPlan.fullBleedSource
      ? 'full-page authentic speaker with restrained overlays'
      : 'framed authentic speaker on softly treated source backdrop',
    brandPackage: {
      header: renderPlan.header,
      logoAsset: path.relative(REPO, EXAMPLECHANNEL_OUTLINE_LOGO),
      logoWidthPx: renderPlan.logoWidth,
      logoScaleFromExodus: 0.6,
      logoPosition,
      transitionVisual: renderPlan.transitionVisual,
      transitionSound: renderPlan.transitionSound,
      logoGlow: '126 px blurred halo at 0.74 alpha behind the crisp 90 px logo core',
    },
    channel: 'Examplechannel',
    status: 'pending_review',
    hookLines,
    closingLines,
    musicBed: musicFile,
    musicUsageScope,
    musicGain,
    musicVolumeMap: `${musicGain} constant bed; authentic source voice remains dominant (0-${totalDur}s)`,
    visualSource: 'authentic source footage from original video',
    sourceAcquisition: dl.sourceAcquisition
      ? {
          ...dl.sourceAcquisition,
          receiptPath: path.relative(REPO, dl.sourceAcquisition.receiptPath),
        }
      : null,
    sourceAcquisitions: woven
      ? woven.sourceAcquisitions.map((acq) => ({
          ...acq,
          receiptPath: acq.receiptPath ? path.relative(REPO, acq.receiptPath) : '',
        }))
      : undefined,
    decorativeBroll: false,
    faceFocusPlan,
    cameraMotion: faceFocusPlan.length
      ? 'restrained 1.008x-1.028x breathing push-in with <=8 px horizontal and <=5 px vertical drift'
      : 'historical fixed center cover crop',
    captionsWords: flagged.words.length,
    emphasisRate: flagged.emphasisRate,
    description:
      String(proposal.youtube_description || '').trim() ||
      `${proposal.insight || ''}\n\nSource: ${attribution}\nFull episode: ${proposal.source_url}`,
    tags:
      Array.isArray(proposal.youtube_tags) && proposal.youtube_tags.length
        ? proposal.youtube_tags
        : [attribution, 'tech', 'short'].filter(Boolean),
    fairUseNotes: `${woven ? `Woven from ${woven.builtSegments.length} source segments totaling` : 'Clip is'} ${clipDur}s out of source. Fair use is case-specific; captions, branding, and vertical reformatting alone may not add enough new commentary or meaning. Source link is included but does not create permission. Written source permission or materially stronger original commentary is recommended before public or monetized distribution. Commercial-song rights are separate.`,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(PENDING_DIR, slug + '.json'), JSON.stringify(meta, null, 2));
  proposal.built_at = meta.builtAt;
  proposal.built_artifact = path.relative(REPO, finalDest);
  proposal.built_layout = meta.layout;
  proposal.built_video_theme = theme;
  proposal.built_theme_version = renderPlan.version;
  proposal.built_music_gain = musicGain;
  proposal.built_music_usage_scope = musicUsageScope;
  proposal.built_logo_position = logoPosition;
  proposal.built_source_auth_mode = dl.sourceAcquisition?.sourceAuth?.mode || '';
  proposal.built_source_auth_provider = dl.sourceAcquisition?.sourceAuth?.provider || '';
  proposal.built_source_acquisition_receipt = dl.sourceAcquisition?.receiptPath
    ? path.relative(REPO, dl.sourceAcquisition.receiptPath)
    : '';
  delete proposal.built_source_acquisition_receipts;
  delete proposal.built_music_file;
  if (woven) {
    proposal.built_segments = woven.builtSegments;
    proposal.built_assembly = 'woven-multi-segment';
  }
  if (buildDirective) proposal.built_build_directive = buildDirective;
  // ExampleCo 2026-09-23: this composite path is the labeled fallback, never the
  // standard. The spine fallback passes its reason; a direct run says so.
  const scriptStandard = scriptBuildStandardFromArgs(args);
  proposal.built_build_standard = scriptStandard.standard;
  proposal.built_build_fallback_reason = scriptStandard.fallbackReason;
  proposal.built_build_task_id = scriptStandard.taskId || null;
  clearRepairMarkers(proposal);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log('[clip] DONE: ' + finalDest);

  // 2026-05-24 ExampleCo ask: queue the built clip in the unified Video
  // Approval Queue so it shows up alongside short000-short0NN entries.
  try {
    const manifestPath = path.join(PENDING_DIR, 'manifest.json');
    const videoFile = path.basename(finalDest);
    const thumbFile = path.basename(thumbnailDest);
    appendBuiltClipToManifest(manifestPath, proposal, videoFile, thumbFile, scriptStandard);
    console.log('[clip] queued in Video Approval Queue: ' + manifestPath);
  } catch (e) {
    console.warn('[clip] manifest append failed (clip still built, just not queued): ' + e.message);
  }
}

// 2026-05-24 ExampleCo ask: built viral clips must land in the unified Video
// Approval Queue (content-review/pending/manifest.json) so they appear
// alongside short000-short0NN entries for final approval. Before this,
// the build wrote content-review/pending/<slug>.{mp4,json} but never
// touched manifest.json, so approved viral clips were invisible to the
// dashboard queue. Idempotent: re-running the build on the same id
// updates the existing entry rather than duplicating it.
// Codex 2026-08-24 [high]: the repair marker must be terminalized by a build
// that actually produced an artifact, or the proposal outlives the problem.
function clearRepairMarkers(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const resolvedAt = new Date().toISOString();
  if (entry.status === 'build_failed' && entry.approved_at) entry.status = 'approved';
  const hadActiveRegen = Boolean(
    entry.video_rejection_note ||
    entry.video_needs_regen === true ||
    ['video_rejected', 'failed', 'rubric_failed', 'dead-letter', 'hard_blocked'].includes(
      String(entry.regen_status || entry.status || '').toLowerCase(),
    ),
  );
  if (hadActiveRegen) {
    if (entry.video_rejection_note) {
      entry.previous_feedback = entry.video_rejection_note;
      entry.fix_summary = entry.fix_summary || 'rebuilt and passed the viral-clip release gates.';
    }
    entry.video_rejection_note = null;
    entry.regen_status = 'done';
    entry.regen_completed_at = resolvedAt;
    entry.video_feedback_resolved_at = resolvedAt;
    entry.video_feedback_resolved_reason = 'successful viral clip rebuild';
  }
  delete entry.repair_required;
  delete entry.repair_proposal;
  delete entry.build_error;
  delete entry.build_failed_at;
  delete entry.regen_error;
  delete entry.regen_failed_at;
  delete entry.regen_overrides_error;
  delete entry.regen_hard_blocked;
  delete entry.regen_hard_block_reason;
  delete entry.regen_unaddressed_rejection;
  delete entry.regen_unaddressed_rejection_details;
  delete entry.regen_unaddressed_rejection_at;
  delete entry.regen_directives;
  entry.repair_resolved_at = resolvedAt;
  return entry;
}

// `standard` records which production standard made these bytes (ExampleCo
// 2026-09-23, scripts/lib/video-build-standard.js). A script build is always
// labeled deterministic-fallback; only --promote from a model session records
// model-session.
function appendBuiltClipToManifest(manifestPath, proposal, videoFile, thumbnailFile, standard) {
  const id = String(proposal.id || '').trim();
  if (!id) throw new Error('proposal.id required');
  if (!proposal.built_logo_position) {
    throw new Error('proposal.built_logo_position required for manifest provenance');
  }
  let manifest = { videos: [] };
  try {
    manifest = JSON.parse(require('fs').readFileSync(manifestPath, 'utf8'));
  } catch {
    /* missing or unreadable -- start fresh */
  }
  if (!Array.isArray(manifest.videos)) manifest.videos = [];
  const ix = manifest.videos.findIndex((v) => v && v.id === id);
  const title = packagedTitle(proposal) || proposal.insight || proposal.source_title || id;
  const channel = proposal.youtube_channel || 'Examplechannel';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const previous = ix >= 0 ? manifest.videos[ix] : {};
  const wasDurablyHeld = previous.status === 'held_missing_final';
  const entry = {
    ...previous,
    id,
    title: String(title).slice(0, 180),
    // The model-session promote path writes no sidecar description, so the
    // upload handoff reads these from the manifest row.
    ...(String(proposal.youtube_description || '').trim()
      ? { description: String(proposal.youtube_description).trim() }
      : {}),
    ...(Array.isArray(proposal.youtube_tags) && proposal.youtube_tags.length
      ? { tags: proposal.youtube_tags }
      : {}),
    channel,
    status: wasDurablyHeld ? 'held_missing_final' : 'pending_approval',
    source: 'viral_clip',
    video_file: videoFile,
    thumbnail_file: thumbnailFile,
    source_url: proposal.source_url || proposal.source_page_url || '',
    source_timestamp_range: proposal.approx_timestamp || '',
    ...(Array.isArray(proposal.built_segments) && proposal.built_segments.length > 1
      ? { source_segments: proposal.built_segments }
      : {}),
    ...(proposal.build_directive ? { build_directive: proposal.build_directive } : {}),
    authentic_source_only: true,
    video_theme: normalizeViralClipTheme(proposal.video_theme),
    video_theme_version: proposal.built_theme_version || VIRAL_CLIP_THEME_VERSION,
    logo_position: proposal.built_logo_position,
    music_gain: proposal.built_music_gain ?? null,
    music_usage_scope:
      proposal.built_music_usage_scope || proposal.music_usage_scope || 'approved-registry',
    source_auth_mode: proposal.built_source_auth_mode || '',
    source_auth_provider: proposal.built_source_auth_provider || '',
    source_acquisition_receipt: proposal.built_source_acquisition_receipt || '',
    ...(Array.isArray(proposal.built_source_acquisition_receipts) &&
    proposal.built_source_acquisition_receipts.length
      ? { source_acquisition_receipts: proposal.built_source_acquisition_receipts }
      : {}),
    ...(proposal.built_music_file ? { music_file: proposal.built_music_file } : {}),
    generated_date: today,
    synced_at: new Date().toISOString(),
    thumbnail_needs_regen: false,
  };
  stampBuildStandard(entry, standard || scriptBuildStandard(proposal));
  const textFitGate = applyVideoTextFitGate(
    entry,
    path.join(path.dirname(manifestPath), videoFile),
    { refreshBindings: true },
  );
  if (!textFitGate.ok) {
    console.warn(
      `[clip] approval promotion blocked by text-fit release gate: ${textFitGate.reason}`,
    );
    if (wasDurablyHeld) failVideoMissingFinalRelease(entry, textFitGate, new Date().toISOString());
    else entry.status = 'blocked_text_fit';
  } else if (!wasDurablyHeld) {
    entry.status = 'pending_approval';
  }
  entry.video_needs_regen = !textFitGate.ok;
  // Codex 2026-08-24: this entry spreads the PRIOR row forward, so a row that
  // had failed kept repair_required / build_error / repair_proposal and stayed
  // advertised as needing repair forever after a successful rebuild. A build
  // that produced an artifact terminalizes the repair; the failure history
  // stays only as build_attempts for forensics.
  if (textFitGate.ok) {
    releaseVideoMissingFinalHold(entry, new Date().toISOString(), textFitGate);
    clearRepairMarkers(entry);
  } else {
    entry.regen_status = 'failed';
    entry.regen_error = `text-fit release gate: ${textFitGate.code}: ${textFitGate.reason}`;
    entry.regen_failed_at = new Date().toISOString();
  }
  if (ix >= 0) manifest.videos[ix] = entry;
  else manifest.videos.push(entry);
  try {
    require('fs').mkdirSync(path.dirname(manifestPath), { recursive: true });
  } catch {
    /* fine */
  }
  require('fs').writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return entry;
}

function scriptBuildStandardFromArgs(args = {}, env = process.env) {
  return {
    standard: DETERMINISTIC_FALLBACK,
    taskId: String(args['task-id'] || env.SB_VIDEO_REGEN_TASK_ID || ''),
    fallbackReason: String(args['fallback-reason'] || DIRECT_SCRIPT_REASON).slice(0, 400),
  };
}

function scriptBuildStandard(proposal = {}) {
  return {
    standard: DETERMINISTIC_FALLBACK,
    taskId: proposal.built_build_task_id || '',
    fallbackReason: proposal.built_build_fallback_reason || DIRECT_SCRIPT_REASON,
  };
}

// A model-session build acquires its source through downloadRange exactly like
// a script build, so its promotion must carry the same secret-free acquisition
// receipts instead of an empty provenance row. Each receipt must have succeeded
// for this proposal's own source URL and name the acquired media hash.
function resolvePromotedSourceReceipts(list, proposal, repo = REPO) {
  const paths = String(list || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const sourceUrl = String(proposal.source_url || proposal.source_page_url || '');
  const clipDir = path.resolve(repo, 'data', 'viral-clip-builds', String(proposal.id || ''));
  const receipts = paths.map((p) => {
    const abs = path.resolve(repo, p);
    const name = path.basename(abs);
    if (path.dirname(abs) !== clipDir) {
      throw new Error(`promote refused: source receipt ${name} is not in this clip's build directory`);
    }
    let receipt;
    try {
      receipt = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch {
      throw new Error(`promote refused: unreadable source receipt ${name}`);
    }
    if (receipt.status !== 'succeeded') {
      throw new Error(`promote refused: source receipt ${name} is ${receipt.status || 'not succeeded'}`);
    }
    if (!sourceUrl || receipt.sourceUrl !== sourceUrl) {
      throw new Error(`promote refused: source receipt ${name} is for another source`);
    }
    const media = receipt.media || {};
    const mediaPath = media.file ? path.join(clipDir, path.basename(String(media.file))) : '';
    if (!mediaPath || !fs.existsSync(mediaPath) || sha256File(mediaPath) !== media.sha256) {
      throw new Error(`promote refused: source receipt ${name} does not match its acquired media`);
    }
    return {
      receiptPath: path.relative(repo, abs),
      mode: receipt.sourceAuth?.mode || '',
      provider: receipt.sourceAuth?.provider || '',
    };
  });
  const modes = new Set(receipts.map((r) => `${r.mode}|${r.provider}`));
  if (modes.size > 1) throw new Error('promote refused: source receipts disagree on source auth mode');
  return receipts;
}

// Music scope comes from the approved-music registry, never from the caller:
// an unregistered or unapproved track fails closed.
function resolvePromotedMusic(
  file,
  gain,
  registryPath = path.join(__dirname, '..', 'config', 'approved-music.json'),
) {
  if (!file) {
    if (gain !== undefined && gain !== '') throw new Error('promote refused: --music-gain needs --music');
    return null;
  }
  const name = path.basename(String(file));
  let registry = {};
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch {
    throw new Error('promote refused: approved-music registry unreadable');
  }
  const track = registry.tracks && registry.tracks[name];
  if (!track || track.ExampleCo_approval !== 'approved') {
    throw new Error(`promote refused: music ${name} is not an approved registry track`);
  }
  const g = gain === undefined || gain === '' ? null : Number(gain);
  if (g !== null && !(Number.isFinite(g) && g > 0 && g <= 4)) {
    throw new Error(`promote refused: music gain ${gain} is outside (0, 4]`);
  }
  return {
    file: name,
    gain: g,
    usageScope: String(track.approved_scope || 'approved-registry'),
  };
}

/**
 * The model session's sanctioned promotion path (ExampleCo 2026-09-23, one
 * standard). The session renders the clip with the video-production skill and
 * the benchmark-motion method in its own production directory, then calls
 *
 *   node scripts/build-viral-clip.js --promote --id <id> --date <date>
 *     --video <final.mp4> --thumbnail <thumb.jpg>
 *     [--source-receipts <a.source-acquisition.json,...>] [--music <file> --music-gain <n>]
 *
 * This copies the exact bytes, their SHA-bound `.text-fit.json` receipt and the
 * thumbnail into the approval queue and runs the same release gates a script
 * build runs: approved proposal, not tombstoned, registered theme,
 * authentic_source_only, and the text-fit gate against the copied bytes. It
 * never approves, uploads or posts. Returns the manifest entry; a failing gate
 * leaves the row blocked_text_fit and throws.
 */
function promoteModelBuild({
  args = {},
  env = process.env,
  pendingDir = PENDING_DIR,
  repo = REPO,
  tombstoneOpts = {},
} = {}) {
  const { proposal, statePath, state } = loadProposal(args);
  if (String(proposal.status || '') !== 'approved') {
    throw new Error(`promote refused: proposal ${proposal.id} is ${proposal.status || 'unapproved'}, not approved`);
  }
  if (isVideoDeleted({ id: proposal.id }, tombstoneOpts)) {
    throw new Error(`promote refused: ${proposal.id} was deleted by ExampleCo (tombstone)`);
  }
  const videoSrc = path.resolve(String(args.video || ''));
  const thumbSrc = path.resolve(String(args.thumbnail || ''));
  if (!args.video || !fs.existsSync(videoSrc)) throw new Error('promote needs --video <final.mp4> that exists');
  if (!args.thumbnail || !fs.existsSync(thumbSrc)) {
    throw new Error('promote needs --thumbnail <thumb.jpg> that exists');
  }
  const receiptSrc = `${videoSrc}.text-fit.json`;
  if (!fs.existsSync(receiptSrc)) {
    throw new Error(`promote refused: no text-fit receipt beside ${path.basename(videoSrc)}`);
  }
  const sourceReceipts = resolvePromotedSourceReceipts(args['source-receipts'], proposal, repo);
  const music = resolvePromotedMusic(args.music, args['music-gain'], args['music-registry'] || undefined);
  const theme = normalizeViralClipTheme(proposal.video_theme);
  const logoPosition = resolveLogoPosition(proposal);
  const slug = slugify(proposal.source + '_' + proposal.id);
  fs.mkdirSync(pendingDir, { recursive: true });
  const videoFile = `${slug}.mp4`;
  const thumbFile = `${slug}_thumb${path.extname(thumbSrc) || '.jpg'}`;
  const videoDest = path.join(pendingDir, videoFile);
  if (path.resolve(videoSrc) !== path.resolve(videoDest)) fs.copyFileSync(videoSrc, videoDest);
  const receiptDest = `${videoDest}.text-fit.json`;
  if (path.resolve(receiptSrc) !== path.resolve(receiptDest)) fs.copyFileSync(receiptSrc, receiptDest);
  const thumbDest = path.join(pendingDir, thumbFile);
  if (path.resolve(thumbSrc) !== path.resolve(thumbDest)) fs.copyFileSync(thumbSrc, thumbDest);

  const standard = {
    standard: MODEL_SESSION,
    taskId: String(args['task-id'] || env.SB_VIDEO_REGEN_TASK_ID || ''),
    model: String(args.model || env.SB_VIDEO_TASK_MODEL || ''),
    effort: String(args.effort || env.SB_VIDEO_TASK_EFFORT || ''),
  };
  proposal.video_theme = theme;
  proposal.built_at = new Date().toISOString();
  proposal.built_artifact = path.relative(repo, videoDest);
  proposal.built_video_theme = theme;
  proposal.built_theme_version = VIRAL_CLIP_THEME_VERSION;
  proposal.built_logo_position = logoPosition;
  proposal.built_build_standard = MODEL_SESSION;
  proposal.built_build_model = standard.model || null;
  proposal.built_build_effort = standard.effort || null;
  proposal.built_build_task_id = standard.taskId || null;
  delete proposal.built_build_fallback_reason;
  if (proposal.build_directive) proposal.built_build_directive = proposal.build_directive;
  // Never let a prior build's provenance describe these bytes.
  proposal.built_source_auth_mode = sourceReceipts[0]?.mode || '';
  proposal.built_source_auth_provider = sourceReceipts[0]?.provider || '';
  proposal.built_source_acquisition_receipt = sourceReceipts[0]?.receiptPath || '';
  proposal.built_source_acquisition_receipts = sourceReceipts.map((r) => r.receiptPath);
  proposal.built_music_file = music ? music.file : null;
  proposal.built_music_gain = music ? music.gain : null;
  delete proposal.built_music_usage_scope;
  if (music) proposal.built_music_usage_scope = music.usageScope;
  const entry = appendBuiltClipToManifest(
    path.join(pendingDir, 'manifest.json'),
    proposal,
    videoFile,
    thumbFile,
    standard,
  );
  if (entry.status !== 'pending_approval') {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    throw new Error(`promote blocked by the release gate: ${entry.regen_error || entry.status}`);
  }
  clearRepairMarkers(proposal);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return entry;
}

function scrubBuildError(error) {
  const rawProxy = String(process.env.VIRAL_SOURCE_PROXY_URL || '');
  const redactions = rawProxy ? [rawProxy] : [];
  try {
    const parsed = new URL(rawProxy);
    redactions.push(parsed.username, parsed.password);
  } catch {
    // A malformed proxy setting can itself be the build error. Never echo it.
  }
  return redactSensitiveText(error?.message || error || 'unknown build failure', redactions)
    .replace(/\bBearer\s+[^\s;,]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:access[_-]?token|api[_-]?key|token|key)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|token|password|secret|cookie|authorization|key)\s*[=:]\s*["']?[^\s;,"']+/gi,
      '$1=[redacted]',
    )
    .slice(0, 700);
}

// An approved clip is not allowed to disappear when the media build fails.
// Persist one durable repair receipt in both the proposal ledger and the same
// review manifest that owns successful clips. A later retry updates this row.
function recordBuildFailure({
  args = {},
  error,
  manifestPath = path.join(PENDING_DIR, 'manifest.json'),
  now = () => new Date(),
} = {}) {
  const { proposal, statePath, state, date } = loadProposal(args);
  const failedAt = now().toISOString();
  const buildError = scrubBuildError(error);
  const datedProposalFile = path.basename(statePath).match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1];
  const proposalDate =
    [state.date, args.date, datedProposalFile, args.proposal ? '' : date]
      .map((value) => String(value || ''))
      .find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)) || '';
  proposal.status = 'build_failed';
  proposal.build_failed_at = failedAt;
  proposal.build_error = buildError;
  proposal.build_attempts = Math.max(0, Number(proposal.build_attempts) || 0) + 1;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  let manifest = { videos: [] };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    // The repair receipt creates the queue if this is the first clip.
  }
  if (!Array.isArray(manifest.videos)) manifest.videos = [];
  const index = manifest.videos.findIndex((row) => row?.id === proposal.id);
  const prior = index >= 0 ? manifest.videos[index] : {};
  const entry = {
    ...prior,
    id: proposal.id,
    title: String(proposal.insight || proposal.source_title || proposal.id).slice(0, 180),
    channel: proposal.youtube_channel || 'Examplechannel',
    status: 'build_failed',
    source: 'viral_clip',
    source_url: proposal.source_url || proposal.source_page_url || '',
    video_theme: normalizeViralClipTheme(proposal.video_theme),
    video_theme_version: proposal.built_theme_version || VIRAL_CLIP_THEME_VERSION,
    generated_date: proposalDate || prior.generated_date || failedAt.slice(0, 10),
    proposal_date: proposalDate || prior.proposal_date || '',
    synced_at: failedAt,
    build_failed_at: failedAt,
    build_error: buildError,
    build_attempts: proposal.build_attempts,
    repair_required: true,
  };
  if (index >= 0) manifest.videos[index] = entry;
  else manifest.videos.push(entry);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return entry;
}

if (require.main === module && parseArgs(process.argv).promote === 'true') {
  try {
    const entry = promoteModelBuild({ args: parseArgs(process.argv) });
    console.log(`[clip] promoted model-session build ${entry.id} to pending_approval (${entry.video_sha256})`);
  } catch (e) {
    console.error('[clip] PROMOTE FAIL:', e.message);
    process.exit(1);
  }
} else if (require.main === module) {
  try {
    main();
  } catch (e) {
    try {
      recordBuildFailure({ args: parseArgs(process.argv), error: e });
      console.error('[clip] durable build_failed repair receipt recorded');
    } catch (receiptError) {
      console.error('[clip] could not record build failure:', receiptError.message);
    }
    console.error('[clip] FAIL:', e.message);
    process.exit(1);
  }
}

module.exports = {
  MUSIC_BED_LEVEL_FILTER,
  MUSIC_BED_LEVELED_FILES,
  parseTimestampRange,
  generateHookLines,
  attributionLabel,
  generateClosingLines,
  buildFeedbackDirectiveAssertions,
  slugify,
  pickMusic,
  selectMusicFromNames,
  resolveClipTailSeconds,
  shouldSnapClipEnd,
  resolveMusicGain,
  resolveLogoPosition,
  resolveLogoPlacement,
  LOGO_HALO_INSET,
  TEXT_FIT_SAFE_RECT,
  pickBroll,
  YT_DLP_SOURCE_FORMAT,
  YT_DLP_SOURCE_FORMAT_HLS,
  sourceFetchAttempts,
  sourceFetchTimeoutMs,
  reusableSourceArtifact,
  downloadRange,
  buildAuthenticLower,
  buildFullBleedSource,
  normalizeFaceFocusPlan,
  buildFaceAwareFullBleedFilter,
  buildThemeRenderPlan,
  generateThemeOverlayAss,
  cleanVttText,
  rollingTranscriptWords,
  fittedFontSize,
  vttCuesInRange,
  vttWordsInRange,
  distributeWordTimings,
  flagEmphasis,
  generateKaraokeAss,
  compositePodcastClip,
  assDialogueSamples,
  buildFfmpegTextFitSamples,
  renderedPixelBounds,
  appendBuiltClipToManifest,
  promoteModelBuild,
  resolvePromotedSourceReceipts,
  resolvePromotedMusic,
  scriptBuildStandardFromArgs,
  buildBridgeClip,
  concatWovenClips,
  wovenBuildReceipt,
  buildDirectiveForBuild,
  prepareWovenSource,
  createApprovalThumbnail,
  run,
  recordBuildFailure,
  clearRepairMarkers,
};
