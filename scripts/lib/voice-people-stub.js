'use strict';

/**
 * Shared people-file stub convention for the Daily Briefing voice review flow.
 *
 * When ExampleCo assigns a brand-new NAME to a speaker that has no people file, that
 * name must (1) get a stub people file in memory/contacts/ matching the existing
 * contact-file convention and (2) become selectable in the assign dropdown next
 * review. The dropdown is built by ec2-server.js loadPeopleFileIndex(), which
 * reads memory/contacts/ and keeps every file that passes its contact filter.
 *
 * Both the synchronous save endpoint (ec2-server.js /briefing/voice-confirm) and
 * the async backprop (scripts/apply-voice-confirmation-actions.js) create stubs.
 * Centralizing the slug + frontmatter here keeps them byte-for-byte identical so
 * a stub written by either path is the same file and passes the picker filter.
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadOperatorIdentity } = require('./operator-identity');

// The voice-name -> canonical-people-slug overrides are operator-specific PII
// (real contact names), so they live in memory/reference_operator_identity.json
// and load at runtime, never hardcoded here. A name that maps to a canonical
// existing slug never spawns a duplicate stub. The public shell has no config
// and resolves to an empty map (no contacts to dedup against anyway).
const NAME_PERSON_OVERRIDES = loadOperatorIdentity().voiceNameOverrides;

function normalizeWords(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

// Slug a heard/typed name into the people-file id used as the filename stem.
function personIdFromName(value) {
  const words = normalizeWords(value);
  return NAME_PERSON_OVERRIDES[words] || words.replace(/ /g, '_') || 'ExampleCo_person';
}

function titleCaseName(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) =>
      part.length <= 2 && part === part.toUpperCase()
        ? part
        : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`,
    )
    .join(' ');
}

// The stub body. Heading is the person's name and the only section is "Voice
// Identity Context" so isLikelyContactPersonFile keeps it in the picker index
// (no analysis/audit/report/summary tokens in the slug or first heading).
function buildStubBody({ name, personId, voiceClusterId = '', notes = '', now } = {}) {
  const safeName = titleCaseName(name || personId.replace(/_/g, ' '));
  const created = now || new Date().toISOString();
  const note = String(notes || '').trim();
  return [
    '---',
    `name: "${safeName.replace(/"/g, '\\"')}"`,
    'source: daily_briefing_voice_identity',
    `created_at: ${created}`,
    '---',
    '',
    `# ${safeName}`,
    '',
    '## Voice Identity Context',
    '',
    `- Created from ExampleCo's Daily Briefing voice identity flow for \`${voiceClusterId}\`.`,
    note ? `- ExampleCo note: ${note}` : '- ExampleCo has not added extra context yet.',
    '',
  ].join('\n');
}

/**
 * Create a people-file stub under contactsRoot if one does not already exist.
 * Returns { rel, created } where rel is the repo-relative memory/contacts path.
 * Idempotent: an existing file is left untouched and reported created:false.
 */
function ensurePeopleFileStub({
  contactsRoot,
  name,
  personId,
  voiceClusterId = '',
  notes = '',
  now,
} = {}) {
  const slug = personId || personIdFromName(name);
  const rel = `memory/contacts/${slug}.md`;
  const file = path.join(contactsRoot, `${slug}.md`);
  if (fs.existsSync(file)) return { rel, created: false };
  const body = buildStubBody({ name, personId: slug, voiceClusterId, notes, now });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return { rel, created: true };
}

module.exports = {
  NAME_PERSON_OVERRIDES,
  normalizeWords,
  personIdFromName,
  titleCaseName,
  buildStubBody,
  ensurePeopleFileStub,
};
