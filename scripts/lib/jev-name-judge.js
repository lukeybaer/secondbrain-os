'use strict';

// scripts/lib/jev-name-judge.js
//
// Speaker-name judging on TypeSafe's Jev decision model (auth-jev-speaker-naming,
// ExampleCo 2026-09-18: "Replace it totally we can always roll back"). A subscription
// LLM first reads each complete speaker-tagged call once and returns only the
// candidate names present. Jev then receives the same complete call, the stable
// speaker ids, and that candidate pool, and assigns a probability to every name
// plus an explicit unknown option for each unresolved acoustic speaker.
//
// ExampleCo, 2026-09-19: stable acoustic speaker ids exist before naming. The LLM
// does not justify or assign names; it only supplies the name pool. Jev owns
// the mapping and confidence. Thresholds are calibrated on voiceprint-confirmed
// speakers with their identities hidden, with precision favored over recall.
// Below-threshold mappings are abstentions, and no text judgment can overwrite
// an authoritative voiceprint identity.
// Owner override, 2026-09-19: after removing already voiceprint-known people
// from each call's multiple-choice list, accept at p >= 0.70 while retaining
// the runner-up margin and explicit unknown option.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  JEV_MODEL,
  JevError,
  jevSystemOne,
  estimateTokens,
  jevMaxTokensExceeded,
} = require('./jev-client.js');
const { admitJevSpend, recordJevSpend } = require('./jev-budget.js');
const { findForbiddenPeople } = require('./forbidden-people.js');
const { askAI } = require('./ask-ai.js');

const SURFACE = 'voice-identity-jev-name-judge';
const MAX_CANDIDATES = 48;
const SCENE_BARS = Object.freeze({ self: 0.95, address: 0.9, reply: 0.95 });
const ANSWERS_BAR = 0.7;
const VARIANT_MIN_P = 0.5;
const MAX_SCENES_PER_NAME = 6;
const MAX_SCENES_PER_WINDOW = 60;
const JUDGE_METHOD = 'jev-whole-call-candidates-v6';
const SCENE_CONCURRENCY = 6;
const MAX_TURN_CHARS = 360;
const MAX_CANDIDATE_NAMES = 40;
// Jev rejects an oversized state with HTTP 400 max_tokens_exceeded. The largest
// state it ever answered was ~30K input tokens; a 149K-char call (~37K) was
// refused on 2026-09-23 and failed its whole voice. Calls over this estimated
// budget send the target's turns plus the nearest surrounding lines instead.
const JEV_MAX_TRANSCRIPT_TOKENS = 24000;
const ASSIGNMENT_MIN_P = Number(process.env.JEV_NAME_MIN_P || 0.7);
const ASSIGNMENT_MIN_MARGIN = Number(process.env.JEV_NAME_MIN_MARGIN || 0.25);
// JEV_NAME_SUPERMAJORITY=off restores the zero-conflict veto without a deploy.
const SUPERMAJORITY_ENABLED = String(process.env.JEV_NAME_SUPERMAJORITY || 'on').toLowerCase() !== 'off';
const SUPERMAJORITY_MIN_WINS = Number(process.env.JEV_NAME_SUPERMAJORITY_MIN_WINS || 5);
const SUPERMAJORITY_SHARE = Number(process.env.JEV_NAME_SUPERMAJORITY_SHARE || 0.8);
const CANDIDATE_SYSTEM_PROMPT = [
  'You extract candidate personal names from a complete meeting transcript.',
  'Return one JSON object only: {"candidate_names":["Name"]}.',
  'Do not map names to speakers and do not explain your answer.',
  'Include first names, nicknames, and full names that may identify a person speaking on the call.',
  'It is safer to over-include a name than to omit it because a separate probabilistic judge decides identity.',
].join(' ');

// Combining several calls' worth of candidate extraction into one askAI round
// trip is the perf fix for the 88s/call bottleneck: one call per window meant
// N sequential LLM round trips (each up to 180s) for a target heard on N
// calls. This variant asks for window-tagged output so names route back to
// the exact call they came from; the single-window path above is unchanged
// so every existing caller and mock keeps working.
const CANDIDATE_SYSTEM_PROMPT_MULTI = [
  'You extract candidate personal names from one or more complete meeting transcripts, each its own window.',
  'Return one JSON object only: {"windows":[{"window":"<window id exactly as shown>","candidate_names":["Name"]}]}.',
  'Include exactly one entry per window id shown, using an empty candidate_names list when none are supported.',
  'Do not mix names across windows. Do not map names to speakers and do not explain your answer.',
  'Include first names, nicknames, and full names that may identify a person speaking in that window.',
  'It is safer to over-include a name than to omit it because a separate probabilistic judge decides identity.',
].join(' ');

// Prompt version bump forces a cache miss whenever the extraction contract
// (system prompt, output shape) changes, even for an identical transcript.
const PROMPT_VERSION = 1;
const CANDIDATE_MAX_PROMPT_BYTES = 320 * 1024;
const CANDIDATE_CACHE_SUBDIR = ['life-archive', 'voiceprints', 'jev-candidate-cache'];

// Consumers must not surface a name made under an older Jev question design
// while the overnight resolver is waiting to re-judge it. Non-Jev artifacts
// belong to the rollback ladder and remain readable under their own gates.
function nameJudgeArtifactCurrent(data) {
  const providers = String((data && data.judge_provider) || '').split('+');
  return !providers.includes('jev') || (data && data.judge_method) === JUDGE_METHOD;
}

// Evidence type strings the existing directNameEvidence() accepts as direct.
const EVIDENCE_TYPE = Object.freeze({
  self: 'self introduction',
  address: 'direct address',
  reply: 'thanks name',
  whole_call_assignment: 'whole call speaker assignment',
});
const KIND_WORDS = Object.freeze({
  self: 'the TARGET says the name',
  address: 'someone says the name and the TARGET answers',
  reply: 'someone says the name right after the TARGET spoke',
  whole_call_assignment: 'the complete tagged conversation identifies that stable speaker id',
});

