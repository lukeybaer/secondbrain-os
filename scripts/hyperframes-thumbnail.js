#!/usr/bin/env node
// hyperframes-thumbnail.js , generate a proper YouTube thumbnail for a stuck
// short-form video using HeyGen's open-source HyperFrames HTML-to-MP4/PNG
// renderer. First integration of the Oct 2026 HyperFrames framework into
// the repo's video pipeline; attacks rubric gap #30 (high-quality
// thumbnail generation with face/text overlays) and unblocks stuck
// "thumbnail is just plain text" items flagged by the daily diagnostic.
//
// Usage:
//   node scripts/hyperframes-thumbnail.js <video_id>
//   node scripts/hyperframes-thumbnail.js --stuck-only
//
// Output: tmp/hyperframes-out/<video_id>/thumbnail.png (1280x720) + the
// composition dir so the agent can iterate on it.
//
// Requirements: run scripts/setup-hyperframes.sh once first. HyperFrames
// needs Node 22+, FFmpeg, and bun on PATH.

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const TOOLS_DIR = path.join(REPO, 'tools', 'hyperframes');
const OUT_ROOT = path.join(REPO, 'tmp', 'hyperframes-out');
const MANIFEST = path.join(REPO, 'content-review', 'pending', 'manifest.json');

function die(msg) {
  console.error(`[hyperframes-thumbnail] ${msg}`);
  process.exit(1);
}

function ensureHyperframes() {
  if (!fs.existsSync(path.join(TOOLS_DIR, 'package.json'))) {
    die(`HyperFrames not installed. Run: bash scripts/setup-hyperframes.sh`);
  }
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) die(`manifest missing: ${MANIFEST}`);
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

function pickStuckVideos(manifest) {
  return (manifest.videos || []).filter(
    (v) =>
      v.video_needs_regen === true &&
      /thumbnail|plain text|no thumbnail|gap/i.test(v.video_rejection_note || ''),
  );
}

function buildComposition(video) {
  const id = video.id;
  const outDir = path.join(OUT_ROOT, id);
  fs.mkdirSync(outDir, { recursive: true });
  const title = (video.title || id).slice(0, 80);
  const subtitle = (video.subtitle || video.hook || '').slice(0, 100);
  const compositionHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      html,body{margin:0;padding:0;background:#0f0f0f;font-family:'Inter','Segoe UI',sans-serif;color:#fff;}
      .frame{width:1280px;height:720px;display:grid;grid-template-rows:1fr auto;padding:48px;box-sizing:border-box;position:relative;overflow:hidden;}
      .frame::before{content:'';position:absolute;inset:0;background:radial-gradient(1200px 700px at 20% 30%,rgba(255,89,0,.35),transparent),radial-gradient(900px 600px at 80% 80%,rgba(0,180,255,.25),transparent);}
      h1{font-size:112px;line-height:1;font-weight:900;letter-spacing:-2px;margin:0;position:relative;text-shadow:0 6px 24px rgba(0,0,0,.55);}
      h1 .hi{background:linear-gradient(90deg,#ff5900,#ffb700);-webkit-background-clip:text;color:transparent;}
      p.sub{font-size:36px;font-weight:600;opacity:.92;margin:24px 0 0 0;position:relative;}
      .badge{position:absolute;top:48px;right:48px;padding:14px 28px;background:#ff2d55;color:#fff;font-weight:800;font-size:28px;border-radius:999px;letter-spacing:1px;}
      .ll{position:relative;display:flex;align-items:center;gap:20px;}
      .ll .dot{width:20px;height:20px;border-radius:50%;background:#ff5900;box-shadow:0 0 24px #ff5900;}
      .ll .ch{font-size:28px;font-weight:700;opacity:.85;}
    </style>
  </head>
  <body>
    <div class="frame" data-hyperframes-scene data-duration="0.3">
      <span class="badge">${escapeHtml(process.env.THUMBNAIL_BRAND || 'SHORT')}</span>
      <div>
        <h1>${escapeHtml(title).replace(/\b(AI|Claude|GPT|Gemini|MIT|BROKE|Failed)\b/g, '<span class="hi">$1</span>')}</h1>
        ${subtitle ? `<p class="sub">${escapeHtml(subtitle)}</p>` : ''}
      </div>
      <div class="ll"><div class="dot"></div><span class="ch">${escapeHtml(process.env.THUMBNAIL_CHANNEL_URL || '')}</span></div>
    </div>
  </body>
</html>`;
  fs.writeFileSync(path.join(outDir, 'composition.html'), compositionHtml);
  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(
      {
        id,
        kind: 'thumbnail',
        width: 1280,
        height: 720,
        format: 'png',
        source_title: title,
        source_rejection: video.video_rejection_note || null,
        generated_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  return outDir;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderComposition(outDir) {
  const hyperframesBin = path.join(TOOLS_DIR, 'packages', 'cli', 'src', 'cli.ts');
  if (!fs.existsSync(hyperframesBin)) {
    console.warn(
      `[hyperframes-thumbnail] CLI not found at ${hyperframesBin} , skipping render (composition written to ${outDir})`,
    );
    return null;
  }
  // HyperFrames recommends bun for workspace resolution; fall back to npx tsx.
  const hasBun = spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
  const cmd = hasBun ? 'bun' : 'npx';
  const args = hasBun
    ? ['x', 'hyperframes', 'render', '--input', path.join(outDir, 'composition.html'), '--output', path.join(outDir, 'thumbnail.png')]
    : ['tsx', hyperframesBin, 'render', '--input', path.join(outDir, 'composition.html'), '--output', path.join(outDir, 'thumbnail.png')];
  const r = spawnSync(cmd, args, { cwd: TOOLS_DIR, stdio: 'inherit' });
  if (r.status !== 0) {
    console.warn('[hyperframes-thumbnail] render exited non-zero , composition still authored; retry manually with:');
    console.warn(`  cd ${TOOLS_DIR} && ${cmd} ${args.join(' ')}`);
    return null;
  }
  return path.join(outDir, 'thumbnail.png');
}

function main() {
  ensureHyperframes();
  const args = process.argv.slice(2);
  const stuckOnly = args.includes('--stuck-only');
  const manifest = loadManifest();
  const targets = stuckOnly
    ? pickStuckVideos(manifest)
    : args
        .filter((a) => !a.startsWith('--'))
        .map((id) => (manifest.videos || []).find((v) => v.id === id))
        .filter(Boolean);
  if (targets.length === 0) die(`no target videos (use --stuck-only or pass ids)`);
  const outputs = [];
  for (const v of targets) {
    console.log(`[hyperframes-thumbnail] authoring ${v.id}...`);
    const outDir = buildComposition(v);
    const png = renderComposition(outDir);
    outputs.push({ id: v.id, composition: outDir, thumbnail: png });
  }
  console.log(JSON.stringify({ generated: outputs }, null, 2));
}

if (require.main === module) main();

module.exports = { buildComposition, pickStuckVideos };
