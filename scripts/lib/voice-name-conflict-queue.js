'use strict';

// The owner's voice-name conflict queue (owner decision).
//
// voice-track-name-check.js queues each track whose own voice strongly matches
// a different person than the group name it carried, and releases a few a day.
// This module serves that queue one item at a time (memory
// feedback_one_click_decisions_in_place.md), records each click in an
// append-only ledger, and writes the owner's answer onto that exact track as his
// own per-track decision. Undo puts the track back exactly as it was.

const fs = require('fs');
const path = require('path');
const { callDate, ownerDecidedIdentity, sameCanonicalPerson, setTrackIdentity } = require('./voice-track-name-check');
const { saveJsonAtomic, tryAcquireReclusterPublishLock } = require('./recluster-publish-lock');
const { voiceNamePairKey } = require('./voice-name-pair-policy');
const { clipMarkedBy, markClipMixed, unmarkClipMixed } = require('./voice-owner-mixed-marks');

const PAGE_PATH = '/briefing/voice-name-conflicts';
const ANSWERS = new Set(['name', 'voice', 'neither', 'unsure', 'two_people']);

function queuePaths(dataDir) {
  const vp = path.join(dataDir, 'life-archive', 'voiceprints');
  return {
    queue: path.join(vp, 'voice-name-conflict-queue.json'),
    decisions: path.join(vp, 'voice-name-conflict-decisions.jsonl'),
    latest: path.join(vp, 'recluster-latest.json'),
    enrichedDir: path.join(dataDir, 'otter', 'enriched'),
  };
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readLedger(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** The standing decision per track key, net of undos, plus the order made. */
function liveDecisions(ledger) {
  const live = new Map();
  for (const row of ledger) {
    if (row.type === 'undo') live.delete(row.track_key);
    else if (row.type === 'decision' && row.track_key) {
      live.delete(row.track_key);
      live.set(row.track_key, row);
    }
  }
  return live;
}

/**
 * Registry person aliases (alias -> canonical id), re-read only when the
 * registry file changes. An unreadable registry has no aliases.
 */
const aliasCache = new Map();
function registryAliases(dataDir) {
  const file = path.join(dataDir, 'life-archive', 'voice-identity-registry.json');
  let stamp = '';
  try {
    const stat = fs.statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return {};
  }
  const hit = aliasCache.get(file);
  if (hit && hit.stamp === stamp) return hit.aliases;
  const aliases = readJson(file, {})?.person_id_aliases || {};
  aliasCache.set(file, { stamp, aliases });
  return aliases;
}

/** Released, undecided items (all queued items with `all`), oldest first. */
function pendingItems(dataDir, { all = false, aliases = null } = {}) {
  const p = queuePaths(dataDir);
  const queue = readJson(p.queue, null);
  if (!queue || !Array.isArray(queue.items)) return { available: false, items: [], backlog: 0 };
  const live = liveDecisions(readLedger(p.decisions));
  const personAliases = aliases || registryAliases(dataDir);
  // Both sides naming the same person (an alias included) is not a conflict;
  // never ask about it, even when it was queued before the rule.
  const open = queue.items.filter(
    (i) => !live.has(i.track_key) && !sameCanonicalPerson(i.named_person_id, i.voice_person_id, personAliases)
  );
  const released = open.filter((i) => i.released_at);
  return {
    available: true,
    items: all ? open : released,
    backlog: all ? 0 : open.length - released.length,
  };
}

function pendingCount(dataDir) {
  const { available, items } = pendingItems(dataDir);
  return available ? items.length : null;
}

function appendLedger(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

function withLock(latest, fn, lockOptions) {
  // A request handler must never sleep-wait on the lock: busy means try again.
  const lock = tryAcquireReclusterPublishLock(latest, { retries: 0, ...lockOptions });
  // `retry` tells the page to keep the answer and resend it shortly.
  if (!lock) return { ok: false, status: 409, retry: true, error: 'busy; a voice job is writing, try again in a moment' };
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/*
 * Save and Undo touch three stores: the decision ledger, the call file's
 * track, and (for Two people) the mixed-clip mark ledger. The decision ledger
 * row is written first, as the intent, so the owner's answer is never lost; the
 * mark and the track write follow, each idempotent. A Save or Undo that
 * stopped part way is finished by the next Save, resend, or Undo of that
 * track, so a failed write is never stranded as a 409 or a 404.
 */

function trackOf(p, row) {
  const file = path.join(p.enrichedDir, `${row.otid}.json`);
  const enriched = readJson(file, null);
  return { file, enriched, current: enriched?.speaker_identity_tracks?.[row.label] };
}

/** The call's track carries this exact decision. */
function decisionApplied(current, row) {
  return Boolean(current) && current.owner_track_decision?.decided_at === row.at;
}

/** The call's track is still as it was before this decision was written. */
function trackStillPrior(current, enriched, row) {
  const prior = row.prior_identity || {};
  return (
    Boolean(current) &&
    String(current.person_id || '') === String(prior.person_id || '') &&
    JSON.stringify(current.owner_track_decision || null) === JSON.stringify(prior.owner_track_decision || null) &&
    (row.source_revision === undefined || String(enriched?.source_revision || '') === String(row.source_revision))
  );
}

/**
 * A mark belongs to one decision, not to the track: replaying the Undo of an
 * older decision must never take back the mark of a newer one on the same clip.
 */
function markRef(row) {
  return `${row.track_key}@${row.at}`;
}

/** Finish a standing decision: the mark (Two people) first, then the track. */
function completeDecision(dataDir, p, row) {
  if (row.answer === 'two_people' && row.mixed_clip && !clipMarkedBy(dataDir, row.mixed_clip, markRef(row))) {
    markClipMixed(dataDir, row.mixed_clip, { ref: markRef(row), at: row.at, source: 'voice-name-conflict-queue' });
  }
  if (row.answer === 'unsure' || !row.otid || !row.prior_identity) return { complete: true };
  const { file, enriched, current } = trackOf(p, row);
  if (decisionApplied(current, row)) return { complete: true };
  if (!trackStillPrior(current, enriched, row)) return { complete: false, reason: 'track_changed' };
  const next = ownerDecidedIdentity(current, {
    personId: row.person_id,
    displayName: row.display_name,
    answer: row.answer,
    at: row.at,
    sourceRevision: row.source_revision,
  });
  setTrackIdentity(enriched, row.label, next);
  saveJsonAtomic(file, enriched);
  return { complete: true };
}

/** Finish an undone decision: put the track back, then take back its own mark. */
function completeUndo(dataDir, p, row) {
  if (row.prior_identity && row.otid) {
    const { file, enriched, current } = trackOf(p, row);
    if (decisionApplied(current, row)) {
      setTrackIdentity(enriched, row.label, row.prior_identity);
      saveJsonAtomic(file, enriched);
    }
  }
  if (row.mixed_clip && clipMarkedBy(dataDir, row.mixed_clip, markRef(row))) {
    unmarkClipMixed(dataDir, row.mixed_clip, {
      ref: markRef(row),
      at: new Date().toISOString(),
      source: 'voice-name-conflict-queue',
    });
  }
}

/** Finish whatever an interrupted Save or Undo left half done on one track. */
function recoverTrack(dataDir, p, ledger, trackKey) {
  const standing = liveDecisions(ledger).get(trackKey);
  if (standing) return completeDecision(dataDir, p, standing);
  const last = [...ledger].reverse().find((r) => r.type === 'decision' && r.track_key === trackKey);
  if (last) completeUndo(dataDir, p, last);
  return { complete: true };
}

/**
 * Record the owner's answer for one queued track and write it onto the call.
 * 'name' keeps the group name, 'voice' names the voice's person, 'neither'
 * leaves it unknown, 'unsure' only takes it off the queue, 'two_people' (Two
 * people, skip) names no one, enrolls nothing, and marks the track and its
 * clip as mixed so nothing names or enrolls from them later.
 */
function decide({ dataDir, trackKey, answer, clickId = '', now = new Date(), lockOptions = {} }) {
  if (!ANSWERS.has(answer)) return { ok: false, status: 400, error: 'answer must be name, voice, neither, unsure or two_people' };
  const p = queuePaths(dataDir);
  const item = (readJson(p.queue, {}).items || []).find((i) => i.track_key === trackKey);
  if (!item) return { ok: false, status: 404, error: 'not in the queue' };
  const at = now.toISOString();
  return withLock(
    p.latest,
    () => {
      const ledger = readLedger(p.decisions);
      // An earlier Save or Undo of this track that stopped part way is finished first.
      recoverTrack(dataDir, p, ledger, trackKey);
      const existing = liveDecisions(ledger).get(trackKey);
      const reply = (d) => ({
        ok: true,
        decision: { track_key: trackKey, answer: d.answer, at: d.at, pair_key: d.pair_key || '', pair_effect: d.pair_effect || '' },
      });
      const changedElsewhere = { ok: false, status: 409, error: 'the track changed since this was queued' };
      // A resent click (its first reply was lost) is recognized by its id:
      // it succeeds only while that same decision still stands, and never
      // reinstates one that was undone since.
      const mine = clickId && ledger.find((r) => r.type === 'decision' && r.click_id === clickId);
      if (mine) {
        if (existing && existing.at === mine.at) return reply(existing);
        return { ok: false, status: 409, error: 'this answer was undone elsewhere' };
      }
      // A resend without its id learns the standing answer, as before.
      if (existing) return { ok: false, status: 409, error: 'already decided', answer: existing.answer };
      const row = { type: 'decision', track_key: trackKey, answer, at, source: 'voice-name-conflict-queue' };
      if (clickId) row.click_id = clickId;
      const pairKey = voiceNamePairKey(item.named_person_id, item.voice_person_id);
      if (pairKey && answer !== 'unsure' && answer !== 'two_people' && (item.spot_check || item.pair_held)) {
        row.pair_key = pairKey;
        row.pair_effect = answer === 'voice' ? 'clear' : 'hold';
        row.pair_reason = item.spot_check ? 'daily_quiet_rename_spot_check' : 'held_pair_owner_clearance';
      }
      if (answer !== 'unsure') {
        const { enriched, current } = trackOf(p, item);
        if (!current) return { ok: false, status: 404, error: 'the call no longer has this track' };
        const revision = String(enriched.source_revision || '');
        if (!item.source_revision || String(item.source_revision) !== revision) {
          return { ok: false, status: 409, error: 'the call changed since this was queued' };
        }
        const queuedPerson = item.outcome === 'renamed' ? item.voice_person_id : item.named_person_id;
        if (String(current.person_id || '') !== String(queuedPerson || '')) return changedElsewhere;
        const personId = answer === 'name' ? item.named_person_id : answer === 'voice' ? item.voice_person_id : null;
        const displayName = answer === 'name' ? item.named_display : answer === 'voice' ? item.voice_display : null;
        Object.assign(row, {
          otid: item.otid,
          label: item.label,
          person_id: personId,
          display_name: displayName,
          source_revision: revision,
          prior_identity: current,
        });
        // The clip holds two voices: it never names a track or serves as a reference.
        if (answer === 'two_people') row.mixed_clip = item.track_audio || '';
      }
      // The intent first: once this row is written the owner's answer stands, and
      // a failure below is finished by the resend instead of being lost.
      appendLedger(p.decisions, row);
      const done = completeDecision(dataDir, p, row);
      if (!done.complete) return changedElsewhere;
      return reply(row);
    },
    lockOptions,
  );
}

/**
 * Undo the owner's most recent decision (or the one for `trackKey`): the track goes
 * back to the identity it had before the click, unless something else has
 * written the track since. With `decidedAt` it undoes only that exact
 * decision, and a resend of an Undo that already went through succeeds (and
 * finishes it, when it stopped part way).
 */
function undo({ dataDir, trackKey = '', decidedAt = '', now = new Date(), lockOptions = {} }) {
  const p = queuePaths(dataDir);
  return withLock(
    p.latest,
    () => {
      const ledger = readLedger(p.decisions);
      const live = [...liveDecisions(ledger).values()];
      const target = trackKey ? live.find((d) => d.track_key === trackKey) : live[live.length - 1];
      if (decidedAt && target?.at !== decidedAt) {
        if (ledger.some((r) => r.type === 'undo' && r.track_key === trackKey && r.decided_at === decidedAt)) {
          const undone = ledger.find((r) => r.type === 'decision' && r.track_key === trackKey && r.at === decidedAt);
          if (undone) completeUndo(dataDir, p, undone);
          return { ok: true, track_key: trackKey };
        }
        return { ok: false, status: 409, error: 'that answer was changed elsewhere; it was left as it is' };
      }
      if (!target) return { ok: false, status: 404, error: 'nothing to undo' };
      if (target.prior_identity && target.otid) {
        const { enriched, current } = trackOf(p, target);
        // The track carries this decision, or the Save never got to write it.
        if (!decisionApplied(current, target) && !trackStillPrior(current, enriched, target)) {
          return { ok: false, status: 409, error: 'the track changed since this decision; it was left as it is' };
        }
      }
      // The intent first, then the track and the mark; a resend finishes them.
      appendLedger(p.decisions, { type: 'undo', track_key: target.track_key, decided_at: target.at, at: now.toISOString() });
      completeUndo(dataDir, p, target);
      return { ok: true, track_key: target.track_key };
    },
    lockOptions,
  );
}

function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function audioUrl(rel) {
  return rel ? `/life-archive/voice-audio?path=${encodeURIComponent(rel)}` : '';
}

/** What the page needs per item; no file paths beyond the playable clip. */
function pageItem(item) {
  return {
    key: item.track_key,
    title: item.title || 'Untitled call',
    date: callDate(item.date),
    named: item.named_display || item.named_person_id,
    voice: item.voice_display || item.voice_person_id,
    score: item.score,
    margin: item.margin,
    outcome: item.outcome,
    gate: item.gate || '',
    spotCheck: Boolean(item.spot_check),
    pairHeld: Boolean(item.pair_held),
    spotCheckDay: item.spot_check_day || '',
    purity: item.purity?.verdict || 'unchecked',
    track: audioUrl(item.track_audio),
    namedRef: audioUrl(item.named_ref?.audio),
    voiceRef: audioUrl(item.voice_ref?.audio),
  };
}

function renderPage({ items, backlog = 0, all = false }) {
  const data = JSON.stringify(items.map(pageItem)).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voice name conflicts</title>
<style>
:root { color-scheme: dark; --bg:#0f0f0f; --card:#171717; --line:#2a2a2a; --text:#ececec; --muted:#9a9a9a; --accent:#c8834a; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.45 system-ui, sans-serif; }
main { max-width:720px; margin:0 auto; padding:20px 16px 140px; }
h1 { font-size:20px; margin:0 0 4px; }
.count { color:var(--muted); margin-bottom:16px; }
.slot { min-height:360px; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:18px; }
.face { font-size:18px; cursor:pointer; margin:0 0 6px; }
.meta { color:var(--muted); font-size:14px; margin-bottom:14px; }
.detail { display:none; color:var(--muted); font-size:14px; margin:0 0 14px; }
.detail.open { display:block; }
.clip { margin:10px 0; }
.clip label { display:block; font-size:14px; color:var(--muted); margin-bottom:4px; }
.clip audio { width:100%; }
.none { color:var(--muted); font-size:14px; }
.bar { position:fixed; left:0; right:0; bottom:0; background:#111; border-top:1px solid var(--line); padding:12px 16px; }
.bar-in { max-width:720px; margin:0 auto; display:grid; grid-template-columns:repeat(5, 1fr) auto; gap:8px; }
button { font:inherit; font-size:15px; padding:12px 6px; border-radius:6px; border:1px solid var(--line); background:#1f1f1f; color:var(--text); cursor:pointer; min-height:48px; }
button.primary { border-color:var(--accent); }
button:disabled { opacity:.4; cursor:default; }
.msg { color:var(--accent); font-size:14px; min-height:20px; margin-top:8px; }
@media (max-width:520px) { .bar-in { grid-template-columns:repeat(2, 1fr); } #undo { grid-column:1 / -1; } }
</style></head>
<body><main>
<h1>Voice name conflicts</h1>
<div class="count" id="count"></div>
<section class="slot" id="slot"></section>
<div class="msg" id="msg"></div>
<div class="msg" id="status"></div>
${!all && backlog ? `<p class="none">${backlog} more wait for later days. <a href="${PAGE_PATH}?all=1" style="color:var(--accent)">Show them now</a></p>` : ''}
</main>
<div class="bar"><div class="bar-in">
<button class="primary" id="b-name" data-answer="name"></button>
<button class="primary" id="b-voice" data-answer="voice"></button>
<button id="b-neither" data-answer="neither">Neither</button>
<button id="b-unsure" data-answer="unsure">Not sure</button>
<button id="b-two" data-answer="two_people">Two people, skip</button>
<button id="undo">Undo</button>
</div></div>
<script>
var items = ${data};
var done = [];     // answered items, newest last: { it, answer, sent, at }
var saving = [];   // answers not yet saved, oldest first
var sending = false, waiting = false, undoing = false;
var shown = null, needsGesture = false;
function el(id) { return document.getElementById(id); }
function text(node, value) { node.textContent = value; return node; }
function clip(label, url, id) {
  var box = document.createElement('div'); box.className = 'clip';
  box.appendChild(text(document.createElement('label'), label));
  if (url) {
    var a = document.createElement('audio'); a.controls = true; a.preload = id ? 'auto' : 'none'; a.src = url;
    if (id) a.id = id;
    box.appendChild(a);
  } else box.appendChild(text(document.createElement('div'), 'No clip available')).className = 'none';
  return box;
}
// One clip plays at a time.
document.addEventListener('play', function (e) {
  document.querySelectorAll('audio').forEach(function (a) { if (a !== e.target) a.pause(); });
}, true);
function playTrack() {
  var a = el('track-audio'); if (!a) return;
  var p = a.play();
  if (p && p.catch) p.catch(function () { needsGesture = true; });
}
// Chrome blocks sound until the first click or tap on the page; play then.
document.addEventListener('click', function (e) {
  if (needsGesture && !e.target.closest('button,audio')) { needsGesture = false; playTrack(); }
}, true);
function controls() {
  var it = items[0];
  text(el('count'), items.length ? items.length + ' left' : '');
  ['b-name', 'b-voice', 'b-neither', 'b-unsure', 'b-two'].forEach(function (id) { el(id).disabled = !it || undoing; });
  el('undo').disabled = !done.length || undoing;
  if (it) { text(el('b-name'), 'Group label: ' + it.named); text(el('b-voice'), 'Track voice: ' + it.voice); }
  else { text(el('b-name'), 'Name'); text(el('b-voice'), 'Voice'); }
  text(el('status'), undoing ? 'Undoing' + (waiting ? '; a voice job is writing, retrying' : '')
    : saving.length ? 'Saving ' + saving.length + (saving.length > 1 ? ' answers' : ' answer') + (waiting ? '; a voice job is writing, retrying' : '') : '');
}
function render() {
  controls();
  var it = items[0];
  if (shown === (it ? it.key : '')) return;
  shown = it ? it.key : '';
  var slot = el('slot');
  slot.querySelectorAll('audio').forEach(function (a) { a.pause(); });
  slot.innerHTML = '';
  if (!it) { slot.appendChild(text(document.createElement('p'), 'All decided.')).className = 'face'; return; }
  var face = text(document.createElement('p'), (it.spotCheck ? 'Spot check: ' : '') + 'The voice group label said ' + it.named + ', while this track sounds like ' + it.voice + '. Who is it?');
  face.className = 'face';
  var detail = document.createElement('div'); detail.className = 'detail';
  detail.textContent = (it.outcome === 'renamed'
    ? 'Amy quietly renamed this checked single-voice track to ' + it.voice + '. '
    : 'Amy kept ' + it.named + ' but marked it probable (' + it.gate.replace(/_/g, ' ') + '). ')
    + 'Both sides come from voice evidence. Purity check: ' + it.purity.replace(/_/g, ' ') + '. Voice match ' + it.score + ', ahead of the next person by ' + it.margin + '. Your answer fixes this one track and teaches the reference voices.';
  face.onclick = function () { detail.classList.toggle('open'); };
  slot.appendChild(face);
  slot.appendChild(text(document.createElement('div'), it.title + (it.date ? ' · ' + it.date : ''))).className = 'meta';
  slot.appendChild(detail);
  slot.appendChild(clip('This track', it.track, 'track-audio'));
  slot.appendChild(clip(it.named + ' reference voice', it.namedRef));
  slot.appendChild(clip(it.voice + ' reference voice', it.voiceRef));
  playTrack();
}
function post(url, body) {
  return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); })
    .catch(function () { return { ok: false, retry: true, error: 'Not saved: no connection' }; });
}
// Saves answers in click order. A busy voice job only delays a save; the owner's
// click is kept and resent until the lock frees.
function pump() {
  if (sending || waiting || !saving.length) return;
  var d = saving[0];
  sending = true; d.sent = true;
  post('${PAGE_PATH}/decide', { trackKey: d.it.key, answer: d.answer, clickId: d.id }).then(function (r) {
    sending = false;
    if (r.ok) {
      saving.shift(); d.at = r.decision.at;
      if (d.undoAfterSave) undoSaved(d);
    }
    else if (r.retry) { waiting = true; setTimeout(function () { waiting = false; pump(); }, 2000); }
    else {
      saving.shift(); done.splice(done.indexOf(d), 1); items.unshift(d.it);
      if (d.undoAfterSave) undoing = false;
      text(el('msg'), (r.error === 'already decided' ? 'Already answered "' + r.answer + '" elsewhere' : r.error || 'Not saved')
        + ' (' + d.it.named + ' / ' + d.it.voice + ' is back on top)');
    }
    render(); pump();
  });
}
document.querySelectorAll('[data-answer]').forEach(function (b) {
  b.onclick = function () {
    var it = items[0]; if (!it || undoing) return;
    var d = { it: it, answer: b.getAttribute('data-answer'), id: Date.now().toString(36) + Math.random().toString(36).slice(2), sent: false, at: '' };
    text(el('msg'), '');
    items.shift(); done.push(d); saving.push(d);
    render(); pump();
  };
});
function undoSaved(d) {
  post('${PAGE_PATH}/undo', { trackKey: d.it.key, decidedAt: d.at }).then(function (r) {
    if (r.retry) { waiting = true; controls(); setTimeout(function () { waiting = false; undoSaved(d); }, 2000); return; }
    undoing = false;
    if (r.ok) { done.splice(done.indexOf(d), 1); items.unshift(d.it); text(el('msg'), ''); } else text(el('msg'), r.error || 'Undo failed');
    render();
  });
}
el('undo').onclick = function () {
  var d = done[done.length - 1]; if (!d || undoing) return;
  text(el('msg'), '');
  if (!d.sent) {
    // Never sent: just take it back.
    saving.splice(saving.indexOf(d), 1); done.pop(); items.unshift(d.it);
    render(); return;
  }
  undoing = true; render();
  // Mid-save: the Undo runs as soon as the save is acknowledged.
  if (!d.at) d.undoAfterSave = true; else undoSaved(d);
};
window.addEventListener('beforeunload', function (e) { if (saving.length || undoing) { e.preventDefault(); e.returnValue = ''; } });
render();
</script>
</body></html>`;
}

/** Board button: red while decisions wait. */
function conflictButtonHtml(pending, { className = 'top-btn' } = {}) {
  const known = Number.isFinite(pending);
  const label = known && pending ? `Voice name conflicts (${pending} waiting)` : 'Voice name conflicts';
  const cls = `${className} voice-name-conflict-btn${known && pending ? ' voice-review-btn-pending' : ''}`;
  return `<a class="${esc(cls)}" href="${PAGE_PATH}" target="_blank" rel="noopener" data-voice-name-conflicts="${known ? pending : 'unknown'}">${esc(label)}</a>`;
}

module.exports = {
  ANSWERS,
  PAGE_PATH,
  conflictButtonHtml,
  decide,
  liveDecisions,
  pageItem,
  pendingCount,
  pendingItems,
  queuePaths,
  readLedger,
  renderPage,
  undo,
};