const NOT_NAMES = new Set(
  `i i'm im i'll i've i'd ok okay yeah yes yep yup no nope so and but or nor the a an this that these those
  it it's its we we're we'll you you're your yours he she they them there their theirs here hi hey hello
  thanks thank well oh um uh hmm mhm huh ah er right good great sure just now then also what when where
  why how who whom which if because let let's can could would should will do does did don't doesn't is
  are was were be been being have has had not all any some one two three four five first second next last
  maybe please sorry alright anyway actually basically really very like know think mean see look go got
  get make take said says say amen lord god jesus christ holy monday tuesday wednesday thursday friday
  saturday sunday january february march april may june july august september october november december
  today tomorrow yesterday morning afternoon evening night english chinese spanish american america texas
  ExampleCo ExampleCo us usa uk ai speaker unknown team company inc llc mr mrs ms dr sir madam guys everyone
  everybody folks man bro dude bye goodbye welcome cheers correct exactly absolutely definitely perfect cool
  nice awesome wow wait hold okay-okay hm yeah-yeah zoom teams google microsoft amazon apple iphone
  mom mommy mama dad daddy papa honey babe baby sweetie dear buddy bud pal mate sis grandma grandpa`.split(
    /\s+/,
  ),
);

// The owner's voice is enrolled, so an unknown acoustic target is never the
// owner. On a real call Jev picked the owner's name at 0.88 because the target
// kept addressing him; his names are never candidates.
const OWNER_NAMES = new Set(['ExampleCo', 'PRIVATE_NAME', 'ExampleCo']);

const INTRO_BEFORE = /\b(?:this is|i'm|i am|my name is|name's|it's|hi|hey|hello|thanks|thank you|bye|welcome|go ahead|over to you)[,\s]+$/i;

function lineBody(line) {
  return String(line || '').replace(/^\[[^\]]*\]\s*/, '');
}

function lineSpeakerLabel(line) {
  const match = String(line || '').match(/^\[[^\]]*?speaker\s+([^\]]+)\]/i);
  return match ? match[1].trim() : '';
}

