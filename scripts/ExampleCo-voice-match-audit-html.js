#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'life-archive-ExampleCo-voice-match-audit.html');
const REGISTRY = path.join(ROOT, 'data', 'life-archive', 'voice-identity-registry.json');
const RESOLVER = path.join(ROOT, 'data', 'life-archive', 'voiceprints', 'ecapa-speaker-resolver-latest.json');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relToRoot(file) {
  if (!file) return '';
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  return path.relative(ROOT, abs).replace(/\\/g, '/');
}

function relFromReport(file) {
  const rel = relToRoot(file);
  return rel ? `../${rel}` : '';
}

function textForTrack(otid, label) {
  const doc = readJson(path.join(ROOT, 'data', 'otter', 'enriched', `${otid}.json`), {});
  return (doc.segments || [])
    .filter((segment) => String(segment.speaker_model_label || '') === String(label))
    .map((segment) => String(segment.text || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 900);
}

const registry = readJson(REGISTRY, {});
const resolver = readJson(RESOLVER, {});
const reference = Object.values(registry.enrollments || {})
  .find((row) => row.person_id === 'ExampleCo' || String(row.display_name || '').toLowerCase() === 'ExampleCo') || {};

const clips = [];
if (reference.reference_audio_path || reference.reference_audio_rel) {
  clips.push({
    kind: 'ExampleCo-confirmed PRIVATE_NAME reference',
    title: 'ExampleCo-confirmed PRIVATE_NAME reference',
    label: 'reference',
    audio: reference.reference_audio_rel || reference.reference_audio_path,
    score: 1,
    margin: null,
    sample: reference.source_label || 'Confirmed reference voiceprint for PRIVATE_NAME.',
  });
}

const seen = new Set(clips.map((clip) => relToRoot(clip.audio)));
for (const row of (resolver.known_matches || [])
  .filter((item) => item.person_id === 'ExampleCo' && item.tier === 'confirmed_reference_voiceprint_match')
  .sort((a, b) => (b.score || 0) - (a.score || 0))) {
  const rel = relToRoot(row.probe_audio_path);
  if (!rel || seen.has(rel)) continue;
  seen.add(rel);
  clips.push({
    kind: 'confirmed PRIVATE_NAME reference voiceprint match',
    title: row.title,
    label: row.speaker_model_label,
    audio: row.probe_audio_path,
    score: row.score,
    margin: row.margin,
    sample: textForTrack(row.otid, row.speaker_model_label),
  });
}

const cards = clips.map((clip, index) => {
  const audio = clip.audio && fs.existsSync(path.join(ROOT, relToRoot(clip.audio)))
    ? `<audio controls preload="metadata" src="${esc(relFromReport(clip.audio))}"></audio>`
    : `<div class="missing">Audio not found: ${esc(clip.audio)}</div>`;
  const score = clip.score == null ? '' : `<span>score ${esc(Number(clip.score).toFixed(3))}</span>`;
  const margin = clip.margin == null ? '' : `<span>margin ${esc(Number(clip.margin).toFixed(3))}</span>`;
  return `<article>
    <h2>${index + 1}. ${esc(clip.title)}</h2>
    <p>${esc(clip.kind)} &middot; speaker ${esc(clip.label)} ${score} ${margin}</p>
    ${audio}
    <blockquote>${esc(clip.sample || '(no transcript sample)')}</blockquote>
  </article>`;
}).join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PRIVATE_NAME Voice Match Audit</title>
  <style>
    body { margin: 0; background: #f7f4ee; color: #20201f; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; line-height: 1.45; }
    main { max-width: 1120px; margin: 0 auto; padding: 28px 20px 48px; }
    header { border-bottom: 1px solid #d8d1c7; margin-bottom: 18px; padding-bottom: 16px; }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }
    .note { color: #625f59; max-width: 980px; }
    .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
    .stat, article { background: #fffdf9; border: 1px solid #d8d1c7; border-radius: 8px; }
    .stat { padding: 12px; }
    .stat strong { display: block; font-size: 25px; }
    article { padding: 16px; margin: 14px 0; }
    h2 { margin: 0 0 3px; font-size: 18px; letter-spacing: 0; }
    article p { margin: 0; color: #625f59; }
    audio { width: 100%; margin: 12px 0; }
    blockquote { margin: 0; border-left: 3px solid #bf6a3a; background: #fbefe6; padding: 10px 12px; color: #4c4741; }
    span { display: inline-block; margin-left: 8px; border: 1px solid #d8d1c7; border-radius: 999px; padding: 2px 7px; background: #f7f4ee; }
    .missing { border: 1px solid #d64b2a; color: #9a3412; background: #fff3ed; border-radius: 8px; padding: 12px; margin: 12px 0; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>PRIVATE_NAME Voice Match Audit</h1>
      <p class="note">This corrected page only includes the ExampleCo-confirmed PRIVATE_NAME reference and clips that clear the confirmed PRIVATE_NAME ECAPA reference voiceprint match. PRIVATE_NAME-cluster consistency alone is excluded.</p>
      <div class="stats">
        <div class="stat"><strong>${clips.length}</strong><span>clips shown</span></div>
        <div class="stat"><strong>${clips.filter((clip) => clip.kind.includes('match')).length}</strong><span>corpus voiceprint match clips</span></div>
      </div>
    </header>
    ${cards}
  </main>
</body>
</html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log(OUT);
