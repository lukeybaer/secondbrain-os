#!/usr/bin/env node
'use strict';
// Fetch real high-definition photography or footage for a clip's image
// accents and cutaways (v5 package, owner decision: "high def, visually
// beautiful, not cartoonish"). Searches Pexels (free commercial license),
// keeps only results whose 9:16 crop is at least 1080 px wide, downloads the
// originals into the production directory and prints the `media` blocks to
// paste into `<final.mp4>.effects.json`.
//
// Usage:
//   node scripts/fetch-accent-media.js --query "rocket launch at night" \
//     --out /opt/secondbrain/data/video-production/<id>-<date>/source/accents \
//     [--kind photo|video] [--count 3] [--orientation portrait|landscape|square]
//
// Key: PEXELS_API_KEY, else pexels_api_key in /opt/secondbrain/empire/config.json
// (or --config <path>). Free API, no paid model spend.

const fs = require('fs');
const path = require('path');
const { pickPexelsPhotos, pickPexelsVideos, sha256File } = require('./lib/accent-media.js');

const DEFAULT_CONFIG = '/opt/secondbrain/empire/config.json';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function resolveKey(args, env = process.env) {
  if (env.PEXELS_API_KEY) return env.PEXELS_API_KEY;
  const file = args.config || DEFAULT_CONFIG;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).pexels_api_key || '';
  } catch {
    return '';
  }
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'accent';
}

function reusable(file, pick) {
  if (!fs.existsSync(file)) return false;
  let side;
  try {
    side = JSON.parse(fs.readFileSync(`${file}.provenance.json`, 'utf8'));
  } catch {
    return false;
  }
  return side.sha256 === sha256File(file)
    && String(side.provider_id) === String(pick.provider_id)
    && side.page_url === pick.page_url
    && side.kind === pick.kind;
}

// Exit codes: 2 usage, 3 no key, 4 search HTTP error, 5 no HD result,
// 6 no file downloaded. Returns { code, media, errors } (tests inject fetchImpl).
async function fetchAccentMedia(args, { fetchImpl = fetch, env = process.env, log = console.error } = {}) {
  const query = String(args.query || '').trim();
  const kind = args.kind === 'video' ? 'video' : 'photo';
  const count = Math.max(1, Math.min(8, Number(args.count) || 3));
  if (!query || !args.out) {
    log('usage: fetch-accent-media.js --query "<words>" --out <dir> [--kind photo|video] [--count 3]');
    return { code: 2, media: [] };
  }
  const key = resolveKey(args, env);
  if (!key) {
    log('PEXELS_AUTH: no PEXELS_API_KEY and no pexels_api_key in config');
    return { code: 3, media: [] };
  }
  const params = new URLSearchParams({ query, per_page: '30' });
  if (args.orientation) params.set('orientation', String(args.orientation));
  const url = kind === 'video'
    ? `https://api.pexels.com/videos/search?${params}`
    : `https://api.pexels.com/v1/search?${params}`;
  const res = await fetchImpl(url, { headers: { Authorization: key } });
  if (!res.ok) {
    log(`PEXELS_HTTP_${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { code: 4, media: [] };
  }
  const payload = await res.json();
  // A landscape search is for a long-form 16:9 film: its pick must fill 1920x1080.
  const frame = args.orientation === 'landscape' ? 'landscape' : 'portrait';
  const picks = kind === 'video' ? pickPexelsVideos(payload, count, frame) : pickPexelsPhotos(payload, count, frame);
  if (!picks.length) {
    log(frame === 'landscape'
      ? `NO_HD_RESULT: no ${kind} for "${query}" fills a 16:9 frame at 1920 px; try other words`
      : `NO_HD_RESULT: no ${kind} for "${query}" fills a 9:16 frame at 1080 px; try other words`);
    return { code: 5, media: [] };
  }
  const outDir = path.resolve(String(args.out));
  fs.mkdirSync(outDir, { recursive: true });
  const media = [];
  const errors = [];
  for (const pick of picks) {
    const ext = kind === 'video' ? '.mp4' : (path.extname(new URL(pick.download_url).pathname) || '.jpg');
    const file = path.join(outDir, `${slug(query)}-pexels-${pick.provider_id}${ext}`);
    // Codex review dae2270ae8ee: write to .part and rename, so a failed or
    // cut-off download never leaves a file that looks complete.
    const part = `${file}.part`;
    try {
      // Codex deploy review 6015ce693c88 (high): reuse an existing file only
      // when its sidecar already proves it is this pick; anything else (a
      // stale, unrelated or hand-made file at that name) is downloaded again
      // and replaced, so a sidecar is never written for bytes not fetched.
      if (!reusable(file, pick)) {
        const dl = await fetchImpl(pick.download_url);
        if (!dl.ok) throw new Error(`HTTP ${dl.status}`);
        const bytes = Buffer.from(await dl.arrayBuffer());
        if (!bytes.length) throw new Error('empty body');
        fs.writeFileSync(part, bytes);
        fs.renameSync(part, file);
      }
    } catch (err) {
      fs.rmSync(part, { force: true });
      errors.push(`${pick.page_url}: ${err.message}`);
      log(`download failed for ${pick.page_url}: ${err.message}`);
      continue;
    }
    const block = {
      kind: pick.kind,
      file,
      sha256: sha256File(file),
      width: pick.width,
      height: pick.height,
      provider: pick.provider,
      provider_id: pick.provider_id,
      page_url: pick.page_url,
      credit: pick.credit,
      license: pick.license,
      query,
    };
    const sidecar = `${file}.provenance.json`;
    fs.writeFileSync(`${sidecar}.part`, `${JSON.stringify({ ...block, fetched_at: new Date().toISOString() }, null, 2)}
`);
    fs.renameSync(`${sidecar}.part`, sidecar);
    media.push(block);
  }
  if (!media.length) {
    log(`NO_DOWNLOAD: none of ${picks.length} ${kind} results downloaded`);
    return { code: 6, media, errors };
  }
  return { code: 0, media, errors };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { code, media } = await fetchAccentMedia(args);
  if (code === 0) {
    process.stdout.write(`${JSON.stringify({ query: String(args.query).trim(), kind: args.kind === 'video' ? 'video' : 'photo', media }, null, 2)}
`);
  }
  process.exit(code);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`fetch-accent-media failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, resolveKey, slug, fetchAccentMedia };