function labelLooksLikeName(label) {
  const text = String(label || '').trim();
  if (!text || /^speaker\s*\d*$/i.test(text) || /^\d+$/.test(text) || /unknown/i.test(text)) {
    return false;
  }
  return /^[A-Z][a-z]+(?:[ '-][A-Z][a-z]+)*$/.test(text);
}

// Deterministic candidate list for one call window. Returns display names,
// best-scored first, never the owner or a hard-excluded person.
function extractNameCandidates(text, { labels = '', max = MAX_CANDIDATES } = {}) {
  const scores = new Map();
  const bump = (name, amount) => {
    const clean = String(name || '').trim();
    if (!clean) return;
    if (NOT_NAMES.has(clean.toLowerCase())) return;
    if (OWNER_NAMES.has(clean.toLowerCase())) return;
    if (findForbiddenPeople(clean).length) return;
    scores.set(clean, (scores.get(clean) || 0) + amount);
  };
  const labelList = [
    ...String(labels || '')
      .split(/[,;|]/)
      .map((label) => label.trim()),
  ];
  for (const line of String(text || '').split('\n')) {
    const label = lineSpeakerLabel(line);
    if (label) labelList.push(label);
    const body = lineBody(line);
    const pattern = /\b([A-Z][a-z]{1,14}(?:-[A-Z][a-z]{1,14})?)\b/g;
    let match;
    while ((match = pattern.exec(body))) {
      const word = match[1];
      const before = body.slice(0, match.index);
      const after = body.slice(match.index + word.length);
      const sentenceStart = /(^|[.!?]\s*)$/.test(before);
      if (INTRO_BEFORE.test(before)) bump(word, 3);
      else if (!sentenceStart) bump(word, 1);
      // A name opening a sentence and followed by a comma is someone being
      // spoken to ("PRIVATE_NAME, what do you think?"), the most useful position.
      else if (/^\s*,/.test(after)) bump(word, 2);
      if (/^\s+here\b/i.test(after)) bump(word, 2);
    }
  }
  for (const label of labelList) {
    if (!labelLooksLikeName(label)) continue;
    bump(label, 2);
    const first = label.split(/\s+/)[0];
    if (first !== label) bump(first, 2);
  }
  return [...scores.entries()]
    .filter(([, score]) => score >= 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([name]) => name);
}

// "[time speaker label] words" lines, with the TARGET's lines between the
// %TSPnS% / %TSPnE% marker lines.
function parseTurns(text, marker) {
  const turns = [];
  let inTarget = false;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (line === `%${marker}S%`) {
      inTarget = true;
      continue;
    }
    if (line === `%${marker}E%`) {
      inTarget = false;
      continue;
    }
    const match = line.match(/^\[(\S+)\s+speaker\s+([^\]]+)\]\s*(.*)$/i);
    if (!match) {
      if (line && turns.length) turns[turns.length - 1].text += ` ${line}`;
      continue;
    }
    turns.push({ label: match[2].trim(), isTarget: inTarget, text: match[3] });
  }
  return turns;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionPattern(name) {
  return new RegExp(`\\b${escapeRegex(name)}\\b`);
}

function clipAround(text, name, max = MAX_TURN_CHARS) {
  const value = String(text || '');
  if (value.length <= max) return value;
  const index = value.search(mentionPattern(name));
  if (index < 0) return `${value.slice(0, max)} ...`;
  const from = Math.max(0, index - Math.floor(max / 2));
  return `${from > 0 ? '... ' : ''}${value.slice(from, from + max)} ...`;
}

// A short scene with generic role labels. Otter's own speaker labels are left
// out because they can be wrong and would leak a guessed name.
function sceneText(turns, from, to, name) {
  const others = new Map();
  const lines = [];
  for (let k = Math.max(0, from); k <= Math.min(turns.length - 1, to); k += 1) {
    const turn = turns[k];
    let who = 'TARGET SPEAKER';
    if (!turn.isTarget) {
      if (!others.has(turn.label)) others.set(turn.label, `OTHER SPEAKER ${others.size + 1}`);
      who = others.get(turn.label);
    }
    lines.push(`${who}: ${clipAround(turn.text, name)}`);
  }
  return lines.join('\n');
}

// How the name sits in the line that says it. Only naming-shaped mentions
// become questions; "I told Priya yesterday" is a reference, not a name tag.
function mentionShape(text, name) {
  const value = String(text || '');
  const match = value.match(mentionPattern(name));
  if (!match) return { intro: false, vocative: false, thanks: false };
  const before = value.slice(0, match.index);
  const after = value.slice(match.index + name.length);
  const sentenceStart =
    /(^|[.!?]\s*)$/.test(before) ||
    /(^|[.!?]\s*)(hey|hi|hello|ok|okay|so|and|but|yes|yeah|well|oh)[,\s]+$/i.test(before);
  return {
    intro: /\b(this is|i'm|i am|my name is|name's|it's)\s+$/i.test(before) || /^\s+here\b/i.test(after),
    vocative:
      /^\s*[,?!]/.test(after) ||
      /^\s*$/.test(after) ||
      (sentenceStart && /^\s*[,?]/.test(after)) ||
      /\b(hey|hi|hello)[,\s]+$/i.test(before),
    thanks: /\b(thanks|thank you|good point|great point|well said|appreciate (it|that))[,\s]+$/i.test(before),
  };
}

// Every naming-shaped place the name is said right next to a TARGET turn,
// nearest first.
function scenesForName(turns, name, max = MAX_SCENES_PER_NAME) {
  const pattern = mentionPattern(name);
  const scenes = [];
  for (let i = 0; i < turns.length; i += 1) {
    if (!pattern.test(turns[i].text)) continue;
    const shape = mentionShape(turns[i].text, name);
    if (turns[i].isTarget) {
      if (shape.intro) {
        scenes.push({ kind: 'self', distance: 0, text: sceneText(turns, i - 1, i + 1, name) });
      }
      continue;
    }
    // Direct address is identity evidence only when the TARGET owns the very
    // next speaker turn. If another speaker talks first, that person may be the
    // addressee; a later TARGET comment is proximity, not identification.
    const answer = i + 1 < turns.length && turns[i + 1].isTarget ? i + 1 : -1;
    if (answer >= 0 && shape.vocative) {
      scenes.push({
        kind: 'address',
        distance: answer - i,
        text: sceneText(turns, i - 1, answer, name),
      });
    } else if (answer < 0 && shape.thanks && i > 0 && turns[i - 1].isTarget) {
      scenes.push({ kind: 'reply', distance: 1, text: sceneText(turns, i - 1, i, name) });
    }
  }
  return scenes.sort((a, b) => a.distance - b.distance).slice(0, max);
}

function whoQuestion(name) {
  return {
    type: 'choice',
    instructions:
      `Does this short excerpt unambiguously identify the TARGET SPEAKER as "${name}"? ` +
      'Guessing is worse than abstaining. Proximity alone is not identity evidence.',
    criteria: {
      target:
        `The excerpt unambiguously proves "${name}" is the TARGET SPEAKER: the TARGET ` +
        'self-identifies with that name, or is directly called that name and immediately answers.',
      other_speaker: `"${name}" is one of the other speakers, not the TARGET SPEAKER`,
      not_speaking: `"${name}" is someone being talked about who is not speaking here`,
      not_a_name: `"${name}" is not a person's name here`,
      insufficient_evidence:
        `It is uncertain who "${name}" identifies, or the apparent link to the TARGET is only ` +
        'proximity, turn attribution, or a later topic response.',
    },
  };
}

function answersQuestion(name) {
  return {
    type: 'noul',
    instructions:
      `The TARGET SPEAKER is the immediate next speaker after "${name}" is called, and the ` +
      `TARGET's line directly answers that address. If this is uncertain, false.`,
  };
}

// Whether one answered scene counts as evidence, by the calibrated bars.
function sceneCounts(kind, pTarget, pAnswers) {
  if (kind === 'address') {
    return pTarget >= SCENE_BARS.address && Number(pAnswers || 0) >= ANSWERS_BAR;
  }
  return pTarget >= (SCENE_BARS[kind] || 1);
}

function firstNameKey(name) {
  return String(name || '').toLowerCase().split(/\s+/)[0] || '';
}

function sameFirstName(a, b) {
  const x = firstNameKey(a);
  const y = firstNameKey(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x)));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function callKey(window = {}) {
  return String(window.otid || window.id || '').replace(/:whole_call:.*$/, '');
}

function canonicalSpeakerTranscript(window = {}) {
  const marker = window.target_marker || 'TSP1';
  const turns = parseTurns(window.call_text_tagged, marker);
  const ids = new Map();
  const lines = [];
  for (const turn of turns) {
    if (!ids.has(turn.label)) ids.set(turn.label, `speaker ${ids.size + 1}`);
    const id = ids.get(turn.label);
    const text = String(turn.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const prior = lines[lines.length - 1];
    if (prior && prior.id === id) prior.text += ` ${text}`;
    else lines.push({ id, text });
  }
  return {
    text: lines.map((line) => `[${line.id}] ${line.text}`).join('\n'),
    speakerIdsByRawLabel: ids,
  };
}

// Keep every line nearest a target turn until the budget is spent, in call
// order, with `[...]` marking skipped stretches. A call within budget is
// returned unchanged, so ordinary requests are byte-identical.
function boundedTranscriptText(text, targetIds = [], maxTokens = JEV_MAX_TRANSCRIPT_TOKENS) {
  const full = String(text || '');
  const maxChars = Math.max(0, Math.floor(maxTokens * 4));
  if (full.length <= maxChars) return { text: full, bounded: false };
  const lines = full.split('\n');
  const prefixes = targetIds.map((id) => `[${id}] `);
  const isTarget = lines.map((line) => prefixes.some((prefix) => line.startsWith(prefix)));
  const fromPrev = new Array(lines.length).fill(Infinity);
  const toNext = new Array(lines.length).fill(Infinity);
  let last = -Infinity;
  for (let i = 0; i < lines.length; i += 1) {
    if (isTarget[i]) last = i;
    fromPrev[i] = i - last;
  }
  last = Infinity;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isTarget[i]) last = i;
    toNext[i] = last - i;
  }
  const distance = lines.map((_, i) => Math.min(fromPrev[i], toNext[i]));
  const order = lines
    .map((_, index) => index)
    .sort((a, b) => distance[a] - distance[b] || a - b);
  // Consecutive turns by one speaker are merged into one line, so a single
  // monologue can outgrow the whole budget. Each line is capped, keeping the
  // side nearest a target turn: the opening of a target turn or a line after
  // one, the closing of a line that leads into one.
  const lineCap = Math.max(400, Math.floor(maxChars / 8));
  const clip = (index, room) => {
    const line = lines[index];
    if (line.length <= room) return line;
    if (room < 40) return '';
    if (distance[index] === 0 || fromPrev[index] <= toNext[index]) return line.slice(0, room);
    const tag = (line.match(/^\[[^\]]+\] /) || [''])[0];
    return `${tag}... ${line.slice(-(room - tag.length - 4))}`;
  };
  const keep = new Map();
  let used = 0;
  for (const index of order) {
    const room = Math.min(lineCap, maxChars - used - 1);
    const kept = clip(index, room);
    if (!kept) continue;
    keep.set(index, kept);
    used += kept.length + 1;
  }
  const out = [];
  let skipped = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (keep.has(i)) {
      if (skipped && out.length) out.push('[...]');
      out.push(keep.get(i));
      skipped = false;
    } else {
      skipped = true;
    }
  }
  return { text: out.join('\n'), bounded: true };
}

