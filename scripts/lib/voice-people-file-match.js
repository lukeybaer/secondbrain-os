'use strict';

// Typed-name -> existing People File matching shared by the briefing
// /briefing/voice-confirm endpoint (ec2-server.js) and the owner-directed
// voice naming CLI (scripts/owner-voice-identity.js).

function normalizeServerPersonSearch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function uniqueExactPeopleFileForProposedName(displayName, people) {
  const proposed = normalizeServerPersonSearch(displayName);
  if (!proposed || !Array.isArray(people)) return null;
  const matches = people.filter((person) => {
    const pathName = String(person?.path || '')
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.md$/i, '');
    return [person?.name, person?.personId, pathName].some(
      (value) => normalizeServerPersonSearch(value) === proposed,
    );
  });
  const unique = new Map(
    matches.map((person) => [String(person.path || person.personId || '').toLowerCase(), person]),
  );
  return unique.size === 1 ? [...unique.values()][0] : null;
}

// A name typed on a voice card that already names exactly one People File
// (exact full name, or a first name only one file carries) links that file
// instead of minting a duplicate. owner decision: typing "PRIVATE_NAME" queued a new
// PRIVATE_NAME.md beside the existing PRIVATE_NAME.md.
function uniquePeopleFileForTypedName(typedName, people) {
  const typed = normalizeServerPersonSearch(typedName);
  if (!typed || !Array.isArray(people)) return null;
  // A parenthetical like "(ExampleCo)" is the owner's disambiguator, so every candidate,
  // exact or first-name, must carry it too. owner decision: "PRIVATE_NAME (ExampleCo)"
  // linked PRIVATE_NAME.md, a prospect, because the qualifier was
  // stripped before matching.
  const qualifiers = [...String(typedName).matchAll(/\(([^)]*)\)/g)]
    .flatMap((m) => normalizeServerPersonSearch(m[1]).split(' '))
    .filter(Boolean);
  const stemOf = (person) => String(person.path).split('/').pop().replace(/\.md$/i, '');
  const contacts = people.filter((person) => {
    if (!/^memory\/contacts\/[^/]+\.md$/.test(String(person?.path || ''))) return false;
    const carried = String([person.name, person.personId, stemOf(person)].join(' '))
      .toLowerCase()
      .split(/[^a-z0-9]+/);
    return qualifiers.every((q) => carried.includes(q));
  });
  const exact = uniqueExactPeopleFileForProposedName(typedName, contacts);
  if (exact) return exact;
  if (typed.includes(' ')) return null;
  const matches = new Map();
  for (const person of contacts) {
    const firstTokens = [person.name, person.personId, stemOf(person)].map(
      (value) => normalizeServerPersonSearch(value).split(' ')[0],
    );
    if (firstTokens.includes(typed)) matches.set(String(person.path).toLowerCase(), person);
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

module.exports = {
  normalizeServerPersonSearch,
  uniqueExactPeopleFileForProposedName,
  uniquePeopleFileForTypedName,
};
