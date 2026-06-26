#!/usr/bin/env node
/**
 * Sync Otter voiceprint evidence back into memory/contacts people files.
 *
 * This creates the durable join ExampleCo asked for:
 * - known people files link to confirmed and likely voiceprints
 * - recurring unidentified voices get provisional people files
 * - generated sections can be refreshed without overwriting hand-written notes
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const CONTACTS_ROOT = path.join(REPO, 'memory', 'contacts');
const VOICEPRINT_ROOT = path.join(REPO, 'data', 'life-archive', 'voiceprints');
const VOICE_IDENTITY_REGISTRY_PATH = path.join(REPO, 'data', 'life-archive', 'voice-identity-registry.json');
const ROSTER_PATH = path.join(VOICEPRINT_ROOT, 'voice-discovery-roster-latest.json');
const SPEAKER_ANALYTICS_PATH = path.join(VOICEPRINT_ROOT, 'otter-speaker-analytics-latest.json');
const STATUS_PATH = path.join(VOICEPRINT_ROOT, 'people-file-voiceprint-sync-latest.json');

const START = '<!-- voiceprint-identity:start -->';
const END = '<!-- voiceprint-identity:end -->';
const GENERATED_BLOCK_RE = new RegExp(`${START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
const CONTACT_INDEX_PATH = path.join(CONTACTS_ROOT, 'INDEX.md');

function parseArgs(argv) {
  const args = {
    write: false,
    allContacts: false,
    maxLikelyPerPerson: 20,
    maxExampleCoFiles: 80,
    ExampleCoMinConversations: 2,
    ExampleCoMinSegments: 80,
    includeContextCandidates: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') args.write = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--all-contacts') args.allContacts = true;
    else if (arg === '--max-likely-per-person') args.maxLikelyPerPerson = Number(argv[++i]);
    else if (arg === '--max-ExampleCo-files') args.maxExampleCoFiles = Number(argv[++i]);
    else if (arg === '--ExampleCo-min-conversations') args.ExampleCoMinConversations = Number(argv[++i]);
    else if (arg === '--ExampleCo-min-segments') args.ExampleCoMinSegments = Number(argv[++i]);
    else if (arg === '--include-context-candidates') args.includeContextCandidates = true;
    else if (arg === '--help' || arg === '-h') usage(0);
    else throw new Error(`ExampleCo argument: ${arg}`);
  }
  return args;
}

function usage(exitCode = 0) {
  const text = [
    'Usage:',
    '  node scripts/sync-voiceprints-to-people-files.js [--write] [--json] [--all-contacts]',
    '       [--max-likely-per-person 20] [--max-ExampleCo-files 80]',
  ].join('\n');
  (exitCode ? console.error : console.log)(text);
  process.exit(exitCode);
}

function loadJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function repoRel(file) {
  if (!file) return null;
  const resolved = path.isAbsolute(file) ? file : path.join(REPO, file);
  return path.relative(REPO, resolved).replace(/\\/g, '/');
}

function repoAbs(maybeRel) {
  if (!maybeRel) return null;
  return path.isAbsolute(maybeRel) ? maybeRel : path.join(REPO, maybeRel);
}

function personKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function shortPersonKey(value) {
  return personKey(value).split(' ')[0] || '';
}

function parseFrontmatter(text) {
  const match = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const parts = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (parts) out[parts[1]] = parts[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function titleFromFile(file) {
  return path.basename(file, '.md')
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function isOrdinaryContactFileName(fileName) {
  if (!fileName.endsWith('.md') || fileName.startsWith('_')) return false;
  if (fileName === 'INDEX.md') return false;
  if (/^ExampleCo_voice_/i.test(fileName)) return false;
  return true;
}

function loadContacts() {
  const rows = [];
  if (!fs.existsSync(CONTACTS_ROOT)) return rows;
  for (const fileName of fs.readdirSync(CONTACTS_ROOT).filter(isOrdinaryContactFileName)) {
    const file = path.join(CONTACTS_ROOT, fileName);
    const text = fs.readFileSync(file, 'utf8');
    const frontmatter = parseFrontmatter(text);
    const displayName = String(frontmatter.name || titleFromFile(fileName)).replace(/\([^)]*\)/g, '').trim();
    const keys = new Set([
      personKey(displayName),
      shortPersonKey(displayName),
      personKey(path.basename(fileName, '.md').replace(/_/g, ' ')),
    ].filter(Boolean));
    rows.push({
      file,
      rel: repoRel(file),
      text,
      display_name: displayName,
      description: frontmatter.description || '',
      category: frontmatter.category || '',
      keys,
    });
  }
  return rows;
}

// 2026-05-24 PII gate fix: the explicit firstname -> contact-file map used to
// live inline as a literal object, which leaked the names into the
// public-sync payload (pii-screen test caught 4 hits). Names belong in
// memory/, not in source code. The map now loads from
// data/agent/voiceprint-contact-aliases.json (gitignored: line matches
// data/agent/*-output.json pattern? no -- explicitly added to .gitignore).
// Missing file is fine; falls back to the keyset / firstname match below.
function loadVoiceprintAliases() {
  try {
    const repo = require('path').resolve(__dirname, '..');
    const p = require('path').join(repo, 'data', 'agent', 'voiceprint-contact-aliases.json');
    if (require('fs').existsSync(p)) return JSON.parse(require('fs').readFileSync(p, 'utf8')) || {};
  } catch { /* missing or unreadable -- skip aliasing */ }
  return {};
}

