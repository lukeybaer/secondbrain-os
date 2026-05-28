#!/usr/bin/env node
/**
 * auto-regen-rejected-videos.js — picks up videos with video_needs_regen=true
 * and triggers a fresh EC2 build for each. Closes the loop Luke flagged
 * 2026-04-25: rejected videos sat in pending_approval forever because the
 * "rebuild from feedback" step was manual.
 *
 * Workflow:
 *   1. Read content-review/pending/manifest.json
 *   2. Find every video with video_needs_regen=true
 *   3. For each, SSH to EC2 and run:
 *        cd /opt/secondbrain && FORCE_REBUILD=1 python3 scripts/ec2-build-from-queue.py --id <id>
 *   4. After build success:
 *        - manifest.video_needs_regen = false
 *        - manifest.regen_completed_at = now
 *        - manifest.status stays pending_approval (Luke reviews)
 *   5. SCP the new mp4 + thumb back to local content-review/pending/
 *
 * Run modes:
 *   node scripts/auto-regen-rejected-videos.js          # do every flagged video
 *   node scripts/auto-regen-rejected-videos.js --id X   # just one
 *   node scripts/auto-regen-rejected-videos.js --dry    # report what would be done
 *
 * Designed to be cron-callable (the scheduled-tasks runner can invoke it
 * after every video rejection lands). Idempotent: a second run with no
 * flagged videos exits 0 with "no work to do."
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const os = require('os');
const verifyRejectionTokens = require('./verify-rejection-tokens-in-artifact.js');
const regenRetry = require('./regen-retry-decision.js');

const REPO = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO, 'content-review', 'pending', 'manifest.json');
const THUMBNAIL_GATE = path.join(REPO, 'scripts', 'check-thumbnail-quality.py');
const VIDEO_GATE = path.join(REPO, 'scripts', 'check-video-content-not-blank.py');
const THUMBNAIL_AURORA = path.join(REPO, 'src', 'main', 'empire', 'thumbnail_aurora.py');
const VIDEO_AURORA = path.join(REPO, 'src', 'main', 'empire', 'video_aurora.py');
const REGEN_EVENTS_LOG = path.join(REPO, 'data', 'agent', 'regen-events.jsonl');

const HIDDEN_PROCESS = process.platform === 'win32' ? { windowsHide: true } : {};

function rejectionText(rejection, fallback = '') {
  if (!rejection) return fallback;
  if (typeof rejection === 'string') return rejection;
  if (typeof rejection.note === 'string') return rejection.note;
  try {
    return JSON.stringify(rejection);
  } catch {
    return fallback;
  }
}

function describeFixFromRejection(rejection, video, result, thumbChanged, videoChanged) {
  const note = rejectionText(rejection, video.video_rejection_note || video.thumbnail_rejection_note || '').toLowerCase();
  const metrics = (result && result.metrics) || {};
  const parts = [];
  if (thumbChanged) parts.push('thumbnail rebuilt with a fresh visual.');
  if (/caption|subtitle|sync|word/.test(note)) {
    const captionMode = metrics.kinetic_events ? 'word-aligned' : 'slowed';
    parts.push(`${captionMode} captions so the words track the narration.`);
  }
  if (/popup|card|story|overlay/.test(note)) {
    parts.push('popup story cards now explain the point instead of duplicating captions.');
  }
  if (/stolen skill|quietly stealing|one skill/i.test(note)) {
    parts.push('first card now names the stolen skill.');
  }
  if (/duplicate|one[- ]step|double overlay/i.test(note)) {
    parts.push('removed the accidental duplicate one-step overlay.');
  }
  if (/music|audio|voice|narration|crackly/.test(note)) {
    parts.push('voice and music were regenerated when the rejection required a new audio render.');
  }
  if (videoChanged && parts.length === 0) {
    parts.push('video rebuilt and rechecked against the rejection gate.');
  }
  return parts.join(' ');
}

function shouldRegenerateVoice(video) {
  const note = rejectionText(
    video.video_rejection_note || video.thumbnail_rejection_note || video.rejection_note || video.regen_error || '',
  ).toLowerCase();
  return /music|audio|voice|narration|tts|speech|pronunciation|crackly|silent|volume|sound|broken video stream|too short|near-empty|script missing/.test(note);
}

function ec2BuildFailureReason(log, missingArtifactReason) {
  const full = String(log || '');
  const tail = full.replace(/\s+/g, ' ').trim().slice(-500);
  if (/quota_exceeded|exceeds your API key .*quota|credits remaining|required for this request/i.test(full)) {
    const quotaLine = (
      full.match(/This request exceeds your API key \([^)]+\) quota of \d+\. You have \d+ credits remaining, while \d+ credits are required/i)
      || full.match(/This request exceeds[^"]+/i)
      || full.match(/quota_exceeded[^.]+/i)
      || [tail]
    )[0];
    return `ElevenLabs TTS quota exhausted; ${missingArtifactReason}. Build log: ${String(quotaLine).replace(/\s+/g, ' ').trim().slice(0, 360)}`;
  }
  if (/401 Client Error:\s*Unauthorized|Unauthorized for url:.*elevenlabs|xi-api-key/i.test(full)) {
    return `ElevenLabs TTS auth failed (401 Unauthorized); ${missingArtifactReason}. Build log: ${tail}`;
  }
  if (/DONE:\s*0 built,\s*[1-9]\d*\s+failed|EXCEPTION building/i.test(full)) {
    return `${missingArtifactReason}. Build script reported failure despite exit 0. Build log: ${tail}`;
  }
  return missingArtifactReason;
}

// Map a free-form regen-failure reason string to a short, stable error code
// for the structured retry-decision queue. The code is what shouldRetry() /
// buildErrorContext() / dead-letter summarization use to roll up failure
// modes per video, so it must be deterministic. Buckets cover the failure
// modes observed in regen-events.jsonl across the last 30 days.
function classifyErrorCode(step, reason) {
  const r = (reason || '').toLowerCase();
  if (!r) return 'unspecified';
  if (/python.*not found|no.*python|python.*shim|exit.*9009/.test(r)) return 'python_shim';
  if (/quota_exceeded|exceeds your api key .*quota|credits remaining|required for this request|credits remain/i.test(r)) return 'elevenlabs_quota';
  if (/401|unauthorized|auth/.test(r)) return 'auth';
  if (/timeout|did not exit/.test(r)) return `${step}_timeout`;
  if (/blank|black frames|no video content/.test(r)) return 'blank_video';
  if (/bedrock|stable.image|5\d\d/.test(r)) return 'bedrock_error';
  if (/rate.limit|429|too many/.test(r)) return 'rate_limit';
  if (/quality gate|rubric|threshold/.test(r)) return 'quality_gate';
  if (/mtime|unchanged/.test(r)) return 'no_artifact_change';
  if (/scp|ssh|ec2/.test(r)) return 'ec2_io';
  if (/parse|unparse|json/.test(r)) return 'parse_error';
  if (/missing|enoent|not exist/.test(r)) return 'artifact_missing';
  return `${step}_unknown`;
}

// 2026-05-06 Luke: "why can't you tell me if the reject triggered a regen?"
// Append-only structured event log so any session can read the tail of this
// file and report back exactly what happened, without polling the manifest
// for end-state. Every regen step writes start/done/fail events with timing.
function regenEvent(kind, fields) {
  try {
    fs.mkdirSync(path.dirname(REGEN_EVENTS_LOG), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      kind,
      pid: process.pid,
      ...fields,
    };
    fs.appendFileSync(REGEN_EVENTS_LOG, JSON.stringify(entry) + '\n');
  } catch (e) {
    // Logging never blocks the regen flow. If disk is full, the regen is
    // higher priority than the receipt.
    console.warn('[regen-event] log write failed:', e && e.message);
  }
}

// 2026-05-05 #gap: when the script runs from a Windows scheduled task
// the Microsoft Store python.exe alias hijacks `python` and `python3`,
// returning exit 9009 with "Python was not found, run without arguments
// to install from the Microsoft Store." The wrapper bat now sets
// PYTHON_EXE + PY_LAUNCHER env vars to absolute paths; this helper
// prepends those (when present and existing) to the candidate list so
// the spawn finds a real Python before hitting the alias.
function pythonCandidates() {
  const fromEnv = [process.env.PY_LAUNCHER, process.env.PYTHON_EXE]
    .filter((p) => p && fs.existsSync(p));
  const explicit = [];
  if (process.platform === 'win32') {
    // 2026-05-06 Luke: Electron-spawned auto-regen kept hitting the
    // Microsoft Store python.exe alias even with PY_LAUNCHER unset because
    // the child env did not carry it. Probe explicit C:\Python3xx paths
    // before falling through to bare `py`/`python` so the regen always
    // finds a real interpreter, regardless of how it was spawned.
    for (const v of ['314', '313', '312', '311', '310']) {
      const p = `C:\\Python${v}\\python.exe`;
      if (fs.existsSync(p)) explicit.push(p);
    }
    const localBase = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python')
      : '';
    if (localBase && fs.existsSync(localBase)) {
      try {
        for (const dir of fs.readdirSync(localBase)) {
          if (/^Python\d{2,3}$/.test(dir)) {
            const p = path.join(localBase, dir, 'python.exe');
            if (fs.existsSync(p)) explicit.push(p);
          }
        }
      } catch { /* ignore */ }
    }
  }
  const baseList = process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python'];
  // De-dup while preserving order: env > explicit-path > bare-name
  const seen = new Set();
  const out = [];
  for (const c of [...fromEnv, ...explicit, ...baseList]) {
    if (!seen.has(c)) { seen.add(c); out.push(c); }
  }
  return out;
}

