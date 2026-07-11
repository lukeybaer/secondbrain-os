#!/usr/bin/env node
/**
 * Per-call context-prior extraction (Phase C1 of the voiceprint matching
 * plan, dev-plans/voiceprint-matching-audit-2026-07-11.html).
 *
 * Emits capped log-odds prior evidence rows (scripts/lib/voice-context-priors.js
 * owns the math and the row contract) for the Phase C2 fusion step:
 *
 *   1. lexical_self_intro / lexical_addressee / lexical_name_mention from
 *      enriched transcripts (data/otter/enriched/<otid>.json). Heard names
 *      map to people via memory/contacts frontmatter names/aliases; a heard
 *      name matching zero or 2+ people yields NO prior rather than a guess.
 *   2. calendar_roster + email_participants from whatever roster-shaped
 *      artifacts exist under DATA_DIR. When no usable source exists the
 *      artifact records sources_missing instead of fabricating rows.
 *   3. cooccurrence from RESOLVED speakers (identity_tier
 *      confirmed_by_ExampleCo_cluster ONLY, the human-confirmed tier); rows carry
 *      the source cluster ids so the circularity block can fire (Codex am. 12).
 *   4. Optional LLM assist (--llm) through the non-charged rungs of
 *      scripts/lib/ask-ai.js only; proposed rows are validated against the
 *      transcript (verbatim quote required) and each row records its
 *      extractor. Charged API rungs are never in the rung order.
 *
 * CLI:
 *   node scripts/voice-context-prior-extract.js --otids a,b,c [--write] [--llm]
 *   node scripts/voice-context-prior-extract.js --all [--write] [--llm]
 *
 * Artifacts (with --write):
 *   DATA_DIR/life-archive/voiceprints/context-priors-latest.json
 *   DATA_DIR/life-archive/voiceprints/context-priors/<otid>.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const priors = require('./lib/voice-context-priors.js');

const REPO = path.resolve(__dirname, '..');
const SCHEMA = 'voice_context_priors.v1';
const CONFIRMED_TIER = 'confirmed_by_ExampleCo_cluster';
// "Frequently co-occur": an edge must span at least this many confirmed calls
// before it produces a weak voice_derived prior.
const MIN_COOCCURRENCE_CALLS = 2;
// Non-charged rungs only. The charged floors (openai-api, anthropic-api,
// bedrock) are intentionally absent so this extractor can never burn paid API
// usage; if none of these answer, we degrade to regex-only and say so.
const NON_CHARGED_RUNG_ORDER = ['codex', 'claude-proxy', 'claude-cli'];

const TITLE_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'call', 'meeting', 'sync', 'notes', 'weekly', 'daily']);

function defaultDataDir() {
  return path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data'));
}

function defaultContactsDir() {
  return path.join(REPO, 'memory', 'contacts');
}

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(String(fs.readFileSync(file, 'utf8')).replace(/^\uFEFF/, '').trim());
  } catch {
    return fallback;
  }
}

function listJsonFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Contacts: person ids + aliases + emails from memory/contacts frontmatter.
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  const out = {};
  const match = String(text || '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return out;
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function splitListField(value) {
  return String(value || '')
    .split(/[,;|]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function loadContacts(contactsDir) {
  const people = [];
  let files = [];
  try {
    files = fs.readdirSync(contactsDir)
      .filter((n) => n.endsWith('.md') && !n.startsWith('_') && !n.startsWith('ExampleCo_voice'));
  } catch {
    return people;
  }
  for (const name of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(contactsDir, name), 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(text);
    const personId = name.replace(/\.md$/, '');
    const displayName = fm.name || personId.replace(/_/g, ' ');
    const aliases = new Set();
    const adExampleCos = (value, force = false) => {
      const n = priors.normalizeName(value);
      if (!n) return;
      if (force || n.length >= 3 || n === 'ed') aliases.add(n);
    };
    adExampleCos(displayName, true);
    adExampleCos(personId.replace(/_/g, ' '), true);
    const parts = priors.normalizeName(displayName).split(' ').filter(Boolean);
    if (parts[0]) adExampleCos(parts[0], parts[0] === 'ed');
    if (parts.length >= 2) adExampleCos(`${parts[0]} ${parts[1]}`, true);
    for (const alias of splitListField(fm.aliases)) adExampleCos(alias);
    const emails = new Set(
      [...splitListField(fm.email), ...splitListField(fm.emails)]
        .map((e) => e.toLowerCase())
        .filter((e) => e.includes('@')),
    );
    people.push({
      person_id: personId,
      display_name: displayName,
      aliases: [...aliases],
      emails: [...emails],
    });
  }
  return people;
}

/** Map normalized alias -> [{ person_id, display_name }] (unique per person). */
function builExampleCosLookup(people) {
  const lookup = new Map();
  for (const person of people) {
    for (const alias of person.aliases || []) {
      if (!lookup.has(alias)) lookup.set(alias, []);
      const hits = lookup.get(alias);
      if (!hits.some((hit) => hit.person_id === person.person_id)) {
        hits.push({ person_id: person.person_id, display_name: person.display_name });
      }
    }
  }
  return lookup;
}