function targetSpeakerIds(window = {}, transcript = canonicalSpeakerTranscript(window)) {
  const marker = window.target_marker || 'TSP1';
  const turns = parseTurns(window.call_text_tagged, marker);
  return [
    ...new Set(
      turns
        .filter((turn) => turn.isTarget)
        .map((turn) => transcript.speakerIdsByRawLabel.get(turn.label))
        .filter(Boolean),
    ),
  ];
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('candidate-name LLM returned no JSON object');
  return JSON.parse(candidate.slice(start, end + 1));
}

function nameParts(value) {
  return String(value || '')
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .map((part) => part.replace(/[^A-Za-z'-]/g, '').toLowerCase())
    .filter(Boolean);
}

function candidateMatchesKnownVoiceprint(candidate, knownNames = []) {
  const candidateKey = String(candidate || '').trim().toLowerCase();
  const candidateParts = nameParts(candidate);
  if (!candidateKey || !candidateParts.length) return false;
  return knownNames.some((known) => {
    const knownKey = String(known || '').trim().toLowerCase();
    const knownParts = nameParts(known);
    if (!knownKey || !knownParts.length) return false;
    if (candidateKey === knownKey) return true;
    // Candidate extraction frequently returns only the first name from a full
    // canonical display name. A unique first-name option is still the same
    // already-resolved person and must not be offered to Jev.
    if (candidateParts.length === 1) return knownParts.includes(candidateParts[0]);
    return candidateParts.every((part) => knownParts.includes(part));
  });
}

function cleanCandidateNames(value, { excludedKnownVoiceprints = [] } = {}) {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set();
  const names = [];
  for (const row of rows) {
    const name = String(row || '')
      .replace(/^[-*\d.)\s]+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    const key = name.toLowerCase();
    if (
      !name ||
      seen.has(key) ||
      /^speaker\s+\d+$/i.test(name) ||
      candidateMatchesKnownVoiceprint(name, excludedKnownVoiceprints)
    ) {
      continue;
    }
    seen.add(key);
    names.push(name);
    if (names.length >= MAX_CANDIDATE_NAMES) break;
  }
  return names;
}

async function candidateNamesForCall(window, deps = {}) {
  const transcript = canonicalSpeakerTranscript(window);
  if (!transcript.text) return { names: [], transcript };
  const ladder = deps.askAIFn || askAI;
  const prompt = [
    'Read the complete speaker-tagged call below once.',
    'Return only the candidate personal names of people who may be speaking on this call.',
    'Do not assign names to speaker ids. Do not provide evidence or commentary.',
    transcript.text,
  ].join('\n\n');
  const options = {
    surface: 'voice-identity-jev-candidate-names',
    system: CANDIDATE_SYSTEM_PROMPT,
    rungOrder: ['claude-cli', 'codex'],
    briefingContext: true,
    toolLess: true,
    rungTimeoutMs: 180000,
    maxDynamicBytes: 256 * 1024,
    maxPromptBytes: 320 * 1024,
  };
  let response = await ladder(prompt, options);
  let parsed;
  try {
    parsed = extractJsonObject(response.text);
  } catch (firstError) {
    response = await ladder(
      [
        prompt,
        'Your prior response was not valid JSON. Return exactly one JSON object now:',
        '{"candidate_names":["First Last"]}',
        'If no personal names are supported, return {"candidate_names":[]}.',
      ].join('\n\n'),
      options,
    );
    try {
      parsed = extractJsonObject(response.text);
    } catch (retryError) {
      return {
        names: [],
        transcript,
        provider: response.rung || 'unknown',
        malformed_candidate_output: true,
      };
    }
  }
  return {
    // Keep the cached pass call-wide. The authoritative voiceprint exclusions
    // are target-specific during hidden-known calibration and are applied just
    // before Jev sees the multiple-choice list.
    names: cleanCandidateNames(parsed.candidate_names),
    transcript,
    provider: response.rung || 'unknown',
  };
}

// --- Batched, cached candidate extraction (otter-speed-C) -----------------
//
// candidateNamesForCall() above still handles exactly one window per askAI
// call, unchanged, so every existing single-window caller and test mock
// keeps working. candidateNamesForWindows() is the new entry point used by
// judgeTargetWithJev/judgeTargetsWithJev: it dedupes windows that share a
// call, skips a window outright when there is no target speaker turn to map
// (nothing for Jev to do), reuses a disk cache keyed by transcript content,
// and only then falls through to askAI, combining several distinct calls
// into one window-tagged prompt when there is more than one left to fetch.

function candidateCacheFilePath(dataDir, otid) {
  return path.join(dataDir, ...CANDIDATE_CACHE_SUBDIR, `${String(otid || 'unknown')}.json`);
}

function candidateFingerprint({ text, sourceRevision }) {
  return crypto
    .createHash('sha256')
    .update(`v${PROMPT_VERSION}\u0000${String(sourceRevision || '')}\u0000${String(text || '')}`)
    .digest('hex');
}

function readCandidateDiskCache(dataDir, otid, fsApi = fs) {
  try {
    const raw = fsApi.readFileSync(candidateCacheFilePath(dataDir, otid), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Failed extractions and empty results are never cached (the caller only
// calls this for a successful, non-empty result). Atomic tmp-then-rename so
// a crash mid-write can never leave a truncated cache file behind.
function writeCandidateDiskCache(dataDir, otid, entry, fsApi = fs) {
  const file = candidateCacheFilePath(dataDir, otid);
  try {
    fsApi.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fsApi.writeFileSync(tmp, JSON.stringify(entry, null, 2));
    fsApi.renameSync(tmp, file);
  } catch {
    // Best effort: a cache write failure must never block naming.
  }
}

function buildMultiWindowPrompt(entries) {
  const sections = entries
    .map((entry) => `=== WINDOW ${entry.key} ===\n${entry.text}`)
    .join('\n\n');
  return [
    'Read each complete speaker-tagged call window below once.',
    'Return only the candidate personal names of people who may be speaking in each window, tagged by window id.',
    'Do not assign names to speaker ids. Do not provide evidence or commentary.',
    sections,
  ].join('\n\n');
}

function parseMultiWindowResponse(text) {
  const parsed = extractJsonObject(text);
  const rows = Array.isArray(parsed.windows) ? parsed.windows : [];
  const map = new Map();
  for (const row of rows) {
    const key = String((row && row.window) || '').trim();
    if (!key) continue;
    map.set(key, cleanCandidateNames(row && row.candidate_names));
  }
  return map;
}

// Greedy bin-packing into the fewest chunks that each fit the prompt-size
// cap, preserving order.
function chunkCandidateEntries(entries, maxBytes) {
  const budget = Math.max(1, Number(maxBytes) || CANDIDATE_MAX_PROMPT_BYTES);
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(entry.text, 'utf8') + 64;
    if (current.length && currentBytes + entryBytes > budget) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += entryBytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// One candidate-extraction pass covering every window given, keyed by call
// (callKey). Returns a Map<callKey, candidateResult> with the same shape
// candidateNamesForCall() returns, so callers can drop the results straight
// into judgeWindow's candidateCache.
async function candidateNamesForWindows(windows, deps = {}) {
  const ladder = deps.askAIFn || askAI;
  const dataDir = deps.dataDir || '';
  const fsApi = deps.fsApi || fs;
  const results = new Map();
  const pending = [];
  const claimed = new Set();
  for (const window of windows || []) {
    const key = callKey(window);
    // Dedupe on first sight, not on resolution: a window already queued in
    // `pending` (askAI not yet answered) must still block a second window
    // for the same call from being queued again.
    if (claimed.has(key)) continue;
    claimed.add(key);
    const transcript = canonicalSpeakerTranscript(window);
    if (!transcript.text) {
      results.set(key, { names: [], transcript });
      continue;
    }
    const targetIds = targetSpeakerIds(window, transcript);
    if (!targetIds.length) {
      // Decisive voiceprint case: no target speaker turn survives in this
      // window, so there is nothing left for Jev to map. Skip the candidate
      // LLM entirely instead of spending an askAI call on it.
      results.set(key, { names: [], transcript, skipped_no_target: true });
      continue;
    }
    const fingerprint = candidateFingerprint({ text: transcript.text, sourceRevision: window.source_revision });
    if (dataDir) {
      const cached = readCandidateDiskCache(dataDir, key, fsApi);
      if (cached && cached.fingerprint === fingerprint && Array.isArray(cached.names) && cached.names.length) {
        results.set(key, { names: cached.names, transcript, provider: cached.provider || 'cache', from_cache: true });
        continue;
      }
    }
    pending.push({ key, window, text: transcript.text, transcript, fingerprint });
  }
  if (!pending.length) return results;

  const maxPromptBytes = deps.maxCandidatePromptBytes || CANDIDATE_MAX_PROMPT_BYTES;
  const chunks = chunkCandidateEntries(pending, maxPromptBytes);

  for (const chunk of chunks) {
    if (chunk.length === 1) {
      const item = chunk[0];
      const result = await candidateNamesForCall(item.window, deps);
      results.set(item.key, result);
      if (!result.malformed_candidate_output && result.names && result.names.length && dataDir) {
        writeCandidateDiskCache(
          dataDir,
          item.key,
          {
            fingerprint: item.fingerprint,
            names: result.names,
            provider: result.provider || 'unknown',
            prompt_version: PROMPT_VERSION,
            cached_at: new Date().toISOString(),
          },
          fsApi,
        );
      }
      continue;
    }
    const entries = chunk.map((item) => ({ key: item.key, text: item.text }));
    const options = {
      surface: 'voice-identity-jev-candidate-names',
      system: CANDIDATE_SYSTEM_PROMPT_MULTI,
      rungOrder: ['claude-cli', 'codex'],
      briefingContext: true,
      toolLess: true,
      rungTimeoutMs: 180000,
      maxDynamicBytes: 256 * 1024,
      maxPromptBytes: CANDIDATE_MAX_PROMPT_BYTES,
    };
    let response = await ladder(buildMultiWindowPrompt(entries), options);
    let parsedMap;
    try {
      parsedMap = parseMultiWindowResponse(response.text);
    } catch {
      response = await ladder(
        [
          buildMultiWindowPrompt(entries),
          'Your prior response was not valid JSON. Return exactly one JSON object now:',
          '{"windows":[{"window":"<window id>","candidate_names":["First Last"]}]}',
          'Include one entry for every window id shown, using an empty list when no personal names are supported.',
        ].join('\n\n'),
        options,
      );
      try {
        parsedMap = parseMultiWindowResponse(response.text);
      } catch {
        parsedMap = null;
      }
    }
    for (const item of chunk) {
      if (!parsedMap) {
        results.set(item.key, {
          names: [],
          transcript: item.transcript,
          provider: response.rung || 'unknown',
          malformed_candidate_output: true,
        });
        continue;
      }
      const names = parsedMap.has(item.key) ? parsedMap.get(item.key) : [];
      results.set(item.key, { names, transcript: item.transcript, provider: response.rung || 'unknown' });
      if (names.length && dataDir) {
        writeCandidateDiskCache(
          dataDir,
          item.key,
          {
            fingerprint: item.fingerprint,
            names,
            provider: response.rung || 'unknown',
            prompt_version: PROMPT_VERSION,
            cached_at: new Date().toISOString(),
          },
          fsApi,
        );
      }
    }
  }
  return results;
}

function assignmentQuestion(targetIds, candidates) {
  const targetLabel = targetIds.map((id) => `[${id}]`).join(' and ');
  const criteria = {};
  candidates.forEach((name, index) => {
    criteria[`candidate_${index + 1}`] =
      `${targetLabel} is named "${name}" in this conversation. The name is tied to that speaker by ` +
      'self-identification, direct address with a responsive turn, or equally explicit conversational evidence.';
  });
  criteria.unknown =
    `The complete conversation does not confidently establish which candidate name belongs to ${targetLabel}.`;
  return {
    type: 'choice',
    instructions:
      `Which candidate name belongs to ${targetLabel}? Use the complete conversation and stable speaker ids. ` +
      'A mentioned person is not necessarily a speaker. Guessing is worse than choosing unknown.',
    criteria,
  };
}

function assignmentResults(candidates, probabilities = {}) {
  const rows = candidates
    .map((name, index) => ({ name, p: Number(probabilities[`candidate_${index + 1}`] || 0) }))
    .sort((a, b) => b.p - a.p || a.name.localeCompare(b.name));
  const top = rows[0] || { name: '', p: 0 };
  const runnerUp = Math.max(Number(probabilities.unknown || 0), Number(rows[1]?.p || 0));
  return rows.map((row, index) => ({
    name: row.name,
    best: row.p,
    lean: row.p,
    kind: 'whole_call_assignment',
    scenes: 1,
    counted:
      index === 0 &&
      row.p >= ASSIGNMENT_MIN_P &&
      row.p - runnerUp >= ASSIGNMENT_MIN_MARGIN,
    runner_up: index === 0 ? runnerUp : undefined,
  }));
}

// Ask Jev once per unresolved voice and complete call. The subscription LLM
// candidate pass is cached by call id, so every call is read by that pass once.
async function judgeWindow(target, window, deps = {}) {
  const system = deps.jevSystemOne || jevSystemOne;
  const admit = deps.admitJevSpend || admitJevSpend;
  const record = deps.recordJevSpend || recordJevSpend;
  const cache = deps.candidateCache || new Map();
  const key = callKey(window);
  const transcript = canonicalSpeakerTranscript(window);
  const targetIds = targetSpeakerIds(window, transcript);
  if (!cache.has(key)) {
    // Decisive voiceprint case: no target speaker turn survives in this
    // window, so there is nothing for Jev to map here. Skip the candidate
    // extraction LLM entirely rather than spending a call on it.
    cache.set(key, targetIds.length ? await candidateNamesForCall(window, deps) : { names: [], transcript });
  }
  const candidateResult = cache.get(key);
  const excludedKnownVoiceprints = window.known_voiceprint_names || [];
  const candidates = cleanCandidateNames(candidateResult.names || [], {
    excludedKnownVoiceprints,
  });
  if (!candidates.length) return { window, names: [], skipped: 'candidate_llm_found_no_names' };
  if (!targetIds.length) return { window, names: [], skipped: 'target_speaker_id_missing' };
  const questions = { assignment: assignmentQuestion(targetIds, candidates) };
  const maxTranscriptTokens = Number(deps.maxTranscriptTokens) || JEV_MAX_TRANSCRIPT_TOKENS;
  let response;
  let estimatedTokens = 0;
  let inputTokens = 0;
  let started = 0;
  let transcriptBounded = false;
  // One retry at half the budget if Jev still reports the state too large,
  // because the chars/4 estimate is an approximation of its tokenizer.
  for (const budget of [maxTranscriptTokens, Math.floor(maxTranscriptTokens / 2)]) {
    const excerpt = boundedTranscriptText(transcript.text, targetIds, budget);
    transcriptBounded = excerpt.bounded;
    const state = {
      candidate_names: candidates,
      excluded_known_voiceprint_names: excludedKnownVoiceprints,
      target_speaker_ids: targetIds,
      complete_speaker_tagged_call: excerpt.text,
    };
    estimatedTokens = estimateTokens(state) + estimateTokens(questions);
    const admission = admit({ estimatedTokens, lane: 'speaker-naming' });
    if (!admission.ok) {
      throw new JevError(`jev spend refused before contact: ${admission.reason}`, { code: 'budget' });
    }
    inputTokens = 0;
    started = Date.now();
    try {
      response = await system({ state, questions });
      inputTokens = Number((response.usage && response.usage.input_tokens) || 0);
      break;
    } catch (error) {
      record({ surface: SURFACE, inputTokens, outcome: `failed:${error.code || 'error'}`, error });
      if (!jevMaxTokensExceeded(error) || budget !== maxTranscriptTokens) throw error;
    }
  }
  record({
    surface: SURFACE,
    inputTokens: inputTokens || estimatedTokens,
    latencyMs: Date.now() - started,
  });
  const probabilities = response?.answers?.assignment?.probabilities || {};
  return {
    window,
    names: assignmentResults(candidates, probabilities),
    target_speaker_ids: targetIds,
    candidate_provider: candidateResult.provider || 'unknown',
    ...(transcriptBounded ? { transcript_bounded: true } : {}),
  };
}

// One name wins a window only when it clears the bar and no different name
// also clears it; two names that both look like the TARGET cancel out.
function windowDecision(result) {
  const names = (result && result.names) || [];
  const top = names[0];
  if (!top || !top.counted) return null;
  const rival = names.slice(1).find((n) => n.counted && !sameFirstName(n.name, top.name));
  return rival ? null : top;
}

function rowFromWindowResults(target, results) {
  const strongByName = new Map();
  const evidence = [];
  const variants = new Set();
  let judgedWindows = 0;
  let skippedWindows = 0;
  const assignmentObservations = [];
  const candidateProviders = new Set();
  for (const result of results) {
    if (!result.names || !result.names.length) {
      skippedWindows += 1;
      continue;
    }
    judgedWindows += 1;
    if (result.candidate_provider) candidateProviders.add(result.candidate_provider);
    assignmentObservations.push({
      window_id: result.window.id,
      target_speaker_ids: result.target_speaker_ids || [],
      candidates: result.names.map((n) => ({
        name: n.name,
        p: n.best,
        runner_up: n.runner_up,
        accepted: Boolean(n.counted),
      })),
    });
    for (const n of result.names) if (n.counted || n.lean >= VARIANT_MIN_P) variants.add(n.name);
    const win = windowDecision(result);
    if (win) {
      const list = strongByName.get(win.name) || [];
      list.push({ window: result.window, win });
      strongByName.set(win.name, list);
      evidence.push({
        window_id: result.window.id,
        name: win.name,
        type: EVIDENCE_TYPE[win.kind],
        strength: 'strong',
        explanation: `Jev ${JEV_MODEL} mapped ${win.name} to the stable target speaker id from the complete tagged call (p=${win.best.toFixed(2)}, runner-up=${Number(win.runner_up || 0).toFixed(2)}, margin=${(win.best - Number(win.runner_up || 0)).toFixed(2)}).`,
      });
    } else {
      const lean = [...result.names].sort((a, b) => b.lean - a.lean)[0];
      if (lean && lean.lean >= VARIANT_MIN_P) {
        evidence.push({
          window_id: result.window.id,
          name: lean.name,
          type: 'possible name',
          strength: 'weak',
          explanation: `Jev leaned toward ${lean.name} as the TARGET (p=${lean.lean.toFixed(2)}), below the bar or tied with another name.`,
        });
      }
    }
  }
  // The name won in the most calls is proposed. A tie between different names
  // proposes nothing: calibration found two voices whose calls each named a
  // different person, and letting the stronger p break the tie turned two
  // one-call picks into a wrong "strong" verdict downstream.
  const ranked = [...strongByName.entries()]
    .map(([name, list]) => ({
      name,
      list,
      self: list.some((r) => r.win.kind === 'self'),
      p: Math.max(...list.map((r) => r.win.best)),
    }))
    .sort((a, b) => b.list.length - a.list.length || Number(b.self) - Number(a.self) || b.p - a.p);
  const leader = ranked[0];
  const tied =
    leader &&
    ranked[1] &&
    ranked[1].list.length === leader.list.length &&
    Number(ranked[1].self) === Number(leader.self);
  const conflictingWins = ranked
    .slice(1)
    .reduce((sum, candidate) => sum + candidate.list.length, 0);
  // Precision is the contract. Each window winner already cleared the
  // calibrated whole-call probability and runner-up margin. A second call is
  // useful corroboration but is not mandatory for an explicit self-name or
  // direct-address assignment that clears those calibrated gates.
  //
  // ExampleCo, 2026-09-26 (#otter): a 12-call voice where 11 calls clearly named
  // PRIVATE_NAME and one named PRIVATE_NAME stayed unnamed, because any single conflicting
  // call vetoed the name. A supermajority now proposes the leader: at least
  // SUPERMAJORITY_MIN_WINS winning calls and at least SUPERMAJORITY_SHARE of all
  // decided calls. Dissenting calls stay weak counterevidence, and ExampleCo's Save
  // remains the only identity authority.
  const supermajority =
    SUPERMAJORITY_ENABLED &&
    leader &&
    leader.list.length >= SUPERMAJORITY_MIN_WINS &&
    leader.list.length / (leader.list.length + conflictingWins) >= SUPERMAJORITY_SHARE;
  const best =
    leader && !tied && leader.list.length >= 1 && (conflictingWins === 0 || supermajority)
      ? leader
      : null;
  // Only the proposed name keeps strong evidence. Calls won by any other name
  // stay visible as weak evidence and count against it, because the pipeline
  // merge counts every strong item in a row as support for the row's name.
  for (const item of evidence) {
    if (item.strength === 'strong' && (!best || item.name !== best.name)) {
      item.strength = 'weak';
      item.type = 'possible name';
      item.explanation = `${item.explanation} Another name also won a call for this voice, so this is not counted.`;
    }
  }
  const clear = best ? best.list.length : 0;
  const selfIntro = best ? best.self : false;
  const counter = conflictingWins;
  const why = best
    ? `Jev ${JEV_MODEL} tied ${best.name} to the stable target speaker id in ${clear} complete tagged call window${clear === 1 ? '' : 's'} above p=${ASSIGNMENT_MIN_P.toFixed(2)} with at least ${ASSIGNMENT_MIN_MARGIN.toFixed(2)} margin and ${counter ? `${counter} conflicting call${counter === 1 ? '' : 's'} (supermajority; review the dissenting call${counter === 1 ? '' : 's'})` : 'no conflicting accepted name'}${selfIntro ? ', including a self-introduction' : ''}.`
    : `Jev ${JEV_MODEL} abstained: no candidate cleared p=${ASSIGNMENT_MIN_P.toFixed(2)} plus ${ASSIGNMENT_MIN_MARGIN.toFixed(2)} runner-up margin with zero conflicting accepted names across ${judgedWindows} complete tagged call window(s)${skippedWindows ? `; ${skippedWindows} window(s) had no usable candidate pool or target speaker id` : ''}.`;
  return {
    target: target.target,
    best_name: best ? best.name : null,
    heard_name_variants: [...variants],
    canonical_person_id_if_known: null,
    confidence: best ? 'strong' : 0,
    clear_evidence_count: clear,
    counterevidence_count: counter,
    why,
    evidence,
    assignment_observations: assignmentObservations,
    candidate_name_providers: [...candidateProviders],
    judge_backend: 'jev',
    judge_model: JEV_MODEL,
    judge_method: JUDGE_METHOD,
  };
}

// Judge one target (one acoustic voice) across the call windows it was given.
// Any provider, budget or key failure throws: the run fails loudly and the
// target is retried later, instead of being recorded as judged-unnamed.
async function judgeTargetWithJev(target, deps = {}) {
  const windows = Array.isArray(target.windows) ? target.windows : [];
  const sharedDeps = { ...deps, candidateCache: deps.candidateCache || new Map() };
  // One batched, cache-aware candidate-extraction pass covers every window
  // this target was heard on, instead of judgeWindow making its own askAI
  // call one window at a time.
  const preloaded = await candidateNamesForWindows(windows, sharedDeps);
  for (const [key, value] of preloaded) sharedDeps.candidateCache.set(key, value);
  const results = [];
  for (const window of windows) results.push(await judgeWindow(target, window, sharedDeps));
  return rowFromWindowResults(target, results);
}

function enforceUniqueNamesPerCall(targetResults) {
  const claims = new Map();
  for (const item of targetResults) {
    for (const result of item.results) {
      const win = windowDecision(result);
      if (!win) continue;
      const key = `${callKey(result.window)}\n${firstNameKey(win.name)}`;
      const list = claims.get(key) || [];
      list.push({ result, win });
      claims.set(key, list);
    }
  }
  for (const list of claims.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => b.win.best - a.win.best);
    const keep = list[0].win.best > list[1].win.best ? list[0] : null;
    for (const claim of list) {
      if (claim === keep) continue;
      for (const row of claim.result.names || []) {
        if (sameFirstName(row.name, claim.win.name)) row.counted = false;
      }
    }
  }
  return targetResults;
}

async function judgeTargetsWithJev(targets, deps = {}) {
  const sharedDeps = { ...deps, candidateCache: deps.candidateCache || new Map() };
  const allWindows = [];
  for (const target of targets) for (const window of target.windows || []) allWindows.push(window);
  const preloaded = await candidateNamesForWindows(allWindows, sharedDeps);
  for (const [key, value] of preloaded) sharedDeps.candidateCache.set(key, value);
  const targetResults = [];
  for (const target of targets) {
    const results = [];
    for (const window of target.windows || []) {
      results.push(await judgeWindow(target, window, sharedDeps));
    }
    targetResults.push({ target, results });
  }
  enforceUniqueNamesPerCall(targetResults);
  return {
    targets: targetResults.map(({ target, results }) => rowFromWindowResults(target, results)),
  };
}

// Liveness probe for the overnight resolver: one tiny request, no transcript.
async function jevPreflight(deps = {}) {
  const system = deps.jevSystemOne || jevSystemOne;
  try {
    const response = await system({
      state: 'Speaker A: Hi, this is PRIVATE_NAME. Speaker B: Thanks PRIVATE_NAME.',
      questions: { named: { type: 'noul', instructions: 'Speaker A says their own name.' } },
      retries: 1,
      timeoutMs: 20000,
    });
    const noul = Number(
      response && response.answers && response.answers.named ? response.answers.named.noul : NaN,
    );
    return Number.isFinite(noul) ? { ok: true } : { ok: false, reason: 'jev preflight returned no answer' };
  } catch (error) {
    return { ok: false, reason: `jev preflight failed: ${error.code || ''} ${error.message}`.trim() };
  }
}

module.exports = {
  SURFACE,
  EVIDENCE_TYPE,
  SCENE_BARS,
  ANSWERS_BAR,
  VARIANT_MIN_P,
  JUDGE_METHOD,
  ASSIGNMENT_MIN_P,
  ASSIGNMENT_MIN_MARGIN,
  nameJudgeArtifactCurrent,
  canonicalSpeakerTranscript,
  boundedTranscriptText,
  JEV_MAX_TRANSCRIPT_TOKENS,
  targetSpeakerIds,
  cleanCandidateNames,
  candidateMatchesKnownVoiceprint,
  candidateNamesForCall,
  candidateNamesForWindows,
  assignmentQuestion,
  assignmentResults,
  mentionShape,
  sceneCounts,
  answersQuestion,
  extractNameCandidates,
  parseTurns,
  scenesForName,
  sceneText,
  whoQuestion,
  windowDecision,
  judgeWindow,
  rowFromWindowResults,
  judgeTargetWithJev,
  judgeTargetsWithJev,
  enforceUniqueNamesPerCall,
  jevPreflight,
};
