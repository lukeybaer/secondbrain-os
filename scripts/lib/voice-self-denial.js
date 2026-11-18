'use strict';

// "IS NOT A; IT IS A" (owner decision).
//
// When the owner answered "this is A", the confirmation writer also recorded a
// denial of the name he replaced. On 194 rows that denial names A itself, so
// the registry said "is not A; it is A" about one voice. The owner never said that.
// Those rows did three kinds of damage: an apply run stripped the name he
// confirmed and stamped it "denied by the owner", the same id's other tracks stayed
// denied, and the voice match refused the right person.
//
// The rows are recognised by one test only: an implicit denial whose own
// correction (same review_action_key) confirms the person it denies, compared
// through aliases so a person merge counts. A real "not them" answer has a
// different key and is never touched. An implied denial that names a different
// person is true and is never touched.
//
// A retired row is moved, never deleted: its name stays as evidence, and its
// manual_corrections row stays so a replay of the old click cannot write it
// again.

const { sameCanonicalPerson } = require('./voice-track-name-check');

const IMPLICIT_DENIAL_SUFFIX = ':implicit-denial';
const RETIRED_FIELD = 'voice_cluster_denials_retired';

const indexCache = new WeakMap();

function correctedPeopleByKey(registry) {
  const rows = registry?.manual_corrections;
  if (!Array.isArray(rows)) return new Map();
  const cached = indexCache.get(rows);
  if (cached?.size === rows.length) return cached.index;
  const index = new Map();
  for (const row of rows) {
    const key = String(row?.review_action_key || '');
    if (!key.endsWith(IMPLICIT_DENIAL_SUFFIX) || !row?.corrected_person_id) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row.corrected_person_id);
  }
  indexCache.set(rows, { size: rows.length, index });
  return index;
}

/** True when this denial row denies the person its own correction confirmed. */
function isSelfDenial(registry, row) {
  const key = String(row?.review_action_key || '');
  if (!key.endsWith(IMPLICIT_DENIAL_SUFFIX)) return false;
  const corrected = correctedPeopleByKey(registry).get(key);
  if (!corrected?.length) return false;
  return corrected.some((personId) =>
    sameCanonicalPerson(personId, row?.denied_person_id, registry?.person_id_aliases));
}

function rowsOf(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

/** Every self-denial row, as { voiceClusterId, row }. */
function listSelfDenials(registry) {
  const out = [];
  for (const [voiceClusterId, value] of Object.entries(registry?.voice_cluster_denials || {})) {
    for (const row of rowsOf(value)) {
      if (isSelfDenial(registry, row)) out.push({ voiceClusterId, row });
    }
  }
  return out;
}

/** The denial table without self-denial rows. Never changes the registry. */
function withoutSelfDenials(registry) {
  const out = {};
  for (const [voiceClusterId, value] of Object.entries(registry?.voice_cluster_denials || {})) {
    const kept = rowsOf(value).filter((row) => !isSelfDenial(registry, row));
    if (kept.length) out[voiceClusterId] = kept;
  }
  return out;
}

/**
 * Moves every self-denial row out of the live table, keeping it as evidence.
 * Running it again moves nothing.
 */
function retireSelfDenials(registry, { at = new Date().toISOString(), reason = 'self_denial' } = {}) {
  const found = listSelfDenials(registry);
  for (const { voiceClusterId, row } of found) {
    registry[RETIRED_FIELD] ||= {};
    (registry[RETIRED_FIELD][voiceClusterId] ||= []).push({
      ...row,
      retired_at: at,
      retired_reason: reason,
    });
    const kept = rowsOf(registry.voice_cluster_denials[voiceClusterId]).filter((item) => item !== row);
    if (kept.length) registry.voice_cluster_denials[voiceClusterId] = kept;
    else delete registry.voice_cluster_denials[voiceClusterId];
  }
  return { retired: found.length, voice_cluster_ids: [...new Set(found.map((item) => item.voiceClusterId))] };
}

/** Roster rows on these ids that deny the person they confirm lose the denial. */
function repairRosterSelfDenials(roster, voiceClusterIds, aliases = null) {
  const ids = new Set(voiceClusterIds);
  let repaired = 0;
  for (const row of roster?.roster || []) {
    if (!ids.has(row?.voice_cluster_id) || !row.denied_person_id) continue;
    if (!sameCanonicalPerson(row.confirmed_person_id, row.denied_person_id, aliases)) continue;
    delete row.denied_person_id;
    delete row.denied_display_name;
    repaired += 1;
  }
  return repaired;
}

module.exports = {
  IMPLICIT_DENIAL_SUFFIX,
  RETIRED_FIELD,
  isSelfDenial,
  listSelfDenials,
  repairRosterSelfDenials,
  retireSelfDenials,
  withoutSelfDenials,
};
