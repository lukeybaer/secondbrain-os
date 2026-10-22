'use strict';

// DIRECT-ADDRESS NAME CONTRADICTION GATE (Owner decision chat).
//
// "it was a call that you had labeled as Ed when it was actually PRIVATE_NAME
//  speaking. you had the voice match wrong possibly. I'm asking you to
//  inspect that and fix the bug."
//
// Root cause, an event-planning call (2026-04-27, otid NSsWB59Qn...):
// the sandbox promoter attached Ed to track 1 under
// strict_reference_voiceprint_plus_whole_call_name_gate. The closed-set ECAPA
// match picked the nearest ENROLLED voice (Ed had 15 track references, PRIVATE_NAME
// had no ECAPA reference until 2026-09-22), and the whole-call name gate only
// blocks on the Jev name judge's strong contradictory verdict, which did not
// exist for that track. The owner addressed the speaker by name three times
// ("Hey, PRIVATE_NAME", "PRIVATE_NAME, okay...", "PRIVATE_NAME, this is...") and nothing read it.
//
// This module is the deterministic, free check that was missing. When the
// other speakers in a call repeatedly address a track by a known person's
// first name, and that name is clearly not the candidate's name, and no other
// identified track in the call carries that name, the candidate is a
// contradiction. The promoters block on it (the candidate stays parked for
// owner review), and the cluster-resolution applier flags an auto-promotion
// that is already applied so the review surfaces can show it. The owner's own
// confirmations (confirmed_by_owner) always win and are never flagged here.
//
// The vocabulary is the people Amy already knows (registry people and
// enrollments plus the operator voice-name families, which carry the ASR
// spellings such as PRIVATE_NAME for PRIVATE_NAME). An unknown capitalized word after
// "hey" is not a name to this gate, so adverbs, places and products never
// count. Only direct address counts: a mention ("I talked to PRIVATE_NAME") is
// never evidence about who is speaking.

const fs = require('node:fs');
const path = require('node:path');
const { heardNameFamily } = require('./people-name-match');
const { loadOperatorIdentity } = require('./operator-identity');

const DIRECT_ADDRESS_CONTRADICTION_REASON = 'direct_address_name_contradiction';
const DEFAULT_MIN_HITS = 2;
const DEFAULT_WINDOW_SECONDS = 20;
const DEFAULT_LOOKAROUND_SEGMENTS = 2;

const GREETING_PATTERN =
  /\b(?:hey|hi|hello|thanks|thank you|yes|yeah|yep|okay|ok|alright|right|sorry|morning|good morning|good afternoon|bye|welcome|over to|back to|go ahead)[,!.]?\s+([A-Za-z]+)\b/gi;
