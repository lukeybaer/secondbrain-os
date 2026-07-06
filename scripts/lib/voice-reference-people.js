/**
 * Reference-person canonicalization + best-match scoring for the speaker resolver.
 *
 * The identity data can hold the same human under several person_ids (e.g.
 * `ExampleCo` and `PRIVATE_NAME`, both pointing at memory/contacts/PRIVATE_NAME.md,
 * enrolled from the SAME reference clip). If each alias becomes its own
 * reference person, the best match and the runner-up are the same voice, the
 * margin computes to ~0, and the margin gate can never pass: every track whose
 * voice is nearest that person is stuck as a durable ExampleCo forever.
 * Canonicalize aliases BEFORE building reference people, and never let a
 * near-identical reference centroid act as the margin runner-up.
 */

const path = require('path');

// Two references of the same clip embed identically; two clips of the same
// voice sit far above any cross-person similarity. Distinct people never reach
// this, so a runner-up at or over it is the same identity, not a rival.
const DUPLICATE_CENTROID_COSINE = 0.999;

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
 *   1. restrict to ids that exist in registry.people (those own enrollments
 *      and historical attribution; e.g. `ExampleCo` stays canonical even though
 *      the contact file is ExampleCo_ExampleCo.md and no `ExampleCo_ExampleCo` person exists)
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
  const registryPids = new Set(Object.keys(registry?.people || {}));
  for (const [contact, pids] of byContact.entries()) {
    if (pids.length < 2) continue;
    const inRegistry = pids.filter((pid) => registryPids.has(pid));
    const candidates = inRegistry.length ? inRegistry : pids;
    const base = path.basename(contact, '.md');
    const canonical = candidates.includes(base) ? base : [...candidates].sort()[0];
    for (const pid of pids) {
      if (pid !== canonical) map.set(pid, canonical);
    }
  }
  return map;
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
  };
}

module.exports = {
  DUPLICATE_CENTROID_COSINE,
  cosine,
  buildCanonicalPersonMap,
  bestPersonMatch,
};