// C5: a person group only counts as confirmed when it ExampleCos actual
// confirmed-reference-voiceprint evidence. confidence_tiers is a count map like
// { confirmed_reference_voiceprint_match: N, inferred_unconfirmed_low_margin: M }.
function groupHasConfirmedVoiceprintEvidence(group) {
  const tiers = group && group.confidence_tiers;
  if (!tiers || typeof tiers !== 'object') return false;
  return Number(tiers.confirmed_reference_voiceprint_match || 0) > 0;
}

function findContactForPerson(contacts, personId, displayName, opts = {}) {
  const id = personKey(personId);
  const name = personKey(displayName);
  const aliases = loadVoiceprintAliases();
  const explicit = aliases[id];
  if (explicit) {
    const hit = contacts.find((contact) => contact.rel === explicit);
    if (hit) return hit;
  }
  // F6: when requireIdMatch is set (the confirmed-promotion path), match only on
  // the person_id key, never the display-name slug, so two people who share a
  // first name cannot have a confirmed voiceprint written to the wrong file.
  if (opts.requireIdMatch) {
    return contacts.find((contact) => contact.keys.has(id)) || null;
  }
  return contacts.find((contact) => contact.keys.has(id) || contact.keys.has(name)) || null;
}

function replaceGeneratedBlock(text, block) {
  const cleanBlock = block.trimEnd();
  if (GENERATED_BLOCK_RE.test(text)) return text.replace(GENERATED_BLOCK_RE, cleanBlock);
  return `${text.replace(/\s+$/, '')}\n\n${cleanBlock}\n`;
}

