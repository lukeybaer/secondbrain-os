#!/usr/bin/env node
'use strict';

// Move legacy generated speaker/voice blocks out of human People markdown.
// It deliberately copies block text verbatim: this is a storage migration, not
// an Otter/voice identity algorithm or a source-raw rewrite.

const fs = require('node:fs');
const path = require('node:path');
const {
  LEGACY_BLOCKS,
  replacePeopleVoiceIdentityLink,
  safePersonId,
  upsertVoiceIdentitySection,
  identityFile,
} = require('./lib/people-voice-identity.js');
const { assertNoForbiddenPeople } = require('./lib/forbidden-people.js');
const { assertPeopleFileWriteAllowed } = require('./lib/people-file-write-guard.js');

const REPO = path.resolve(__dirname, '..');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function legacyBlocks(text) {
  return LEGACY_BLOCKS.flatMap(([start, end], index) => {
    const match = String(text || '').match(new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, 'm'));
    return match ? [{
      section: index === 0 ? 'legacy-otter-speaker-intelligence' : 'legacy-voiceprint-identity',
      content: match[0],
    }] : [];
  });
}

function peopleFiles(peopleRoot, personId = '') {
  const wanted = safePersonId(personId);
  if (!fs.existsSync(peopleRoot)) return [];
  return fs.readdirSync(peopleRoot, { withFileTypes: true })
    .filter((entry) => {
      const basename = path.basename(entry.name, '.md');
      return entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_') && basename !== basename.toUpperCase();
    })
    .map((entry) => path.join(peopleRoot, entry.name))
    .filter((file) => !personId || safePersonId(path.basename(file, '.md')) === wanted)
    .sort();
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, 'utf8');
  fs.renameSync(temporary, file);
}

function planPersonMigration(file, dataRoot) {
  const peopleText = fs.readFileSync(file, 'utf8');
  const blocks = legacyBlocks(peopleText);
  const personId = path.basename(file, '.md');
  const externalFile = identityFile(dataRoot, personId);
  const existingExternal = fs.existsSync(externalFile) ? fs.readFileSync(externalFile, 'utf8') : '';
  let externalText = existingExternal;
  for (const block of blocks) {
    externalText = upsertVoiceIdentitySection(externalText, { personId, ...block });
  }
  const peopleNext = blocks.length ? replacePeopleVoiceIdentityLink(peopleText, personId) : peopleText;
  if (blocks.length) {
    // Privacy is checked before either derived artifact can be written. Raw
    // files are not inputs or outputs of this migration.
    assertNoForbiddenPeople(peopleNext, `People voice migration ${file}`);
    assertNoForbiddenPeople(externalText, `voice identity migration ${externalFile}`);
  }
  return {
    file,
    person_id: safePersonId(personId),
    external_file: externalFile,
    legacy_blocks: blocks.map((block) => block.section),
    needs_migration: blocks.length > 0,
    people_next: peopleNext,
    external_next: externalText,
    external_changed: externalText !== existingExternal,
  };
}

function planMigration({ peopleRoot = path.join(REPO, 'memory', 'contacts'), dataRoot = path.join(REPO, 'data'), personId = '' } = {}) {
  return peopleFiles(peopleRoot, personId).map((file) => planPersonMigration(file, dataRoot));
}

function applyMigration(plan, { repo = REPO } = {}) {
  const changing = plan.filter((entry) => entry.needs_migration);
  if (!changing.length) return { migrated: 0 };
  assertPeopleFileWriteAllowed({ repo });
  for (const entry of changing) {
    // Write external data first: an interrupted run remains backward-readable
    // because the People legacy block is still present until its own write.
    if (entry.external_changed) atomicWrite(entry.external_file, entry.external_next);
    atomicWrite(entry.file, entry.people_next);
  }
  return { migrated: changing.length };
}

function parseArgs(argv) {
  const value = (name, fallback = '') => {
    const index = argv.indexOf(name);
    return index < 0 ? fallback : argv[index + 1];
  };
  const repo = path.resolve(value('--repo', REPO));
  return {
    repo,
    peopleRoot: path.resolve(value('--people-root', path.join(repo, 'memory', 'contacts'))),
    dataRoot: path.resolve(value('--data-root', path.join(repo, 'data'))),
    personId: value('--person-id', ''),
    write: argv.includes('--write'),
    check: argv.includes('--check'),
    json: argv.includes('--json'),
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const plan = planMigration(args);
  const pending = plan.filter((entry) => entry.needs_migration);
  let applied = { migrated: 0 };
  if (args.write) applied = applyMigration(plan, { repo: args.repo });
  const result = {
    schema: 'amy.people-voice-identity-migration.v1',
    mode: args.write ? 'write' : (args.check ? 'check' : 'dry-run'),
    people_root: args.peopleRoot,
    data_root: args.dataRoot,
    scanned: plan.length,
    pending: pending.length,
    migrated: applied.migrated,
    entries: plan.map(({ people_next, external_next, ...entry }) => entry),
  };
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[people-voice-migration] ${result.mode}: ${result.migrated} migrated, ${result.pending} pending of ${result.scanned} People files`);
  return args.check && pending.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  applyMigration,
  legacyBlocks,
  main,
  planMigration,
  planPersonMigration,
};
