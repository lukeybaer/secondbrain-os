/**
 * otter-speaker-transcript.js, speaker-labeled call transcript for answering
 * questions about a call.
 *
 * The raw Otter transcript is one block of text with no speaker labels, so a
 * model reading it has to infer who said what. This module joins the enriched
 * call segments with the call ledger roster and labels every turn with the
 * strongest identity evidence available:
 *
 *   confirmed  ledger roster confirmed the voice (voiceprint match or ExampleCo's
 *              confirmation). Only these may be quoted as "X said".
 *   guess      a current, receipt-backed name hypothesis. Shown as a guess.
 *   unnamed    everything else, shown as "[speaker not named]" plus a voice
 *              letter so two lines from the same unnamed voice stay linked.
 *
 * A conflict between the ledger and the segment tags fails closed to unnamed.
 */

const UNNAMED = '[speaker not named]';

function exactCurrentHypothesis(row = {}) {
  return Boolean(
    row.status === 'suggested_name' &&
      row.coverage_complete === true &&
      row.best_name &&
      row.receipt_id &&
      row.evidence_basis === 'exact_current_revision_naming_receipt',
  );
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function voiceLetter(index) {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function trackIdentity(segments) {
  const byLabel = new Map();
  for (const segment of segments) {
    const label = String(segment?.speaker_model_label ?? segment?.resolved_speaker?.otter_speaker ?? '');
    if (!label) continue;
    const entry = byLabel.get(label) || { label, words: 0, first: Infinity, tiers: new Map() };
    entry.words += Number(segment.word_count) || String(segment.text || '').split(/\s+/).filter(Boolean).length;
    entry.first = Math.min(entry.first, Number(segment.start_seconds) || 0);
    const rs = segment.resolved_speaker || {};
    const key = `${rs.identity_tier || ''}|${rs.resolved_person || ''}`;
    const tier = entry.tiers.get(key) || { tier: rs.identity_tier || null, person: rs.resolved_person || null, score: null, count: 0 };
    tier.count += 1;
    const score = Number(rs.voice_embedding_match?.score ?? rs.confidence);
    if (Number.isFinite(score) && rs.identity_tier === 'confirmed_reference_voiceprint_match') tier.score = score;
    entry.tiers.set(key, tier);
    byLabel.set(label, entry);
  }
  for (const entry of byLabel.values()) {
    entry.top = [...entry.tiers.values()].sort((a, b) => b.count - a.count)[0] || {};
  }
  return byLabel;
}

function confirmedBasis(top) {
  if (top.tier === 'confirmed_reference_voiceprint_match') {
    return top.score != null ? `voiceprint match ${top.score.toFixed(2)}` : 'voiceprint match';
  }
  if (top.tier === 'confirmed_by_ExampleCo_cluster') return 'ExampleCo confirmed this voice';
  return 'confirmed in the call roster';
}

/**
 * Decide one identity per speaker track.
 * @returns {Map<string, object>} label -> speaker
 */
function resolveSpeakers(segments, roster = {}) {
  const tracks = trackIdentity(segments);
  const known = new Map((roster.known || []).map((row) => [String(row.label), row]));
  const guesses = new Map(
    (roster.hypotheses || []).filter(exactCurrentHypothesis).map((row) => [String(row.label), row]),
  );
  const speakers = new Map();
  const ordered = [...tracks.values()].sort((a, b) => a.first - b.first);
  let unnamedCount = 0;
  for (const track of ordered) {
    const top = track.top;
    const segmentConfirmed = /^confirmed/.test(String(top.tier || '')) && top.person;
    const knownRow = known.get(track.label);
    const guessRow = guesses.get(track.label);
    let speaker = null;
    if (knownRow) {
      const name = knownRow.display_name || String(knownRow.target || '').replace(/^person:/, '');
      if (segmentConfirmed && top.person !== name) {
        speaker = { kind: 'unnamed', note: `roster says ${name}, voice tags say ${top.person}; left unnamed` };
      } else {
        speaker = { kind: 'confirmed', name, basis: confirmedBasis(top) };
      }
    } else if (segmentConfirmed && !guessRow) {
      speaker = { kind: 'confirmed', name: top.person, basis: confirmedBasis(top) };
    } else if (guessRow) {
      const confidence = Number(guessRow.confidence);
      speaker = {
        kind: 'guess',
        name: guessRow.best_name,
        basis: 'name heard in the conversation, no voice match',
        confidence: Number.isFinite(confidence) && guessRow.confidence !== '' ? confidence : null,
      };
    } else {
      speaker = { kind: 'unnamed' };
      if (top.tier === 'non_speech_audio_artifact') speaker.note = 'may be background audio';
    }
    if (speaker.kind === 'unnamed') speaker.voice = voiceLetter(unnamedCount++);
    speakers.set(track.label, { label: track.label, words: track.words, ...speaker });
  }
  return speakers;
}

function displayName(speaker) {
  if (!speaker) return UNNAMED;
  if (speaker.kind === 'confirmed') return speaker.name;
  if (speaker.kind === 'guess') return `${speaker.name} (guess)`;
  return `${UNNAMED} (voice ${speaker.voice})`;
}

/**
 * Build the labeled transcript: consecutive segments by the same track merge
 * into one turn.
 */
function buildSpeakerTranscript({ enriched = {}, roster = {} } = {}) {
  const segments = (Array.isArray(enriched.segments) ? enriched.segments : [])
    .filter((segment) => String(segment?.text || '').trim())
    .slice()
    .sort((a, b) => (Number(a.start_seconds) || 0) - (Number(b.start_seconds) || 0));
  const speakers = resolveSpeakers(segments, roster);
  const turns = [];
  for (const segment of segments) {
    const label = String(segment.speaker_model_label ?? segment.resolved_speaker?.otter_speaker ?? '');
    const text = String(segment.text).trim();
    const last = turns[turns.length - 1];
    if (last && last.label === label) {
      last.text += ' ' + text;
      last.end = Number(segment.end_seconds) || last.end;
      continue;
    }
    turns.push({
      label,
      start: Number(segment.start_seconds) || 0,
      end: Number(segment.end_seconds) || 0,
      text,
    });
  }
  for (const turn of turns) {
    const speaker = speakers.get(turn.label) || { kind: 'unnamed', voice: '?' };
    turn.kind = speaker.kind;
    turn.speaker = displayName(speaker);
  }
  const startTime = Number(enriched.start_time);
  return {
    otid: enriched.otid || null,
    title: enriched.title || '(untitled)',
    started_at: Number.isFinite(startTime) && startTime > 0 ? new Date(startTime * 1000).toISOString() : null,
    duration_sec: Number(enriched.duration_sec) || 0,
    speakers: [...speakers.values()].sort((a, b) => b.words - a.words),
    turns,
  };
}

const ANSWER_RULES = [
  'Say "X said" only for CONFIRMED speakers.',
  'For a GUESS, say "probably X" and note it is a guess.',
  `Never attribute a ${UNNAMED} line to anyone, even if the context suggests who it was.`,
  'Cite the [time] of each line you rely on.',
  'If the transcript does not answer the question, say so.',
];

function ctDate(iso) {
  if (!iso) return 'date unknown';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    dateStyle: 'medium',
    timeStyle: 'short',
  }) + ' CT';
}

