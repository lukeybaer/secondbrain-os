#!/usr/bin/env node
/**
 * sync-videos-from-ec2.js
 *
 * Pulls newly built videos from EC2 into content-review/pending/ and
 * updates the local manifest so they appear in ContentPipeline for review.
 *
 * Run manually or from the ContentPipeline "Sync from EC2" button
 * (IPC: empire:syncFromEC2).
 *
 * Usage:
 *   node scripts/sync-videos-from-ec2.js
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SECONDBRAIN_ROOT = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const PENDING_DIR = path.join(SECONDBRAIN_ROOT, 'content-review', 'pending');
const MANIFEST_PATH = path.join(PENDING_DIR, 'manifest.json');
const SSH_KEY = path.join(os.homedir(), '.ssh', 'secondbrain-backend-key.pem');
const EC2_HOST = 'ec2-user@98.80.164.16';
const EC2_YT_DIR = '/opt/secondbrain/data/youtube';
const EC2_BUILD_DIR = '/opt/secondbrain/data/youtube/build';

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return { videos: [] };
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return { videos: [] };
  }
}

function saveManifest(m) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

function ssh(cmd) {
  try {
    return execSync(
      `ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "${EC2_HOST}" "${cmd}"`,
      { encoding: 'utf8', timeout: 30000 },
    ).trim();
  } catch (e) {
    return null;
  }
}

function scp(remote, local) {
  try {
    execSync(`scp -i "${SSH_KEY}" -o StrictHostKeyChecking=no "${EC2_HOST}:${remote}" "${local}"`, {
      timeout: 120000,
    });
    return true;
  } catch (e) {
    console.error(`  SCP failed: ${remote} → ${e.message.slice(0, 120)}`);
    return false;
  }
}

(async () => {
  console.log('[sync] Checking EC2 for built videos...');
  fs.mkdirSync(PENDING_DIR, { recursive: true });

  // List mp4 files in EC2 youtube dir (final outputs, not build subdirs)
  const lsOut = ssh(`ls ${EC2_YT_DIR}/*.mp4 2>/dev/null`);
  if (!lsOut) {
    console.log('[sync] EC2 unreachable or no videos found');
    process.exit(0);
  }

  const ec2Files = lsOut
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.mp4'));

  console.log(`[sync] EC2 has ${ec2Files.length} built videos`);

  const manifest = loadManifest();
  const existingIds = new Set((manifest.videos || []).map((v) => v.id));
  let synced = 0;
  let skipped = 0;

  for (const remotePath of ec2Files) {
    const filename = path.basename(remotePath); // e.g. ai_agent_income_formula.mp4
    const videoId = filename.replace('.mp4', '');
    const localMp4 = path.join(PENDING_DIR, filename);
    const thumbFilename = `${videoId}_thumb.jpg`;
    const localThumb = path.join(PENDING_DIR, thumbFilename);
    const remoteThumb = `${EC2_YT_DIR}/${thumbFilename}`;

    // Skip if local copy is at least as new as the EC2 copy. Otherwise pull
    // the fresh build. Locked 2026-04-26 -- before this, the script only
    // checked for file presence, so 10-day-old local copies persisted while
    // EC2 built newer versions, and the videoPipeline probe correctly
    // flagged "newest video 232h old" because synced_at never advanced.
    let needsPull = !fs.existsSync(localMp4);
    if (!needsPull) {
      try {
        const remoteMtimeRaw = ssh(`stat -c %Y "${remotePath}" 2>/dev/null`);
        const remoteMtime = parseInt((remoteMtimeRaw || '').trim(), 10);
        const localMtime = Math.floor(fs.statSync(localMp4).mtimeMs / 1000);
        if (Number.isFinite(remoteMtime) && remoteMtime > localMtime + 5) {
          needsPull = true;
          console.log(`[sync] Refreshing ${videoId} (EC2 ${remoteMtime - localMtime}s newer)`);
        }
      } catch (e) { /* fall through to skip */ }
    }
    if (!needsPull) {
      // Even when skipped, advance the manifest's synced_at so the
      // videoPipeline probe doesn't false-red on a quiet day.
      const entry = (manifest.videos || []).find((v) => v.id === videoId);
      if (entry && !entry.synced_at) entry.synced_at = new Date().toISOString();
      skipped++;
      continue;
    }

    console.log(`[sync] Downloading ${videoId}...`);

    // Download mp4
    const mp4Ok = scp(remotePath, localMp4);
    if (!mp4Ok) continue;

    // Download thumbnail (best-effort)
    const thumbOk = scp(remoteThumb, localThumb);

    // Get title from EC2 build manifest
    const buildManifestRaw = ssh(`cat ${EC2_BUILD_DIR}/build_manifest.json 2>/dev/null`);
    let title = videoId.replace(/_/g, ' ');
    let channel = process.env.YT_CHANNEL_PRIMARY || '';
    if (buildManifestRaw) {
      try {
        const bm = JSON.parse(buildManifestRaw);
        if (bm[videoId]) {
          title = bm[videoId].title || title;
          channel = bm[videoId].channel || channel;
        }
      } catch {
        /* ignore */
      }
    }

    // Also check ec2-build-queue.json for metadata
    const queueRaw = ssh(`cat /opt/secondbrain/scripts/ec2-build-queue.json 2>/dev/null`);
    if (queueRaw) {
      try {
        const q = JSON.parse(queueRaw);
        const spec = (q.videos || []).find((v) => v.id === videoId);
        if (spec) {
          title = spec.title || title;
          channel = spec.channel || channel;
        }
      } catch {
        /* ignore */
      }
    }

    // Add to manifest
    if (existingIds.has(videoId)) {
      // Update existing entry. Honesty contract (locked 2026-04-26): do NOT
      // unconditionally reset status to pending_approval. If the entry has
      // an open rejection (video_needs_regen or thumbnail_needs_regen),
      // only clear the matching flag when the synced file is genuinely
      // newer than the most recent rejection of that target. Pre-fix, this
      // script was clobbering status='pending_approval' even when the
      // synced mp4 was the same file Luke had just rejected.
      const entry = manifest.videos.find((v) => v.id === videoId);
      if (entry) {
        const wasVideoRejected = entry.video_needs_regen === true;
        const wasThumbRejected = entry.thumbnail_needs_regen === true;
        const nowMp4Mtime = fs.existsSync(localMp4) ? fs.statSync(localMp4).mtimeMs : 0;
        const nowThumbMtime =
          thumbOk && fs.existsSync(localThumb) ? fs.statSync(localThumb).mtimeMs : 0;

        function lastRejectedAtMs(target) {
          try {
            const lines = fs
              .readFileSync(
                path.join(SECONDBRAIN_ROOT, 'content-review', 'rejections.jsonl'),
                'utf8',
              )
              .split('\n')
              .filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                const r = JSON.parse(lines[i]);
                if (r.id === videoId && (r.target === target || r.target === 'both')) {
                  return new Date(r.rejectedAt).getTime();
                }
              } catch {}
            }
          } catch {}
          return 0;
        }

        entry.video_file = filename;
        entry.thumbnail_file = thumbOk ? thumbFilename : entry.thumbnail_file;
        entry.synced_at = new Date().toISOString();
        entry.fix_summary = (entry.fix_summary || '') + ' [synced from EC2]';

        let allCleared = true;
        if (wasVideoRejected) {
          const rejectedMs = lastRejectedAtMs('video');
          if (nowMp4Mtime > rejectedMs && rejectedMs > 0) {
            entry.video_needs_regen = false;
          } else {
            allCleared = false;
          }
        }
        if (wasThumbRejected) {
          const rejectedMs = lastRejectedAtMs('thumbnail');
          if (nowThumbMtime > rejectedMs && rejectedMs > 0) {
            entry.thumbnail_needs_regen = false;
          } else {
            allCleared = false;
          }
        }

        if (allCleared) {
          entry.status = 'pending_approval';
        }
      }
    } else {
      // New entry
      manifest.videos.push({
        id: videoId,
        title,
        channel,
        status: 'pending_approval',
        video_file: filename,
        thumbnail_file: thumbOk ? thumbFilename : null,
        generated_date: new Date().toISOString().slice(0, 10),
        synced_at: new Date().toISOString(),
        local_size_mb: Math.round((fs.statSync(localMp4).size / 1024 / 1024) * 10) / 10,
      });
      existingIds.add(videoId);
    }

    synced++;
    console.log(`  [sync] OK: ${videoId} (${title})`);
  }

  saveManifest(manifest);
  console.log(`[sync] Done — ${synced} new videos synced, ${skipped} already present`);
  if (synced > 0) {
    console.log('[sync] Open ContentPipeline tab to review new videos');
  }
})();
