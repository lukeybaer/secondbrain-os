const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const DEFAULT_REGISTRY = path.resolve(__dirname, '..', '..', 'config', 'approved-music.json');
const DEFAULT_CANDIDATES = path.resolve(__dirname, '..', '..', 'config', 'music-review-candidates.json');
const VALID_ACTIONS = new Set(['keep', 'reject', 'delete']);
const previewCache = new Map();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function titleFromFilename(filename) {
  return filename.replace(/\.mp3$/i, '').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function approvedTrack(filename, row, kind) {
  const isLocal = kind === 'builder';
  return {
    id: `approved:${filename}`,
    filename,
    title: row.title || titleFromFilename(filename),
    artist: row.artist || (isLocal ? 'Amy approved music bank' : 'Unknown artist'),
    group: 'approved',
    badge: isLocal ? 'APPROVED · IN VIDEO BANK' : 'APPROVED · COMMERCIAL REFERENCE',
    style: /instrumental|ambient|piano|orchestral|cinematic|lullaby|lofi|trap|futuristic/i.test(`${row.vibe || ''} ${row.title || ''}`) ? 'sound-effect' : 'lyrics',
    why: row.vibe || 'Previously approved for Amy video use.',
    bestFor: Array.isArray(row.best_for) ? row.best_for.join(' · ') : '',
    source: row.approval_source || 'Canonical approved music bank',
    evidenceUrl: row.reference_url || row.release_reference_url || '',
    preview: isLocal
      ? { kind: 'local', url: `/briefing/music-review/audio?id=${encodeURIComponent(`approved:${filename}`)}` }
      : { kind: 'apple-search', query: `${row.title || titleFromFilename(filename)} ${row.artist || ''}`.trim() },
  };
}

function buildMusicReviewCatalog({ registryPath = DEFAULT_REGISTRY, candidatesPath = DEFAULT_CANDIDATES } = {}) {
  const bank = readJson(registryPath);
  const candidates = readJson(candidatesPath);
  const approved = [];
  // A kept review candidate stays on its candidate row, whichever bank section holds it.
  const reviewedIds = new Set((candidates.tracks || []).map((row) => row.id));
  for (const [filename, row] of Object.entries(bank.tracks || {})) {
    if (row.review_candidate_id && reviewedIds.has(row.review_candidate_id)) continue;
    if (row.owner_approval === 'approved') approved.push(approvedTrack(filename, row, 'builder'));
  }
  // A reference promoted from a reviewed candidate keeps that candidate's row
  // (and its saved decision) instead of reappearing as a second, undecided track.
  const candidateIds = new Set((candidates.tracks || []).map((row) => row.id));
  for (const [filename, row] of Object.entries(bank.reference_tracks || {})) {
    if (row.review_candidate_id && candidateIds.has(row.review_candidate_id)) continue;
    if (row.creative_approval === 'approved') approved.push(approvedTrack(filename, row, 'reference'));
  }
  const fresh = (candidates.tracks || []).map((row) => ({
    id: `candidate:${row.id}`,
    title: row.title,
    artist: row.artist,
    group: 'candidate',
    badge: `NEW · CURRENT VIRAL · ${row.style === 'sound-effect' ? 'EFFECT-STYLE' : 'LYRICS'}`,
    style: row.style,
    why: row.why,
    bestFor: row.style === 'sound-effect' ? 'Pattern interrupts · reveals · fast edits' : 'Hooks · story beats · emotional edits',
    source: `Trend evidence checked ${candidates.researched_on}`,
    evidenceUrl: row.evidence_url,
    preview: { kind: 'apple-search', query: row.preview_query },
  }));
  if (fresh.length !== 30) throw new Error(`music review requires exactly 30 candidates; found ${fresh.length}`);
  const all = [...approved, ...fresh];
  if (new Set(all.map((row) => row.id)).size !== all.length) throw new Error('music review track ids must be unique');
  return all;
}

function reviewDir(dataDir) {
  return path.join(dataDir, 'agent', 'music-review');
}

function decisionPath(dataDir) {
  return path.join(reviewDir(dataDir), 'decisions.jsonl');
}

function readDecisionRows(dataDir) {
  const file = decisionPath(dataDir);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.track_id === 'string' && VALID_ACTIONS.has(row.action)) rows.push(row);
    } catch {}
  }
  return rows;
}

