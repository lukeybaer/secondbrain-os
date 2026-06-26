const fs = require('fs');
const path = require('path');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/ExampleCo-voice-audit-html.js <acoustic_ExampleCo_id> [--limit N]');
  process.exit(2);
}
const limitArgIndex = process.argv.indexOf('--limit');
const rowLimit = limitArgIndex >= 0 ? Number(process.argv[limitArgIndex + 1] || '0') : 0;

const repo = process.cwd();
const enrichedDir = path.join(repo, 'data', 'otter', 'enriched');
const reportDir = path.join(repo, 'reports');
const groupsPath = path.join(repo, 'data', 'life-archive', 'voiceprints', 'ecapa-speaker-groups-latest.json');
fs.mkdirSync(reportDir, { recursive: true });

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function displayDate(value) {
  const n = Number(value || 0);
  if (n > 1000000000) return new Date(n * 1000).toISOString().slice(0, 10);
  return String(value || '').slice(0, 10) || 'ExampleCo date';
}

function relForHtml(filePath) {
  return '../' + filePath.replace(/\\/g, '/');
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

const rows = [];
const groupReport = readJson(groupsPath, {});
const groupInfo = (groupReport.groups || []).find((group) => group.acoustic_ExampleCo_id === target) || null;
const thresholds = groupReport.thresholds || {};
for (const file of fs.readdirSync(enrichedDir).filter((name) => name.endsWith('.json'))) {
  const full = path.join(enrichedDir, file);
  const doc = JSON.parse(fs.readFileSync(full, 'utf8'));
  const tracks = doc.speaker_identity_tracks || {};
  for (const [label, track] of Object.entries(tracks)) {
    if (track.acoustic_ExampleCo_id !== target) continue;
    const segments = (doc.segments || []).filter(
      (segment) => String(segment.speaker_model_label) === String(label),
    );
    const audio = track.probe_audio_path || '';
    rows.push({
      date: displayDate(doc.start_time || doc.created_at),
      title: doc.title || doc.otid || file.replace(/\.json$/, ''),
      otid: doc.otid || file.replace(/\.json$/, ''),
      label,
      segmentCount: segments.length,
      audio,
      audioExists: audio ? fs.existsSync(path.join(repo, audio)) : false,
      text: segments
        .map((segment) => String(segment.text || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 1600),
    });
  }
}

rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.segmentCount - a.segmentCount);
const displayRows = rowLimit > 0 ? rows.slice(0, rowLimit) : rows;

const playable = displayRows.filter((row) => row.audioExists).length;
const suffix = rowLimit > 0 ? `-core-${rowLimit}` : '';
const outPath = path.join(reportDir, `life-archive-ExampleCo-voice-${target.replace(/^ExampleCo_voice_ecapa_/, '')}${suffix}-audit.html`);

const cards = displayRows
  .map((row, index) => {
    const audio = row.audioExists
      ? `<audio controls preload="metadata" src="${esc(relForHtml(row.audio))}"></audio>`
      : `<div class="missing">Audio file missing: ${esc(row.audio)}</div>`;
    return `<article class="clip">
      <div class="clip-head">
        <div>
          <h2>${index + 1}. ${esc(row.date)} - ${esc(row.title)}</h2>
          <p class="meta">otid ${esc(row.otid)} &middot; Otter speaker label ${esc(row.label)} &middot; ${row.segmentCount} segment(s)</p>
        </div>
        <span class="${row.audioExists ? 'pill ok' : 'pill bad'}">${row.audioExists ? 'audio ready' : 'missing audio'}</span>
      </div>
      ${audio}
      <section class="sample">
        <h3>Transcript sample</h3>
        <p>${esc(row.text || '(no transcript text captured for this track)')}</p>
      </section>
    </article>`;
  })
  .join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PRIVATE_NAME Voice Audit - ${esc(target)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #20201f;
      --muted: #68645f;
      --line: #d8d1c7;
      --soft: #f7f3ed;
      --accent: #0f766e;
      --warn: #9a3412;
      --white: #fffdf9;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--soft);
      line-height: 1.45;
    }
    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 28px 20px 48px;
    }
    header {
      padding-bottom: 18px;
      border-bottom: 1px solid var(--line);
      margin-bottom: 18px;
    }
    h1 {
      font-size: 26px;
      line-height: 1.15;
      margin: 0 0 8px;
      letter-spacing: 0;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-top: 16px;
    }
    .stat {
      background: var(--white);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
    }
    .stat strong {
      display: block;
      font-size: 24px;
      line-height: 1;
      margin-bottom: 4px;
    }
    .stat span, .note, .meta {
      color: var(--muted);
      font-size: 14px;
    }
    .clip {
      background: var(--white);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      margin: 14px 0;
    }
    .clip-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 12px;
    }
    h2 {
      font-size: 18px;
      margin: 0 0 4px;
      letter-spacing: 0;
    }
    h3 {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0;
      margin: 0 0 6px;
      color: var(--muted);
    }
    audio {
      display: block;
      width: 100%;
      margin: 10px 0 12px;
    }
    .sample {
      border-left: 3px solid #c96f3a;
      background: #fbf1e9;
      padding: 10px 12px;
    }
    .sample p { margin: 0; }
    .pill {
      white-space: nowrap;
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 5px 9px;
      font-size: 13px;
      font-weight: 650;
    }
    .ok { color: var(--accent); border-color: #99d1c8; background: #edfdf9; }
    .bad, .missing { color: var(--warn); border-color: #f0b493; background: #fff3ed; }
    .missing {
      border: 1px solid #f0b493;
      border-radius: 8px;
      padding: 12px;
      margin: 10px 0 12px;
    }
    code {
      background: #ece6dd;
      border-radius: 5px;
      padding: 2px 5px;
    }
    @media (max-width: 780px) {
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .clip-head { flex-direction: column; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>PRIVATE_NAME Voice Audit</h1>
      <p class="note">Acoustic ExampleCo ID: <code>${esc(target)}</code>. This page is a test of whether the voice-only grouping is real. Do not treat the speaker as named or confirmed.${rowLimit > 0 ? ` Showing the first ${displayRows.length} of ${rows.length} available clips.` : ''}</p>
      <p class="note">Grouping rule: centroid >= <code>${esc(thresholds.ExampleCo_cluster_score ?? 'n/a')}</code>, at least <code>${esc(thresholds.ExampleCo_cluster_min_core_matches ?? 'n/a')}</code> core matches >= <code>${esc(thresholds.ExampleCo_cluster_min_pair_score ?? 'n/a')}</code>; this group min-pair is <code>${esc(groupInfo?.min_pair_score ?? 'n/a')}</code>.</p>
      <div class="summary">
        <div class="stat"><strong>${displayRows.length}</strong><span>shown track clips</span></div>
        <div class="stat"><strong>${new Set(displayRows.map((row) => row.otid)).size}</strong><span>shown distinct calls</span></div>
        <div class="stat"><strong>${rows.length}</strong><span>available matched clips</span></div>
        <div class="stat"><strong>${playable}/${displayRows.length}</strong><span>playable audio files shown</span></div>
      </div>
    </header>
    ${cards || '<p>No clips found for this acoustic ExampleCo ID.</p>'}
  </main>
</body>
</html>
`;

fs.writeFileSync(outPath, html, 'utf8');
console.log(outPath);