function removeGeneratedBlock(text) {
  if (!GENERATED_BLOCK_RE.test(text)) return text;
  return text
    .replace(new RegExp(`\\n{0,2}${START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'm'), '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
    .concat('\n');
}

function sortByImportance(a, b) {
  return (b.conversation_count || 0) - (a.conversation_count || 0)
    || (b.segment_count || 0) - (a.segment_count || 0)
    || (b.top_name_guess?.score || 0) - (a.top_name_guess?.score || 0)
    || String(a.voice_cluster_id).localeCompare(String(b.voice_cluster_id));
}

function bulletLine(text) {
  return `- ${text}`;
}

function isQuarantinedEnrollment(enrollment) {
  return String(enrollment?.calibration_quarantine_status || '') === 'quarantined';
}

function renderPersonBlock({ contact, confirmed = [], likely = [], quarantined = [], generatedAt, args }) {
  const lines = [
    START,
    '## Voiceprint Identity',
    '',
    '<!-- Generated by `node scripts/sync-voiceprints-to-people-files.js --write --all-contacts`; edit source voiceprint/correction records, not this block. -->',
    '',
  ];
  if (!confirmed.length && !likely.length && !quarantined.length) {
    lines.push(bulletLine('No active confirmed or likely Otter voiceprint is linked yet.'));
    lines.push(bulletLine(`Last checked: ${generatedAt}.`));
    lines.push(END);
    return lines.join('\n');
  }

  if (confirmed.length) {
    lines.push('### Confirmed Voiceprint');
    for (const item of confirmed) {
      lines.push(bulletLine(`Person id: \`${item.person_id}\`; status: \`${item.identity_confirmation_status || 'confirmed_by_ExampleCo'}\`; model: \`${item.model || item.voiceprint_model || 'local_acoustic_fingerprint.v1'}\`.`));
      if (item.voice_cluster_id) lines.push(bulletLine(`Stable voice cluster: \`${item.voice_cluster_id}\`.`));
      if (item.enrollment_id) lines.push(bulletLine(`Enrollment: \`${item.enrollment_id}\`; reference clip: \`${repoRel(item.reference_audio_path)}\`.`));
      if (item.identity_confirmed_at) lines.push(bulletLine(`Confirmed at: ${item.identity_confirmed_at}.`));
    }
    lines.push('');
  }

  if (quarantined.length) {
    lines.push('### Excluded / Quarantined Voiceprints');
    lines.push(bulletLine('These references are preserved for audit only and are not allowed to confirm this person or update transcript speakers.'));
    for (const item of quarantined) {
      const heard = item.calibration_actual_name ? `; heard name: \`${item.calibration_actual_name}\`` : '';
      lines.push(bulletLine(`Enrollment: \`${item.enrollment_id || 'ExampleCo'}\`; prior person id: \`${item.person_id || 'ExampleCo'}\`${heard}; reason: ${item.calibration_quarantine_reason || 'failed known-speaker calibration'}.`));
      if (item.voice_cluster_id) lines.push(bulletLine(`Excluded voice cluster: \`${item.voice_cluster_id}\`.`));
    }
    lines.push('');
  }

  if (likely.length) {
    lines.push('### Likely / Unconfirmed Voice Clusters');
    lines.push(bulletLine('These are durable voice IDs inferred from Otter audio and context. Treat as provisional until ExampleCo confirms or corrects them.'));
    for (const item of likely.slice(0, args.maxLikelyPerPerson)) {
      const guess = item.top_name_guess || {};
      const clip = item.representative_probe_audio_path || 'missing';
      const evidence = (guess.evidence || [])[0];
      const evidenceText = evidence ? ` Evidence: ${evidence.type || 'context'} in "${evidence.title || evidence.otid || 'ExampleCo'}"${evidence.snippet ? `: ${evidence.snippet}` : ''}` : '';
      lines.push(bulletLine(`\`${item.voice_cluster_id}\`: ${item.conversation_count || 0} conversation(s), ${item.segment_count || 0} segment(s), guess \`${guess.display_name || 'ExampleCo'}\` (${guess.confidence || 'unscored'}, score ${guess.score ?? 'n/a'}), clip \`${clip}\`.${evidenceText}`));
    }
    if (likely.length > args.maxLikelyPerPerson) lines.push(bulletLine(`Additional linked clusters omitted from this file block: ${likely.length - args.maxLikelyPerPerson}. See \`data/life-archive/voiceprints/voice-discovery-roster-latest.json\`.`));
    lines.push('');
  }

  lines.push(bulletLine(`Last synced: ${generatedAt}.`));
  lines.push(END);
  return lines.join('\n');
}

