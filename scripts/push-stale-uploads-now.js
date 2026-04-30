#!/usr/bin/env node
// One-shot: push the 3 stale approved videos to EC2 so the 10 AM slot picks
// them up. This is the heal path that normally runs at 3 AM but the fix for
// healStaleUploads landed at 01:29 CT on 2026-04-20, after the 01:18 nightly
// run. Rather than wait until tomorrow's 3 AM run, trigger the same logic now.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const queuePath = path.join(REPO, 'content-review', 'upload-queue.json');
const pendingDir = path.join(REPO, 'content-review', 'pending');
const SSH_KEY = path.join(process.env.HOME || process.env.USERPROFILE || require('os').homedir(), '.ssh', 'secondbrain-backend-key.pem');
const EC2_HOST = 'ec2-user@98.80.164.16';
const EC2_VIDEO_DIR = '/opt/secondbrain/data/youtube';
const EC2_BASE = process.env.EC2_BASE_URL || 'http://98.80.164.16:3001';

const staleIds = new Set(['mit_30_agents', 'kids_tiny_elephant', 'kids_little_whale']);
const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
const pushed = [];
const failed = [];

for (const item of queue) {
  if (!staleIds.has(item.id)) continue;
  if (item.upload_status === 'uploading' || item.upload_status === 'posted') {
    console.log('[skip]', item.id, 'already', item.upload_status);
    continue;
  }
  const videoPath = path.join(pendingDir, item.video_file || `${item.id}.mp4`);
  const thumbPath = item.thumbnail_file ? path.join(pendingDir, item.thumbnail_file) : null;
  if (!fs.existsSync(videoPath)) {
    console.log('[fail]', item.id, 'missing file:', videoPath);
    failed.push(`${item.id} (missing video file)`);
    continue;
  }
  console.log('[push]', item.id, '-- scp video...');
  try {
    const scpOpts = `-i ${SSH_KEY} -o StrictHostKeyChecking=no`;
    const remoteVideo = `${EC2_VIDEO_DIR}/${item.id}.mp4`;
    execSync(
      `ssh ${scpOpts} ${EC2_HOST} "mkdir -p ${EC2_VIDEO_DIR}" && scp ${scpOpts} "${videoPath.replace(/\\/g, '/')}" ${EC2_HOST}:${remoteVideo}`,
      { timeout: 300000, stdio: 'inherit' },
    );
    let remoteThumb;
    if (thumbPath && fs.existsSync(thumbPath)) {
      remoteThumb = `${EC2_VIDEO_DIR}/${item.id}_thumb.jpg`;
      console.log('[push]', item.id, '-- scp thumb...');
      execSync(
        `scp ${scpOpts} "${thumbPath.replace(/\\/g, '/')}" ${EC2_HOST}:${remoteThumb}`,
        { timeout: 60000, stdio: 'inherit' },
      );
    }
    const payload = JSON.stringify({
      id: item.id,
      title: item.title,
      channel: item.channel || 'Channel1',
      description: item.description || '',
      tags: item.tags || [],
      videoPath: remoteVideo,
      thumbnailPath: remoteThumb,
    });
    console.log('[push]', item.id, '-- POST /youtube/queue...');
    const tmpPayload = path.join(REPO, `.tmp-payload-${item.id}.json`);
    fs.writeFileSync(tmpPayload, payload);
    const out = execSync(
      `curl -sS --max-time 30 -X POST ${EC2_BASE}/youtube/queue -H "Content-Type: application/json" --data-binary @${tmpPayload}`,
      { timeout: 40000, encoding: 'utf8' },
    );
    fs.unlinkSync(tmpPayload);
    console.log('[push]', item.id, 'response:', out.slice(0, 200));
    item.upload_status = 'uploading';
    item.queued_at = new Date().toISOString();
    pushed.push(item.id);
  } catch (e) {
    console.log('[fail]', item.id, e.message.slice(0, 300));
    failed.push(`${item.id} (${e.message.slice(0, 60)})`);
  }
}

fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
console.log('\n=== RESULT ===');
console.log('pushed:', pushed);
console.log('failed:', failed);
process.exit(failed.length > 0 ? 1 : 0);
