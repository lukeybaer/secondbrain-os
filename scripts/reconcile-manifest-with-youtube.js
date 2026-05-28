#!/usr/bin/env node
/**
 * 2026-05-25 Luke #gap: "that is an old one that was already posted aren't
 * you supposed to be teeing up the next one?"
 *
 * Root cause: the dashboard's Video Approval Queue keeps surfacing
 * already-posted videos because the manifest doesn't carry a posted
 * status. Every YouTube post writes the video to the channel but
 * leaves manifest.json untouched, so videoReadyForApproval and
 * videoNeedsReviewOrRegen treat the entry as still pending. Result:
 * dead horses in the queue.
 *
 * This script reconciles manifest.json against the YouTube channel(s)
 * by fuzzy title match. Hits get marked status=posted with
 * youtube_video_id and posted_at populated.
 *
 * Usage:
 *   node scripts/reconcile-manifest-with-youtube.js [--write] [--channels=AILifeHacks,BedtimeStories]
 * Default channels: AILifeHacks
 * --write: persist changes; without it, dry-run only
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = process.env.SECONDBRAIN_ROOT || '/opt/secondbrain';
const MANIFEST_PATH = process.env.MANIFEST_PATH || path.join(REPO, 'content-review', 'pending', 'manifest.json');
const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET env vars are required');

const WRITE = process.argv.includes('--write');
const channelsArg = (process.argv.find((a) => a.startsWith('--channels=')) || '').split('=')[1];
const CHANNELS = (channelsArg || 'AILifeHacks').split(',').map((c) => c.trim()).filter(Boolean);
const MAX_PER_CHANNEL = Number(process.env.MAX_PER_CHANNEL || 50);

function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Token-set Jaccard: how many tokens overlap as a fraction of union.
function titleSimilarity(a, b) {
  const ta = new Set(normalizeTitle(a).split(' ').filter((w) => w.length > 2));
  const tb = new Set(normalizeTitle(b).split(' ').filter((w) => w.length > 2));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter += 1;
  const union = new Set([...ta, ...tb]).size;
  return inter / union;
}

function refreshAccess(refreshToken) {
  const body = `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&refresh_token=${refreshToken}&grant_type=refresh_token`;
  const r = execSync(`curl -s -X POST https://oauth2.googleapis.com/token -d "${body}"`).toString();
  const j = JSON.parse(r);
  if (!j.access_token) throw new Error('no access_token: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

function ytGet(access, url) {
  const r = execSync(`curl -s -H "Authorization: Bearer ${access}" "${url}"`).toString();
  return JSON.parse(r);
}

function listUploads(channel) {
  const tokFile = path.join(REPO, 'data', 'youtube', `${channel}_token.json`);
  if (!fs.existsSync(tokFile)) return [];
  const tok = JSON.parse(fs.readFileSync(tokFile, 'utf8'));
  const access = refreshAccess(tok.refresh_token);
  const ch = ytGet(access, 'https://youtube.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true');
  if (!ch.items || !ch.items.length) return [];
  const uploads = ch.items[0].contentDetails.relatedPlaylists.uploads;
  const out = [];
  let pageToken = '';
  while (out.length < MAX_PER_CHANNEL) {
    const url = `https://youtube.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploads}&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const page = ytGet(access, url);
    for (const it of page.items || []) {
      out.push({
        channel,
        publishedAt: it.snippet.publishedAt,
        videoId: it.snippet.resourceId.videoId,
        title: it.snippet.title,
      });
    }
    if (!page.nextPageToken || out.length >= MAX_PER_CHANNEL) break;
    pageToken = page.nextPageToken;
  }
  return out.slice(0, MAX_PER_CHANNEL);
}

function reconcile(manifest, uploads, threshold = 0.18) {
  const changes = [];
  for (const v of manifest.videos || []) {
    // Skip already-posted entries.
    if (v.status === 'posted' || v.youtube_video_id) continue;
    let best = null;
    for (const u of uploads) {
      const score = titleSimilarity(v.title, u.title);
      if (!best || score > best.score) best = { upload: u, score };
    }
    if (best && best.score >= threshold) {
      changes.push({
        id: v.id,
        manifestTitle: v.title,
        matched: best.upload,
        score: best.score,
      });
    }
  }
  return changes;
}

function applyChanges(manifest, changes) {
  const byId = new Map(changes.map((c) => [c.id, c]));
  for (const v of manifest.videos || []) {
    const c = byId.get(v.id);
    if (!c) continue;
    v.status = 'posted';
    v.youtube_video_id = c.matched.videoId;
    v.youtube_channel = c.matched.channel;
    v.posted_at = c.matched.publishedAt;
    v.posted_reconciled_at = new Date().toISOString();
    v.posted_reconciled_score = Number(c.score.toFixed(3));
    v.posted_reconciled_match_title = c.matched.title;
  }
  return manifest;
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  console.log(`[reconcile] manifest videos: ${(manifest.videos || []).length}`);
  let allUploads = [];
  for (const ch of CHANNELS) {
    try {
      const u = listUploads(ch);
      console.log(`[reconcile] ${ch}: ${u.length} uploads`);
      allUploads = allUploads.concat(u);
    } catch (e) {
      console.error(`[reconcile] ${ch} fetch failed: ${e.message}`);
    }
  }
  const thresholdArg = (process.argv.find((a) => a.startsWith('--threshold=')) || '').split('=')[1];
  const threshold = thresholdArg ? Number(thresholdArg) : undefined;
  const changes = reconcile(manifest, allUploads, threshold);
  console.log(`[reconcile] proposed matches: ${changes.length}`);
  for (const c of changes) {
    console.log(`  ${c.id} -> ${c.matched.videoId} (${(c.score * 100).toFixed(0)}% match)`);
    console.log(`    manifest: ${c.manifestTitle.slice(0, 80)}`);
    console.log(`    youtube:  ${c.matched.title.slice(0, 80)} (${c.matched.publishedAt.slice(0, 10)})`);
  }
  if (!WRITE) {
    console.log('[reconcile] DRY RUN: re-run with --write to persist');
    return;
  }
  if (!changes.length) {
    console.log('[reconcile] nothing to write');
    return;
  }
  applyChanges(manifest, changes);
  const backup = MANIFEST_PATH + '.bak-' + Date.now();
  fs.copyFileSync(MANIFEST_PATH, backup);
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`[reconcile] wrote ${MANIFEST_PATH} (backup at ${backup})`);
}

if (require.main === module) main();

module.exports = {
  titleSimilarity,
  normalizeTitle,
  reconcile,
  applyChanges,
};
