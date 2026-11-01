#!/usr/bin/env node
'use strict';

// Post one dashboard-approved video to the Examplechannel X account (The owner,
// 2026-09-29: one X account only, @Examplechannel7; this replaced the
// 2026-09-25 two-account rule). Launched detached by POST /briefing/approve-video; safe to
// rerun by hand because the ledger makes an already-posted account a no-op.
//
//   node scripts/x-post-approved-video.js --id <video id> [--video <path>] [--owner-now <reason>]
//
// --owner-now is the owner's explicit "post it now" (owner-video-control's
// publish-now): this one video skips the daily cap. Held drains never do.

const fs = require('fs');
const path = require('path');
const { resolveCredential } = require('./lib/credential-broker');
const { postApprovedVideoToX, heldVideoIds, readLedger, xStillNeedsVideo, DEFAULT_LEDGER_FILE } = require('./lib/x-video-post');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_CANDIDATES = [
  process.env.VIDEO_APPROVAL_MANIFEST,
  '/opt/secondbrain/content-review/pending/manifest.json',
  path.join(ROOT, 'content-review', 'pending', 'manifest.json'),
].filter(Boolean);
const LEDGER = DEFAULT_LEDGER_FILE;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

// Approved, or already on YouTube (the upload flips approved to posted). A
// cap-held video was stuck forever once YouTube posted it (2026-10-22).
const X_POSTABLE = new Set(['approved', 'posted']);

function loadApprovedVideo(id) {
  for (const file of MANIFEST_CANDIDATES) {
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const video = (manifest.videos || []).find((row) => row && row.id === id);
    if (video) return { video, dir: path.dirname(file) };
  }
  return { video: null, dir: null };
}

// YouTube already posted and settled this video, and the staging copy was
// kept only for X: once X has it too, the staged copy goes. The manifest is
// read again here, never trusted from the start of the run (YouTube may have
// settled meanwhile). An explicit --video path (a build output) is never touched.
function releaseStagedVideo(id, stagedPath, { ledgerFile = LEDGER, load = loadApprovedVideo } = {}) {
  const { video } = load(id);
  if (!video || String(video.status || '') !== 'posted' || xStillNeedsVideo(readLedger(ledgerFile), id)) return false;
  try {
    fs.unlinkSync(stagedPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const id = arg('--id');
  if (!id) throw new Error('usage: --id <video id>');
  const { video, dir } = loadApprovedVideo(id);
  if (!video) throw new Error(`video ${id} not found in the approval manifest`);
  if (!X_POSTABLE.has(String(video.status || ''))) {
    throw new Error(`video ${id} is not approved; X posts only follow the owner's approval`);
  }
  const stagedPath = path.join(dir, String(video.video_file || ''));
  const videoPath = arg('--video') || stagedPath;
  const keys = [
    'apiKey',
    'apiSecret',
    'examplechannelAccessToken',
    'examplechannelAccessTokenSecret',
  ];
  const creds = Object.fromEntries(keys.map((key) => [key, resolveCredential('x', key).value]));
  const ownerNow = arg('--owner-now');
  const results = await postApprovedVideoToX({ video, videoPath, creds, ledgerFile: LEDGER, ownerNow });
  releaseStagedVideo(id, stagedPath);
  // Drain earlier approvals held by the daily cap, oldest first; the cap still
  // applies, so anything over it stays held for the next run.
  for (const heldId of heldVideoIds(readLedger(LEDGER)).filter((held) => held !== id)) {
    const held = loadApprovedVideo(heldId);
    if (!held.video || !X_POSTABLE.has(String(held.video.status || ''))) continue;
    const heldPath = path.join(held.dir, String(held.video.video_file || ''));
    // One unpostable held video (its file gone) never aborts the drain; it is
    // recorded, the rest still drain, and the run then reports failure.
    // Publish-now reads its own video's row, so its post still counts.
    try {
      results.push(...(await postApprovedVideoToX({ video: held.video, videoPath: heldPath, creds, ledgerFile: LEDGER })));
      releaseStagedVideo(heldId, heldPath);
    } catch (error) {
      results.push(recordHeldUnpostable(heldId, error));
    }
  }
  console.log(JSON.stringify({ ok: results.every((r) => r.status !== 'failed' && r.status !== 'held_unpostable'), id, results }, null, 2));
  if (results.some((r) => ['failed', 'in_progress_elsewhere', 'held_unpostable'].includes(r.status))) {
    process.exitCode = 1;
  }
}

// A held video that cannot post (file gone) gets one durable ledger row, so
// video status shows it; it stays held and posts if the file comes back.
function recordHeldUnpostable(videoId, error, ledgerFile = LEDGER) {
  const row = { at: new Date().toISOString(), videoId, account: null, status: 'held_unpostable', error: String(error.message || error).slice(0, 300) };
  const mine = readLedger(ledgerFile).filter((r) => r.videoId === videoId);
  const last = mine[mine.length - 1];
  if (!last || last.status !== 'held_unpostable' || last.error !== row.error) {
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.appendFileSync(ledgerFile, `${JSON.stringify(row)}\n`);
  }
  return row;
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

module.exports = { loadApprovedVideo, releaseStagedVideo, recordHeldUnpostable, X_POSTABLE };
