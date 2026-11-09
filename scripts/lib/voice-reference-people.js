/**
 * Reference-person canonicalization + best-match scoring for the speaker resolver.
 *
 * The identity data can hold the same human under several person_ids (e.g.
 * two alias IDs resolving to one contact file,
 * enrolled from the SAME reference clip). If each alias becomes its own
 * reference person, the best match and the runner-up are the same voice, the
 * margin computes to ~0, and the margin gate can never pass: every track whose
 * voice is nearest that person is stuck as a durable unknown forever.
 * Canonicalize aliases BEFORE building reference people, and never let a
 * near-identical reference centroid act as the margin runner-up.
 */

const path = require('path');

// Two references of the same clip embed identically; two clips of the same
// voice sit far above any cross-person similarity. Distinct people never reach
// this, so a runner-up at or over it is the same identity, not a rival.
const DUPLICATE_CENTROID_COSINE = 0.999;

// A person's bank keeps every qualifying clip; matching uses the 10 that sit
// closest to the bank's own centroid (owner decision). Leave-one-call-out
// backtest on 357 Owner-confirmed tracks: 341 correct vs 334 for the old
// 10-clip cap, wrong-person 4 vs 4, unenrolled-stranger false matches 26 vs
// 28; sets of 15, 20 or all clips raised stranger matches to 33-36.
const REFERENCE_SET_LIMIT = 10;

function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm ? dot / norm : 0;
}

/**
 * Map alias person_ids -> canonical person_id.
 *
 * Two ids are aliases when they resolve to the same contact file, via the
 * registry `people[*].contact_file` first and the checked alias map
 * (data/agent/voiceprint-contact-aliases.json) as a fallback for ids with no
 * registry entry. Canonical id choice, per contact group:
 *   1. restrict to ids that exist in registry.people because those own the
 *      enrollments and historical attribution
 *   2. of those, prefer the id equal to the contact file basename
 *   3. else the alphabetically first candidate (deterministic)
 */
function buildCanonicalPersonMap(registry, extraAliases = {}) {
  const contactByPid = new Map();
  for (const [pid, person] of Object.entries(registry?.people || {})) {
    const contact = String(person?.contact_file || '').trim();
    if (contact) contactByPid.set(pid, contact);
  }
  for (const [pid, contact] of Object.entries(extraAliases || {})) {
    const cleaned = String(contact || '').trim();
    if (cleaned && !contactByPid.has(pid)) contactByPid.set(pid, cleaned);
  }
  const byContact = new Map();
  for (const [pid, contact] of contactByPid.entries()) {
    if (!byContact.has(contact)) byContact.set(contact, []);
    byContact.get(contact).push(pid);
  }
  const map = new Map();
  for (const [alias, canonical] of Object.entries(registry?.person_id_aliases || {})) {
    if (alias && canonical && alias !== canonical) map.set(alias, canonical);
  }
  const registryPids = new Set(Object.keys(registry?.people || {}));
  for (const [contact, pids] of byContact.entries()) {
    if (pids.length < 2) continue;
    const inRegistry = pids.filter((pid) => registryPids.has(pid));
    const candidates = inRegistry.length ? inRegistry : pids;
    const base = path.basename(contact, '.md');
    const canonical = candidates.includes(base) ? base : [...candidates].sort()[0];
    for (const pid of pids) {
      if (pid !== canonical && !map.has(pid)) map.set(pid, canonical);
    }
  }
  return map;
}

/**
 * The limit rows nearest the mean of all rows, in their original order. A
 * bank at or under the limit is returned unchanged. Over the limit, a row
 * whose vector is missing, non-finite, zero or off-dimension is dropped with
 * a warning so it can never skew the centroid or the ranking.
 */
function selectBestReferences(rows, vectorOf = (row) => row.vector, limit = REFERENCE_SET_LIMIT) {
  const all = Array.isArray(rows) ? rows : [];
  if (all.length <= limit) return all;
  const dims = new Map();
  for (const row of all) {
    const n = vectorOf(row)?.length || 0;
    if (n) dims.set(n, (dims.get(n) || 0) + 1);
  }
  const dim = [...dims.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] || 0;
  const valid = (v) => Array.isArray(v) && v.length === dim && v.every(Number.isFinite) && v.some((x) => x !== 0);
  const list = all.filter((row) => valid(vectorOf(row)));
  if (list.length < all.length) {
    console.warn(`[voice-reference-people] dropped ${all.length - list.length} malformed reference vector(s) before best-${limit} selection`);
  }
  if (list.length <= limit) return list;
  const mean = new Array(dim).fill(0);
  for (const row of list) {
    const v = vectorOf(row);
    const norm = Math.hypot(...v) || 1;
    for (let i = 0; i < dim; i += 1) mean[i] += v[i] / norm;
  }
  const keep = new Set(
    list
      .map((row, index) => ({ index, score: cosine(vectorOf(row), mean) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, limit)
      .map((x) => x.index),
  );
  return list.filter((_, index) => keep.has(index));
}

/**
 * Best-scoring reference person for a probe vector, with the margin measured
 * against the best GENUINELY DIFFERENT voice: runner-up candidates whose
 * centroid is near-identical to the winner's (duplicate reference, alias that
 * escaped canonicalization) are skipped, so a duplicate can never zero the
 * margin and permanently block attribution. A skip is warned to stderr because
 * it means the identity linkage (registry contact_file / alias map) is missing
 * an alias that should have been canonicalized upstream.
 */
function bestPersonMatch(vector, referencePeople, deniedPersonIds = new Set()) {
  const scores = referencePeople
    .filter((person) => !deniedPersonIds.has(person.person_id))
    .map((person) => ({ person, score: cosine(vector, person.centroid) }))
    .sort((a, b) => b.score - a.score);
  const best = scores[0] || null;
  if (!best) return null;
  let second = null;
  for (const row of scores.slice(1)) {
    if (cosine(row.person.centroid, best.person.centroid) < DUPLICATE_CENTROID_COSINE) {
      second = row;
      break;
    }
    console.warn(
      `[voice-reference-people] margin runner-up skipped: ${row.person.person_id} has a near-identical reference centroid to ${best.person.person_id} - alias missing from registry contact_file / voiceprint-contact-aliases.json?`,
    );
  }
  return {
    person_id: best.person.person_id,
    display_name: best.person.display_name,
    score: Number(best.score.toFixed(6)),
    runner_up_person_id: second?.person?.person_id || null,
    runner_up_display_name: second?.person?.display_name || null,
    runner_up_score: second ? Number(second.score.toFixed(6)) : null,
    margin: second ? Number((best.score - second.score).toFixed(6)) : Number(best.score.toFixed(6)),
    reference_count: best.person.reference_count,
    reference_provenance: best.person.reference_provenance || [],
  };
}

module.exports = {
  DUPLICATE_CENTROID_COSINE,
  REFERENCE_SET_LIMIT,
  cosine,
  selectBestReferences,
  buildCanonicalPersonMap,
  bestPersonMatch,
};