/**
 * A heard name resolves only when EXACTLY one person matches; zero or 2+
 * matches yield null (no prior rather than a guess).
 */
function resolveHeardName(rawName, aliasLookup) {
  const phrase = priors.normalizeName(rawName);
  if (!phrase) return null;
  const hits = aliasLookup.get(phrase) || [];
  if (hits.length === 1) return hits[0];
  return null;
}

function buildEmailLookup(people) {
  const lookup = new Map();
  for (const person of people) {
    for (const email of person.emails || []) {
      if (!lookup.has(email)) lookup.set(email, []);
      lookup.get(email).push({ person_id: person.person_id, display_name: person.display_name });
    }
  }
  return lookup;
}

// ---------------------------------------------------------------------------
// Enriched transcript access.
// ---------------------------------------------------------------------------

function enrichedDir(dataDir) {
  return path.join(dataDir, 'otter', 'enriched');
}

function listEnrichedOtids(dataDir) {
  return listJsonFiles(enrichedDir(dataDir)).map((f) => path.basename(f, '.json'));
}

function readEnriched(dataDir, otid) {
  return readJson(path.join(enrichedDir(dataDir), `${otid}.json`), null);
}

function segmentCluster(segment) {
  const s = segment?.resolved_speaker || {};
  return String(s.voice_cluster_id || s.ExampleCo_speaker_id || s.acoustic_ExampleCo_id || '');
}