function musicReviewState({ dataDir, catalog = buildMusicReviewCatalog() }) {
  const rows = readDecisionRows(dataDir);
  const decisions = {};
  // A track retired from the bank keeps its row in the ledger but no longer
  // counts toward this catalog's progress.
  const ids = new Set(catalog.map((track) => track.id));
  for (const row of rows) if (ids.has(row.track_id)) decisions[row.track_id] = row;
  const pending = catalog.filter((track) => !decisions[track.id]);
  const counts = { keep: 0, reject: 0, delete: 0 };
  for (const row of Object.values(decisions)) counts[row.action] += 1;
  return { pending, decisions, counts, total: catalog.length, reviewed: catalog.length - pending.length };
}

function recordMusicReviewDecision({ dataDir, catalog = buildMusicReviewCatalog(), input, now = new Date() }) {
  const decisionId = String(input?.decisionId || '').trim();
  const trackId = String(input?.trackId || '').trim();
  const action = String(input?.action || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{8,100}$/i.test(decisionId)) throw new Error('invalid decision id');
  if (!VALID_ACTIONS.has(action)) throw new Error('action must be keep, reject, or delete');
  const track = catalog.find((row) => row.id === trackId);
  if (!track) throw new Error('unknown music track');
  const prior = readDecisionRows(dataDir).find((row) => row.decision_id === decisionId);
  if (prior) return { created: false, row: prior, state: musicReviewState({ dataDir, catalog }) };

  const row = {
    schema_version: 1,
    decision_id: decisionId,
    track_id: track.id,
    action,
    decided_at: now.toISOString(),
    track: { title: track.title, artist: track.artist, group: track.group, filename: track.filename || null },
  };
  const dir = reviewDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(decisionPath(dataDir), 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(row)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { created: true, row, state: musicReviewState({ dataDir, catalog }) };
}

function resolveApprovedAudioPath({ trackId, catalog = buildMusicReviewCatalog(), roots }) {
  const track = catalog.find((row) => row.id === trackId && row.preview.kind === 'local');
  if (!track || !/^[a-z0-9_.-]+\.mp3$/i.test(track.filename || '')) return null;
  for (const root of roots || []) {
    const base = path.resolve(root);
    const candidate = path.resolve(base, track.filename);
    if (candidate.startsWith(base + path.sep) && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function requestJson(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'SecondBrain-Music-Review/1.0' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 1024 * 1024) body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('preview provider unavailable'));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('preview provider returned invalid data')); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('preview lookup timed out')));
    req.on('error', reject);
  });
}

function previewMatchScore(track, row) {
  const normalize = (value) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const expectedTitle = normalize(track.title);
  const expectedArtist = normalize(track.artist);
  const title = normalize(row.trackName);
  const artist = normalize(row.artistName);
  const tokens = (value) => new Set(value.split(' ').filter((word) => word.length > 1 && !['feat', 'featuring', 'the', 'and', 'remix', 'edit', 'presents'].includes(word)));
  const overlap = (expected, actual) => [...tokens(expected)].filter((word) => tokens(actual).has(word)).length;
  const imitationPenalty = /\b(?:karaoke|in the style of|tribute)\b/i.test(`${row.trackName} ${row.artistName}`) ? 200 : 0;
  return (title === expectedTitle ? 150 : 0) + overlap(expectedTitle, title) * 10 + overlap(expectedArtist, `${artist} ${title}`) * 25 - imitationPenalty;
}

function previewIdentityMatches(track, row) {
  const normalize = (value) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const baseTitle = (value) => normalize(String(value || '').replace(/\s*[\[(][^\])]*(?:feat(?:uring)?\.?|radio edit|remix|edit)[^\])]*[\])]/gi, ''));
  const tokens = (value) => new Set(normalize(value).split(' ').filter((word) => word.length > 1 && !['feat', 'featuring', 'the', 'and', 'remix', 'edit', 'presents'].includes(word)));
  const expectedTitleTokens = tokens(track.title);
  const titleOverlap = [...expectedTitleTokens].filter((word) => tokens(row.trackName).has(word)).length;
  const artistOverlap = [...tokens(track.artist)].filter((word) => tokens(`${row.artistName} ${row.trackName}`).has(word)).length;
  const exactTitle = normalize(track.title) === normalize(row.trackName);
  const exactBaseTitle = baseTitle(track.title) === baseTitle(row.trackName);
  const titleCoverage = expectedTitleTokens.size ? titleOverlap / expectedTitleTokens.size : 0;
  return (exactTitle && (artistOverlap > 0 || expectedTitleTokens.size >= 4)) ||
    (exactBaseTitle && artistOverlap > 0) ||
    (titleCoverage >= 0.75 && artistOverlap > 0);
}