function safeExampleCoFileName(clusterId) {
  return `ExampleCo_voice_${String(clusterId || '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()}.md`;
}

function renderExampleCoFile(row, generatedAt) {
  const guess = row.top_name_guess || null;
  const title = `ExampleCo voice ${row.voice_cluster_id}`;
  const description = guess
    ? `Durable Otter voice cluster; likely ${guess.display_name}, not yet confirmed by ExampleCo`
    : 'Durable Otter voice cluster; identity not yet confirmed by ExampleCo';
  const lines = [
    '---',
    `name: ${title}`,
    `description: ${description}`,
    'type: user',
    'category: voice-ExampleCo',
    `last_interaction: "${row.last_seen || generatedAt.slice(0, 10)}"`,
    'warmth: ExampleCo',
    '---',
    '',
    '## Voice Identity',
    '',
    `- **Stable voice cluster**: \`${row.voice_cluster_id}\``,
    `- **Status**: ${row.status || 'ExampleCo_person'}`,
    `- **Likely name**: ${guess ? `${guess.display_name} (${guess.confidence}, score ${guess.score})` : 'ExampleCo'}`,
    `- **Observed**: ${row.conversation_count || 0} conversation(s), ${row.segment_count || 0} segment(s), ${row.first_seen || '?'} to ${row.last_seen || '?'}`,
    `- **Review clip**: \`${row.representative_probe_audio_path || 'missing'}\``,
    `- **Roster**: \`data/life-archive/voiceprints/voice-discovery-roster-latest.json\``,
    '',
    '## Current Evidence',
    '',
  ];
  if (guess && Array.isArray(guess.evidence)) {
    for (const evidence of guess.evidence.slice(0, 4)) {
      lines.push(`- ${evidence.type || 'context'} in "${evidence.title || evidence.otid || 'ExampleCo'}": ${evidence.snippet || ''}`);
    }
  } else {
    const conversation = (row.conversations || [])[0];
    if (conversation) lines.push(`- Frequent/substantial ExampleCo speaker in "${conversation.title || conversation.otid}" (${conversation.date || 'ExampleCo date'}).`);
  }
  lines.push('');
  lines.push('## Merge Rule');
  lines.push('');
  lines.push('- When ExampleCo identifies this voice, use `node scripts/otter-voiceprint-correct.js --voice-cluster-id <id> --person <person_id> --apply-to-all-inferred --write` and merge this provisional file into the confirmed person file.');
  lines.push('');
  lines.push(renderPersonBlock({ contact: null, confirmed: [], likely: [row], generatedAt, args: { maxLikelyPerPerson: 20 } }));
  return `${lines.join('\n')}\n`;
}

