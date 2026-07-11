/**
 * Voice context priors: pure prior math + evidence types (Phase C1).
 *
 * Plan: dev-plans/voiceprint-matching-audit-2026-07-11.html, Phase C items
 * 9-10 plus Codex amendment 12. Every context signal enters fusion as a
 * capped log-odds evidence row so no single text signal can override the
 * calibrated acoustic score, and voice-derived signals can never confirm
 * themselves circularly.
 *
 * Interface contract (Phase C2 fusion consumes exactly this row shape):
 * {
 *   target: { otid, speaker_model_label, voice_cluster_id },
 *   candidate_person_id, display_name,
 *   term: 'calendar_roster' | 'email_participants' | 'cooccurrence'
 *       | 'lexical_self_intro' | 'lexical_name_mention' | 'lexical_addressee',
 *   log_odds: <number, already capped per rules below>,
 *   independence: 'source_independent' | 'voice_derived',
 *   blocked: <boolean>, blocked_reason: <string|''>,
 *   provenance: { source, quote, otid, detail }
 * }
 *
 * Caps (Codex amendment 12):
 * - source_independent terms cap at +/-2.0 log-odds each
 * - voice_derived terms cap at +/-0.7 log-odds each
 * - the total prior sum per (target, candidate) caps at +/-3.0 and blocked
 *   rows are excluded from the sum
 * - cooccurrence is ALWAYS voice_derived and is blocked when the edge derives
 *   from assignments of the same target track / acoustic cluster being scored
 * - lexical terms require a verbatim quote in provenance
 */

'use strict';

const SOURCE_INDEPENDENT_TERM_CAP = 2.0;
const VOICE_DERIVED_TERM_CAP = 0.7;
const TOTAL_PRIOR_CAP = 3.0;

const TERM_INDEPENDENCE = Object.freeze({
  calendar_roster: 'source_independent',
  email_participants: 'source_independent',
  cooccurrence: 'voice_derived',
  lexical_self_intro: 'source_independent',
  lexical_name_mention: 'source_independent',
  lexical_addressee: 'source_independent',
});

const LEXICAL_TERMS = Object.freeze([
  'lexical_self_intro',
  'lexical_name_mention',
  'lexical_addressee',
]);

// Default per-term evidence strengths. These are conservative starting points
// (a self-introduction is strong text evidence, a bare third-person mention is
// weak); the Phase C2 rolling precision audit is what ultimately certifies
// the operating point, never these constants alone.
const DEFAULT_TERM_LOG_ODDS = Object.freeze({
  lexical_self_intro: 1.6,
  lexical_addressee: 1.0,
  lexical_name_mention: 0.3,
  calendar_roster: 1.2,
  email_participants: 0.9,
  cooccurrence: 0.3,
});

// Weak per-call increment for co-occurrence edges; always capped at the
// voice_derived term cap regardless of how many calls the edge spans.
const COOCCURRENCE_LOG_ODDS_PER_CALL = 0.15;

function independenceForTerm(term) {
  return TERM_INDEPENDENCE[term] || '';
}

function isLexicalTerm(term) {
  return LEXICAL_TERMS.includes(term);
}

function termCap(independence) {
  if (independence === 'voice_derived') return VOICE_DERIVED_TERM_CAP;
  if (independence === 'source_independent') return SOURCE_INDEPENDENT_TERM_CAP;
  return 0;
}

function capLogOdds(logOdds, independence) {
  const cap = termCap(independence);
  const value = Number(logOdds);
  if (!Number.isFinite(value) || cap <= 0) return 0;
  return Math.max(-cap, Math.min(cap, value));
}

function cooccurrenceLogOdds(edgeCallCount) {
  const count = Number(edgeCallCount);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(VOICE_DERIVED_TERM_CAP, COOCCURRENCE_LOG_ODDS_PER_CALL * count);
}

/**
 * Throws when a prior evidence row violates the contract. Rules:
 * - term must be one of the six known terms
 * - independence must match the term (cooccurrence is always voice_derived)
 * - target requires otid + speaker_model_label (voice_cluster_id may be '')
 * - candidate_person_id required
 * - log_odds finite and within the per-term cap
 * - blocked rows carry a nonempty blocked_reason
 * - lexical terms require a verbatim quote in provenance (Codex am. 12)
 */