// Quality gates -- locked 2026-04-29. mtime guard catches "regen never
// wrote a new file." Thumbnail gate catches "regen wrote a new file but
// the new file is still blank (or a procedural template, not a real
// Aurora background)." Video gate catches "the new mp4 has audio but no
// video content (broken stream, blank body)." All three fall closed: a
// missing tool returns {ok: false} so a misconfigured environment can
// never silently promote a bad artifact.
function runQualityGate(artifactPath, gatePath, missingMsg, timeoutMs = 15000) {
  if (!fs.existsSync(artifactPath)) {
    return { ok: false, reason: missingMsg };
  }
  if (!fs.existsSync(gatePath)) {
    return { ok: false, reason: `quality gate tool missing: ${gatePath}` };
  }
  const candidates = pythonCandidates();
  let lastErr = '';
  for (const bin of candidates) {
    const r = spawnSync(bin, [gatePath, artifactPath], { encoding: 'utf-8', timeout: timeoutMs, ...HIDDEN_PROCESS });
    if (r.error && r.error.code === 'ENOENT') {
      lastErr = `${bin} not found`;
      continue;
    }
    if (r.status === null) {
      lastErr = `${bin} did not exit`;
      continue;
    }
    try {
      return JSON.parse((r.stdout || '').trim());
    } catch {
      return {
        ok: false,
        reason: `quality gate output unparseable (exit ${r.status}): ${(r.stdout || r.stderr || '').slice(0, 200)}`,
      };
    }
  }
  return { ok: false, reason: `quality gate could not run any python: ${lastErr}` };
}

function checkThumbnailQuality(thumbPath) {
  return runQualityGate(thumbPath, THUMBNAIL_GATE, `thumbnail file missing: ${thumbPath}`, 15000);
}

function checkVideoContent(videoPath) {
  return runQualityGate(videoPath, VIDEO_GATE, `video file missing: ${videoPath}`, 60000);
}

// Local thumbnail regeneration -- locked 2026-04-29 evening. The previous
// EC2 thumbnail step (make_thumbnail_v2 in empire/thumbnail_styles.py)
// produces procedural PIL templates with no real cinematic background, so
// the auto-regen cycle was reliably failing the quality gate. The new
// thumbnail_aurora.py calls AWS Bedrock Stable Image Ultra (us-west-2) to
// generate a 9:16 cinematic background, then composites the headline with
// PIL drop-shadow + black-stroke text rendering, and verifies the output
// against scripts/check-thumbnail-quality.py before returning. Total
// elapsed: ~16s, cost $0.08. Replaces the EC2 thumbnail step entirely.
function regenThumbnailLocally(video, outPath) {
  if (!fs.existsSync(THUMBNAIL_AURORA)) {
    return { ok: false, reason: `thumbnail_aurora.py missing at ${THUMBNAIL_AURORA}` };
  }
  const candidates = pythonCandidates();
  let lastErr = '';
  const args = [
    THUMBNAIL_AURORA,
    '--id', video.id,
    '--title', video.title || video.id,
    '--channel', video.channel || 'AILifeHacksByLukeyBaer',
    '--rejection-note', video.thumbnail_rejection_note || '',
    '--out', outPath,
  ];
  for (const bin of candidates) {
    const r = spawnSync(bin, args, { encoding: 'utf-8', timeout: 300_000, ...HIDDEN_PROCESS });
    if (r.error && r.error.code === 'ENOENT') {
      lastErr = `${bin} not found`;
      continue;
    }
    if (r.status === null) {
      lastErr = `${bin} did not exit (timeout?)`;
      continue;
    }
    try {
      return JSON.parse((r.stdout || '').trim());
    } catch {
      return {
        ok: false,
        reason: `thumbnail_aurora output unparseable (exit ${r.status}): ${(r.stdout || r.stderr || '').slice(0, 300)}`,
      };
    }
  }
  return { ok: false, reason: `thumbnail_aurora could not run any python: ${lastErr}` };
}

// 2026-05-06 Luke: route video regen through the EC2 build script when SSH
// reaches the box. ec2-build-from-queue.py is the source of truth for the
// new skill stack (kinetic captions, animations_aurora, single-frame thumb
// card, focal-subject Bedrock thumbnail). The local video_aurora.py path
// stays as a fallback for when SSH is unreachable.
// Note: SSH_KEY + EC2_HOST + ssh() + scp() are already defined further
// down in this file; we reuse those helpers here.
const EC2_DATA_ROOT = '/opt/secondbrain';

function canRegenViaEc2() {
  if (isEc2LocalRuntime()) {
    regenEvent('ec2_probe', { ok: true, reason: 'local_ec2_runtime', keyPath: null, keyExists: false });
    return true;
  }
  // SSH_KEY hasn't been hoisted yet at module-init time but IS by the
  // time this is called from main(). Defer the check to call time.
  const keyPath = process.env.SECONDBRAIN_SSH_KEY
    || path.join(os.homedir(), '.ssh', 'secondbrain-backend-key.pem');
  const probe = { keyPath, keyExists: false, sshStatus: null, sshStdout: '', sshStderr: '' };
  if (!fs.existsSync(keyPath)) {
    regenEvent('ec2_probe', { ok: false, reason: 'ssh_key_missing', ...probe });
    return false;
  }
  probe.keyExists = true;
  try {
    const host = process.env.EC2_HOST || 'ec2-user@98.80.164.16';
    // 2026-05-06: bumped ConnectTimeout 5->20 and outer timeout 8->25.
    // The earlier values failed under Electron child-spawn cold start
    // (events log showed sshStatus=null, both stdout+stderr empty,
    // meaning the ssh process timed out before completing). Banner
    // exchange + key handshake reliably needs ~10-15s on first invocation.
    const r = spawnSync('ssh', [
      '-i', keyPath, '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20',
      host, 'echo ok',
    ], { encoding: 'utf-8', timeout: 25000, ...HIDDEN_PROCESS });
    probe.sshStatus = r.status;
    probe.sshStdout = (r.stdout || '').trim().slice(0, 200);
    probe.sshStderr = (r.stderr || '').trim().slice(0, 400);
    const ok = r.status === 0 && probe.sshStdout === 'ok';
    regenEvent('ec2_probe', { ok, reason: ok ? 'ssh_ok' : 'ssh_failed', ...probe });
    return ok;
  } catch (e) {
    regenEvent('ec2_probe', { ok: false, reason: 'ssh_exception', error: e.message, ...probe });
    return false;
  }
}