function speakerLine(speaker) {
  const words = `${speaker.words} word${speaker.words === 1 ? '' : 's'}`;
  if (speaker.kind === 'confirmed') return `- ${speaker.name}: CONFIRMED (${speaker.basis}). ${words}.`;
  if (speaker.kind === 'guess') {
    const pct = speaker.confidence == null ? '' : `, ${Math.round(speaker.confidence * 100)}% context confidence`;
    return `- ${speaker.name} (guess): GUESS (${speaker.basis}${pct}). ${words}.`;
  }
  const note = speaker.note ? `, ${speaker.note}` : '';
  return `- ${UNNAMED} (voice ${speaker.voice}): NOT NAMED${note}. ${words}.`;
}

/**
 * Header (call, speaker legend, answering rules) and one line per turn, so a
 * caller can window the turns while always keeping the header.
 */
function renderSpeakerTranscriptParts(transcript) {
  const header = [
    `PROCESSED CALL, speaker-labeled. CALL: ${transcript.title} | ${ctDate(transcript.started_at)} | ${Math.round(transcript.duration_sec / 60)} min | id ${transcript.otid || 'unknown'}`,
    'SPEAKERS (how each was identified):',
    ...transcript.speakers.map(speakerLine),
    'RULES FOR ANSWERING:',
    ...ANSWER_RULES.map((rule) => `- ${rule}`),
    'TRANSCRIPT:',
  ].join('\n');
  const lines = transcript.turns.map((turn) => `[${clock(turn.start)}] ${turn.speaker}: ${turn.text}`);
  return { header, lines };
}

/** Plain text for a model prompt. */
function renderSpeakerTranscriptText(transcript) {
  const { header, lines } = renderSpeakerTranscriptParts(transcript);
  return [header, ...lines].join('\n');
}

/** A call has usable speaker processing when its segments carry track labels. */
function hasSpeakerProcessing(enriched = {}) {
  const segments = Array.isArray(enriched.segments) ? enriched.segments : [];
  return segments.some(
    (segment) =>
      String(segment?.text || '').trim() &&
      (segment.speaker_model_label != null || segment.resolved_speaker),
  );
}

