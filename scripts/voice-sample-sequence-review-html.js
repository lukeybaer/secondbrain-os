const fs = require('fs');
const path = require('path');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/voice-sample-sequence-review-html.js <speaker-or-acoustic-id> [--limit N]');
  process.exit(2);
}

const limitIndex = process.argv.indexOf('--limit');
const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1] || '20') : 20;
const repo = process.cwd();
const enrichedDir = path.join(repo, 'data', 'otter', 'enriched');
const probeIndexPath = path.join(repo, 'data', 'life-archive', 'voiceprints', 'track-probe-index-latest.json');
const callRostersPath = path.join(repo, 'data', 'life-archive', 'voiceprints', 'otter-call-speaker-rosters-latest.json');
const reportDir = path.join(repo, 'reports');
const forceServerUrls = process.argv.includes('--server-url') || process.argv.includes('--web');
const localFileMode = !forceServerUrls && (process.argv.includes('--local-file') || !fs.existsSync('/opt/secondbrain'));
fs.mkdirSync(reportDir, { recursive: true });

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slug(value) {
  return String(value || 'voice')
    .replace(/^ExampleCo_voice_ecapa_/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

function dateFromValue(value) {
  const n = Number(value || 0);
  if (n > 1000000000) return new Date(n * 1000).toISOString().slice(0, 10);
  const s = String(value || '');
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : 'ExampleCo-date';
}

function relForHtml(repoRelPath) {
  return '../' + String(repoRelPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function voiceAudioUrl(repoRelPath) {
  return '/life-archive/voice-audio?path=' + encodeURIComponent(String(repoRelPath || '').replace(/\\/g, '/').replace(/^\/+/, ''));
}

function audioSrc(repoRelPath) {
  return localFileMode ? relForHtml(repoRelPath) : voiceAudioUrl(repoRelPath);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function normalizeId(value) {
  return String(value || '').replace(/^(ExampleCo|known):/, '');
}

function targetAliases() {
  const aliases = new Set([String(target), normalizeId(target)]);
  const person = String(target || '').match(/^person:(.+)$/);
  if (person) aliases.add(person[1]);
  return aliases;
}

function segmentText(segments) {
  return segments
    .map((segment) => String(segment.text || segment.transcript || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 1800);
}

function trackMatches(track, label) {
  const aliases = targetAliases();
  const candidates = [
    track.acoustic_ExampleCo_id,
    track.voice_cluster_id,
    track.ExampleCo_speaker_id,
    track.person_id,
    track.confirmed_person_id,
    track.person_id ? `person:${track.person_id}` : '',
    track.confirmed_person_id ? `person:${track.confirmed_person_id}` : '',
    track.resolved_person,
    track?.resolved_speaker?.person_id,
    track?.resolved_speaker?.person_id ? `person:${track.resolved_speaker.person_id}` : '',
    label,
  ].filter(Boolean).map(String);
  return candidates.some((id) => aliases.has(id) || aliases.has(normalizeId(id)));
}

function loadRosterByOtid() {
  const rosters = readJson(callRostersPath, {});
  const out = new Map();
  for (const call of rosters.calls || []) {
    if (call.otid) out.set(String(call.otid), call);
  }
  return out;
}

function speakerFromCall(call, aliases) {
  for (const speaker of call?.speakers || []) {
    const ids = [
      speaker.speaker_id,
      speaker.person_id,
      speaker.display_name,
      ...(speaker.voice_cluster_ids || []),
      ...(speaker.ExampleCo_speaker_ids || []),
      ...(speaker.acoustic_ExampleCo_ids || []),
      ...(speaker.otter_tracks || []),
    ].filter(Boolean).map(String);
    if (ids.some((id) => aliases.has(id) || aliases.has(normalizeId(id)))) return speaker;
  }
  return null;
}

function rowsFromProbeIndex() {
  const index = readJson(probeIndexPath, {});
  const aliases = targetAliases();
  const rosterByOtid = loadRosterByOtid();
  const out = [];
  for (const probe of index.probes || []) {
    const ids = [
      probe.voice_cluster_id,
      probe.ExampleCo_speaker_id,
      probe.acoustic_ExampleCo_id,
      probe.person_id,
      probe.speaker_model_label,
    ].filter(Boolean).map(String);
    if (!ids.some((id) => aliases.has(id) || aliases.has(normalizeId(id)))) continue;
    const call = rosterByOtid.get(String(probe.otid || ''));
    const speaker = speakerFromCall(call, aliases);
    const audio = String(probe.probe_audio_path || speaker?.probe_audio_path || '').replace(/\\/g, '/');
    out.push({
      date: call?.date || dateFromValue(probe.date || probe.start_time || ''),
      title: call?.title || probe.title || probe.otid || 'untitled',
      otid: probe.otid || call?.otid || '',
      label: probe.speaker_model_label || (speaker?.otter_tracks || [])[0] || '',
      segmentCount: Number(probe.segment_count || speaker?.segment_count || 0),
      wordCount: Number(probe.word_count || speaker?.word_count || 0),
      audio,
      audioExists: audio ? fs.existsSync(path.join(repo, audio)) : false,
      text: probe.sample_transcript || speaker?.sample_text || '',
      identityTier: speaker?.identity_tier || '',
      voiceClusterId: probe.voice_cluster_id || (speaker?.voice_cluster_ids || [])[0] || '',
      ExampleCoSpeakerId: probe.ExampleCo_speaker_id || (speaker?.ExampleCo_speaker_ids || [])[0] || '',
      topMatch: probe.ecapa || probe.voice_embedding_match || null,
    });
  }
  return out;
}

function rowsFromEnriched() {
  if (!fs.existsSync(enrichedDir)) return [];
  const out = [];
  for (const fileName of fs.readdirSync(enrichedDir).filter((name) => name.endsWith('.json'))) {
    const filePath = path.join(enrichedDir, fileName);
    const doc = readJson(filePath, {});
    const tracks = doc.speaker_identity_tracks || {};
    for (const [label, track] of Object.entries(tracks)) {
      if (!trackMatches(track, label)) continue;
      const segments = (doc.segments || []).filter(
        (segment) => String(segment.speaker_model_label) === String(label),
      );
      const audio = String(track.probe_audio_path || '').replace(/\\/g, '/');
      out.push({
        date: dateFromValue(doc.start_time || doc.created_at || doc.date),
        title: doc.title || doc.otid || fileName.replace(/\.json$/, ''),
        otid: doc.otid || doc.id || fileName.replace(/\.json$/, ''),
        label,
        segmentCount: segments.length,
        wordCount: segments.reduce((sum, segment) => sum + Number(segment.word_count || String(segment.text || '').split(/\s+/).filter(Boolean).length || 0), 0),
        audio,
        audioExists: audio ? fs.existsSync(path.join(repo, audio)) : false,
        text: segmentText(segments),
        identityTier: track.identity_tier || '',
        voiceClusterId: track.voice_cluster_id || '',
        ExampleCoSpeakerId: track.ExampleCo_speaker_id || '',
        topMatch: track.ecapa || track.voice_embedding_match || null,
      });
    }
  }
  return out;
}

// This page is voice-only. Do not expand targets through Pareto rows, names,
// topics, or relationship dossiers: those are useful context, but not acoustic
// membership. Exact person/voice ids and current enriched speaker tracks are the
// only source of truth for review clips.
const acousticExampleCoTarget = /^ExampleCo_voice_/.test(String(target || ''));
const personTarget = /^person:/.test(String(target || ''));
const rows = acousticExampleCoTarget || personTarget ? rowsFromEnriched() : rowsFromProbeIndex();
if (!rows.length && !acousticExampleCoTarget && !personTarget) rows.push(...rowsFromEnriched());

rows.sort((a, b) => (
  String(b.date).localeCompare(String(a.date)) ||
  b.segmentCount - a.segmentCount ||
  String(a.title).localeCompare(String(b.title))
));

const byDay = [];
const seenCalls = new Set();
for (const row of rows) {
  const callKey = row.otid || `${row.date}|${row.title}`;
  if (seenCalls.has(callKey)) continue;
  seenCalls.add(callKey);
  byDay.push(row);
  if (byDay.length >= limit) break;
}

const playable = byDay.filter((row) => row.audioExists).length;
const selectedDays = new Set(byDay.map((row) => row.date));
const reviewSlug = slug(target);
const outPath = path.join(reportDir, `life-archive-voice-sequence-${reviewSlug}.html`);
const legacyOutPath = path.join(reportDir, `life-archive-voice-sequence-${reviewSlug}-${byDay.length}.html`);
const manifestPath = path.join(repo, 'data', 'life-archive', 'voiceprints', `voice-sequence-${reviewSlug}.json`);
const legacyManifestPath = path.join(repo, 'data', 'life-archive', 'voiceprints', `voice-sequence-${reviewSlug}-${byDay.length}.json`);
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
const manifest = {
  schema: 'life_archive.voice_sequence_review.v1',
  generated_at: new Date().toISOString(),
  target,
  requested_limit: limit,
  total_tracks_found: rows.length,
  distinct_calls_found: seenCalls.size,
  distinct_days_found: new Set(rows.map((row) => row.date)).size,
  samples_selected: byDay.length,
  playable_samples: playable,
  samples: byDay,
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
if (legacyManifestPath !== manifestPath) fs.writeFileSync(legacyManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const rowsJson = JSON.stringify(byDay.map((row, index) => ({
  index,
  date: row.date,
  title: row.title,
  otid: row.otid,
  label: row.label,
  segmentCount: row.segmentCount,
  wordCount: row.wordCount,
  src: row.audioExists ? audioSrc(row.audio) : '',
  audio: row.audio,
  text: row.text,
  identityTier: row.identityTier,
  voiceClusterId: row.voiceClusterId,
  ExampleCoSpeakerId: row.ExampleCoSpeakerId,
  topMatch: row.topMatch,
})));

const listItems = byDay.map((row, index) => `
  <button class="sample-row${index === 0 ? ' active' : ''}" type="button" data-index="${index}">
    <span class="row-index">${index + 1}</span>
    <span><strong>${esc(row.date)}</strong><br>${esc(row.title)}</span>
    <span class="${row.audioExists ? 'ok' : 'bad'}">${row.audioExists ? 'ready' : 'missing'}</span>
  </button>
`).join('');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Voice Sequence Review - ${esc(target)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1f2320;
      --muted: #666f68;
      --line: #d7ddd7;
      --soft: #f4f7f3;
      --panel: #fffef9;
      --accent: #0f766e;
      --accent-soft: #e4f7f2;
      --warn: #9a3412;
      --warn-soft: #fff3ec;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--soft);
      color: var(--ink);
      line-height: 1.45;
    }
    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 24px 18px 42px;
    }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      align-items: start;
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      font-size: 25px;
      line-height: 1.15;
      margin: 0 0 8px;
      letter-spacing: 0;
    }
    .meta, .subtle {
      color: var(--muted);
      font-size: 14px;
    }
    code {
      background: #e9eee8;
      border-radius: 5px;
      padding: 2px 5px;
      overflow-wrap: anywhere;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(90px, 1fr));
      gap: 8px;
      min-width: 310px;
    }
    .stat {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 11px;
    }
    .stat strong {
      display: block;
      color: #8f4229;
      font-size: 24px;
      line-height: 1;
      margin-bottom: 4px;
    }
    .review {
      display: grid;
      grid-template-columns: minmax(260px, 330px) minmax(0, 1fr);
      gap: 14px;
      align-items: start;
    }
    .queue, .player-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .queue {
      padding: 8px;
      max-height: calc(100vh - 155px);
      overflow: auto;
      position: sticky;
      top: 12px;
    }
    .sample-row {
      width: 100%;
      display: grid;
      grid-template-columns: 30px minmax(0, 1fr) auto;
      gap: 9px;
      align-items: center;
      text-align: left;
      border: 1px solid transparent;
      border-radius: 7px;
      background: transparent;
      color: var(--ink);
      padding: 9px 8px;
      cursor: pointer;
    }
    .sample-row:hover, .sample-row.active {
      border-color: #99d1c8;
      background: var(--accent-soft);
    }
    .row-index {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      display: inline-grid;
      place-items: center;
      background: #e8ede8;
      font-weight: 700;
      font-size: 13px;
    }
    .ok, .bad {
      border: 1px solid;
      border-radius: 999px;
      padding: 3px 7px;
      font-weight: 700;
      font-size: 12px;
      white-space: nowrap;
    }
    .ok { color: var(--accent); border-color: #98d8cc; background: #eefbf8; }
    .bad { color: var(--warn); border-color: #f0b493; background: var(--warn-soft); }
    .player-card {
      padding: 18px;
      min-height: 520px;
    }
    .player-top {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      align-items: flex-start;
      margin-bottom: 12px;
    }
    h2 {
      font-size: 22px;
      margin: 0 0 5px;
      letter-spacing: 0;
    }
    .counter {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 10px;
      color: var(--muted);
      font-weight: 700;
      white-space: nowrap;
    }
    audio {
      display: block;
      width: 100%;
      margin: 12px 0 14px;
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 10px 0 14px;
    }
    button.main {
      border: 1px solid #7bc5b7;
      background: var(--accent);
      color: white;
      border-radius: 7px;
      padding: 9px 13px;
      font-weight: 750;
      cursor: pointer;
    }
    button.secondary {
      border: 1px solid var(--line);
      background: white;
      color: var(--ink);
      border-radius: 7px;
      padding: 9px 13px;
      font-weight: 700;
      cursor: pointer;
    }
    .sample {
      border-left: 3px solid #c96f3a;
      background: #fbf1e9;
      padding: 11px 13px;
      border-radius: 6px;
      margin-top: 12px;
    }
    .sample h3, .evidence h3 {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0;
      margin: 0 0 6px;
      color: var(--muted);
    }
    .sample p { margin: 0; }
    .evidence {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 12px;
    }
    .evidence div {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 9px 10px;
      background: #fff;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .missing {
      border: 1px solid #f0b493;
      border-radius: 8px;
      padding: 12px;
      color: var(--warn);
      background: var(--warn-soft);
      margin: 12px 0;
    }
    @media (max-width: 860px) {
      header, .review { grid-template-columns: 1fr; }
      .stats { min-width: 0; }
      .queue { position: static; max-height: none; }
      .evidence { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Voice Sequence Review</h1>
        <div class="meta">Target: <code>${esc(target)}</code></div>
        <div class="subtle">Most recent ${byDay.length} call clips from ${selectedDays.size} different days. Use Next to pause the current clip and immediately start the next one.</div>
      </div>
      <div class="stats">
        <div class="stat"><strong>${rows.length}</strong><span>matched tracks</span></div>
        <div class="stat"><strong>${seenCalls.size}</strong><span>distinct calls</span></div>
        <div class="stat"><strong>${playable}/${byDay.length}</strong><span>playable selected</span></div>
      </div>
    </header>
    <section class="review">
      <nav class="queue" aria-label="Samples">
        ${listItems || '<p class="missing">No samples found.</p>'}
      </nav>
      <article class="player-card">
        <div class="player-top">
          <div>
            <h2 id="title"></h2>
            <div id="meta" class="meta"></div>
          </div>
          <div id="counter" class="counter"></div>
        </div>
        <div id="audioSlot"></div>
        <div class="controls">
          <button id="playBtn" class="main" type="button">Play current</button>
          <button id="nextBtn" class="main" type="button">Next</button>
          <button id="prevBtn" class="secondary" type="button">Previous</button>
          <button id="stopBtn" class="secondary" type="button">Stop</button>
        </div>
        <section class="sample">
          <h3>Transcript from this speaker track</h3>
          <p id="sampleText"></p>
        </section>
        <section class="evidence">
          <div><h3>Otter / Track</h3><p id="trackInfo"></p></div>
          <div><h3>Voice Evidence</h3><p id="voiceInfo"></p></div>
        </section>
      </article>
    </section>
  </main>
  <script>
    const samples = ${rowsJson};
    let current = 0;
    let audioEl = null;

    function escText(value) {
      return String(value ?? '');
    }

    function stopAudio(reset = true) {
      if (!audioEl) return;
      audioEl.pause();
      if (reset) {
        try { audioEl.currentTime = 0; } catch {}
      }
    }

    function render(index, autoplay = false) {
      if (!samples.length) return;
      stopAudio(true);
      current = (index + samples.length) % samples.length;
      const s = samples[current];
      document.querySelectorAll('.sample-row').forEach((button) => {
        button.classList.toggle('active', Number(button.dataset.index) === current);
      });
      document.getElementById('title').textContent = (current + 1) + '. ' + s.date + ' - ' + s.title;
      document.getElementById('meta').textContent = 'otid ' + s.otid + ' · Otter label ' + s.label + ' · ' + s.segmentCount + ' segment(s), ' + s.wordCount + ' word(s)';
      document.getElementById('counter').textContent = (current + 1) + ' / ' + samples.length;
      document.getElementById('sampleText').textContent = s.text || '(no transcript text captured for this track)';
      document.getElementById('trackInfo').textContent = 'voice cluster ' + (s.voiceClusterId || 'n/a') + ' · ExampleCo speaker ' + (s.ExampleCoSpeakerId || 'n/a') + ' · tier ' + (s.identityTier || 'n/a');
      const top = s.topMatch || {};
      document.getElementById('voiceInfo').textContent = top.display_name
        ? 'nearest enrolled voice: ' + top.display_name + ' score ' + top.score + ', runner-up ' + (top.runner_up_display_name || 'n/a') + ' score ' + (top.runner_up_score ?? 'n/a') + '. This is not confirmation; this page is reviewing the acoustic ExampleCo arc.'
        : 'No enrolled-person match cleared threshold; reviewing durable ExampleCo voice arc.';
      const slot = document.getElementById('audioSlot');
      if (!s.src) {
        slot.innerHTML = '<div class="missing">No playable audio was generated for this sample.</div>';
        audioEl = null;
        return;
      }
      slot.innerHTML = '<audio id="currentAudio" controls preload="metadata" src="' + s.src.replace(/"/g, '&quot;') + '"></audio>';
      audioEl = document.getElementById('currentAudio');
      audioEl.addEventListener('ended', () => render(current + 1, true));
      if (autoplay) {
        const p = audioEl.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    }

    document.getElementById('nextBtn').addEventListener('click', () => render(current + 1, true));
    document.getElementById('prevBtn').addEventListener('click', () => render(current - 1, true));
    document.getElementById('stopBtn').addEventListener('click', () => stopAudio(true));
    document.getElementById('playBtn').addEventListener('click', () => {
      if (audioEl) audioEl.play().catch(() => {});
    });
    document.querySelectorAll('.sample-row').forEach((button) => {
      button.addEventListener('click', () => render(Number(button.dataset.index), true));
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'n') render(current + 1, true);
      if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'p') render(current - 1, true);
      if (event.key === ' ') {
        event.preventDefault();
        if (audioEl?.paused) audioEl.play().catch(() => {});
        else stopAudio(false);
      }
    });
    render(0, false);
  </script>
</body>
</html>
`;

fs.writeFileSync(outPath, html, 'utf8');
if (legacyOutPath !== outPath) fs.writeFileSync(legacyOutPath, html, 'utf8');
console.log(outPath);
console.log(manifestPath);