const SENTENCE_INITIAL_PATTERN = /(?:^|[.!?]\s+)([A-Z][a-z]+),\s/g;
// A trailing name counts only at the end of a question or exclamation
// ("How are you, PRIVATE_NAME?"); "I spoke with our planner, PRIVATE_NAME." is an
// appositive mention and never direct address (Codex 86f261461274, F3).
const TRAILING_PATTERN = /,\s*([A-Z][a-z]+)[!?](?:\s|$)/g;
// "I spoke with our planner, PRIVATE_NAME!" is still an appositive: the name renames
// the person the clause just mentioned. An appositive therefore needs a
// person or role noun right before the comma (friend, planner, boss), led by
// a determiner or possessive; such a trailing name is discarded even in a
// question or an exclamation (Codex 8e98cc943d8e). An object noun keeps the
// vocative: "Did you receive the email, PRIVATE_NAME?" and "Do you have the
// numbers, the owner?" count, as do "How are you, PRIVATE_NAME?" and "What do you
// think, the owner?" (Codex 0448230c6dd4, high: a noun-phrase-only rule swallowed
// them). A noun this list does not know counts as a vocative, so the unknown
// case errs toward a review flag, never toward a silent promotion.
const PERSON_NOUNS = [
  'friend', 'buddy', 'pal', 'colleague', 'coworker', 'partner', 'boss', 'manager', 'director',
  'assistant', 'planner', 'coordinator', 'organizer', 'designer', 'developer', 'engineer',
  'lawyer', 'attorney', 'accountant', 'doctor', 'nurse', 'therapist', 'counselor', 'coach',
  'pastor', 'teacher', 'student', 'intern', 'consultant', 'advisor', 'adviser', 'agent',
  'broker', 'realtor', 'contractor', 'builder', 'vendor', 'client', 'customer', 'guy', 'man',
  'woman', 'lady', 'girl', 'boy', 'kid', 'son', 'daughter', 'brother', 'sister', 'mother',
  'father', 'mom', 'dad', 'wife', 'husband', 'cousin', 'uncle', 'aunt', 'nephew', 'niece',
  'neighbor', 'neighbour', 'roommate', 'teammate', 'leader', 'head', 'chief', 'founder',
  'cofounder', 'ceo', 'cto', 'president', 'owner', 'host', 'guest', 'speaker', 'mentor',
  'mentee', 'sponsor', 'sponsee', 'investor', 'author', 'artist', 'musician', 'producer',
  'editor', 'writer', 'photographer', 'trainer', 'specialist', 'analyst', 'scientist',
  'researcher', 'professor', 'recruiter', 'candidate', 'hire', 'employee', 'officer', 'rep',
  'representative', 'person', 'people',
];
const APPOSITIVE_HEAD_PATTERN = new RegExp(
  `\\b(?:a|an|the|this|that|these|those|my|our|your|his|her|their|its)\\s+(?:[a-z]+\\s+){0,2}(?:${PERSON_NOUNS.join('|')})s?$`,
);
const PATTERNS = [GREETING_PATTERN, SENTENCE_INITIAL_PATTERN, TRAILING_PATTERN];

function firstNameToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)[0] || '';
}

// ASR spellings of a known first name that the shared name families keep
// apart on purpose (PRIVATE_NAME LaForest and PRIVATE_NAME are different people).
// To this gate they are only "possibly the same", so a heard "PRIVATE_NAME" never
// contradicts a PRIVATE_NAME candidate; it still contradicts an Ed candidate.
// `directAddressAsrSpellings` in memory/reference_operator_identity.json
// extends this table without a code change.
const DEFAULT_ASR_SPELLINGS = Object.freeze({
  PRIVATE_NAME: ['PRIVATE_NAME', 'bryan', 'brien'],
  PRIVATE_NAME: ['PRIVATE_NAME', 'tracey'],
  PRIVATE_NAME: ['shawn', 'shaun'],
  eric: ['erik'],
  jeff: ['geoff'],
  kristen: ['kristin'],
  PRIVATE_NAME: ['alison', 'allyson'],
  mark: ['marc'],
  carl: ['karl'],
  kathy: ['cathy'],
  catherine: ['katherine', 'kathryn'],
  philip: ['phillip'],
  teresa: ['theresa'],
});
let asrSpellings = DEFAULT_ASR_SPELLINGS;

function asrSpellingsPossiblySame(a, b) {
  for (const [canonical, variants] of Object.entries(asrSpellings)) {
    const family = new Set([firstNameToken(canonical), ...(variants || []).map(firstNameToken)]);
    if (family.has(a) && family.has(b)) return true;
  }
  return false;
}

// A heard name and a candidate name are "possibly the same person" only when
// they are equal, share one nickname family (PRIVATE_NAME, PRIVATE_NAME, PRIVATE_NAME; Ed,
// Edmund), one is a prefix of the other (PRIVATE_NAME, Danielle) or they sit in one
// explicit ASR spelling family above. There is deliberately no edit-distance
// or soundex rule here: Codex review 86f261461274 (high) showed the earlier
// same-initial two-edit rule let Mark pass as Mary and the owner as Lucy, which
// is exactly the class of wrong promotion this gate exists to stop. A
// spelling this table does not know errs toward a review flag, never toward
// a silent promotion.
function namesPossiblySame(heard, candidate) {
  const a = firstNameToken(heard);
  const b = firstNameToken(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  const familyA = heardNameFamily(a);
  const familyB = heardNameFamily(b);
  if (familyA && familyB && familyA === familyB) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3 && long.startsWith(short)) return true;
  return asrSpellingsPossiblySame(a, b);
}