function callStartMs(enriched) {
  const raw = enriched?.start_time || enriched?.created_at || enriched?.modified_at;
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n > 10_000_000_000 ? n : n * 1000;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Map speaker_model_label -> target { otid, speaker_model_label, voice_cluster_id } plus tier info. */
function callTracks(enriched, otid) {
  const tracks = new Map();
  for (const segment of enriched?.segments || []) {
    const label = String(segment?.speaker_model_label || '');
    if (!label) continue;
    if (!tracks.has(label)) {
      tracks.set(label, {
        target: { otid, speaker_model_label: label, voice_cluster_id: '' },
        identity_tier: '',
        person_id: '',
        display_name: '',
        segment_count: 0,
      });
    }
    const track = tracks.get(label);
    track.segment_count += 1;
    if (!track.target.voice_cluster_id) track.target.voice_cluster_id = segmentCluster(segment);
    const resolved = segment?.resolved_speaker || {};
    if (!track.identity_tier && resolved.identity_tier) {
      track.identity_tier = String(resolved.identity_tier);
      track.person_id = String(resolved.person_id || '');
      track.display_name = String(resolved.resolved_person || '');
    }
  }
  return tracks;
}

// ---------------------------------------------------------------------------
// 1. Lexical extraction (regex extractor).
// ---------------------------------------------------------------------------

function buildMentionScanner(aliasLookup) {
  // Only aliases that resolve to exactly one person can produce a mention
  // prior, so ambiguous aliases are excluded from the scan up front.
  const usable = [...aliasLookup.entries()]
    .filter(([alias, hits]) => alias && hits.length === 1)
    .map(([alias, hits]) => ({ alias, person: hits[0] }));
  usable.sort((a, b) => b.alias.length - a.alias.length);
  return usable;
}

function spansOverlap(index, length, spans) {
  const end = index + length;
  return spans.some((span) => index < span.end && end > span.start);
}

function extractLexicalRows({ enriched, otid, aliasLookup }) {
  const rows = [];
  const segments = Array.isArray(enriched?.segments) ? enriched.segments : [];
  const tracks = callTracks(enriched, otid);
  const mentionScanner = buildMentionScanner(aliasLookup);
  const dedupe = new Map(); // term|label|person -> row aggregation
  const sourceRel = `data/otter/enriched/${otid}.json`;

  const addLexical = ({ term, label, person, quote, detail }) => {
    const track = tracks.get(label);
    if (!track) return;
    const key = `${term}|${label}|${person.person_id}`;
    const existing = dedupe.get(key);
    if (existing) {
      existing.count += 1;
      existing.row.provenance.detail = `${existing.baseDetail} (${existing.count} cues in this call)`;
      return;
    }
    const row = priors.makeRow({
      target: track.target,
      candidate_person_id: person.person_id,
      display_name: person.display_name,
      term,
      provenance: { source: sourceRel, quote, otid, detail },
      extractor: 'regex',
    });
    dedupe.set(key, { row, count: 1, baseDetail: detail });
    rows.push(row);
  };

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const label = String(segment?.speaker_model_label || '');
    const text = String(segment?.text || '');
    if (!label || !text.trim()) continue;

    const claimedSpans = [];
    const claimedPeople = new Set();

    // Self intro: the SPEAKING track gets the prior.
    for (const match of priors.selfIntroMatches(text)) {
      const person = resolveHeardName(match.raw_name, aliasLookup);
      if (!person) continue;
      claimedSpans.push({ start: match.index, end: match.index + match.length });
      claimedPeople.add(person.person_id);
      addLexical({
        term: 'lexical_self_intro',
        label,
        person,
        quote: match.quote,
        detail: `speaker on track ${label} introduced themselves as "${match.raw_name}"`,
      });
    }

    // Direct address: the NEXT different-label track gets the addressee prior
    // (reply-turn heuristic ported from voice-confirmation-queue-build.js).
    const addressHits = priors.directAddressMatches(text);
    if (addressHits.length) {
      const strongest = Math.max(...addressHits.map((h) => Number(h.priority || 0)));
      for (const match of addressHits.filter((h) => Number(h.priority || 0) === strongest)) {
        const person = resolveHeardName(match.raw_name, aliasLookup);
        if (!person) continue;
        claimedSpans.push({ start: match.index, end: match.index + match.length });
        claimedPeople.add(person.person_id);
        for (let j = i + 1; j < Math.min(segments.length, i + 4); j += 1) {
          const reply = segments[j];
          const replyLabel = String(reply?.speaker_model_label || '');
          if (!replyLabel || replyLabel === label) continue;
          addLexical({
            term: 'lexical_addressee',
            label: replyLabel,
            person,
            quote: match.quote,
            detail: `"${match.raw_name}" was directly addressed by track ${label}; track ${replyLabel} replied next`,
          });
          break;
        }
      }
    }

    // Name mention: weaker evidence that the mentioned person is on the call
    // somewhere; targets every OTHER track (the mentioning track rarely says
    // its own name in the third person). Skips spans already claimed by
    // self-intro / direct-address cues.
    for (const { alias, person } of mentionScanner) {
      if (claimedPeople.has(person.person_id)) continue;
      const occurrences = priors.finExampleCosOccurrences(text, alias)
        .filter((occ) => !spansOverlap(occ.index, occ.length, claimedSpans));
      if (!occurrences.length) continue;
      claimedPeople.add(person.person_id);
      for (const [otherLabel] of tracks) {
        if (otherLabel === label) continue;
        addLexical({
          term: 'lexical_name_mention',
          label: otherLabel,
          person,
          quote: occurrences[0].quote,
          detail: `track ${label} mentioned "${alias}" by name; weak presence prior for the other tracks`,
        });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 2. Roster sources (calendar_roster + email_participants): discover, never
//    fabricate.
// ---------------------------------------------------------------------------

function attendeeStrings(item) {
  const raw = item?.attendees || item?.participants || item?.guests || null;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a && typeof a === 'object') return String(a.name || a.displayName || a.email || '');
      return '';
    })
    .filter(Boolean);
}

function extractCalendarEvents(parsed, sourceFile) {
  const arrays = [];
  if (Array.isArray(parsed)) arrays.push(parsed);
  else if (parsed && typeof parsed === 'object') {
    for (const value of Object.values(parsed)) {
      if (Array.isArray(value)) arrays.push(value);
    }
  }
  const out = [];
  for (const array of arrays) {
    for (const item of array) {
      if (!item || typeof item !== 'object') continue;
      const attendees = attendeeStrings(item);
      if (!attendees.length) continue;
      const start = item.start || item.start_time || item.startTime || item.when || item.date || null;
      const title = String(item.title || item.summary || item.subject || '');
      if (!start && !title) continue;
      out.push({ title, start, attendees, source_file: sourceFile });
    }
  }
  return out;
}

function discoverCalendarSources(dataDir) {
  const searched = [];
  const events = [];
  const usedFiles = [];
  const candidateDirs = [
    path.join(dataDir, 'calendar'),
    path.join(dataDir, 'life-archive', 'calendar'),
    path.join(dataDir, 'agent'),
    path.join(dataDir, 'briefings'),
  ];
  for (const dir of candidateDirs) {
    searched.push(dir);
    for (const file of listJsonFiles(dir)) {
      const inCalendarDir = /(^|[\\/])calendar$/.test(dir.replace(/[\\/]+$/, ''));
      if (!inCalendarDir && !/calendar|meeting|event/i.test(path.basename(file))) continue;
      const parsed = readJson(file);
      const found = extractCalendarEvents(parsed, file);
      if (found.length) {
        events.push(...found);
        usedFiles.push(file);
      }
    }
  }
  return { events, usedFiles, searched };
}

function extractEmailMessages(parsed, sourceFile) {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const from = item.from || item.sender || '';
    const to = item.to || item.recipients || [];
    const cc = item.cc || [];
    const subject = String(item.subject || '');
    const date = item.date || item.internalDate || item.ts || null;
    const participants = [
      ...(typeof from === 'string' ? [from] : attendeeStrings({ attendees: [from] })),
      ...(Array.isArray(to) ? to : [to]).map((v) => (typeof v === 'string' ? v : String(v?.email || v?.name || ''))),
      ...(Array.isArray(cc) ? cc : [cc]).map((v) => (typeof v === 'string' ? v : String(v?.email || v?.name || ''))),
    ].filter(Boolean);
    if (!participants.length || (!subject && !date)) continue;
    out.push({ subject, date, participants, source_file: sourceFile });
  }
  return out;
}

