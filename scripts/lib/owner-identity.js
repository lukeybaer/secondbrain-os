'use strict';

// The owner is not a contact.
//
// ExampleCo 2026-08-16: "why do I need a people file of course I don't need one my
// memory.md is my file of what you need to know about me."
//
// Every People-file metric measures whether a CONTACT's file reflects current
// state. The owner has no contacts file by design - his canonical record is
// memory/MEMORY.md plus the user_profile files, and the voice identity registry
// already points person_id `ExampleCo` at memory/user_profile.md rather than at
// memory/contacts/. Counting the owner as a missing People file is therefore a
// measurement bug, not a real gap: it can never be closed without creating a
// file that must not exist.
//
// This module is the single place that answers "is this person the owner", so
// no metric has to hardcode a name inline.

const DEFAULT_OWNER_PERSON_IDS = ['ExampleCo'];

// Where the owner's durable record actually lives. Kept here so a producer can
// name the real target instead of reporting an absent contacts file.
const OWNER_CANONICAL_RECORDS = ['memory/MEMORY.md', 'memory/user_profile.md'];

function normalizeOwnerPersonId(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/^person:/, '')
    .trim();
}

// Env override exists so a different principal (or a test) can be the owner
// without editing code. Empty/absent env keeps the real default.
function ownerPersonIds() {
  const raw = String(process.env.AMY_OWNER_PERSON_IDS || '').trim();
  const ids = raw ? raw.split(/[,\s]+/).filter(Boolean) : DEFAULT_OWNER_PERSON_IDS;
  return new Set(ids.map(normalizeOwnerPersonId).filter(Boolean));
}

function isOwnerPersonId(value) {
  const normalized = normalizeOwnerPersonId(value);
  if (!normalized) return false;
  return ownerPersonIds().has(normalized);
}

module.exports = {
  DEFAULT_OWNER_PERSON_IDS,
  OWNER_CANONICAL_RECORDS,
  normalizeOwnerPersonId,
  ownerPersonIds,
  isOwnerPersonId,
};