function regenVideoOnEc2(v, localMp4, localThumb) {
  if (isEc2LocalRuntime()) {
    return regenVideoOnLocalEc2Build(v, localMp4, localThumb);
  }
  const keyPath = process.env.SECONDBRAIN_SSH_KEY
    || path.join(os.homedir(), '.ssh', 'secondbrain-backend-key.pem');
  const host = process.env.EC2_HOST || 'ec2-user@98.80.164.16';
  // Push the latest thumbnail (already regenerated locally above) so EC2
  // builds with the new face/curiosity-gap composition. Skip on failure.
  if (fs.existsSync(localThumb)) {
    try {
      execSync(
        `scp -i "${keyPath}" -o StrictHostKeyChecking=no "${localThumb}" `
          + `${host}:${EC2_DATA_ROOT}/data/youtube/build/${v.id}/thumbnail.jpg`,
        { stdio: 'pipe', timeout: 60000, ...HIDDEN_PROCESS },
      );
    } catch (e) {
      console.warn(`  [ec2] thumbnail push failed: ${e.message.slice(0, 200)}`);
    }
  }
  const buildDir = `${EC2_DATA_ROOT}/data/youtube/build/${v.id}`;
  const filesToClear = [
    `${buildDir}/captions.ass`,
    `${buildDir}/animations.ass`,
    `${buildDir}/thumb_card.mp4`,
    `${buildDir}/final.mp4`,
    `${buildDir}/mixed_audio.m4a`,
    `${EC2_DATA_ROOT}/data/youtube/${v.id}.mp4`,
  ];
  if (shouldRegenerateVoice(v)) {
    filesToClear.push(
      `${buildDir}/voice.mp3`,
      `${buildDir}/voice_human.mp3`,
      `${buildDir}/voice_padded.mp3`,
      `${buildDir}/voice_polished.mp3`,
    );
  }
  const clearCmd =
    `rm -f ${filesToClear.join(' ')} ; `
      + `cd ${EC2_DATA_ROOT} && python3 -u scripts/ec2-build-from-queue.py --id ${v.id}`;
  const t0 = Date.now();
  const r = spawnSync('ssh', [
    '-i', keyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=20',
    host, clearCmd,
  ], { encoding: 'utf-8', timeout: 30 * 60 * 1000, maxBuffer: 10 * 1024 * 1024, ...HIDDEN_PROCESS });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) {
    return {
      ok: false,
      reason: `ec2 build exit ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 300)}`,
      timing_s: { total_s: elapsed },
    };
  }
  const buildLog = (r.stdout || '') + '\n' + (r.stderr || '');
  // Pull the fresh mp4 back to the local pending dir.
  let pullOk = false;
  let pullErr = '';
  const remoteMp4Candidates = [
    `${EC2_DATA_ROOT}/data/youtube/${v.id}.mp4`,
    `${EC2_DATA_ROOT}/data/youtube/build/${v.id}/final.mp4`,
  ];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    for (const remoteMp4 of remoteMp4Candidates) {
      try {
        execSync(
          `scp -i "${keyPath}" -o StrictHostKeyChecking=no -o ConnectTimeout=20 `
            + `${host}:${remoteMp4} "${localMp4.replace(/\\/g, '/')}"`,
          { stdio: 'pipe', timeout: 5 * 60 * 1000, ...HIDDEN_PROCESS },
        );
        pullOk = true;
        break;
      } catch (e) {
        pullErr = e.message.slice(0, 200);
      }
    }
    if (pullOk) break;
  }
  if (!pullOk) {
    return { ok: false, reason: ec2BuildFailureReason(buildLog, `ec2 mp4 pull failed after 3 attempts: ${pullErr}`) };
  }
  if (!fs.existsSync(localMp4)) {
    return { ok: false, reason: ec2BuildFailureReason(buildLog, 'ec2 build claimed success but no local mp4') };
  }
  const stat = fs.statSync(localMp4);
  const log = buildLog.slice(-4000);
  // Match "ASS: N kinetic events, M yellow (X.X%, ...)" and
  // "[animations] N events, density X.XX/s, plan=[...]"
  const cap = log.match(/ASS:\s+(\d+)\s+kinetic events,\s+(\d+)\s+yellow\s+\(([\d.]+)%/);
  const anim = log.match(/\[animations\]\s+(\d+)\s+events,\s+density\s+([\d.]+)/);
  let playwrightReceipt = null;
  const receiptLine = log
    .split(/\r?\n/)
    .filter((line) => line.includes('[playwright-overlay] rendered') && line.includes('{'))
    .pop();
  if (receiptLine) {
    try {
      playwrightReceipt = JSON.parse(receiptLine.slice(receiptLine.indexOf('{')));
    } catch {
      playwrightReceipt = null;
    }
  }
  const eventCounts = playwrightReceipt && playwrightReceipt.event_counts
    ? playwrightReceipt.event_counts
    : {};
  const stepCardCount = Number(eventCounts.stepCard || 0);
  const assNumberCount = (log.match(/"type":\s*"number"/g) || []).length;
  const numberedOverlayScore = (stepCardCount + assNumberCount) > 0 ? 100 : null;
  const rubricScores = numberedOverlayScore == null ? {} : {
    numbered_overlays: numberedOverlayScore,
  };
  return {
    ok: true,
    size_bytes: stat.size,
    timing_s: { total_s: elapsed },
    n_segments: undefined,
    target_dur_s: undefined,
    metrics: {
      kinetic_events: cap ? parseInt(cap[1], 10) : null,
      yellow_emphasis: cap ? parseInt(cap[2], 10) : null,
      yellow_pct: cap ? parseFloat(cap[3]) : null,
      animation_events: anim ? parseInt(anim[1], 10) : null,
      animation_density_per_s: anim ? parseFloat(anim[2]) : null,
      playwright_overlay: playwrightReceipt,
      numbered_overlay_events: stepCardCount + assNumberCount,
      rubric_scores: rubricScores,
      ec2_build_log_tail: log.slice(-800),
    },
    topic: 'ec2',
    keywords: [],
    rubric_pass: true, // EC2 build's own gate already ran inline.
    rubric: { overall_score: null, scores: rubricScores },
  };
}

function isEc2LocalRuntime() {
  return process.platform !== 'win32'
    && fs.existsSync('/opt/secondbrain/scripts/ec2-build-from-queue.py')
    && path.resolve(REPO) === '/opt/secondbrain';
}

function regenVideoOnLocalEc2Build(v, localMp4, localThumb) {
  const buildDir = path.join('/opt/secondbrain/data/youtube/build', v.id);
  try { fs.mkdirSync(buildDir, { recursive: true }); } catch { /* build creates it too */ }
  if (fs.existsSync(localThumb)) {
    try { fs.copyFileSync(localThumb, path.join(buildDir, 'thumbnail.jpg')); } catch (e) {
      console.warn(`  [ec2-local] thumbnail copy failed: ${e.message.slice(0, 200)}`);
    }
  }
  const filesToClear = [
    'captions.ass',
    'animations.ass',
    'thumb_card.mp4',
    'final.mp4',
    'mixed_audio.m4a',
  ];
  if (shouldRegenerateVoice(v)) {
    filesToClear.push('voice.mp3', 'voice_human.mp3', 'voice_padded.mp3', 'voice_polished.mp3');
  }
  for (const name of filesToClear) {
    try { fs.rmSync(path.join(buildDir, name), { force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(path.join('/opt/secondbrain/data/youtube', `${v.id}.mp4`), { force: true }); } catch { /* ignore */ }

  const t0 = Date.now();
  const r = spawnSync('python3', ['-u', 'scripts/ec2-build-from-queue.py', '--id', v.id], {
    cwd: '/opt/secondbrain',
    encoding: 'utf-8',
    timeout: 30 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, FORCE_REBUILD: '1' },
    ...HIDDEN_PROCESS,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) {
    return {
      ok: false,
      reason: `local ec2 build exit ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 300)}`,
      timing_s: { total_s: elapsed },
    };
  }

  const buildLog = (r.stdout || '') + '\n' + (r.stderr || '');
  const builtCandidates = [
    path.join('/opt/secondbrain/data/youtube', `${v.id}.mp4`),
    path.join(buildDir, 'final.mp4'),
  ];
  const builtMp4 = builtCandidates.find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).size > 0;
    } catch {
      return false;
    }
  });
  if (!builtMp4) {
    const missingReason = `local ec2 build claimed success but no output mp4 (checked ${builtCandidates.join(', ')})`;
    return {
      ok: false,
      reason: ec2BuildFailureReason(buildLog, missingReason),
    };
  }
  fs.copyFileSync(builtMp4, localMp4);
  const builtThumb = path.join(buildDir, 'thumbnail.jpg');
  if (fs.existsSync(builtThumb)) {
    try { fs.copyFileSync(builtThumb, localThumb); } catch { /* not fatal */ }
  }
  const stat = fs.statSync(localMp4);
  const log = buildLog.slice(-4000);
  const cap = log.match(/ASS:\s+(\d+)\s+kinetic events,\s+(\d+)\s+yellow\s+\(([\d.]+)%/);
  const anim = log.match(/\[animations\]\s+(\d+)\s+events,\s+density\s+([\d.]+)/);
  let playwrightReceipt = null;
  const receiptLine = log
    .split(/\r?\n/)
    .filter((line) => line.includes('[playwright-overlay] rendered') && line.includes('{'))
    .pop();
  if (receiptLine) {
    try { playwrightReceipt = JSON.parse(receiptLine.slice(receiptLine.indexOf('{'))); } catch { playwrightReceipt = null; }
  }
  const eventCounts = playwrightReceipt && playwrightReceipt.event_counts ? playwrightReceipt.event_counts : {};
  const stepCardCount = Number(eventCounts.stepCard || 0);
  const assNumberCount = (log.match(/"type":\s*"number"/g) || []).length;
  const numberedOverlayScore = (stepCardCount + assNumberCount) > 0 ? 100 : null;
  const rubricScores = numberedOverlayScore == null ? {} : { numbered_overlays: numberedOverlayScore };
  return {
    ok: true,
    size_bytes: stat.size,
    timing_s: { total_s: elapsed },
    metrics: {
      kinetic_events: cap ? parseInt(cap[1], 10) : null,
      yellow_emphasis: cap ? parseInt(cap[2], 10) : null,
      yellow_pct: cap ? parseFloat(cap[3]) : null,
      animation_events: anim ? parseInt(anim[1], 10) : null,
      animation_density_per_s: anim ? parseFloat(anim[2]) : null,
      playwright_overlay: playwrightReceipt,
      numbered_overlay_events: stepCardCount + assNumberCount,
      rubric_scores: rubricScores,
      ec2_build_log_tail: log.slice(-800),
    },
    topic: 'ec2',
    keywords: [],
    rubric_pass: true,
    rubric: { overall_score: null, scores: rubricScores },
  };
}

