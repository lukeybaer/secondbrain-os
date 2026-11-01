'use strict';

// Deterministic, no-model scan of transcript text for names that are spoken to
// someone ("..., PRIVATE_NAME", "Thanks PRIVATE_NAME") and belong to nobody Amy has on
// file. It is a clue that a person of that name may be on the call, never
// attendance and never a voice match. Pattern shapes mirror the vocative
// detector in scripts/otter-context-speaker-resolver.js (directAddressAliases).

const fs = require('node:fs');
const path = require('node:path');

const STOPLIST = new Set(
  [
    'okay', 'yeah', 'well', 'so', 'and', 'but', 'thanks', 'thank', 'hey', 'right', 'sure',
    'yes', 'no', 'oh', 'now', 'then', 'also', 'just', 'like', 'look', 'listen', 'great',
    'good', 'sorry', 'please', 'hello', 'hi', 'team', 'everyone', 'everybody', 'guys', 'folks',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
    'october', 'november', 'december',
  ],
);

const NAME = '([A-Z][a-z]{2,13})';
const PATTERNS = [
  // Trailing vocative at the end of a clause: "..., PRIVATE_NAME" / "..., PRIVATE_NAME." / "..., PRIVATE_NAME?"
  new RegExp(String.raw`,\s+${NAME}(?=\s*(?:[.?!]|$))`, 'g'),
  // Greeting/thanks: "hey PRIVATE_NAME", "Thanks PRIVATE_NAME"
  new RegExp(String.raw`\b(?:[Hh]ey|[Hh]i|[Hh]ello|[Tt]hanks|[Tt]hank you)\s+${NAME}\b`, 'g'),
  // Handoff: "over to PRIVATE_NAME", "question for PRIVATE_NAME"
  new RegExp(String.raw`\b(?:[Oo]ver to|[Qq]uestion for)\s+${NAME}\b`, 'g'),
  // Clause-initial: "PRIVATE_NAME, can you ..."
  new RegExp(String.raw`(?:^|[.!?]\s+)${NAME},\s+(?:can|could|would|do|are|is|what|how)\b`, 'g'),
];

function segmentStart(seg) {
  for (const v of [seg?.start_sec, seg?.start, seg?.start_seconds]) {
    const n = Number(v);
    if (v !== null && v !== undefined && v !== '' && Number.isFinite(n)) return n;
  }
  return null;
}

function snippetAround(text, index, length) {
  const max = 60;
  const hitLen = Math.min(length, max);
  const room = Math.max(0, max - hitLen);
  let from = Math.max(0, index - Math.floor(room / 2));
  const to = Math.min(text.length, from + max);
  from = Math.max(0, to - max);
  return text.slice(from, to).trim();
}

// resolveSpeaker(track) -> display name when the roster identifies that track,
// else null; absent, no speaker is claimed for a mention.
function extractTranscriptNameMentions(segments, { knownAliases = [], resolveSpeaker = null } = {}) {
  const known = new Set(
    (Array.isArray(knownAliases) ? knownAliases : [])
      .flatMap((a) => String(a || '').toLowerCase().split(/\s+/))
      .filter(Boolean),
  );
  const found = new Map();
  for (const seg of Array.isArray(segments) ? segments : []) {
    const text = String(seg?.text || '');
    if (!text) continue;
    const start = segmentStart(seg);
    const track = seg?.speaker ?? seg?.speaker_track ?? seg?.speaker_model_label ?? null;
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        if (m.index === re.lastIndex) re.lastIndex += 1;
        const name = m[1];
        const key = name.toLowerCase();
        if (STOPLIST.has(key) || known.has(key)) continue;
        const nameAt = m.index + m[0].indexOf(name);
        const row = found.get(key) || { name, count: 0, firstAt: null, speakerTrack: null, speaker: null, snippet: '', _seen: new Set() };
        const dedupe = `${seg?.segment_id ?? start}:${nameAt}`;
        if (row._seen.has(dedupe)) continue;
        row._seen.add(dedupe);
        row.count += 1;
        const speaker = typeof resolveSpeaker === 'function' ? resolveSpeaker(track) || null : null;
        if (start !== null && (row.firstAt === null || start < row.firstAt)) {
          row.firstAt = start;
          row.speakerTrack = track;
          row.speaker = speaker;
          row.snippet = snippetAround(text, nameAt, name.length);
        } else if (!row.snippet) {
          row.speakerTrack = track;
          row.speaker = speaker;
          row.snippet = snippetAround(text, nameAt, name.length);
        }
        found.set(key, row);
      }
    }
  }
  return [...found.values()]
    .map(({ _seen, ...row }) => row)
    .sort((a, b) => (a.firstAt ?? Infinity) - (b.firstAt ?? Infinity) || a.name.localeCompare(b.name));
}

// First names of everyone with a contact file (filename only, e.g. PRIVATE_NAME.md -> PRIVATE_NAME).
let contactFirstNamesCache = null;
function loadContactFirstNames(dir = path.join(__dirname, '..', '..', 'memory', 'contacts')) {
  if (contactFirstNamesCache && contactFirstNamesCache.dir === dir) return contactFirstNamesCache.names;
  let names = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
      .map((f) => f.replace(/\.md$/, '').split('_')[0])
      .filter((n) => n.length >= 3);
  } catch {
    names = [];
  }
  contactFirstNamesCache = { dir, names };
  return names;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// "Heard by name (no contact on file): PRIVATE_NAME (addressed at 7:41)"; ", spoken by
// PRIVATE_NAME" only when the roster resolved the speaking track, never a guess about an
// unidentified voice (Codex review 2026-10-24).
// Returns '' when there is nothing to say so the row stays unchanged.
function formatHeardByName(mentions, { maxVisible = 3 } = {}) {
  const list = (Array.isArray(mentions) ? mentions : []).filter((m) => m?.name);
  if (!list.length) return '';
  const parts = list.slice(0, maxVisible).map((m) => {
    const when = Number.isFinite(m.firstAt) ? ` at ${formatClock(m.firstAt)}` : '';
    const times = m.count > 1 ? `addressed ${m.count} times, first${when}` : `addressed${when}`;
    const by = m.speaker ? `, spoken by ${m.speaker}` : '';
    return `${m.name} (${times}${by})`;
  });
  if (list.length > maxVisible) parts.push(`+${list.length - maxVisible} more`);
  return `Heard by name (no contact on file): ${parts.join(', ')}`;
}

module.exports = {
  extractTranscriptNameMentions,
  loadContactFirstNames,
  formatHeardByName,
  formatClock,
};
