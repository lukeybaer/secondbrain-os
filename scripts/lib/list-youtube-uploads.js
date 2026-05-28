#!/usr/bin/env node
/**
 * 2026-05-25: list the last N uploads on AILifeHacks so we can reconcile
 * which manifest entries are already posted and should be cleared from
 * the Video Approval Queue. Pure read; writes nothing.
 *
 * Usage: node scripts/lib/list-youtube-uploads.js [channel] [maxResults]
 *   channel defaults to AILifeHacks
 *   maxResults defaults to 25
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CHANNEL = process.argv[2] || 'AILifeHacks';
const MAX = Number(process.argv[3] || 25);

const TOKEN_PATH = `/opt/secondbrain/data/youtube/${CHANNEL}_token.json`;
const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET env vars are required');

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

const tok = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
const access = refreshAccess(tok.refresh_token);
const ch = ytGet(access, 'https://youtube.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true');
if (!ch.items || !ch.items.length) {
  console.log('no channel found');
  process.exit(1);
}
const uploadsPlaylist = ch.items[0].contentDetails.relatedPlaylists.uploads;
const list = ytGet(access, `https://youtube.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylist}&maxResults=${MAX}`);
const items = list.items || [];
const out = items.map((it) => ({
  publishedAt: it.snippet.publishedAt,
  videoId: it.snippet.resourceId.videoId,
  title: it.snippet.title,
}));
console.log(JSON.stringify({ channel: CHANNEL, count: out.length, uploads: out }, null, 2));