const RAW_FALLBACK_NOTICE =
  'UNPROCESSED CALL: speaker identification has not run on this call yet, so this is raw Otter text with no speaker labels. Do not attribute any statement to a named person; say who spoke is unknown.';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Standalone HTML page for ExampleCo to read. */
function renderSpeakerTranscriptHtml(transcript) {
  const counts = { confirmed: 0, guess: 0, unnamed: 0 };
  const total = transcript.speakers.reduce((sum, s) => sum + s.words, 0) || 1;
  for (const s of transcript.speakers) counts[s.kind] += s.words;
  const pct = (kind) => Math.round((counts[kind] / total) * 100);
  const legend = transcript.speakers
    .map((s) => `<tr><td><span class="chip ${s.kind}">${escapeHtml(displayName(s))}</span></td><td>${
      s.kind === 'confirmed' ? 'Confirmed' : s.kind === 'guess' ? 'Guess' : 'Not named'
    }</td><td>${escapeHtml(
      s.kind === 'unnamed' ? s.note || 'no voice match, no name clue' : s.basis +
        (s.confidence != null ? `, ${Math.round(s.confidence * 100)}%` : ''),
    )}</td><td class="num">${s.words}</td></tr>`)
    .join('\n');
  const rows = transcript.turns
    .map((t) => `<div class="turn ${t.kind}"><span class="t">${clock(t.start)}</span><span class="who">${escapeHtml(t.speaker)}</span><p>${escapeHtml(t.text)}</p></div>`)
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Labeled Call Transcript</title>
<style>
:root{--bg:#0f0f0f;--panel:#171717;--text:#e8e8e8;--muted:#9a9a9a;--line:#2a2a2a;--ok:#3fb97a;--guess:#e0a33a;--un:#8a8a8a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;margin:8px 0 4px}.bar span{display:block}
.k{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin-bottom:20px}
table{width:100%;border-collapse:collapse;background:var(--panel);border-radius:8px;overflow:hidden;margin-bottom:28px;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600}td.num{text-align:right}
.chip{display:inline-block;padding:1px 8px;border-radius:10px;font-weight:600;font-size:13px}
.chip.confirmed{background:rgba(63,185,122,.15);color:var(--ok)}.chip.guess{background:rgba(224,163,58,.15);color:var(--guess)}.chip.unnamed{background:rgba(138,138,138,.15);color:#bdbdbd}
.turn{display:grid;grid-template-columns:64px 1fr;gap:0 12px;padding:10px 12px;border-left:3px solid var(--line);margin-bottom:6px;background:var(--panel);border-radius:0 6px 6px 0}
.turn.confirmed{border-left-color:var(--ok)}.turn.guess{border-left-color:var(--guess)}.turn.unnamed{border-left-color:var(--un)}
.t{color:var(--muted);font-variant-numeric:tabular-nums;font-size:13px;padding-top:1px}.who{font-weight:600}
.turn.confirmed .who{color:var(--ok)}.turn.guess .who{color:var(--guess)}.turn.unnamed .who{color:#bdbdbd}
.turn p{grid-column:2;margin:2px 0 0}
@media (max-width:600px){.turn{grid-template-columns:1fr}.turn p{grid-column:1}}
</style></head><body><main>
<h1>${escapeHtml(transcript.title)}</h1>
<p class="sub">${escapeHtml(ctDate(transcript.started_at))} · ${Math.round(transcript.duration_sec / 60)} min · ${transcript.turns.length} turns · call id ${escapeHtml(transcript.otid || '')}</p>
<div class="bar"><span style="width:${pct('confirmed')}%;background:var(--ok)"></span><span style="width:${pct('guess')}%;background:var(--guess)"></span><span style="width:${pct('unnamed')}%;background:var(--un)"></span></div>
<div class="k"><span>Confirmed ${pct('confirmed')}% of words</span><span>Guess ${pct('guess')}%</span><span>Not named ${pct('unnamed')}%</span></div>
<table><thead><tr><th>Speaker</th><th>Status</th><th>Evidence</th><th class="num">Words</th></tr></thead><tbody>
${legend}
</tbody></table>
${rows}
</main></body></html>
`;
}

module.exports = {
  UNNAMED,
  ANSWER_RULES,
  RAW_FALLBACK_NOTICE,
  buildSpeakerTranscript,
  resolveSpeakers,
  hasSpeakerProcessing,
  renderSpeakerTranscriptParts,
  renderSpeakerTranscriptText,
  renderSpeakerTranscriptHtml,
  clock,
};
