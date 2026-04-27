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
const { execSync } = require('child_process');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO, 'content-review', 'pending', 'manifest.json');
const SSH_KEY = process.env.SECONDBRAIN_SSH_KEY
  || path.join(os.homedir(), '.ssh', 'secondbrain-backend-key.pem');
const EC2_HOST = process.env.EC2_HOST || 'ec2-user@98.80.164.16';

function ssh(cmd, opts = {}) {
  return execSync(
    `ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${EC2_HOST} "${cmd.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: opts.timeout || 1800000 },
  );
}

function scp(remote, local) {
  execSync(
    `scp -i "${SSH_KEY}" -o StrictHostKeyChecking=no ${EC2_HOST}:${remote} "${local.replace(/\\/g, '/')}"`,
    { stdio: ['ignore', 'pipe', 'inherit'], timeout: 180000 },
  );
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry');
  const idIdx = args.indexOf('--id');
  const filterId = idIdx >= 0 ? args[idIdx + 1] : null;

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
  if (filterId) candidates = candidates.filter((v) => v.id === filterId);

  if (candidates.length === 0) {
    console.log('no work to do (no videos with video_needs_regen=true or thumbnail_needs_regen=true' + (filterId ? ` matching id ${filterId}` : '') + ')');
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
    const localMp4 = path.join(REPO, 'content-review', 'pending', `${v.id}.mp4`);
    const localThumb = path.join(REPO, 'content-review', 'pending', `${v.id}_thumb.jpg`);
    const beforeMp4Mtime = mtimeOrZero(localMp4);
    const beforeThumbMtime = mtimeOrZero(localThumb);
    try {
      console.log('  triggering EC2 build (FORCE_REBUILD=1) ...');
      ssh(
        `cd /opt/secondbrain && FORCE_REBUILD=1 PYTHONUNBUFFERED=1 python3 -u scripts/ec2-build-from-queue.py --id ${v.id} 2>&1`,
        { timeout: 1800000 },
      );
      console.log('  build complete');

      // SCP the mp4 + thumb back. The build script copies final.mp4 to
      // /opt/secondbrain/data/youtube/<id>.mp4. Thumb path varies; try
      // common locations.
      try {
        scp(`/opt/secondbrain/data/youtube/${v.id}.mp4`, localMp4);
        console.log('  mp4 synced');
      } catch (e) {
        console.warn('  mp4 sync failed:', e.message.split('\n')[0].slice(0, 80));
      }
      try {
        scp(`/opt/secondbrain/data/youtube/${v.id}_thumb.jpg`, localThumb);
        console.log('  thumb synced');
      } catch (e) {
        console.warn('  thumb sync failed (may not exist):', e.message.split('\n')[0].slice(0, 60));
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
        continue;
      }

      // Real regen: only clear the flag for the artifact that actually
      // moved. If only the video was rebuilt, leave thumbnail_needs_regen
      // set so a follow-up thumbnail-rebuild path can pick it up.
      if (videoChanged) v.video_needs_regen = false;
      if (thumbChanged) v.thumbnail_needs_regen = false;
      v.regen_completed_at = new Date().toISOString();
      v.regen_status = 'done';
      v.status = 'pending_approval';
      console.log(
        `  manifest entry updated -> pending_approval (video=${videoChanged}, thumb=${thumbChanged})`,
      );
    } catch (e) {
      console.error('  FAILED:', e.message.split('\n')[0].slice(0, 200));
      v.regen_status = 'failed';
      v.regen_error = e.message.split('\n')[0].slice(0, 200);
      v.regen_failed_at = new Date().toISOString();
      // Leave *_needs_regen=true so the next run picks it up.
    }
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('\nmanifest written.');
}

if (require.main === module) main();