function validateRow(row) {
  if (!row || typeof row !== 'object') throw new Error('prior row must be an object');
  const term = String(row.term || '');
  const expectedIndependence = independenceForTerm(term);
  if (!expectedIndependence) throw new Error(`ExampleCo prior term: "${term}"`);
  if (row.independence !== expectedIndependence) {
    throw new Error(`term ${term} must carry independence ${expectedIndependence}, got "${row.independence}"`);
  }
  const target = row.target || {};
  if (!String(target.otid || '').trim()) throw new Error('prior row target.otid is required');
  if (!String(target.speaker_model_label || '').trim()) {
    throw new Error('prior row target.speaker_model_label is required');
  }
  if (typeof target.voice_cluster_id !== 'string') {
    throw new Error('prior row target.voice_cluster_id must be a string (may be empty)');
  }
  if (!String(row.candidate_person_id || '').trim()) {
    throw new Error('prior row candidate_person_id is required');
  }
  const logOdds = Number(row.log_odds);
  if (!Number.isFinite(logOdds)) throw new Error('prior row log_odds must be a finite number');
  const cap = termCap(expectedIndependence);
  if (Math.abs(logOdds) > cap + 1e-9) {
    throw new Error(`prior row log_odds ${logOdds} exceeds the ${expectedIndependence} cap of ${cap}`);
  }
  if (typeof row.blocked !== 'boolean') throw new Error('prior row blocked must be a boolean');
  if (row.blocked && !String(row.blocked_reason || '').trim()) {
    throw new Error('blocked prior rows must carry a nonempty blocked_reason');
  }
  if (!row.blocked && String(row.blocked_reason || '') !== '') {
    throw new Error('unblocked prior rows must carry blocked_reason: ""');
  }
  const provenance = row.provenance || null;
  if (!provenance || typeof provenance !== 'object' || !String(provenance.source || '').trim()) {
    throw new Error('prior row provenance.source is required');
  }
  if (isLexicalTerm(term) && !String(provenance.quote || '').trim()) {
    throw new Error(`lexical prior rows (${term}) require a verbatim quote in provenance`);
  }
  return true;
}

/**
 * Build a validated prior evidence row. Independence is derived from the
 * term (never caller-supplied), log_odds defaults to the per-term default and
 * is capped before validation.
 */
function makeRow(input = {}) {
  const term = String(input.term || '');
  const independence = independenceForTerm(term);
  if (!independence) throw new Error(`ExampleCo prior term: "${term}"`);
  const target = input.target || {};
  const rawLogOdds = input.log_odds === undefined || input.log_odds === null
    ? DEFAULT_TERM_LOG_ODDS[term]
    : input.log_odds;
  const blocked = input.blocked === true;
  const provenance = input.provenance || {};
  const row = {
    target: {
      otid: String(target.otid || ''),
      speaker_model_label: String(target.speaker_model_label || ''),
      voice_cluster_id: String(target.voice_cluster_id || ''),
    },
    candidate_person_id: String(input.candidate_person_id || ''),
    display_name: String(input.display_name || ''),
    term,
    log_odds: capLogOdds(rawLogOdds, independence),
    independence,
    blocked,
    blocked_reason: blocked ? String(input.blocked_reason || '') : '',
    provenance: {
      source: String(provenance.source || ''),
      quote: String(provenance.quote || ''),
      otid: String(provenance.otid || target.otid || ''),
      detail: String(provenance.detail || ''),
    },
  };
  if (input.extractor) row.extractor = String(input.extractor);
  validateRow(row);
  return row;
}

/**
 * Build a cooccurrence row (always voice_derived). The caller MUST carry the
 * source cluster ids the co-occurrence edge was derived from; when the target
 * track's own cluster id appears among them the row is blocked as circular
 * self-confirmation (Codex amendment 12).
 */
function makeCooccurrenceRow(input = {}) {
  const target = input.target || {};
  const sourceClusterIds = [...new Set((input.source_cluster_ids || []).map((id) => String(id || '')).filter(Boolean))];
  if (!sourceClusterIds.length) {
    throw new Error('cooccurrence rows require source_cluster_ids so circularity can be blocked');
  }
  const targetCluster = String(target.voice_cluster_id || '');
  const circular = Boolean(targetCluster) && sourceClusterIds.includes(targetCluster);
  const row = makeRow({
    ...input,
    term: 'cooccurrence',
    blocked: circular || input.blocked === true,
    blocked_reason: circular
      ? `cooccurrence edge derives from the target track's own cluster ${targetCluster}; using it would be circular self-confirmation`
      : (input.blocked === true ? String(input.blocked_reason || '') : ''),
  });
  row.source_cluster_ids = sourceClusterIds;
  return row;
}

/**
 * Total prior for one (target, candidate) pair: sum of log_odds over rows,
 * EXCLUDING blocked rows, capped at +/-TOTAL_PRIOR_CAP.
 */
function sumPriors(rows) {
  const total = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.blocked !== true)
    .reduce((acc, row) => acc + (Number.isFinite(Number(row.log_odds)) ? Number(row.log_odds) : 0), 0);
  return Math.max(-TOTAL_PRIOR_CAP, Math.min(TOTAL_PRIOR_CAP, total));
}

function pairKey(row) {
  const target = row?.target || {};
  return [
    String(target.otid || ''),
    String(target.speaker_model_label || ''),
    String(target.voice_cluster_id || ''),
    String(row?.candidate_person_id || ''),
  ].join('|');
}