// One predicate for "this identity was attached by a machine, not by the owner",
// shared by the promoters, the applier and the sweep. Production tracks
// promoted at enrichment time carry only identity_tier (no
// voice_cluster_resolution_status), so both fields are read (Codex
// 86f261461274, F4).
function isAutoPromotedTrack(track) {
  const status = String(track?.voice_cluster_resolution_status || track?.identity_tier || '');
  return /^confirmed_reference_voiceprint/.test(status);
}

function personNameTokens(personId, displayName) {
  const tokens = new Set();
  const first = firstNameToken(displayName);
  if (first) tokens.add(first);
  const fromId = firstNameToken(String(personId || '').replace(/_/g, ' '));
  if (fromId) tokens.add(fromId);
  const parenthetical = String(displayName || '').match(/\(([^)]+)\)/);
  if (parenthetical) {
    const alias = firstNameToken(parenthetical[1]);
    if (alias) tokens.add(alias);
  }
  return [...tokens];
}

function buildKnownNameVocabulary({ registry = {}, operatorIdentity = null } = {}) {
  const vocabulary = new Set();
  const add = (value) => {
    const token = firstNameToken(value);
    if (token && token.length >= 3 && !/^\d+$/.test(token)) vocabulary.add(token);
  };
  for (const [personId, person] of Object.entries(registry?.people || {})) {
    for (const token of personNameTokens(personId, person?.display_name)) add(token);
  }
  for (const enrollment of registry?.enrollments || []) {
    for (const token of personNameTokens(enrollment?.person_id, enrollment?.display_name)) add(token);
  }
  const identity = operatorIdentity || loadOperatorIdentity();
  if (identity?.directAddressAsrSpellings && typeof identity.directAddressAsrSpellings === 'object') {
    asrSpellings = { ...DEFAULT_ASR_SPELLINGS, ...identity.directAddressAsrSpellings };
  }
  for (const family of identity?.voiceNameFamilies || []) {
    add(family?.canonical);
    for (const token of family?.first || []) add(token);
    for (const token of family?.compact || []) add(token);
  }
  return vocabulary;
}

function heardNamesInText(text, vocabulary) {
  const names = new Set();
  const value = String(text || '');
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(value);
    while (match) {
      const heard = match[1];
      const appositive = pattern === TRAILING_PATTERN
        && APPOSITIVE_HEAD_PATTERN.test(value.slice(0, match.index).trimEnd());
      // The greeting may be capitalized ("Hey, PRIVATE_NAME"); the name must be.
      if (!appositive && /^[A-Z][a-z]+$/.test(heard) && vocabulary.has(heard.toLowerCase())) names.add(heard);
      match = pattern.exec(value);
    }
  }
  return [...names];
}

function seconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// Map each speaker label to the names it is addressed by. An addressing
// segment attributes its names to ONE addressee: the nearest different-label
// neighbour (within a few segments and a short time window). When the
// speaker before and the speaker after are different people the address is
// ambiguous and attributed to nobody, so one "Thanks, PRIVATE_NAME" in a
// multi-party call can never count against two tracks (Codex 86f261461274,
// F2). In a two-party call the person who answers "Hey, PRIVATE_NAME" is PRIVATE_NAME.
function directAddressCounts(segments, vocabulary, options = {}) {
  const windowSeconds = Number(options.windowSeconds ?? DEFAULT_WINDOW_SECONDS);
  const lookaround = Number(options.lookaroundSegments ?? DEFAULT_LOOKAROUND_SEGMENTS);
  const counts = new Map();
  const rows = Array.isArray(segments) ? segments : [];
  for (let index = 0; index < rows.length; index += 1) {
    const segment = rows[index] || {};
    const names = heardNamesInText(segment.text, vocabulary);
    if (!names.length) continue;
    const label = String(segment.speaker_model_label ?? '');
    const start = seconds(segment.start_seconds);
    const end = seconds(segment.end_seconds ?? segment.start_seconds);
    let nextLabel = null;
    for (let next = index + 1; next < Math.min(rows.length, index + 1 + lookaround); next += 1) {
      const other = rows[next] || {};
      const otherLabel = String(other.speaker_model_label ?? '');
      if (otherLabel === label) continue;
      if (seconds(other.start_seconds) - end <= windowSeconds) nextLabel = otherLabel;
      break;
    }
    let prevLabel = null;
    for (let prev = index - 1; prev >= Math.max(0, index - lookaround); prev -= 1) {
      const other = rows[prev] || {};
      const otherLabel = String(other.speaker_model_label ?? '');
      if (otherLabel === label) continue;
      if (start - seconds(other.end_seconds ?? other.start_seconds) <= windowSeconds) prevLabel = otherLabel;
      break;
    }
    const targets = new Set();
    if (nextLabel !== null && prevLabel !== null && nextLabel !== prevLabel) {
      // Two different neighbours: ambiguous, attributed to nobody.
    } else if (nextLabel !== null || prevLabel !== null) {
      targets.add(nextLabel !== null ? nextLabel : prevLabel);
    }
    for (const target of targets) {
      if (!counts.has(target)) counts.set(target, new Map());
      const byName = counts.get(target);
      for (const name of names) {
        const row = byName.get(name) || { hits: 0, evidence: [] };
        row.hits += 1;
        row.evidence.push({
          start_seconds: start,
          addressed_by_label: label,
          text: String(segment.text || '').slice(0, 160),
        });
        byName.set(name, row);
      }
    }
  }
  return counts;
}

function directAddressContradiction({
  segments = [],
  tracks = {},
  speakerModelLabel,
  candidatePersonId = '',
  candidateDisplayName = '',
  vocabulary,
  minHits = DEFAULT_MIN_HITS,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
} = {}) {
  const result = {
    contradiction: false,
    reason: '',
    heard_name: '',
    hits: 0,
    evidence: [],
    addressed: {},
  };
  if (!vocabulary || !(vocabulary instanceof Set) || !vocabulary.size) return result;
  const label = String(speakerModelLabel ?? '');
  const byName = directAddressCounts(segments, vocabulary, { windowSeconds }).get(label);
  if (!byName) return result;
  const candidateNames = personNameTokens(candidatePersonId, candidateDisplayName);
  const otherTrackNames = [];
  for (const [otherLabel, track] of Object.entries(tracks || {})) {
    if (String(otherLabel) === label || !track?.person_id) continue;
    otherTrackNames.push(...personNameTokens(track.person_id, track.resolved_person || track.display_name));
  }
  for (const [name, row] of byName) {
    result.addressed[name] = row.hits;
    if (row.hits < Number(minHits)) continue;
    if (candidateNames.some((candidate) => namesPossiblySame(name, candidate))) continue;
    if (otherTrackNames.some((other) => namesPossiblySame(name, other))) continue;
    if (row.hits > result.hits) {
      result.contradiction = true;
      result.reason = DIRECT_ADDRESS_CONTRADICTION_REASON;
      result.heard_name = name;
      result.hits = row.hits;
      result.evidence = row.evidence.slice(0, 5);
    }
  }
  return result;
}

function readEnrichedCall(dataDir, otid) {
  const file = path.join(dataDir, 'otter', 'enriched', `${otid}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

// One cached reader per run so a promoter never parses the same call twice.
function enrichedReader(dataDir) {
  const cache = new Map();
  return (otid) => {
    const key = String(otid || '');
    if (!cache.has(key)) cache.set(key, readEnrichedCall(dataDir, key));
    return cache.get(key);
  };
}

module.exports = {
  DIRECT_ADDRESS_CONTRADICTION_REASON,
  buildKnownNameVocabulary,
  directAddressContradiction,
  directAddressCounts,
  enrichedReader,
  heardNamesInText,
  isAutoPromotedTrack,
  namesPossiblySame,
  personNameTokens,
};
