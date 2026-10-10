'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SAFE_PERSON_ID_ALIASES = Object.freeze({});

const PEOPLE_FILE_OVERRIDES = Object.freeze({});

const ORGANIZATION_TOKENS = new Set([]);

function canonicalPersonId(value) {
  const raw = String(value || '').trim().replace(/^person:/, '');
  return SAFE_PERSON_ID_ALIASES[raw] || raw;
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function parseFrontmatterName(text) {
  const match = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    const heading = String(text || '').match(/^#\s+(.+)$/m);
    return heading ? heading[1].trim() : '';
  }
  const line = match[1].split(/\r?\n/).find((row) => /^name:\s*/i.test(row));
  return line
    ? line
        .replace(/^name:\s*/i, '')
        .replace(/^['"]|['"]$/g, '')
        .trim()
    : '';
}

function ordinaryContactName(name) {
  return (
    name.endsWith('.md') &&
    name !== 'INDEX.md' &&
    !name.startsWith('_') &&
    !/^unknown_voice_/i.test(name)
  );
}

function loadPeopleFileCatalog(repoRoot) {
  const rows = [];
  const contactsDir = path.join(repoRoot, 'memory', 'contacts');
  if (fs.existsSync(contactsDir)) {
    for (const name of fs.readdirSync(contactsDir).filter(ordinaryContactName)) {
      const file = path.join(contactsDir, name);
      const text = fs.readFileSync(file, 'utf8');
      const displayName = parseFrontmatterName(text) || path.basename(name, '.md').replace(/_/g, ' ');
      rows.push({
        file,
        rel: path.relative(repoRoot, file).replace(/\\/g, '/'),
        text,
        display_name: displayName,
        display_key: normalizeName(displayName),
        file_key: normalizeName(path.basename(name, '.md').replace(/_/g, ' ')),
      });
    }
  }
  const userProfile = path.join(repoRoot, 'memory', 'user_profile.md');
  if (fs.existsSync(userProfile)) {
    const text = fs.readFileSync(userProfile, 'utf8');
    const displayName = parseFrontmatterName(text) || 'Owner';
    rows.push({
      file: userProfile,
      rel: 'memory/user_profile.md',
      text,
      display_name: displayName,
      display_key: normalizeName(displayName),
      file_key: 'ExampleCo',
    });
  }
  return rows;
}

function significantTokens(value) {
  return normalizeName(value)
    .split(' ')
    .filter(Boolean)
    .filter((token) => !ORGANIZATION_TOKENS.has(token));
}

function hasConflictingSurname(displayName, contact) {
  const wanted = significantTokens(displayName);
  const actual = significantTokens(contact?.display_name || contact?.file_key || '');
  if (!wanted.length || !actual.length) return false;
  if (wanted[0] !== actual[0]) return true;
  // A first-name-only confirmed identity is not authority to attach the voice
  // to an existing full-name People File.
  if (wanted.length === 1 || actual.length === 1) {
    return wanted.length !== actual.length || wanted[0] !== actual[0];
  }
  return wanted[wanted.length - 1] !== actual[actual.length - 1];
}

function exactCandidates(catalog, value) {
  const key = normalizeName(String(value || '').replace(/_/g, ' '));
  return (catalog || []).filter(
    (row) => row.display_key === key || row.file_key === key,
  );
}

function exactPersonIdCandidates(catalog, personId) {
  const key = normalizeName(String(personId || '').replace(/_/g, ' '));
  const fileMatches = (catalog || []).filter((row) => row.file_key === key);
  if (fileMatches.length) return fileMatches;
  return (catalog || []).filter((row) => row.display_key === key);
}

function resolvePeopleFileTarget({
  repoRoot,
  personId,
  displayName,
  registryPerson = {},
  catalog = loadPeopleFileCatalog(repoRoot),
} = {}) {
  const canonicalId = canonicalPersonId(personId);
  const currentRel = String(registryPerson.contact_file || '').replace(/\\/g, '/');
  const current = catalog.find((row) => row.rel === currentRel) || null;
  const idExact = exactPersonIdCandidates(catalog, canonicalId);

  if (idExact.length === 1) {
    return {
      person_id: canonicalId,
      rel: idExact[0].rel,
      file: idExact[0].file,
      exists: true,
      source: 'exact_person_id',
      current_rel: currentRel,
      changed: idExact[0].rel !== currentRel,
      ambiguous: false,
      conflicting_current_name: Boolean(current && hasConflictingSurname(displayName, current)),
    };
  }
  if (idExact.length > 1) {
    return {
      person_id: canonicalId,
      rel: '',
      file: '',
      exists: false,
      source: 'ambiguous_exact_person_id',
      current_rel: currentRel,
      changed: false,
      ambiguous: true,
      candidates: idExact.map((row) => row.rel),
      conflicting_current_name: false,
    };
  }

  const overrideRel = PEOPLE_FILE_OVERRIDES[canonicalId] || '';
  if (overrideRel) {
    const override = catalog.find((row) => row.rel === overrideRel);
    return {
      person_id: canonicalId,
      rel: overrideRel,
      file: override?.file || path.join(repoRoot, overrideRel),
      exists: Boolean(override),
      source: 'explicit_override',
      current_rel: currentRel,
      changed: overrideRel !== currentRel,
      ambiguous: false,
      conflicting_current_name: false,
    };
  }

  const nameExact = exactCandidates(catalog, displayName);
  if (nameExact.length === 1) {
    return {
      person_id: canonicalId,
      rel: nameExact[0].rel,
      file: nameExact[0].file,
      exists: true,
      source: 'exact_display_name',
      current_rel: currentRel,
      changed: nameExact[0].rel !== currentRel,
      ambiguous: false,
      conflicting_current_name: Boolean(current && hasConflictingSurname(displayName, current)),
    };
  }
  if (nameExact.length > 1) {
    return {
      person_id: canonicalId,
      rel: '',
      file: '',
      exists: false,
      source: 'ambiguous_exact_display_name',
      current_rel: currentRel,
      changed: false,
      ambiguous: true,
      candidates: nameExact.map((row) => row.rel),
      conflicting_current_name: false,
    };
  }

  if (current && !hasConflictingSurname(displayName, current)) {
    return {
      person_id: canonicalId,
      rel: current.rel,
      file: current.file,
      exists: true,
      source: 'compatible_registry_target',
      current_rel: currentRel,
      changed: false,
      ambiguous: false,
      conflicting_current_name: false,
    };
  }

  const rel = `memory/contacts/${canonicalId.replace(/[^a-zA-Z0-9_-]+/g, '_')}.md`;
  return {
    person_id: canonicalId,
    rel,
    file: path.join(repoRoot, rel),
    exists: fs.existsSync(path.join(repoRoot, rel)),
    source: current ? 'conflicting_registry_target_rejected' : 'confirmed_identity_default',
    current_rel: currentRel,
    changed: rel !== currentRel,
    ambiguous: false,
    conflicting_current_name: Boolean(current),
  };
}

module.exports = {
  SAFE_PERSON_ID_ALIASES,
  PEOPLE_FILE_OVERRIDES,
  canonicalPersonId,
  normalizeName,
  parseFrontmatterName,
  loadPeopleFileCatalog,
  hasConflictingSurname,
  exactCandidates,
  exactPersonIdCandidates,
  resolvePeopleFileTarget,
};