/** Group rows by (target, candidate) pair -> Map(pairKey -> rows[]). */
function groupRowsByPair(rows) {
  const out = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const key = pairKey(row);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure lexical extraction helpers (ported from the patterns proven in
// scripts/voice-confirmation-queue-build.js; duplicated here rather than
// imported because that script is owned by another lane and importing it
// would drag in its artifact IO).
// ---------------------------------------------------------------------------

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function regexEscape(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NAME_PATTERN = "([a-z][a-z0-9']*(?:\\s+[a-z][a-z0-9']*){0,2})";

const SELF_INTRO_PATTERNS = [
  new RegExp(`\\bthis\\s+is\\s+${NAME_PATTERN}(?:\\s+(?:speaking|here)|\\s*[,!.?]|$)`, 'g'),
  new RegExp(`(?:^|[.!?]\\s+)${NAME_PATTERN}\\s+(?:here|speaking)(?:\\s*[,!.?]|$)`, 'g'),
  new RegExp(`\\bi(?:\\s+am|'m)\\s+${NAME_PATTERN}(?:\\s+(?:speaking|here)|\\s*[,!.?]|$)`, 'g'),
];

const DIRECT_ADDRESS_PATTERNS = [
  { re: new RegExp(`(?:^|[.!?]\\s+)(?:oh|hey|hi|hello|okay|ok|thanks|thank\\s+you|all\\s+right)?\\s*,?\\s*${NAME_PATTERN}\\s*[,?!:]`, 'g'), priority: 4 },
  { re: new RegExp(`\\b(?:hey|hi|hello|thanks|thank\\s+you)\\s+${NAME_PATTERN}\\s*(?:[,?!:.]|$)`, 'g'), priority: 4 },
  { re: new RegExp(`\\b(?:look|listen|so|and|but|okay|ok|all\\s+right)\\s*,?\\s*${NAME_PATTERN}\\s*[,?!:]`, 'g'), priority: 3 },
  { re: new RegExp(`\\b${NAME_PATTERN}\\s*,\\s*(?:can|could|would|do|did|are|is|what|how|why|when|where|please|great|yeah|you)\\b`, 'g'), priority: 3 },
  { re: new RegExp(`\\b${NAME_PATTERN}\\s*,\\s*(?:and|but|so|great|yeah|okay|ok|all\\s+right|i|we|you|the|this|that|it)\\b`, 'g'), priority: 1 },
];

/**
 * Lowercase is length-preserving, so pattern indices found on the lowercase
 * copy slice the ORIGINAL text: quotes stay verbatim transcript substrings.
 */
function verbatimSlice(original, index, length) {
  return String(original || '').slice(index, index + length).trim();
}

/** [{ raw_name, quote, index }] for self-introductions in one segment text. */
function selfIntroMatches(text) {
  const original = String(text || '');
  const lower = original.toLowerCase();
  const out = [];
  for (const re of SELF_INTRO_PATTERNS) {
    re.lastIndex = 0;
    let match = null;
    while ((match = re.exec(lower)) !== null) {
      out.push({
        raw_name: normalizeName(match[1]),
        quote: verbatimSlice(original, match.index, match[0].length),
        index: match.index,
        length: match[0].length,
      });
    }
  }
  return out;
}

/** [{ raw_name, quote, index, priority }] for direct-address cues. */
function directAddressMatches(text) {
  const original = String(text || '');
  const lower = original.toLowerCase();
  const out = [];
  for (const { re, priority } of DIRECT_ADDRESS_PATTERNS) {
    re.lastIndex = 0;
    let match = null;
    while ((match = re.exec(lower)) !== null) {
      out.push({
        raw_name: normalizeName(match[1]),
        quote: verbatimSlice(original, match.index, match[0].length),
        index: match.index,
        length: match[0].length,
        priority,
      });
    }
  }
  return out;
}

/**
 * Occurrences of one normalized alias inside a segment text, with a verbatim
 * context window quote. [{ quote, index, length }]
 */
function finExampleCosOccurrences(text, alias) {
  const original = String(text || '');
  const words = normalizeName(alias).split(' ').filter(Boolean);
  if (!words.length) return [];
  const re = new RegExp(`\\b${words.map(regexEscape).join("[^a-z0-9']+")}\\b`, 'gi');
  const out = [];
  let match = null;
  while ((match = re.exec(original)) !== null) {
    const start = Math.max(0, match.index - 60);
    const end = Math.min(original.length, match.index + match[0].length + 60);
    out.push({
      quote: original.slice(start, end).trim(),
      index: match.index,
      length: match[0].length,
    });
  }
  return out;
}

module.exports = {
  SOURCE_INDEPENDENT_TERM_CAP,
  VOICE_DERIVED_TERM_CAP,
  TOTAL_PRIOR_CAP,
  TERM_INDEPENDENCE,
  LEXICAL_TERMS,
  DEFAULT_TERM_LOG_ODDS,
  COOCCURRENCE_LOG_ODDS_PER_CALL,
  independenceForTerm,
  isLexicalTerm,
  termCap,
  capLogOdds,
  cooccurrenceLogOdds,
  validateRow,
  makeRow,
  makeCooccurrenceRow,
  sumPriors,
  pairKey,
  groupRowsByPair,
  normalizeName,
  selfIntroMatches,
  directAddressMatches,
  finExampleCosOccurrences,
};