function buildSync(args) {
  const generatedAt = new Date().toISOString();
  const contacts = loadContacts();
  const registry = loadJson(VOICE_IDENTITY_REGISTRY_PATH, { people: {}, enrollments: [] });
  const roster = loadJson(ROSTER_PATH, null);
  const analytics = loadJson(SPEAKER_ANALYTICS_PATH, { person_groups: [] });
  if (!roster) throw new Error(`missing ${repoRel(ROSTER_PATH)}; run node scripts/otter-voice-discovery-roster.js --write first`);
  const reviewedVoiceClusters = new Set([
    ...Object.keys(registry.voice_cluster_resolutions || {}),
    ...Object.keys(registry.voice_cluster_denials || {}),
  ]);

  const byContact = new Map();
  const touched = new Set();
  function entryFor(contact) {
    const rel = contact.rel;
    if (!byContact.has(rel)) byContact.set(rel, { contact, confirmed: [], likely: [], quarantined: [] });
    return byContact.get(rel);
  }

  const enrollments = registry.enrollments || [];
  for (const enrollment of enrollments) {
    const contact = findContactForPerson(contacts, enrollment.person_id, enrollment.display_name);
    if (!contact) continue;
    const entry = entryFor(contact);
    if (isQuarantinedEnrollment(enrollment)) entry.quarantined.push(enrollment);
    else entry.confirmed.push(enrollment);
  }

  for (const group of analytics.person_groups || []) {
    if (!group.person_id || !String(group.person_group_id || '').startsWith('person:')) continue;
    // C5: do NOT trust the person: prefix alone. Promote to a confirmed block
    // only when the group actually ExampleCos confirmed-reference-voiceprint
    // evidence (a nonzero confirmed_reference_voiceprint_match count in its
    // confidence_tiers). Otherwise an analytics row with no acoustic proof
    // could write a "confirmed" voiceprint into a contact file unattended.
    if (!groupHasConfirmedVoiceprintEvidence(group)) continue;
    // F6: bind by person_id (or an explicit alias), never by display-name slug
    // alone, so two people who share a first name cannot cross-contaminate.
    const contact = findContactForPerson(contacts, group.person_id, group.display_name, { requireIdMatch: true });
    if (!contact) continue;
    const already = entryFor(contact);
    if (already.confirmed.some((item) => item.person_id === group.person_id && item.analytics_person_group_id)) continue;
    already.confirmed.push({
      person_id: group.person_id,
      display_name: group.display_name,
      identity_confirmation_status: 'confirmed_reference_voiceprint_match',
      model: 'local_acoustic_fingerprint.v1',
      analytics_person_group_id: group.person_group_id,
      conversation_count: group.conversation_count,
      segment_count: group.segment_count,
    });
  }

  for (const row of roster.roster || []) {
    if (reviewedVoiceClusters.has(row.voice_cluster_id) || row.review_status === 'confirmed_by_ExampleCo' || row.review_status === 'denied_by_ExampleCo') continue;
    if (!args.includeContextCandidates && !row.confirmed_person_id && row.identity_tier !== 'confirmed_reference_voiceprint_match') continue;
    const guess = row.top_name_guess;
    if (!guess || !guess.contact_file) continue;
    const contact = contacts.find((item) => item.rel === guess.contact_file);
    if (!contact) continue;
    entryFor(contact).likely.push(row);
  }

  if (args.allContacts) {
    for (const contact of contacts) entryFor(contact);
  }

  const plannedContactUpdates = [];
  for (const record of byContact.values()) {
    record.confirmed.sort((a, b) => String(a.person_id).localeCompare(String(b.person_id)));
    record.likely.sort(sortByImportance);
    if (!args.allContacts && !record.confirmed.length && !record.likely.length) continue;
    const block = renderPersonBlock({
      contact: record.contact,
      confirmed: record.confirmed,
      likely: record.likely,
      quarantined: record.quarantined,
      generatedAt,
      args,
    });
    const nextText = replaceGeneratedBlock(record.contact.text, block);
    if (nextText !== record.contact.text) {
      plannedContactUpdates.push({
        file: record.contact.file,
        rel: record.contact.rel,
        confirmed_voiceprints: record.confirmed.length,
        likely_voice_clusters: record.likely.length,
        quarantined_voiceprints: record.quarantined.length,
        nextText,
      });
      touched.add(record.contact.rel);
    }
  }

  const existingExampleCoFiles = new Set(fs.readdirSync(CONTACTS_ROOT)
    .filter((name) => /^ExampleCo_voice_speaker_\d+\.md$/.test(name))
    .map((name) => path.join(CONTACTS_ROOT, name)));
  const recurringExampleCo = (roster.roster || [])
    .filter((row) => !row.confirmed_person_id)
    .filter((row) => !reviewedVoiceClusters.has(row.voice_cluster_id) && row.review_status !== 'confirmed_by_ExampleCo' && row.review_status !== 'denied_by_ExampleCo')
    .filter((row) => (row.conversation_count || 0) >= args.ExampleCoMinConversations || (row.segment_count || 0) >= args.ExampleCoMinSegments)
    .sort(sortByImportance)
    .slice(0, args.maxExampleCoFiles);
  const plannedExampleCoFiles = [];
  for (const row of recurringExampleCo) {
    const file = path.join(CONTACTS_ROOT, safeExampleCoFileName(row.voice_cluster_id));
    const nextText = renderExampleCoFile(row, generatedAt);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== nextText) {
      plannedExampleCoFiles.push({
        file,
        rel: repoRel(file),
        voice_cluster_id: row.voice_cluster_id,
        conversation_count: row.conversation_count,
        segment_count: row.segment_count,
        top_name_guess: row.top_name_guess || null,
        nextText,
      });
    }
    existingExampleCoFiles.delete(file);
  }

  const cleanupFiles = [CONTACT_INDEX_PATH].filter((file) => fs.existsSync(file));
  const plannedCleanupFiles = cleanupFiles
    .map((file) => {
      const text = fs.readFileSync(file, 'utf8');
      const nextText = removeGeneratedBlock(text);
      return nextText !== text ? { file, rel: repoRel(file), nextText } : null;
    })
    .filter(Boolean);

  if (args.write) {
    for (const update of plannedContactUpdates) fs.writeFileSync(update.file, update.nextText, 'utf8');
    for (const update of plannedExampleCoFiles) fs.writeFileSync(update.file, update.nextText, 'utf8');
    for (const update of plannedCleanupFiles) fs.writeFileSync(update.file, update.nextText, 'utf8');
  }

  const report = {
    schema: 'life_archive_people_voiceprint_sync.v1',
    generated_at: generatedAt,
    wrote_files: Boolean(args.write),
    source_roster_path: repoRel(ROSTER_PATH),
    source_registry_path: repoRel(VOICE_IDENTITY_REGISTRY_PATH),
    contacts_seen: contacts.length,
    contacts_with_generated_section: args.write
      ? Array.from(byContact.keys()).length
      : plannedContactUpdates.length,
    contact_files_updated: plannedContactUpdates.length,
    ExampleCo_voice_files_planned_or_updated: plannedExampleCoFiles.length,
    recurring_ExampleCo_voice_files_targeted: recurringExampleCo.length,
    stale_ExampleCo_files_not_touched: Array.from(existingExampleCoFiles).map(repoRel),
    cleanup_files_updated: plannedCleanupFiles.map((item) => item.rel),
    updated_contacts: plannedContactUpdates.map((item) => ({
      file: item.rel,
      confirmed_voiceprints: item.confirmed_voiceprints,
      likely_voice_clusters: item.likely_voice_clusters,
      quarantined_voiceprints: item.quarantined_voiceprints,
    })),
    ExampleCo_voice_files: plannedExampleCoFiles.map((item) => ({
      file: item.rel,
      voice_cluster_id: item.voice_cluster_id,
      conversation_count: item.conversation_count,
      segment_count: item.segment_count,
      top_name_guess: item.top_name_guess,
    })),
  };
  if (args.write) saveJson(STATUS_PATH, report);
  return report;
}

function formatReport(report) {
  return [
    `People voiceprint sync: ${report.contact_files_updated} contact file(s) updated; ${report.ExampleCo_voice_files_planned_or_updated} ExampleCo voice file(s) planned/updated.`,
    `Contacts seen: ${report.contacts_seen}; recurring ExampleCo voice files targeted: ${report.recurring_ExampleCo_voice_files_targeted}.`,
    `Status: ${report.wrote_files ? repoRel(STATUS_PATH) : 'dry run only'}.`,
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = buildSync(args);
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
}

module.exports = {
  buildSync,
  replaceGeneratedBlock,
  renderPersonBlock,
  groupHasConfirmedVoiceprintEvidence,
  findContactForPerson,
};
