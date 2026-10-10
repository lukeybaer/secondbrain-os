#!/usr/bin/env node
'use strict';

// Post one dashboard-approved video to the Examplechannel X account (ExampleCo,
// 2026-09-29: one X account only, @Examplechannel7; this replaced the
// 2026-09-25 two-account rule). Launched detached by POST /briefing/approve-video; safe to
// rerun by hand because the ledger makes an already-posted account a no-op.
//
//   node scripts/x-post-approved-video.js --id <video id> [--video <path>]

const fs = require('fs');
const path = require('path');
const { resolveCredential } = require('./lib/credential-broker');
const { postApprovedVideoToX, heldVideoIds, readLedger } = require('./lib/x-video-post');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR =
  process.env.SECONDBRAIN_DATA_DIR ||
  (process.platform === 'linux' ? '/opt/secondbrain/data' : path.join(ROOT, 'data'));
const MANIFEST_CANDIDATES = [
  process.env.VIDEO_APPROVAL_MANIFEST,
  '/opt/secondbrain/content-review/pending/manifest.json',
  path.join(ROOT, 'content-review', 'pending', 'manifest.json'),
].filter(Boolean);
const LEDGER = path.join(DATA_DIR, 'x', 'approved-video-posts.jsonl');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function loadApprovedVideo(id) {
  for (const file of MANIFEST_CANDIDATES) {
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const video = (manifest.videos || []).find((row) => row && row.id === id);
    if (video) return { video, dir: path.dirname(file) };
  }
  return { video: null, dir: null };
}

async function main() {
  const id = arg('--id');
  if (!id) throw new Error('usage: --id <video id>');
  const { video, dir } = loadApprovedVideo(id);
  if (!video) throw new Error(`video ${id} not found in the approval manifest`);
  if (String(video.status || '') !== 'approved') {
    throw new Error(`video ${id} is not approved; X posts only follow ExampleCo's approval`);
  }
  const videoPath = arg('--video') || path.join(dir, String(video.video_file || ''));
  const keys = [
    'apiKey',
    'apiSecret',
    'examplechannelAccessToken',
    'examplechannelAccessTokenSecret',
  ];
  const creds = Object.fromEntries(keys.map((key) => [key, resolveCredential('x', key).value]));
  const results = await postApprovedVideoToX({ video, videoPath, creds, ledgerFile: LEDGER });
  // Drain earlier approvals held by the daily cap, oldest first; the cap still
  // applies, so anything over it stays held for the next run.
  for (const heldId of heldVideoIds(readLedger(LEDGER)).filter((held) => held !== id)) {
    const held = loadApprovedVideo(heldId);
    if (!held.video || String(held.video.status || '') !== 'approved') continue;
    const heldPath = path.join(held.dir, String(held.video.video_file || ''));
    results.push(...(await postApprovedVideoToX({ video: held.video, videoPath: heldPath, creds, ledgerFile: LEDGER })));
  }
  console.log(JSON.stringify({ ok: results.every((r) => r.status !== 'failed'), id, results }, null, 2));
  if (results.some((r) => r.status === 'failed' || r.status === 'in_progress_elsewhere')) {
    process.exitCode = 1;
  }
}

// Every early failure (bad id, not approved, missing file or credential)
// leaves a ledger row so a silent failure cannot look like a post.
function recordRunFailure(id, error) {
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(
      LEDGER,
      `${JSON.stringify({ at: new Date().toISOString(), videoId: id || null, account: null, status: 'failed', error: String(error.message || error).slice(0, 400) })}\n`,
    );
  } catch {
    /* the log file still carries the error */
  }
}

if (require.main === module) {
  main().catch((error) => {
    recordRunFailure(arg('--id'), error);
    console.error(`[x-post-approved-video] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { loadApprovedVideo };