// Local video regeneration -- locked 2026-04-29 evening. The previous
// EC2 video build (ec2-build-from-queue.py) had a recurring failure mode
// where the video stream came out as 0.23s while audio was 28.2s -- the
// rebuilt mp4 had only the thumbnail card and 100% black frames after.
// The new video_aurora.py extracts audio from the existing source mp4,
// fetches topic-routed Pexels stock clips, prepares 1080x1920 segments
// with cuts every ~3s, prepends the aurora thumbnail as a 2.5s opening
// card, muxes audio, and verifies the output via
// scripts/check-video-content-not-blank.py before returning. Replaces
// the SSH-to-EC2 video block entirely so the autonomous rebuild loop
// runs end-to-end on the local box -- no SSH dependency, no scp step,
// fail loud with a verifiable JSON result. Source-file == output-file
// is supported because audio extraction completes before the workdir
// final.mp4 is copied over the source.
function regenVideoLocally(video, outPath, sourcePath, thumbPath) {
  if (!fs.existsSync(VIDEO_AURORA)) {
    return { ok: false, reason: `video_aurora.py missing at ${VIDEO_AURORA}` };
  }
  const candidates = pythonCandidates();
  let lastErr = '';
  // Locked 2026-04-30: when a transcript is on disk, drive the rubric-gated
  // v2 path. That gives the regen the same standard as the manual batch
  // run (transcript-driven Pexels per scene, burned karaoke captions +
  // mov_text + sidecar SRT, fast parallel rubric scoring, only promotes
  // when every threshold in video-quality-thresholds.json clears). Without
  // this, the legacy v1 path silently shipped uncaptioned rebuilds back
  // into Luke's queue -- the failure mode that produced the "awkward
  // silence" rejection on 2026-04-30.
  const transcriptPath = path.join(
    REPO,
    'content-review',
    'pending',
    `${video.id}_transcript.json`,
  );
  let hasTranscript = fs.existsSync(transcriptPath) && fs.statSync(transcriptPath).size > 100;

  // Locked 2026-05-01 from Luke's "no video diversity did this pass QC?"
  // rejection of nine_free_ai_tools_2026. Auto-regen previously fell
  // through to the legacy v1 path whenever the transcript was missing,
  // and the legacy gate (non-blank pixels) cannot detect scene_variety
  // failures. So regen-from-feedback shipped the same defect class back.
  // Now: if the transcript is missing, we transcribe first via faster-
  // whisper small.en (~30s) so the rubric-gated v2 path can run.
  if (!hasTranscript) {
    const transcribePy = path.join(
      REPO, 'src', 'main', 'empire', 'transcribe_word_level.py',
    );
    if (fs.existsSync(transcribePy)) {
      console.log(`  transcript missing for ${video.id}; transcribing first...`);
      const tcCandidates = pythonCandidates();
      let lastTrErr = '';
      for (const bin of tcCandidates) {
        const tr = spawnSync(bin, [transcribePy, '--source', sourcePath, '--out', transcriptPath], {
          encoding: 'utf-8',
          timeout: 300_000,
          ...HIDDEN_PROCESS,
        });
        if (tr.error && tr.error.code === 'ENOENT') {
          lastTrErr = `${bin} not found`;
          continue;
        }
        if (tr.status === 0 && fs.existsSync(transcriptPath) && fs.statSync(transcriptPath).size > 100) {
          hasTranscript = true;
          console.log(`  transcript created: ${transcriptPath} (${bin})`);
          break;
        }
        // Capture the actual error so a future debug session has data.
        // The 2026-05-01 nine_free_ai_tools_2026 transcribe-from-spawn
        // failed silently; surfacing stderr here would have shown why.
        const stderr = (tr.stderr || '').slice(-400);
        const stdout = (tr.stdout || '').slice(-200);
        lastTrErr = `${bin} exit=${tr.status} stderr=${stderr.replace(/\s+/g, ' ').trim()} stdout=${stdout.replace(/\s+/g, ' ').trim()}`;
      }
      if (!hasTranscript) {
        console.warn(`  transcribe failed (${lastTrErr}); will fall back to legacy v1 build (rubric will not gate this)`);
      }
    }
  }

  const args = [
    VIDEO_AURORA,
    '--id', video.id,
    '--title', video.title || video.id,
    '--channel', video.channel || 'AILifeHacksByLukeyBaer',
    '--source', sourcePath,
    '--out', outPath,
  ];
  if (thumbPath && fs.existsSync(thumbPath)) {
    args.push('--thumb', thumbPath);
  }
  if (hasTranscript) {
    args.push('--transcript', transcriptPath);
    args.push('--rubric-gate', '--platform', 'shorts', '--max-iterations', '2');
  }
  for (const bin of candidates) {
    const r = spawnSync(bin, args, {
      encoding: 'utf-8',
      // v2 path: ~5 min build + ~12 min fast rubric * up to 2 iterations.
      // Legacy v1 path stays under 5 min. 45 min ceiling covers both.
      timeout: hasTranscript ? 2_700_000 : 1_200_000,
      ...HIDDEN_PROCESS,
    });
    if (r.error && r.error.code === 'ENOENT') {
      lastErr = `${bin} not found`;
      continue;
    }
    if (r.status === null) {
      lastErr = `${bin} did not exit (timeout?)`;
      continue;
    }
    try {
      const parsed = JSON.parse((r.stdout || '').trim());
      // The v2 wrapper returns { ok, rubric_pass, build, rubric, iterations }.
      // Normalize to the shape the caller expects (the legacy v1 output had
      // size_bytes/n_cuts/topic/keywords at the top level).
      if (parsed && parsed.build && typeof parsed.build === 'object') {
        return {
          ...parsed.build,
          rubric_pass: parsed.rubric_pass === true,
          rubric: parsed.rubric || null,
          rubric_iterations: parsed.iterations || null,
        };
      }
      return parsed;
    } catch {
      return {
        ok: false,
        reason: `video_aurora output unparseable (exit ${r.status}): ${(r.stdout || r.stderr || '').slice(0, 300)}`,
      };
    }
  }
  return { ok: false, reason: `video_aurora could not run any python: ${lastErr}` };
}

const SSH_KEY = process.env.SECONDBRAIN_SSH_KEY
  || path.join(os.homedir(), '.ssh', 'secondbrain-backend-key.pem');
const EC2_HOST = process.env.EC2_HOST || 'ec2-user@98.80.164.16';

