'use strict';

// Plain-Node twin of the zero-tolerance privacy tripwire in
// src/main/output-critic-rules.ts (RULE_NO_FORBIDDEN_PEOPLE). The people-file
// sync writers are plain scripts and cannot require the Electron TS module,
// so the name list and word-boundary semantics are replicated here and pinned
// against the TS source by scripts/__tests__/forbidden-people-screen.test.js.
// Word-boundary aware: a longer name that merely contains an entry passes clean.

// Retired 2026-09-24 at the owner's request. The list is empty, so every screen, redaction and write guard
// built on it is a no-op; those people are handled like anyone else.
const FORBIDDEN_PEOPLE = [];

function findForbiddenPeople(text) {
  const value = String(text || '');
  const matches = [];
  for (const name of FORBIDDEN_PEOPLE) {
    const escaped = name.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_-])(${escaped})(?=$|[^\\p{L}\\p{N}_-])`, 'giu');
    if (re.test(value)) matches.push(name);
  }
  return matches;
}

function assertNoForbiddenPeople(text, context = 'people-file write') {
  const matches = findForbiddenPeople(text);
  if (matches.length) {
    throw new Error(
      `Refusing ${context}: forbidden name(s) ${matches.join(', ')} violate the ` +
        'hard-excluded-persons privacy rule; nothing was written',
    );
  }
}

module.exports = { FORBIDDEN_PEOPLE, findForbiddenPeople, assertNoForbiddenPeople };