function discoverEmailSources(dataDir) {
  const dir = path.join(dataDir, 'gmail', 'raw');
  const searched = [dir];
  const messages = [];
  const usedFiles = [];
  for (const file of listJsonFiles(dir)) {
    const parsed = readJson(file);
    const found = extractEmailMessages(parsed, file);
    if (found.length) {
      messages.push(...found);
      usedFiles.push(file);
    }
  }
  return { messages, usedFiles, searched };
}

function meaningfulTitleTokens(value) {
  return new Set(
    String(value || '')
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g)
      ?.filter((t) => !TITLE_STOPWORDS.has(t)) || [],
  );
}

function tokenOverlap(a, b) {
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap;
}

function timeMs(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n > 10_000_000_000 ? n : n * 1000;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

const CALENDAR_MATCH_WINDOW_MS = 2 * 60 * 60 * 1000;
const EMAIL_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

function resolveRosterPerson(nameOrEmail, aliasLookup, emailLookup) {
  const value = String(nameOrEmail || '').trim();
  if (!value) return null;
  if (value.includes('@')) {
    const hits = emailLookup.get(value.toLowerCase()) || [];
    return hits.length === 1 ? hits[0] : null;
  }
  return resolveHeardName(value, aliasLookup);
}

function rosterRowsForCall({ enriched, otid, tracks, events, messages, aliasLookup, emailLookup }) {
  const rows = [];
  const callTitleTokens = meaningfulTitleTokens(enriched?.title || '');
  const callMs = callStartMs(enriched);
  const sameDay = (ms) => callMs !== null && ms !== null && Math.abs(ms - callMs) <= EMAIL_MATCH_WINDOW_MS;

  const emit = ({ term, person, sourceFile, detail }) => {
    for (const track of tracks.values()) {
      rows.push(priors.makeRow({
        target: track.target,
        candidate_person_id: person.person_id,
        display_name: person.display_name,
        term,
        provenance: { source: sourceFile, quote: '', otid, detail },
        extractor: 'regex',
      }));
    }
  };

  for (const event of events) {
    const eventMs = timeMs(event.start);
    const titleHit = tokenOverlap(callTitleTokens, meaningfulTitleTokens(event.title)) >= 2;
    const timeHit = callMs !== null && eventMs !== null && Math.abs(eventMs - callMs) <= CALENDAR_MATCH_WINDOW_MS;
    if (!titleHit && !timeHit) continue;
    for (const attendee of event.attendees) {
      const person = resolveRosterPerson(attendee, aliasLookup, emailLookup);
      if (!person) continue;
      emit({
        term: 'calendar_roster',
        person,
        sourceFile: event.source_file,
        detail: `attendee "${attendee}" on calendar event "${event.title}" matched by ${timeHit ? 'time window' : 'title overlap'}`,
      });
    }
  }

  for (const message of messages) {
    const msgMs = timeMs(message.date);
    const overlap = tokenOverlap(callTitleTokens, meaningfulTitleTokens(message.subject));
    const matched = overlap >= 2 || (sameDay(msgMs) && overlap >= 1);
    if (!matched) continue;
    for (const participant of message.participants) {
      const person = resolveRosterPerson(participant, aliasLookup, emailLookup);
      if (!person) continue;
      emit({
        term: 'email_participants',
        person,
        sourceFile: message.source_file,
        detail: `email participant "${participant}" on "${message.subject}" near this call`,
      });
    }
  }

  // One row per (track, person, term): keep the first, count the rest.
  const seen = new Map();
  const out = [];
  for (const row of rows) {
    const key = `${row.term}|${row.target.speaker_model_label}|${row.candidate_person_id}`;
    const existing = seen.get(key);
    if (existing) {
      existing.count += 1;
      existing.row.provenance.detail = `${existing.baseDetail} (${existing.count} matching roster hits)`;
      continue;
    }
    seen.set(key, { row, count: 1, baseDetail: row.provenance.detail });
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Co-occurrence from human-confirmed speakers only.
// ---------------------------------------------------------------------------

/**
 * Build the person co-occurrence graph from confirmed_by_ExampleCo_cluster
 * assignments across the whole enriched corpus. Every edge ExampleCos the voice
 * cluster ids of the assignments that created it so scoring can block
 * circular reuse against the same cluster (Codex amendment 12).
 */
function buildCooccurrenceGraph(dataDir, otids) {
  const edges = new Map(); // 'a|b' sorted -> { count, source_cluster_ids:Set, people:[a,b] }
  const displayNames = new Map();
  for (const otid of otids) {
    const enriched = readEnriched(dataDir, otid);
    if (!enriched) continue;
    const confirmed = new Map(); // person_id -> Set(cluster ids in this call)
    for (const track of callTracks(enriched, otid).values()) {
      if (track.identity_tier !== CONFIRMED_TIER || !track.person_id) continue;
      if (!confirmed.has(track.person_id)) confirmed.set(track.person_id, new Set());
      if (track.target.voice_cluster_id) confirmed.get(track.person_id).add(track.target.voice_cluster_id);
      if (track.display_name) displayNames.set(track.person_id, track.display_name);
    }
    const people = [...confirmed.keys()].sort();
    for (let i = 0; i < people.length; i += 1) {
      for (let j = i + 1; j < people.length; j += 1) {
        const key = `${people[i]}|${people[j]}`;
        if (!edges.has(key)) {
          edges.set(key, { count: 0, source_cluster_ids: new Set(), people: [people[i], people[j]] });
        }
        const edge = edges.get(key);
        edge.count += 1;
        for (const id of confirmed.get(people[i])) edge.source_cluster_ids.add(id);
        for (const id of confirmed.get(people[j])) edge.source_cluster_ids.add(id);
      }
    }
  }
  return { edges, displayNames };
}

function cooccurrenceRowsForCall({ enriched, otid, tracks, graph }) {
  const rows = [];
  const confirmedHere = new Set();
  for (const track of tracks.values()) {
    if (track.identity_tier === CONFIRMED_TIER && track.person_id) confirmedHere.add(track.person_id);
  }
  if (!confirmedHere.size) return rows;

  // Candidate strength: total confirmed-call count of edges linking the
  // candidate to this call's confirmed participants.
  const candidates = new Map(); // person_id -> { count, source_cluster_ids:Set, via:Set }
  for (const edge of graph.edges.values()) {
    const [a, b] = edge.people;
    const pairs = [
      [a, b],
      [b, a],
    ];
    for (const [candidate, anchor] of pairs) {
      if (!confirmedHere.has(anchor) || candidate === anchor) continue;
      if (!candidates.has(candidate)) {
        candidates.set(candidate, { count: 0, source_cluster_ids: new Set(), via: new Set() });
      }
      const row = candidates.get(candidate);
      row.count += edge.count;
      row.via.add(anchor);
      for (const id of edge.source_cluster_ids) row.source_cluster_ids.add(id);
    }
  }

  for (const [candidate, info] of candidates) {
    if (info.count < MIN_COOCCURRENCE_CALLS) continue;
    for (const track of tracks.values()) {
      // Confirmed tracks already have a human-tier identity; scoring them
      // with weak co-occurrence priors adds nothing.
      if (track.identity_tier === CONFIRMED_TIER) continue;
      rows.push(priors.makeCooccurrenceRow({
        target: track.target,
        candidate_person_id: candidate,
        display_name: graph.displayNames.get(candidate) || candidate,
        log_odds: priors.cooccurrenceLogOdds(info.count),
        source_cluster_ids: [...info.source_cluster_ids],
        provenance: {
          source: 'otter_enriched_confirmed_cooccurrence',
          quote: '',
          otid,
          detail: `co-occurs with confirmed participant(s) ${[...info.via].join(', ')} across ${info.count} human-confirmed call pairings`,
        },
        extractor: 'regex',
      }));
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 4. Optional LLM assist (non-charged rungs only).
// ---------------------------------------------------------------------------

function normalizeForQuoteCheck(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function llmLexicalAssist({ enriched, otid, aliasLookup, existingRows }) {
  let askAiLib = null;
  try {
    askAiLib = require('./lib/ask-ai.js');
  } catch {
    return { rows: [], note: 'ask-ai ladder unavailable; regex-only' };
  }
  const segments = (enriched?.segments || []).slice(0, 400);
  const transcript = segments
    .map((s) => `[track ${s.speaker_model_label}] ${String(s.text || '').slice(0, 400)}`)
    .join('\n')
    .slice(0, 24000);
  if (!transcript.trim()) return { rows: [], note: 'empty transcript; nothing for the LLM pass' };
  const question = [
    'From this diarized call transcript, list speaker-identity lexical evidence as a JSON array.',
    'Each item: {"term":"lexical_self_intro"|"lexical_addressee"|"lexical_name_mention",',
    '"speaker_model_label":"<track the evidence points AT>","heard_name":"<name heard>",',
    '"quote":"<VERBATIM substring copied from the transcript>"}.',
    'lexical_self_intro points at the introducing track; lexical_addressee points at the track that replied',
    'after being addressed; lexical_name_mention points at any OTHER track. Output ONLY the JSON array.',
    '',
    transcript,
  ].join('\n');
  let answer = null;
  try {
    answer = await askAiLib.askAI(question, {
      surface: 'voice-context-prior-extract',
      rungOrder: NON_CHARGED_RUNG_ORDER,
      silent: true,
    });
  } catch {
    answer = null;
  }
  if (!answer || !answer.text) {
    return { rows: [], note: 'no non-charged LLM rung answered; regex-only' };
  }
  const jsonMatch = String(answer.text).match(/\[[\s\S]*\]/);
  if (!jsonMatch) return { rows: [], note: `LLM (${answer.rung}) returned no parseable JSON; regex-only` };
  let proposals = [];
  try {
    proposals = JSON.parse(jsonMatch[0]);
  } catch {
    return { rows: [], note: `LLM (${answer.rung}) JSON parse failed; regex-only` };
  }
  const tracks = callTracks(enriched, otid);
  const fullText = normalizeForQuoteCheck(segments.map((s) => s.text).join(' '));
  const existingKeys = new Set(existingRows.map((r) => `${r.term}|${r.target.speaker_model_label}|${r.candidate_person_id}`));
  const rows = [];
  let rejected = 0;
  for (const proposal of Array.isArray(proposals) ? proposals : []) {
    try {
      const term = String(proposal?.term || '');
      if (!priors.isLexicalTerm(term)) { rejected += 1; continue; }
      const label = String(proposal?.speaker_model_label || '');
      const track = tracks.get(label);
      const quote = String(proposal?.quote || '');
      const person = resolveHeardName(proposal?.heard_name, aliasLookup);
      // Validation gates: real track, unique person, quote VERBATIM in call.
      if (!track || !person || !quote.trim() || !fullText.includes(normalizeForQuoteCheck(quote))) {
        rejected += 1;
        continue;
      }
      const key = `${term}|${label}|${person.person_id}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      rows.push(priors.makeRow({
        target: track.target,
        candidate_person_id: person.person_id,
        display_name: person.display_name,
        term,
        provenance: {
          source: `data/otter/enriched/${otid}.json`,
          quote,
          otid,
          detail: `LLM-proposed (${answer.rung} rung), quote-verified against the transcript`,
        },
        extractor: 'llm',
      }));
    } catch {
      rejected += 1;
    }
  }
  return { rows, note: `LLM rung ${answer.rung} proposed ${rows.length} validated row(s), rejected ${rejected}` };
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

function summarizeRows(rows) {
  const termCounts = {};
  let blocked = 0;
  for (const row of rows) {
    termCounts[row.term] = (termCounts[row.term] || 0) + 1;
    if (row.blocked) blocked += 1;
  }
  return { row_count: rows.length, term_counts: termCounts, blocked_count: blocked };
}

async function runExtract(options = {}) {
  const dataDir = path.resolve(options.dataDir || defaultDataDir());
  const contactsDir = path.resolve(options.contactsDir || defaultContactsDir());
  const write = options.write === true;
  const useLlm = options.llm === true;

  const allOtids = listEnrichedOtids(dataDir);
  const otids = options.all || !Array.isArray(options.otids) || !options.otids.length
    ? allOtids
    : options.otids.filter((otid) => allOtids.includes(otid));

  const people = loadContacts(contactsDir);
  const aliasLookup = builExampleCosLookup(people);
  const emailLookup = buildEmailLookup(people);

  const sourcesUsed = [];
  const sourcesMissing = [];

  if (allOtids.length) {
    sourcesUsed.push({ source: 'otter_enriched', detail: `${allOtids.length} enriched transcript(s) under ${enrichedDir(dataDir)}` });
  } else {
    sourcesMissing.push({
      term: 'lexical_*',
      source: 'otter_enriched',
      reason: `no enriched transcripts found under ${enrichedDir(dataDir)}`,
    });
  }
  if (people.length) {
    sourcesUsed.push({ source: 'memory_contacts', detail: `${people.length} people file(s) under ${contactsDir}` });
  } else {
    sourcesMissing.push({
      term: 'lexical_*',
      source: 'memory_contacts',
      reason: `no contacts frontmatter found under ${contactsDir}; heard names cannot map to people`,
    });
  }

  const calendar = discoverCalendarSources(dataDir);
  if (calendar.events.length) {
    sourcesUsed.push({ source: 'calendar_roster', detail: `${calendar.events.length} event(s) from ${calendar.usedFiles.join(', ')}` });
  } else {
    sourcesMissing.push({
      term: 'calendar_roster',
      source: 'calendar_artifacts',
      reason: 'no calendar/meeting artifact with attendee lists found under DATA_DIR; emitted zero calendar_roster rows instead of fabricating them',
      searched: calendar.searched,
    });
  }
  const email = discoverEmailSources(dataDir);
  if (email.messages.length) {
    sourcesUsed.push({ source: 'email_participants', detail: `${email.messages.length} message(s) from ${email.usedFiles.length} file(s) under data/gmail/raw` });
  } else {
    sourcesMissing.push({
      term: 'email_participants',
      source: 'gmail_raw',
      reason: 'no usable gmail raw messages with participants found under DATA_DIR; emitted zero email_participants rows instead of fabricating them',
      searched: email.searched,
    });
  }

  // Co-occurrence graph spans the WHOLE enriched corpus (not just the target
  // otids) so edge counts reflect real recurrence.
  const graph = buildCooccurrenceGraph(dataDir, allOtids);
  if (graph.edges.size) {
    sourcesUsed.push({
      source: 'cooccurrence_confirmed_graph',
      detail: `${graph.edges.size} person-pair edge(s) from ${CONFIRMED_TIER} assignments (voice_derived)`,
    });
  }

  const rows = [];
  const perOtid = {};
  const llmNotes = [];
  for (const otid of otids) {
    const enriched = readEnriched(dataDir, otid);
    if (!enriched) continue;
    const tracks = callTracks(enriched, otid);
    const callRows = [];
    callRows.push(...extractLexicalRows({ enriched, otid, aliasLookup }));
    callRows.push(...rosterRowsForCall({
      enriched, otid, tracks, events: calendar.events, messages: email.messages, aliasLookup, emailLookup,
    }));
    callRows.push(...cooccurrenceRowsForCall({ enriched, otid, tracks, graph }));
    if (useLlm) {
      const assist = await llmLexicalAssist({ enriched, otid, aliasLookup, existingRows: callRows });
      callRows.push(...assist.rows);
      llmNotes.push(`${otid}: ${assist.note}`);
    }
    perOtid[otid] = {
      title: String(enriched.title || otid),
      tracks: tracks.size,
      ...summarizeRows(callRows),
    };
    rows.push(...callRows);
  }

  const llmAssist = useLlm
    ? { requested: true, mode: llmNotes.some((n) => /proposed \d+ validated/.test(n)) ? 'llm_plus_regex' : 'regex_only', notes: llmNotes }
    : { requested: false, mode: 'regex_only', notes: ['LLM assist not requested (--llm); regex extractors only'] };

  const artifact = {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    data_dir: dataDir,
    contacts_dir: contactsDir,
    otids,
    sources_used: sourcesUsed,
    sources_missing: sourcesMissing,
    llm_assist: llmAssist,
    caps: {
      source_independent_term_cap: priors.SOURCE_INDEPENDENT_TERM_CAP,
      voice_derived_term_cap: priors.VOICE_DERIVED_TERM_CAP,
      total_prior_cap: priors.TOTAL_PRIOR_CAP,
    },
    row_count: rows.length,
    rows,
    per_otid: perOtid,
  };

  if (write) {
    const outDir = path.join(dataDir, 'life-archive', 'voiceprints');
    const perOtidDir = path.join(outDir, 'context-priors');
    fs.mkdirSync(perOtidDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'context-priors-latest.json'), JSON.stringify(artifact, null, 2));
    for (const otid of otids) {
      const otidRows = rows.filter((row) => row.target.otid === otid);
      fs.writeFileSync(path.join(perOtidDir, `${otid}.json`), JSON.stringify({
        schema: SCHEMA,
        generated_at: artifact.generated_at,
        otid,
        sources_used: sourcesUsed,
        sources_missing: sourcesMissing,
        llm_assist: llmAssist,
        summary: perOtid[otid] || summarizeRows(otidRows),
        rows: otidRows,
      }, null, 2));
    }
  }
  return artifact;
}

async function main() {
  const all = hasArg('--all');
  const otidsArg = arg('--otids', '');
  const otids = otidsArg.split(',').map((v) => v.trim()).filter(Boolean);
  if (!all && !otids.length) {
    console.error('Usage: node scripts/voice-context-prior-extract.js (--otids a,b,c | --all) [--write] [--llm]');
    process.exit(1);
  }
  const artifact = await runExtract({ all, otids, write: hasArg('--write'), llm: hasArg('--llm') });
  const summary = {
    schema: artifact.schema,
    otids: artifact.otids.length,
    rows: artifact.row_count,
    sources_used: artifact.sources_used.map((s) => s.source),
    sources_missing: artifact.sources_missing.map((s) => `${s.term}:${s.source}`),
    llm_assist: artifact.llm_assist.mode,
    wrote: hasArg('--write'),
  };
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  runExtract,
  loadContacts,
  builExampleCosLookup,
  resolveHeardName,
  extractLexicalRows,
  discoverCalendarSources,
  discoverEmailSources,
  buildCooccurrenceGraph,
  cooccurrenceRowsForCall,
  MIN_COOCCURRENCE_CALLS,
  NON_CHARGED_RUNG_ORDER,
  CONFIRMED_TIER,
  SCHEMA,
};