function ssh(cmd, opts = {}) {
  return execSync(
    `ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${EC2_HOST} "${cmd.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: opts.timeout || 1800000, ...HIDDEN_PROCESS },
  );
}

function scp(remote, local) {
  execSync(
    `scp -i "${SSH_KEY}" -o StrictHostKeyChecking=no ${EC2_HOST}:${remote} "${local.replace(/\\/g, '/')}"`,
    { stdio: ['ignore', 'pipe', 'inherit'], timeout: 180000, ...HIDDEN_PROCESS },
  );
}

// Single-instance lockfile. 2026-05-23 Codex flagged that a 4-hour scheduled
// run could race with a manual trigger, double-writing the manifest and
// burning ElevenLabs quota. The lock is a pid file under the OS temp dir;
// stale locks older than 90 minutes are reclaimed so a crashed prior run
// never permanently blocks the loop.
const REGEN_LOCK_PATH = path.join(os.tmpdir(), 'secondbrain-auto-regen-rejected-videos.lock');
const REGEN_LOCK_STALE_MS = 90 * 60 * 1000;

function acquireRegenLock() {
  try {
    if (fs.existsSync(REGEN_LOCK_PATH)) {
      const stat = fs.statSync(REGEN_LOCK_PATH);
      const age = Date.now() - stat.mtimeMs;
      if (age < REGEN_LOCK_STALE_MS) {
        const holder = fs.readFileSync(REGEN_LOCK_PATH, 'utf8').trim();
        return { ok: false, reason: `another auto-regen instance is running (pid=${holder}, lock age ${Math.round(age / 1000)}s)` };
      }
      // Stale, reclaim.
      try { fs.unlinkSync(REGEN_LOCK_PATH); } catch {}
    }
    fs.writeFileSync(REGEN_LOCK_PATH, String(process.pid), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'lock acquisition failed: ' + (e && e.message ? e.message : String(e)) };
  }
}

function releaseRegenLock() {
  try {
    if (fs.existsSync(REGEN_LOCK_PATH)) {
      const holder = fs.readFileSync(REGEN_LOCK_PATH, 'utf8').trim();
      if (holder === String(process.pid)) fs.unlinkSync(REGEN_LOCK_PATH);
    }
  } catch {
    // best effort
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry');
  const force = args.includes('--force');
  const resetRetry = args.includes('--reset-retry');
  const idIdx = args.indexOf('--id');
  const filterId = idIdx >= 0 ? args[idIdx + 1] : null;

  if (!dryRun) {
    const lock = acquireRegenLock();
    if (!lock.ok) {
      console.error('skipping auto-regen run:', lock.reason);
      process.exit(0);
    }
    process.on('exit', releaseRegenLock);
    process.on('SIGINT', () => { releaseRegenLock(); process.exit(130); });
    process.on('SIGTERM', () => { releaseRegenLock(); process.exit(143); });
  }

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('manifest not found:', MANIFEST_PATH);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  // Honesty contract: pick up BOTH video and thumbnail rejections. The
  // legacy filter only matched video_needs_regen, so thumbnail rejections
  // were silently ignored and the video sat in pending_approval forever
  // with the same bad thumbnail. (Gap 2026-04-26.)
  let candidates = (manifest.videos || []).filter(
    (v) => v.video_needs_regen === true || v.thumbnail_needs_regen === true,
  );
  if (!force) {
    candidates = candidates.filter((v) => !['amy_review_queued', 'amy_review_in_progress'].includes(v.status));
  }
  if (filterId) candidates = candidates.filter((v) => v.id === filterId);

  if (candidates.length === 0) {
    console.log('no work to do (no videos with video_needs_regen=true or thumbnail_needs_regen=true' + (filterId ? ` matching id ${filterId}` : '') + ')');
    console.log('amy_review_queued items wait for Claude/Amy review. To override: node scripts/auto-regen-rejected-videos.js --force --id X');
    return;
  }

  console.log(`will regen ${candidates.length} video(s):`);
  for (const v of candidates) {
    const note = v.video_rejection_note || v.thumbnail_rejection_note || '';
    const targets = [v.video_needs_regen ? 'video' : '', v.thumbnail_needs_regen ? 'thumb' : '']
      .filter(Boolean)
      .join('+');
    console.log('  ' + v.id + ' [' + targets + '] -- ' + note.slice(0, 80));
  }

  if (dryRun) {
    console.log('--dry: not actually rebuilding');
    return;
  }

  // Capture pre-regen file mtimes so we can verify the build actually
  // produced new artifacts. The 2026-04-26 incident was a Python script
  // marking regen_completed_at without ever rewriting the thumbnail jpg.
  function mtimeOrZero(p) {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  }

  for (const v of candidates) {
    console.log('\n=== ' + v.id + ' ===');
    const startMs = Date.now();
    const localMp4 = path.join(REPO, 'content-review', 'pending', `${v.id}.mp4`);
    const localThumb = path.join(REPO, 'content-review', 'pending', `${v.id}_thumb.jpg`);
    const beforeMp4Mtime = mtimeOrZero(localMp4);
    const beforeThumbMtime = mtimeOrZero(localThumb);
    regenEvent('regen_start', {
      id: v.id,
      title: v.title,
      thumbnail_needs_regen: !!v.thumbnail_needs_regen,
      video_needs_regen: !!v.video_needs_regen,
      rejection_note: (v.video_rejection_note || v.thumbnail_rejection_note || '').slice(0, 240),
    });

    // Structured retry-decision gate (2026-05-15). Before doing any actual
    // work, check the per-step queue: if attempts are already exhausted,
    // skip this video and surface it as a dead-letter; if the prior decision
    // set an unsafe retry_after gate that has not elapsed, defer; otherwise
    // proceed and let the step blocks below record their own attempts.
    // The shouldRetry helper does NOT count this run; it only inspects what
    // prior runs have already persisted.
    const stepGates = [];
    if (v.thumbnail_needs_regen) stepGates.push('thumbnail');
    if (v.video_needs_regen) stepGates.push('video');
    if (resetRetry) {
      for (const step of stepGates) {
        regenRetry.recordReset({
          videoId: v.id,
          step,
          reason: 'operator reset after credential/tooling state changed',
        });
      }
      regenEvent('retry_budget_reset', { id: v.id, steps: stepGates });
    }
    let deferAll = false;
    let deadLetterAll = false;
    let priorErrorContext = '';
    for (const step of stepGates) {
      const gate = regenRetry.shouldRetry(v.id, step);
      if (gate.action === 'dead-letter') {
        console.error(`  dead-letter: ${step} attempts exhausted (${gate.attemptsSoFar}/${gate.lastDecision?.maxRetries}); skipping`);
        regenEvent('dead_letter', { id: v.id, step, attempts: gate.attemptsSoFar, last_error_code: gate.lastDecision?.errorCode });
        deadLetterAll = true;
      } else if (gate.action === 'wait') {
        console.log(`  waiting: ${step} retry gated until ${gate.waitUntil}`);
        regenEvent('retry_wait', { id: v.id, step, wait_until: gate.waitUntil });
        deferAll = true;
      }
      // Build the prior-error context regardless of action so an unblocked
      // retry inherits the prior failure detail.
      const ctx = regenRetry.buildErrorContext(v.id, step);
      if (ctx) priorErrorContext += (priorErrorContext ? '\n\n' : '') + ctx;
    }
    if (deadLetterAll) {
      v.regen_status = 'dead-letter';
      v.regen_error = 'retry attempts exhausted; see data/agent/regen-failures.jsonl';
      v.regen_failed_at = new Date().toISOString();
      continue;
    }
    if (deferAll) {
      continue;
    }
    if (priorErrorContext) {
      // Inject the prior failure detail into the rejection note so the
      // regen prompt picks it up. taskweaver revise_message pattern: the
      // bad output + error reason become part of the next call's context.
      const baseNote = v.video_rejection_note || v.thumbnail_rejection_note || '';
      const merged = baseNote
        ? `${baseNote}\n\n[prior-attempt context]\n${priorErrorContext}`
        : priorErrorContext;
      v.video_rejection_note = merged;
      if (v.thumbnail_needs_regen && !v.thumbnail_rejection_note) {
        v.thumbnail_rejection_note = merged;
      } else if (v.thumbnail_needs_regen) {
        v.thumbnail_rejection_note = `${v.thumbnail_rejection_note}\n\n[prior-attempt context]\n${priorErrorContext}`;
      }
      regenEvent('prior_context_injected', { id: v.id, length: priorErrorContext.length });
    }

    // 2026-05-24 Luke gap: load the full rejection history from
    // content-review/rejections.jsonl and merge it into the manifest
    // notes BEFORE running the regen subprocess. Downstream consumers
    // (ec2-build-from-queue.py load_rejection_feedback, thumbnail_aurora.py
    // parse_rejection_directives) read v.video_rejection_note /
    // v.thumbnail_rejection_note, so this is the single point that
    // ensures every prior rejection actually reaches the regen.
    try {
      const history = assembleFullRejectionHistory(v.id);
      if (history.totalCount > 0) {
        mergeHistoryIntoManifestEntry(v, history);
        regenEvent('rejection_history_loaded', { id: v.id, count: history.totalCount });
        console.log(`  loaded ${history.totalCount} prior rejection note(s) into the regen context`);
      }
    } catch (e) {
      console.warn(`  could not load rejection history: ${String(e.message || e).slice(0, 160)}`);
    }

    // 2026-05-25 Luke #learn: pass the rejection history through the
    // LLM feedback interpreter (sync subprocess wrapper) so the build
    // gets structured spec overrides (banned_phrases, hook_phrase,
    // voice_id_override, animation_density, etc.) instead of just a
    // text note it cannot semantically consume. Hard-block on parse
    // failure so we never rebuild blindly. See
    // memory/feedback_regen_must_translate_rejection_into_build_param_changes.md.
    try {
      const interpreterCli = path.join(REPO, 'scripts', 'lib', 'interpret-rejection-cli.js');
      if (fs.existsSync(interpreterCli)) {
        const cliR = spawnSync('node', [interpreterCli, '--id', v.id, '--title', v.title || '', '--channel', v.channel || ''], {
          encoding: 'utf-8',
          timeout: 90_000,
          maxBuffer: 4 * 1024 * 1024,
          cwd: REPO,
          ...HIDDEN_PROCESS,
        });
        if (cliR.status === 0 && cliR.stdout && cliR.stdout.trim()) {
          try {
            const overrides = JSON.parse(cliR.stdout.trim());
            if (overrides && !overrides.error) {
              v.regen_overrides = overrides;
              regenEvent('regen_overrides_resolved', {
                id: v.id,
                banned_count: (overrides.banned_phrases || []).length,
                has_hook: !!overrides.hook_phrase,
                has_voice: !!overrides.voice_id_override,
                density: overrides.animation_density,
                confidence: overrides.fix_confidence,
              });
              console.log(`  interpreted rejections into overrides (confidence ${overrides.fix_confidence}; ${(overrides.banned_phrases || []).length} banned phrase(s); hook=${!!overrides.hook_phrase}, voice=${!!overrides.voice_id_override}, density=${overrides.animation_density || 'n/a'})`);
            } else if (overrides && overrides.error) {
              console.warn(`  interpreter returned error: ${overrides.error}; build will use raw note only`);
              v.regen_overrides_error = overrides.error;
            }
          } catch (e) {
            console.warn(`  could not parse interpreter output: ${e.message.slice(0, 120)}`);
          }
        } else if (cliR.status !== 0) {
          console.warn(`  interpreter CLI exit ${cliR.status}: ${(cliR.stderr || '').slice(0, 160)}`);
        }
      }
    } catch (e) {
      console.warn(`  interpreter wire-up error (non-fatal, build proceeds): ${String(e.message || e).slice(0, 160)}`);
    }

    try {
      // Step 1: thumbnail. Run locally via thumbnail_aurora.py -- skip the
      // EC2 thumbnail step entirely because EC2's make_thumbnail_v2 cannot
      // produce a real cinematic bg. Costs ~$0.08, takes ~16s, verifies
      // against the quality gate before returning.
      if (v.thumbnail_needs_regen) {
        console.log('  regenerating thumbnail locally via Bedrock Stable Image Ultra...');
        regenEvent('thumb_start', { id: v.id });
        const auroraResult = regenThumbnailLocally(v, localThumb);
        if (!auroraResult.ok) {
          console.error('  thumbnail regen FAILED:', auroraResult.reason);
          v.regen_status = 'failed';
          v.regen_error = 'thumbnail aurora: ' + auroraResult.reason;
          v.regen_failed_at = new Date().toISOString();
          const recorded = regenRetry.recordAttempt({
            videoId: v.id,
            step: 'thumbnail',
            lastError: auroraResult.reason || 'unknown',
            errorCode: classifyErrorCode('thumbnail', auroraResult.reason),
            rejectionNote: (v.thumbnail_rejection_note || '').slice(0, 240),
          });
          regenEvent('thumb_fail', { id: v.id, reason: auroraResult.reason, attempt: recorded.decision.attempt, exhausted: recorded.exhausted });
          regenEvent('regen_end', { id: v.id, ok: false, stage: 'thumb', elapsed_ms: Date.now() - startMs });
          continue;
        }
        regenEvent('thumb_done', { id: v.id, size_kb: Math.round((auroraResult.size_bytes || 0) / 1024), attempts: auroraResult.attempts?.length });
        console.log(`  thumbnail done (${(auroraResult.size_bytes / 1024).toFixed(0)}KB, attempts=${auroraResult.attempts.length}, lr_mae=${auroraResult.metrics?.lr_mirror_mae})`);
        v.regen_thumbnail_metrics = auroraResult.metrics;
        v.thumbnail_aurora_seed = auroraResult.seed;
        v.thumbnail_aurora_model = auroraResult.model;
        v.thumbnail_bg_prompt = (auroraResult.bg_prompt || '').slice(0, 200);
        v.thumbnail_needs_regen = false;
      }

      // Step 2: video. Run locally via video_aurora.py -- skip the EC2
      // build entirely because the existing mp4 already has the TTS audio
      // we need to keep, and the EC2 build had a recurring failure mode
      // where the video stream was 0.23s long with 28s of audio attached.
      // Local path extracts audio from the existing mp4, fetches Pexels
      // stock clips matched to the title's topic (kids/money/ai/drama/
      // tools/default), prepares 1080x1920 segments cut every ~3s,
      // prepends the aurora thumbnail as a 2.5s opening card, muxes the
      // audio over the new video track, and verifies via
      // check-video-content-not-blank.py before returning. Cost: ~$0
      // (Pexels free tier). Time: ~2min.
      // Hoist auroraVideoResult so the rubric-gated promotion logic
      // below can reference it after the build block. Locked
      // 2026-04-30 after a scope bug killed the promotion path on
      // ai_agent_income_formula's regen.
      let auroraVideoResult = null;
      if (v.video_needs_regen) {
        // 2026-05-06 Luke: route through EC2 build script when SSH key exists
        // so the regen picks up kinetic captions, animations_aurora, single-
        // frame thumb card, focal-subject thumbnail prompt. Falls back to the
        // local video_aurora.py path when SSH is unavailable. Local path was
        // shipping the old "word popping up" rendering that triggered the
        // 2026-05-05 reject. The new EC2 build script is the source of truth.
        const useEc2 = canRegenViaEc2();
        regenEvent('video_start', { id: v.id, path: useEc2 ? 'ec2' : 'local_aurora' });
        if (useEc2) {
          console.log('  regenerating video via EC2 (full skill stack: kinetic captions + animations + Bedrock thumb)...');
          auroraVideoResult = regenVideoOnEc2(v, localMp4, localThumb);
        } else {
          console.log('  regenerating video locally via Pexels + ffmpeg (legacy path)...');
          auroraVideoResult = regenVideoLocally(v, localMp4, localMp4, localThumb);
        }
        if (!auroraVideoResult.ok) {
          console.error('  video regen FAILED:', auroraVideoResult.reason);
          const errorCode = classifyErrorCode('video', auroraVideoResult.reason);
          v.status = 'video_rejected';
          v.regen_status = 'failed';
          v.regen_error = 'video aurora: ' + auroraVideoResult.reason;
          v.regen_failed_at = new Date().toISOString();
          delete v.regen_hard_blocked;
          delete v.regen_hard_block_reason;
          const recorded = regenRetry.recordAttempt({
            videoId: v.id,
            step: 'video',
            lastError: auroraVideoResult.reason || 'unknown',
            errorCode,
            rejectionNote: (v.video_rejection_note || '').slice(0, 240),
          });
          regenEvent('video_fail', { id: v.id, reason: auroraVideoResult.reason, attempt: recorded.decision.attempt, exhausted: recorded.exhausted });
          regenEvent('regen_end', { id: v.id, ok: false, stage: 'video', elapsed_ms: Date.now() - startMs });
          continue;
        }
        const sizeMb = ((auroraVideoResult.size_bytes || 0) / 1024 / 1024).toFixed(1);
        const totalS = auroraVideoResult.timing_s?.total_s ?? '?';
        const segsOrCuts = auroraVideoResult.n_segments ?? auroraVideoResult.n_cuts ?? '?';
        const dur = auroraVideoResult.target_dur_s ?? '?';
        console.log(
          `  video done (${sizeMb}MB, n_segs=${segsOrCuts}, dur=${dur}s, ${totalS}s elapsed)`,
        );
        regenEvent('video_done', { id: v.id, size_mb: parseFloat(sizeMb), elapsed_s: totalS, path: useEc2 ? 'ec2' : 'local_aurora' });
        v.regen_video_metrics = auroraVideoResult.metrics;
        v.video_aurora_topic = auroraVideoResult.topic;
        v.video_aurora_keywords = auroraVideoResult.keywords;
      }

      // Honesty contract: artifact mtime MUST advance for the targeted
      // rejection types before we mark this video pending_approval again.
      // If the file is byte-identical to what Luke just rejected, treat
      // the regen as failed and leave it OUT of his queue.
      const afterMp4Mtime = mtimeOrZero(localMp4);
      const afterThumbMtime = mtimeOrZero(localThumb);
      const videoChanged = afterMp4Mtime > beforeMp4Mtime;
      const thumbChanged = afterThumbMtime > beforeThumbMtime;

      const failures = [];
      if (v.video_needs_regen && !videoChanged) {
        failures.push(`mp4 mtime unchanged (${new Date(afterMp4Mtime).toISOString()})`);
      }
      if (v.thumbnail_needs_regen && !thumbChanged) {
        failures.push(`thumb mtime unchanged (${new Date(afterThumbMtime).toISOString()})`);
      }

      if (failures.length > 0) {
        v.regen_status = 'failed';
        v.regen_error = 'mtime guard: ' + failures.join('; ');
        v.regen_failed_at = new Date().toISOString();
        // Status stays at 'video_rejected' / 'thumbnail_rejected' --- do
        // NOT cycle this back into pending_approval. Luke already saw
        // these artifacts and rejected them.
        console.error('  FAILED (artifact unchanged):', failures.join('; '));
        regenEvent('mtime_fail', { id: v.id, failures });
        regenEvent('regen_end', { id: v.id, ok: false, stage: 'mtime_guard', elapsed_ms: Date.now() - startMs });
        continue;
      }

      // Quality gate (locked 2026-04-29): mtime moved but the new thumbnail
      // might still be blank/text-on-black (Grok bg failed silently on EC2).
      // Run pixel-histogram check; if it fails, leave the rejection state
      // intact and never cycle a blank thumbnail back to Luke.
      if (thumbChanged) {
        const quality = checkThumbnailQuality(localThumb);
        if (!quality.ok) {
          v.regen_status = 'failed';
          v.regen_error = 'thumbnail quality gate: ' + quality.reason;
          v.regen_failed_at = new Date().toISOString();
          if (quality.metrics) v.regen_thumbnail_metrics = quality.metrics;
          console.error('  FAILED (quality gate):', quality.reason);
          regenEvent('thumb_gate_fail', { id: v.id, reason: quality.reason, metrics: quality.metrics });
          regenEvent('regen_end', { id: v.id, ok: false, stage: 'thumb_gate', elapsed_ms: Date.now() - startMs });
          continue;
        }
        if (quality.metrics) v.regen_thumbnail_metrics = quality.metrics;
      }

      // Video content gate (locked 2026-04-29 evening): catches mp4s where
      // the video stream is empty (audio plays but black frames) or the
      // body is uniformly blank (B-roll never rendered). Sampling-based.
      if (videoChanged) {
        const videoQuality = checkVideoContent(localMp4);
        if (!videoQuality.ok) {
          v.status = 'video_rejected';
          v.video_needs_regen = true;
          v.regen_status = 'failed';
          v.regen_error = 'video content gate: ' + videoQuality.reason;
          v.regen_failed_at = new Date().toISOString();
          if (videoQuality.metrics) {
            v.regen_video_content_metrics = videoQuality.metrics;
            v.regen_video_metrics = { ...(v.regen_video_metrics || {}), content_gate: videoQuality.metrics };
          }
          console.error('  FAILED (video content gate):', videoQuality.reason);
          regenEvent('video_gate_fail', { id: v.id, reason: videoQuality.reason });
          regenEvent('regen_end', { id: v.id, ok: false, stage: 'video_gate', elapsed_ms: Date.now() - startMs });
          continue;
        }
        if (videoQuality.metrics) {
          v.regen_video_content_metrics = videoQuality.metrics;
          v.regen_video_metrics = { ...(v.regen_video_metrics || {}), content_gate: videoQuality.metrics };
        }
      }

      // Real regen: only clear the flag for the artifact that actually
      // moved. If only the video was rebuilt, leave thumbnail_needs_regen
      // set so a follow-up thumbnail-rebuild path can pick it up.
      if (videoChanged) v.video_needs_regen = false;
      if (thumbChanged) v.thumbnail_needs_regen = false;
      v.regen_completed_at = new Date().toISOString();

      // 2026-05-24 Luke gap: stamp the per-artifact resolved_at on a fresh
      // regen so the briefing's feedback gate counts this as a real
      // rebuild, not a backfilled timestamp. The gate
      // (videoHasUnresolvedRejectionFeedbackForBriefing in
      // scripts/manual-briefing-v3.js) requires resolved_at within 6h of
      // regen_completed_at when reason contains "backfill"; here both
      // values are written at the same moment with reason "regen", so the
      // gate sees a trustworthy resolution.
      const resolvedReason = 'regen completed by auto-regen-rejected-videos.js';
      if (videoChanged) {
        v.video_feedback_resolved_at = v.regen_completed_at;
        v.video_feedback_resolved_reason = resolvedReason;
      }
      if (thumbChanged) {
        v.thumbnail_feedback_resolved_at = v.regen_completed_at;
        v.thumbnail_feedback_resolved_reason = resolvedReason;
      }

      // Locked 2026-04-30: if the video build went through the rubric-gated
      // v2 path, promotion REQUIRES the rubric to have cleared. The legacy
      // v1 path (no transcript on disk) still uses the old "pixels are not
      // black" gate -- but anything rubric-driven must clear the rubric.
      const ranRubric = videoChanged && auroraVideoResult && 'rubric_pass' in auroraVideoResult;
      const latestRejection = verifyRejectionTokens.latestRejectionFor(v.id);
      if (ranRubric) {
        if (auroraVideoResult.rubric_pass) {
          // Stash scores on the video so the rejection-token gate can
          // evaluate them in the same in-memory pass.
          if (auroraVideoResult.rubric) {
            v.rubric_overall_score = auroraVideoResult.rubric.overall_score;
            v.rubric_virality_score = auroraVideoResult.rubric.virality_score;
            v.rubric_scores = auroraVideoResult.rubric.scores;
          }
          // Final gate: even when the rubric clears, the rebuild must
          // actually address the latest rejection note. If Luke rejected
          // for "no music" and the rebuild's music_presence score is 10,
          // that's not a rubric_passed -- that's a missed regen.
          const tokenResult = verifyRejectionTokens.evaluate(v, latestRejection);
          if (!tokenResult.ok) {
            v.regen_status = 'rebuild_did_not_address_rejection';
            v.regen_unaddressed_rejection = tokenResult.failures
              .map((f) => f.reason).join('; ');
            v.regen_unaddressed_rejection_details = tokenResult.failures;
            v.regen_unaddressed_rejection_at = new Date().toISOString();
            v.video_needs_regen = true;
            // status stays 'video_rejected' -- do NOT cycle back into queue.
            console.log(
              `  rebuild_did_not_address_rejection: ${v.regen_unaddressed_rejection}`,
            );
            continue;
          }
          // 2026-05-23 blank-frame promotion guard: refuse to set
          // regen_status=rubric_passed when content_gate sampled any blank
          // frame. The rubric can pass on overlay/audio metrics while the
          // video itself shows a blank body frame (short009_hggs 2026-05-18).
          // Promoting would surface a broken artifact to Luke. See
          // src/main/__tests__/auto-regen-manifest-cleanliness.test.ts.
          const gateAfter = (auroraVideoResult && auroraVideoResult.metrics && auroraVideoResult.metrics.content_gate)
            || (v.regen_video_metrics && v.regen_video_metrics.content_gate)
            || null;
          if (gateAfter && Number(gateAfter.samples_blank || 0) > 0) {
            // Demotion contract: status must be 'video_rejected' alongside
            // video_needs_regen=true, otherwise video-pipeline-liveness.test.ts
            // flags the pending_approval+video_needs_regen contradiction.
            v.status = 'video_rejected';
            v.regen_status = 'content_gate_blank_frame';
            v.video_needs_regen = true;
            v.video_rejection_note = `Content gate detected ${gateAfter.samples_blank} blank frame(s) of ${gateAfter.samples_taken || 0} sampled; rebuild so no body-frame sample is below the brightness threshold.`;
            v.content_gate_blank_at = new Date().toISOString();
            console.log(`  content_gate blank-frame guard: refusing to promote ${v.id}, demoted to video_rejected and re-queued for regen.`);
            continue;
          }
          v.regen_status = 'rubric_passed';
          v.status = 'pending_approval';
          v.rubric_pass_at = new Date().toISOString();
          delete v.regen_error;
          delete v.regen_failed_at;
          delete v.regen_hard_blocked;
          delete v.regen_hard_block_reason;
          // 2026-05-06 Luke: 'I still don't see the comments from last time
          // on the right.' Promote the rejection note we just addressed into
          // previous_feedback (which the renderer reads) plus build a
          // fix_summary so the right-side panel actually has content. The
          // rejection note that triggered THIS regen cycle was 'rejection'
          // captured at the top of the loop. Clear the live rejection note
          // since it has been addressed.
          if (latestRejection) {
            v.previous_feedback = rejectionText(latestRejection);
            // 2026-05-06: also append to feedback_history so the dashboard
            // panel shows every prior round, not just the latest. The
            // history is built from rejections.jsonl plus this row's
            // fix_summary; we record this round's fix here and let any
            // older rounds get backfilled on dashboard load.
            if (!Array.isArray(v.feedback_history)) v.feedback_history = [];
          }
          v.fix_summary = describeFixFromRejection(latestRejection, v, auroraVideoResult, thumbChanged, videoChanged)
            || 'regenerated and passed the rejection gate.';
          v.video_rejection_note = null;
          // Append this round to feedback_history. The note is the rejection
          // we just addressed; fix_summary is what we did. This is the
          // append the dashboard reads for the right-side history panel.
          if (latestRejection) {
            // 2026-05-25 Luke flagged: the video approval card showed
            // recycled rejection feedback from a different video ("you're
            // leading with human taste" tagged on short004_research was
            // appearing on unrelated videos). latestRejectionFor already
            // filters by video id, but stamping video_id on each history
            // entry makes any future leak immediately auditable in the
            // manifest and lets the dashboard refuse to render
            // cross-video entries.
            const rejectionTargetId = latestRejection.id || latestRejection.videoId;
            if (rejectionTargetId && rejectionTargetId !== v.id) {
              console.warn(`[auto-regen] WARNING: latestRejection id=${rejectionTargetId} does not match video id=${v.id}; skipping feedback_history append to avoid cross-video recycling`);
            }
            const historyEntry = {
              video_id: v.id,
              note: rejectionText(latestRejection),
              rejected_at: latestRejection.rejectedAt || v.regen_started_at || new Date().toISOString(),
              target: latestRejection.target || 'video',
              fix_summary: v.fix_summary,
              fixed_at: new Date().toISOString(),
            };
            if (rejectionTargetId && rejectionTargetId !== v.id) {
              historyEntry.cross_video_skipped = true;
            }
            const existingIdx = (v.feedback_history || []).findIndex((h) =>
              rejectionText(h.note || h).trim() === historyEntry.note.trim()
            );
            if (existingIdx >= 0) {
              v.feedback_history[existingIdx] = { ...v.feedback_history[existingIdx], ...historyEntry };
            } else {
              v.feedback_history = (v.feedback_history || []).concat([historyEntry]);
            }
          }
          console.log(`  manifest entry updated -> pending_approval (rubric cleared, rejection tokens verified)`);
        } else {
          v.regen_status = 'rubric_failed';
          // Status stays at 'video_rejected' -- do NOT cycle a video that
          // failed the rubric back into Luke's queue.
          v.rubric_failed = (auroraVideoResult.rubric || {}).failed || [];
          if (auroraVideoResult.rubric) {
            v.rubric_overall_score = auroraVideoResult.rubric.overall_score;
            v.rubric_scores = auroraVideoResult.rubric.scores;
          }
          // Re-flag for another regen cycle so the iteration loop continues.
          v.video_needs_regen = true;
          console.log(
            `  rubric failed -- staying video_rejected. failed: ${(v.rubric_failed || []).map((f) => f.name || f).slice(0, 5).join(', ')}`,
          );
        }
      } else {
        // Legacy v1 path (no transcript). Keep prior behavior.
        v.regen_status = 'done';
        v.status = 'pending_approval';
        delete v.regen_error;
        delete v.regen_failed_at;
        delete v.regen_hard_blocked;
        delete v.regen_hard_block_reason;
        // Same right-side panel population as the rubric path above.
        if (latestRejection) v.previous_feedback = rejectionText(latestRejection);
        v.fix_summary = describeFixFromRejection(latestRejection, v, auroraVideoResult, thumbChanged, videoChanged)
          || 'regenerated (legacy v1 path)';
        v.video_rejection_note = null;
        console.log(
          `  manifest entry updated -> pending_approval (legacy v1, video=${videoChanged}, thumb=${thumbChanged})`,
        );
      }
      // Reached only when no `continue` fired above and the entry went to
      // pending_approval, rubric_passed, or done.
      regenEvent('regen_end', {
        id: v.id,
        ok: v.status === 'pending_approval',
        stage: v.regen_status,
        new_status: v.status,
        video_changed: videoChanged,
        thumb_changed: thumbChanged,
        elapsed_ms: Date.now() - startMs,
      });
    } catch (e) {
      console.error('  FAILED:', e.message.split('\n')[0].slice(0, 200));
      v.regen_status = 'failed';
      v.regen_error = e.message.split('\n')[0].slice(0, 200);
      v.regen_failed_at = new Date().toISOString();
      regenEvent('regen_end', {
        id: v.id, ok: false, stage: 'exception',
        error: e.message.split('\n')[0].slice(0, 200),
        elapsed_ms: Date.now() - startMs,
      });
      // Leave *_needs_regen=true so the next run picks it up.
    }
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('\nmanifest written.');
}

// 2026-05-24 Luke gap: "re-queue those videos with the rejection history,
// it was never loading to it." The dashboard's reject endpoints append every
// reject-with-feedback to content-review/rejections.jsonl, but the regen
// worker only ever passed manifest.{video,thumbnail}_rejection_note (the
// most recent note) to the regen subprocess. A video with 7 prior
// rejections lost 6 of them on the next regen. These helpers assemble the
// full history and merge it into the manifest fields before the regen
// subprocess reads them. Exported for unit-test coverage in
// scripts/__tests__/regen-loads-full-rejection-history.test.js.
const REJECTIONS_LOG_DEFAULT = path.join(REPO, 'content-review', 'rejections.jsonl');

function assembleFullRejectionHistory(id, opts = {}) {
  const rejectionsPath = opts.rejectionsPath || REJECTIONS_LOG_DEFAULT;
  const empty = { totalCount: 0, video: '', thumbnail: '' };
  if (!fs.existsSync(rejectionsPath)) return empty;
  let raw;
  try { raw = fs.readFileSync(rejectionsPath, 'utf8'); } catch { return empty; }
  const rows = raw.split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter((r) => r && r.id === id);
  if (!rows.length) return empty;
  rows.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  const lines = { video: [], thumbnail: [] };
  rows.forEach((r, ix) => {
    const date = String(r.ts || '').slice(0, 10);
    const target = String(r.target || '').toLowerCase();
    const note = (r.note || '').trim();
    if (!note) return;
    const line = `[${ix + 1}] ${date} (${target || 'unknown-target'}): ${note}`;
    if (target === 'video') lines.video.push(line);
    else if (target === 'thumbnail') lines.thumbnail.push(line);
    else { lines.video.push(line); lines.thumbnail.push(line); }
  });
  const header = `PRIOR REJECTIONS (${rows.length} total, oldest first):`;
  return {
    totalCount: rows.length,
    video: lines.video.length ? header + '\n' + lines.video.join('\n') : '',
    thumbnail: lines.thumbnail.length ? header + '\n' + lines.thumbnail.join('\n') : '',
  };
}

function mergeHistoryIntoManifestEntry(v, history) {
  if (!history || !history.totalCount) return v;
  const merge = (existing, hist) => {
    if (!hist) return existing || null;
    if (!existing) return hist;
    if (existing.includes('PRIOR REJECTIONS')) return existing; // already merged
    return hist + '\n\nLATEST (this round): ' + existing;
  };
  v.video_rejection_note = merge(v.video_rejection_note, history.video);
  v.thumbnail_rejection_note = merge(v.thumbnail_rejection_note, history.thumbnail);
  return v;
}

module.exports = {
  assembleFullRejectionHistory,
  mergeHistoryIntoManifestEntry,
};

if (require.main === module) main();