function applePreviewRows(payload) {
  return (payload.results || []).map((row) => ({
    trackName: row.trackName || '',
    artistName: row.artistName || '',
    previewUrl: row.previewUrl || '',
    artworkUrl: String(row.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
    externalUrl: row.trackViewUrl || '',
  }));
}

function deezerPreviewRows(payload) {
  return (payload.data || []).map((row) => ({
    trackName: row.title || '',
    artistName: row.artist?.name || '',
    previewUrl: row.preview || '',
    artworkUrl: row.album?.cover_xl || row.album?.cover_big || '',
    externalUrl: row.link || '',
  }));
}

async function resolveCommercialPreview({ trackId, catalog = buildMusicReviewCatalog(), request = requestJson }) {
  const track = catalog.find((row) => row.id === trackId && row.preview.kind === 'apple-search');
  if (!track) throw new Error('track has no commercial preview lookup');
  if (previewCache.has(track.id)) return previewCache.get(track.id);
  const query = encodeURIComponent(track.preview.query);
  const providers = [
    { url: `https://api.deezer.com/search?q=${query}&limit=25`, rows: deezerPreviewRows },
    { url: `https://itunes.apple.com/search?entity=song&limit=50&country=US&term=${query}`, rows: applePreviewRows },
  ];
  let match = null;
  for (const provider of providers) {
    try {
      const payload = await request(provider.url);
      match = provider.rows(payload)
        .filter((row) => row.previewUrl && previewIdentityMatches(track, row))
        .sort((left, right) => previewMatchScore(track, right) - previewMatchScore(track, left))[0] || null;
    } catch {}
    if (match) break;
  }
  if (!match) throw new Error('no playable preview found');
  const resolved = {
    previewUrl: match.previewUrl,
    artworkUrl: match.artworkUrl || '',
    externalUrl: match.externalUrl || track.evidenceUrl || '',
    matchedTitle: match.trackName || '',
    matchedArtist: match.artistName || '',
  };
  previewCache.set(track.id, resolved);
  return resolved;
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
}

function renderMusicReviewHtml({ catalog = buildMusicReviewCatalog() } = {}) {
  const approvedCount = catalog.filter((row) => row.group === 'approved').length;
  const candidateCount = catalog.filter((row) => row.group === 'candidate').length;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Amy Music Review</title><meta name="description" content="Fast one-track-at-a-time review of Amy's approved music bank and 30 current viral candidates.">
<style>
:root{color-scheme:dark;--ink:#f7f5ef;--muted:#a6a39c;--line:rgba(255,255,255,.12);--lime:#c9ff63;--rose:#ff6f91;--amber:#ffbf5f;--bg:#080909}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 70% 15%,#263514 0,transparent 30%),radial-gradient(circle at 5% 85%,#31131f 0,transparent 28%),var(--bg);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;min-height:100vh}.shell{width:min(1120px,100%);margin:auto;padding:28px 24px 64px}header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:18px}.brand{font-size:13px;font-weight:900;letter-spacing:.18em}.brand b{color:var(--lime)}.progress{font-variant-numeric:tabular-nums;color:var(--muted);font-size:14px}.bar{height:3px;background:rgba(255,255,255,.1);margin:18px 0 38px;border-radius:9px;overflow:hidden}.bar i{display:block;background:var(--lime);height:100%;width:0;transition:width .35s ease}.stage{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(300px,.9fr);gap:42px;align-items:center;min-height:620px}.art{aspect-ratio:1;border:1px solid var(--line);border-radius:28px;background:linear-gradient(145deg,#222,#0e0f0f);position:relative;overflow:hidden;display:grid;place-items:center;box-shadow:0 30px 90px rgba(0,0,0,.45)}.art:before,.art:after{content:"";position:absolute;border-radius:50%;filter:blur(2px)}.art:before{width:70%;height:70%;background:linear-gradient(135deg,var(--lime),transparent 70%);opacity:.32;top:-25%;right:-15%}.art:after{width:55%;height:55%;background:linear-gradient(135deg,var(--rose),transparent 72%);opacity:.28;bottom:-20%;left:-10%}.disc{width:54%;aspect-ratio:1;border-radius:50%;background:repeating-radial-gradient(circle,#111 0 7px,#222 8px 10px);display:grid;place-items:center;box-shadow:0 12px 50px #000;transition:transform .3s}.playing .disc{animation:spin 7s linear infinite}.disc i{width:29%;aspect-ratio:1;border-radius:50%;background:var(--lime);box-shadow:0 0 0 12px #151515}.cover{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.5;mix-blend-mode:screen}.play{position:absolute;bottom:24px;left:24px;right:24px;border:0;border-radius:999px;padding:16px;background:rgba(8,9,9,.78);backdrop-filter:blur(14px);color:white;font-weight:800;cursor:pointer}.copy{position:relative}.badge{display:inline-block;color:var(--lime);font-weight:900;font-size:11px;letter-spacing:.12em;border:1px solid rgba(201,255,99,.35);padding:7px 10px;border-radius:99px;margin:0 0 20px}.counter{font-size:13px;color:var(--muted);margin:0 0 10px}.copy h1{font-size:clamp(42px,6vw,76px);line-height:.93;letter-spacing:-.055em;margin:0 0 13px}.artist{font-size:22px;color:#d4d0c8;margin:0 0 28px}.why{font-size:17px;line-height:1.55;color:#c2bfb8;margin:0 0 10px}.best{font-size:13px;color:var(--muted);margin:0 0 30px}.actions{display:grid;grid-template-columns:1.15fr 1fr 1fr;gap:10px}.actions button{border:1px solid var(--line);border-radius:15px;padding:17px 10px;background:#151717;color:white;font-weight:900;font-size:14px;cursor:pointer}.actions button:hover{transform:translateY(-2px)}.actions .keep{background:var(--lime);color:#111}.actions .reject:hover{border-color:var(--rose)}.actions .delete{color:#bbb}.source{display:inline-block;color:var(--muted);font-size:12px;margin-top:20px;text-underline-offset:3px}.notice{min-height:24px;color:var(--amber);font-size:13px;margin-top:12px}.summary{display:none;text-align:center;padding:110px 20px}.summary h1{font-size:60px;margin:0 0 15px}.summary p{color:var(--muted);font-size:18px}.stats{display:flex;justify-content:center;gap:12px;margin-top:28px}.stats b{border:1px solid var(--line);padding:14px 18px;border-radius:12px}.saving{pointer-events:none;opacity:.62}.exit{animation:exit .18s ease forwards}@keyframes spin{to{transform:rotate(360deg)}}@keyframes exit{to{opacity:0;transform:translateX(-20px)}}@media(max-width:800px){.shell{padding:20px 16px 40px}.stage{grid-template-columns:1fr;gap:24px;min-height:auto}.art{aspect-ratio:1.25}.copy h1{font-size:46px}.actions{position:sticky;bottom:10px;z-index:5;background:rgba(8,9,9,.86);backdrop-filter:blur(15px);padding:10px;border-radius:20px}.actions button{padding:15px 5px}}
</style></head><body><main class="shell"><header><div class="brand">AMY <b>/// MUSIC LAB</b></div><div class="progress" id="progress">Loading…</div></header><div class="bar"><i id="bar"></i></div>
<section class="stage" id="stage"><div class="art" id="art"><img id="cover" class="cover" alt="" hidden><div class="disc"><i></i></div><button class="play" id="play" type="button">▶ Play preview</button></div><div class="copy" id="copy"><p class="counter" id="counter"></p><p class="badge" id="badge"></p><h1 id="title"></h1><p class="artist" id="artist"></p><p class="why" id="why"></p><p class="best" id="best"></p><div class="actions"><button class="keep" data-action="keep">✓ Keep</button><button class="reject" data-action="reject">× Reject</button><button class="delete" data-action="delete">Delete</button></div><a class="source" id="source" target="_blank" rel="noopener">View trend / approval source ↗</a><p class="notice" id="notice" role="status"></p></div></section>
<section class="summary" id="summary"><h1>Review complete.</h1><p>Every decision is saved. Amy can now apply the Keep list to future video builds.</p><div class="stats"><b id="kept"></b><b id="rejected"></b><b id="deleted"></b></div></section><audio id="audio" preload="auto"></audio></main>
<script>const CATALOG=${safeJson(catalog)};const COUNTS={approved:${approvedCount},candidate:${candidateCount},total:${catalog.length}};let queue=[];let decisions={};let current=0;let busy=false;const previewCache=new Map();const audio=document.getElementById('audio');const stage=document.getElementById('stage');const art=document.getElementById('art');const notice=document.getElementById('notice');
function uid(){return 'music-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,12)}
function currentTrack(){return queue[current]||null}
function progress(){const reviewed=Object.keys(decisions).length;document.getElementById('progress').textContent=reviewed+' reviewed · '+queue.length+' left · '+COUNTS.total+' tracks';document.getElementById('bar').style.width=Math.round(reviewed/COUNTS.total*100)+'%'}
async function previewFor(track){if(track.preview.kind==='local')return{previewUrl:track.preview.url,artworkUrl:'',externalUrl:track.evidenceUrl};if(previewCache.has(track.id))return previewCache.get(track.id);const response=await fetch('/briefing/music-review/preview?id='+encodeURIComponent(track.id),{cache:'force-cache'});if(!response.ok)throw new Error('Preview unavailable for this track. Use the source link to listen.');const result=await response.json();previewCache.set(track.id,result);return result}
async function setAudio(track,autoplay){audio.pause();art.classList.remove('playing');document.getElementById('cover').hidden=true;try{const preview=await previewFor(track);if(currentTrack()?.id!==track.id)return;audio.src=preview.previewUrl;const cover=document.getElementById('cover');if(preview.artworkUrl){cover.src=preview.artworkUrl;cover.hidden=false}if(preview.externalUrl&&!track.evidenceUrl)document.getElementById('source').href=preview.externalUrl;if(autoplay){await audio.play();art.classList.add('playing');document.getElementById('play').textContent='Ⅱ Pause preview'}}catch(error){notice.textContent=error.message||'Preview unavailable.'}}
function render(autoplay=false){progress();const track=currentTrack();if(!track){stage.style.display='none';const summary=document.getElementById('summary');summary.style.display='block';const values=Object.values(decisions);document.getElementById('kept').textContent=values.filter(x=>x.action==='keep').length+' kept';document.getElementById('rejected').textContent=values.filter(x=>x.action==='reject').length+' rejected';document.getElementById('deleted').textContent=values.filter(x=>x.action==='delete').length+' deleted';return}notice.textContent='';document.getElementById('counter').textContent='TRACK '+(Object.keys(decisions).length+1)+' OF '+COUNTS.total+' · '+(track.group==='approved'?COUNTS.approved+' PRE-APPROVED':COUNTS.candidate+' NEW CANDIDATES');document.getElementById('badge').textContent=track.badge;document.getElementById('title').textContent=track.title;document.getElementById('artist').textContent=track.artist;document.getElementById('why').textContent=track.why;document.getElementById('best').textContent=track.bestFor;const source=document.getElementById('source');source.href=track.evidenceUrl||'#';source.hidden=!track.evidenceUrl;setAudio(track,autoplay);if(queue[1])previewFor(queue[1]).catch(()=>{})}
async function decide(action){if(busy||!currentTrack())return;busy=true;const track=currentTrack();const priorQueue=queue.slice();const decisionId=uid();queue=queue.slice(1);current=0;decisions[track.id]={action,decision_id:decisionId};render(queue.length>0);try{const response=await fetch('/briefing/music-review/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decisionId,trackId:track.id,action})});if(!response.ok)throw new Error('save failed');const saved=await response.json();decisions=saved.state.decisions;queue=saved.state.pending;progress()}catch{queue=priorQueue;delete decisions[track.id];render(false);notice.textContent='That choice was not saved. Please tap it again.'}finally{busy=false}}
async function playCurrent(force=false){const track=currentTrack();if(!track)return;if(!force&&!audio.paused){audio.pause();art.classList.remove('playing');document.getElementById('play').textContent='▶ Play preview';return}await setAudio(track,true)}
document.getElementById('play').addEventListener('click',()=>playCurrent());document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>decide(button.dataset.action)));audio.addEventListener('ended',()=>{audio.currentTime=0;audio.play().catch(()=>{})});
fetch('/briefing/music-review/state',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error();return r.json()}).then(state=>{queue=state.pending;decisions=state.decisions;render(false)}).catch(()=>{queue=CATALOG;render(false);notice.textContent='Saved decisions could not be loaded. Review is paused to protect your choices.';document.querySelector('.actions').classList.add('saving')});</script></body></html>`;
}

module.exports = {
  buildMusicReviewCatalog,
  musicReviewState,
  recordMusicReviewDecision,
  renderMusicReviewHtml,
  resolveApprovedAudioPath,
  resolveCommercialPreview,
};
