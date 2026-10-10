#!/usr/bin/env node
/**
 * Sync Otter voiceprint evidence back into memory/contacts people files.
 *
 * This creates the durable join ExampleCo asked for:
 * - known people files link to confirmed and likely voiceprints
 * - recurring unidentified voices stay in voice artifacts and ExampleCo's review queue
 * - generated sections can be refreshed without overwriting hand-written notes
 */

const fs = require('node:fs');
const path = require('node:path');
const { assertPeopleFileWriteAllowed } = require('./lib/people-file-write-guard.js');
const { assertNoForbiddenPeople } = require('./lib/forbidden-people.js');
const { repoRelativeTail } = require('./lib/repo-audio-path.js');
const {
  canonicalPersonId,
  normalizeName,
  resolvePeopleFileTarget,
} = require('./lib/voice-people-file-target.js');
const {
  appendProjectionEvent,
} = require('./lib/voice-people-projection-events.js');
const {
  identityFile,
  replacePeopleVoiceIdentityLink,
  upsertVoiceIdentitySection,
} = require('./lib/people-voice-identity.js');

const CODE_ROOT = path.resolve(__dirname, '..');
// A root that cannot exist on this platform (a desktop path in the cloud
// environment, 2026-09-27) falls back to this checkout instead of a phantom folder.
const PEOPLE_ROOT = path.resolve(
  require('./lib/runtime-root-env.js').usableRuntimeRoot(process.env.SECONDBRAIN_ROOT) || CODE_ROOT,
);
const DATA_ROOT = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(CODE_ROOT, 'data'));
const CONTACTS_ROOT = path.join(PEOPLE_ROOT, 'memory', 'contacts');
const VOICEPRINT_ROOT = path.join(DATA_ROOT, 'life-archive', 'voiceprints');
const VOICE_IDENTITY_REGISTRY_PATH = path.join(DATA_ROOT, 'life-archive', 'voice-identity-registry.json');
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
    writeUnknownFiles: false,
    maxLikelyPerPerson: 20,
    maxUnknownFiles: 80,
    unknownMinConversations: 2,
    unknownMinSegments: 80,
    includeContextCandidates: false,
    personIds: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') args.write = true;
    else if (arg === '--json') args.json = true;
    // Compatibility flag: it no longer creates blank generated blocks for every contact.
    else if (arg === '--all-contacts') args.allContacts = true;
    else if (arg === '--write-unknown-files') args.writeUnknownFiles = true;
    else if (arg === '--max-likely-per-person') args.maxLikelyPerPerson = Number(argv[++i]);
    else if (arg === '--max-unknown-files') args.maxUnknownFiles = Number(argv[++i]);
    else if (arg === '--unknown-min-conversations') args.unknownMinConversations = Number(argv[++i]);
    else if (arg === '--unknown-min-segments') args.unknownMinSegments = Number(argv[++i]);
    else if (arg === '--include-context-candidates') args.includeContextCandidates = true;
    else if (arg === '--person-id') args.personIds.push(canonicalPersonId(argv[++i]));
    else if (arg === '--help' || arg === '-h') usage(0);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function usage(exitCode = 0) {
  const text = [
    'Usage:',
    '  node scripts/sync-voiceprints-to-people-files.js [--write] [--json] [--all-contacts]',
    '       [--write-unknown-files] [--person-id PERSON_ID] [--max-likely-per-person 20] [--max-unknown-files 80]',
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
  const portable = repoRelativeTail(file);
  if (portable) return portable;
  const resolved = path.isAbsolute(file) ? file : path.join(PEOPLE_ROOT, file);
  return path.relative(PEOPLE_ROOT, resolved).replace(/\\/g, '/');
}

function repoAbs(maybeRel) {
  if (!maybeRel) return null;
  return path.isAbsolute(maybeRel) ? maybeRel : path.join(PEOPLE_ROOT, maybeRel);
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
  if (/^unknown_voice_/i.test(fileName)) return false;
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
    rows.push({
      file,
      rel: repoRel(file),
      text,
      display_name: displayName,
      description: frontmatter.description || '',
      category: frontmatter.category || '',
      display_key: normalizeName(displayName),
      file_key: normalizeName(path.basename(fileName, '.md').replace(/_/g, ' ')),
    });
  }
  const userProfile = path.join(PEOPLE_ROOT, 'memory', 'user_profile.md');
  if (fs.existsSync(userProfile)) {
    const text = fs.readFileSync(userProfile, 'utf8');
    const frontmatter = parseFrontmatter(text);
    const displayName = String(frontmatter.name || 'PRIVATE_NAME').trim();
    rows.push({
      file: userProfile,
      rel: 'memory/user_profile.md',
      text,
      display_name: displayName,
      description: frontmatter.description || '',
      category: frontmatter.category || '',
      display_key: normalizeName(displayName),
      file_key: 'ExampleCo',
    });
  }
  return rows;
}

// C5: a person group only counts as confirmed when it carries actual
// confirmed-reference-voiceprint evidence. confidence_tiers is a count map like
// { confirmed_reference_voiceprint_match: N, inferred_unconfirmed_low_margin: M }.
function groupHasConfirmedVoiceprintEvidence(group) {
  const tiers = group && group.confidence_tiers;
  if (!tiers || typeof tiers !== 'object') return false;
  return Number(tiers.confirmed_reference_voiceprint_match || 0) > 0;
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

function identityPersonIdForRecord(record) {
  const direct = (record.confirmed || []).find((row) => row.person_id)?.person_id;
  return canonicalPersonId(direct || path.basename(record.contact.rel, '.md'));
}

function planContactReconciliation(contacts, byContact, args) {
  const plannedContactUpdates = [];
  const activeEvidenceContacts = new Set();

  for (const record of byContact.values()) {
    record.confirmed.sort((a, b) => String(a.person_id).localeCompare(String(b.person_id)));
    record.likely.sort(sortByImportance);
    if (!hasVoiceEvidence(record)) continue;
    activeEvidenceContacts.add(record.contact.rel);
    const block = renderPersonBlock({
      contact: record.contact,
      confirmed: record.confirmed,
      likely: record.likely,
      quarantined: record.quarantined,
      args,
    });
    const personId = identityPersonIdForRecord(record);
    const externalFile = identityFile(DATA_ROOT, personId);
    const externalText = fs.existsSync(externalFile) ? fs.readFileSync(externalFile, 'utf8') : '';
    const externalNextText = upsertVoiceIdentitySection(externalText, {
      personId,
      section: 'voiceprint-identity',
      content: block,
    });
    const nextText = replacePeopleVoiceIdentityLink(record.contact.text, personId);
    const voiceIdentityChanged = externalText !== externalNextText;
    if (nextText !== record.contact.text || voiceIdentityChanged) {
      plannedContactUpdates.push({
        file: record.contact.file,
        rel: record.contact.rel,
        confirmed_voiceprints: record.confirmed.length,
        likely_voice_clusters: record.likely.length,
        quarantined_voiceprints: record.quarantined.length,
        removed_stale_voiceprint_block: false,
        nextText,
        voice_identity_file: externalFile,
        voice_identity_text: externalNextText,
        voice_identity_changed: voiceIdentityChanged,
      });
    }
  }

  // Cluster truth is authoritative in both directions. If a person no longer
  // has current voice evidence, remove the generated block from that person's
  // file. Keeping it would make an automatic unassignment or move look linked
  // forever even though the registry and enriched call tracks had changed.
  for (const contact of contacts) {
    if (activeEvidenceContacts.has(contact.rel)) continue;
    // Do not remove the shared link here: speaker intelligence can still be
    // current even when this contact has no current voiceprint enrollment.
    const nextText = removeGeneratedBlock(contact.text);
    if (nextText === contact.text) continue;
    plannedContactUpdates.push({
      file: contact.file,
      rel: contact.rel,
      confirmed_voiceprints: 0,
      likely_voice_clusters: 0,
      quarantined_voiceprints: 0,
      removed_stale_voiceprint_block: true,
      nextText,
    });
  }

  return plannedContactUpdates;
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

function hasVoiceEvidence(record = {}) {
  return Boolean(
    (record.confirmed && record.confirmed.length) ||
      (record.likely && record.likely.length) ||
      (record.quarantined && record.quarantined.length),
  );
}

function renderPersonBlock({ contact, confirmed = [], likely = [], quarantined = [], args }) {
  const lines = [
    START,
    '## Voiceprint Identity',
    '',
    '<!-- Generated by `node scripts/sync-voiceprints-to-people-files.js --write`; edit source voiceprint/correction records, not this block. -->',
    '',
  ];
  if (!confirmed.length && !likely.length && !quarantined.length) {
    lines.push(bulletLine('No current voiceprint evidence is linked.'));
    lines.push(END);
    return lines.join('\n');
  }

  if (confirmed.length) {
    lines.push('### Confirmed Voiceprint');
    const confirmedPeople = new Map();
    for (const item of confirmed) {
      const personKey = item.person_id || item.display_name || 'unknown';
      if (!confirmedPeople.has(personKey)) confirmedPeople.set(personKey, []);
      confirmedPeople.get(personKey).push(item);
    }
    for (const [personId, items] of confirmedPeople) {
      const first = items[0] || {};
      lines.push(
        bulletLine(
          `Person id: \`${personId}\`; status: \`${first.identity_confirmation_status || 'confirmed_by_ExampleCo'}\`; canonical speaker: \`${first.voice_cluster_id || `person:${personId}`}\`; model: \`${first.model || first.voiceprint_model || 'local_acoustic_fingerprint.v1'}\`.`,
        ),
      );
      if (first.created_at || first.identity_confirmed_at) {
        lines.push(
          bulletLine(`Confirmed at: ${first.created_at || first.identity_confirmed_at}.`),
        );
      }
      lines.push(bulletLine(`${items.length} call-linked reference clip(s):`));
      for (const item of items) {
        const sourceLabel = String(item.source_label || '')
          .replace(/^ExampleCo confirmed .*? as .*?;\s*/i, '')
          .trim();
        const clip = item.reference_audio_rel || repoRel(item.reference_audio_path);
        lines.push(
          `  - ${sourceLabel || item.source_id || 'Recorded Otter call'}; source track: \`${item.source_voice_cluster_id || item.source_id || 'unknown'}\`; enrollment: \`${item.enrollment_id || 'unknown'}\`; clip: \`${clip || 'missing'}\`.`,
        );
      }
    }
    lines.push('');
  }

  if (quarantined.length) {
    lines.push('### Excluded / Quarantined Voiceprints');
    lines.push(bulletLine('These references are preserved for audit only and are not allowed to confirm this person or update transcript speakers.'));
    for (const item of quarantined) {
      const heard = item.calibration_actual_name ? `; heard name: \`${item.calibration_actual_name}\`` : '';
      lines.push(bulletLine(`Enrollment: \`${item.enrollment_id || 'unknown'}\`; prior person id: \`${item.person_id || 'unknown'}\`${heard}; reason: ${item.calibration_quarantine_reason || 'failed known-speaker calibration'}.`));
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
      const evidenceText = evidence ? ` Evidence: ${evidence.type || 'context'} in "${evidence.title || evidence.otid || 'unknown'}"${evidence.snippet ? `: ${evidence.snippet}` : ''}` : '';
      lines.push(bulletLine(`\`${item.voice_cluster_id}\`: ${item.conversation_count || 0} conversation(s), ${item.segment_count || 0} segment(s), guess \`${guess.display_name || 'unknown'}\` (${guess.confidence || 'unscored'}, score ${guess.score ?? 'n/a'}), clip \`${clip}\`.${evidenceText}`));
    }
    if (likely.length > args.maxLikelyPerPerson) lines.push(bulletLine(`Additional linked clusters omitted from this file block: ${likely.length - args.maxLikelyPerPerson}. See \`data/life-archive/voiceprints/voice-discovery-roster-latest.json\`.`));
    lines.push('');
  }

  lines.push(END);
  return lines.join('\n');
}

function safeUnknownFileName(clusterId) {
  return `unknown_voice_${String(clusterId || '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()}.md`;
}

function renderUnknownFile(row) {
  const guess = row.top_name_guess || null;
  const title = `Unknown voice ${row.voice_cluster_id}`;
  const description = guess
    ? `Durable Otter voice cluster; likely ${guess.display_name}, not yet confirmed by ExampleCo`
    : 'Durable Otter voice cluster; identity not yet confirmed by ExampleCo';
  const lines = [
    '---',
    `name: ${title}`,
    `description: ${description}`,
    'type: user',
    'category: voice-unknown',
    `last_interaction: "${row.last_seen || row.first_seen || 'unknown'}"`,
    'warmth: unknown',
    '---',
    '',
    '## Voice Identity',
    '',
    `- **Stable voice cluster**: \`${row.voice_cluster_id}\``,
    `- **Status**: ${row.status || 'unknown_person'}`,
    `- **Likely name**: ${guess ? `${guess.display_name} (${guess.confidence}, score ${guess.score})` : 'unknown'}`,
    `- **Observed**: ${row.conversation_count || 0} conversation(s), ${row.segment_count || 0} segment(s), ${row.first_seen || '?'} to ${row.last_seen || '?'}`,
    `- **Review clip**: \`${row.representative_probe_audio_path || 'missing'}\``,
    `- **Roster**: \`data/life-archive/voiceprints/voice-discovery-roster-latest.json\``,
    '',
    '## Current Evidence',
    '',
  ];
  if (guess && Array.isArray(guess.evidence)) {
    for (const evidence of guess.evidence.slice(0, 4)) {
      lines.push(`- ${evidence.type || 'context'} in "${evidence.title || evidence.otid || 'unknown'}": ${evidence.snippet || ''}`);
    }
  } else {
    const conversation = (row.conversations || [])[0];
    if (conversation) lines.push(`- Frequent/substantial unknown speaker in "${conversation.title || conversation.otid}" (${conversation.date || 'unknown date'}).`);
  }
  lines.push('');
  lines.push('## Merge Rule');
  lines.push('');
  lines.push('- When ExampleCo identifies this voice, use `node scripts/otter-voiceprint-correct.js --voice-cluster-id <id> --person <person_id> --apply-to-all-inferred --write` and merge this provisional file into the confirmed person file.');
  lines.push('');
  lines.push(renderPersonBlock({ contact: null, confirmed: [], likely: [row], args: { maxLikelyPerPerson: 20 } }));
  return `${lines.join('\n')}\n`;
}

function buildSync(args) {
  if (args.write) assertPeopleFileWriteAllowed({ repo: PEOPLE_ROOT });
  const generatedAt = new Date().toISOString();
  const contacts = loadContacts();
  if (!fs.existsSync(VOICE_IDENTITY_REGISTRY_PATH)) {
    throw new Error(
      `refusing People File reconciliation without voice identity registry: ${repoRel(VOICE_IDENTITY_REGISTRY_PATH)}`,
    );
  }
  const registry = loadJson(VOICE_IDENTITY_REGISTRY_PATH, { people: {}, enrollments: [] });
  if (!registry || typeof registry !== 'object' || !Array.isArray(registry.enrollments)) {
    throw new Error(
      `refusing People File reconciliation with invalid voice identity registry: ${repoRel(VOICE_IDENTITY_REGISTRY_PATH)}`,
    );
  }
  const roster = loadJson(ROSTER_PATH, { roster: [] });
  const analytics = loadJson(SPEAKER_ANALYTICS_PATH, { person_groups: [] });
  const reviewedVoiceClusters = new Set([
    ...Object.keys(registry.voice_cluster_resolutions || {}),
    ...Object.keys(registry.voice_cluster_denials || {}),
  ]);

  const byContact = new Map();
  function entryFor(contact) {
    const rel = contact.rel;
    if (!byContact.has(rel)) byContact.set(rel, { contact, confirmed: [], likely: [], quarantined: [] });
    return byContact.get(rel);
  }

  const enrollments = registry.enrollments || [];
  for (const enrollment of enrollments) {
    // Quarantined rows still need an audit block, so target them with the same
    // exact identity resolver as active references.
    const personId = canonicalPersonId(enrollment.person_id);
    const person = registry.people?.[personId] || registry.people?.[enrollment.person_id] || {};
    const target = resolvePeopleFileTarget({
      repoRoot: PEOPLE_ROOT,
      personId,
      displayName: person.display_name || enrollment.display_name || personId,
      registryPerson: person,
      catalog: contacts,
    });
    const contact = contacts.find((row) => row.rel === target.rel);
    if (!contact) continue;
    const entry = entryFor(contact);
    const normalizedEnrollment = {
      ...enrollment,
      person_id: personId,
      display_name: person.display_name || enrollment.display_name || personId,
      contact_file: target.rel,
    };
    if (isQuarantinedEnrollment(enrollment)) entry.quarantined.push(normalizedEnrollment);
    else entry.confirmed.push(normalizedEnrollment);
  }

  for (const group of analytics.person_groups || []) {
    if (!group.person_id || !String(group.person_group_id || '').startsWith('person:')) continue;
    // C5: do NOT trust the person: prefix alone. Promote to a confirmed block
    // only when the group actually carries confirmed-reference-voiceprint
    // evidence (a nonzero confirmed_reference_voiceprint_match count in its
    // confidence_tiers). Otherwise an analytics row with no acoustic proof
    // could write a "confirmed" voiceprint into a contact file unattended.
    if (!groupHasConfirmedVoiceprintEvidence(group)) continue;
    // F6: bind by person_id (or an explicit alias), never by display-name slug
    // alone, so two people who share a first name cannot cross-contaminate.
    const personId = canonicalPersonId(group.person_id);
    const person = registry.people?.[personId] || {};
    const target = resolvePeopleFileTarget({
      repoRoot: PEOPLE_ROOT,
      personId,
      displayName: person.display_name || group.display_name || personId,
      registryPerson: person,
      catalog: contacts,
    });
    const contact = contacts.find((row) => row.rel === target.rel);
    if (!contact) continue;
    const already = entryFor(contact);
    if (already.confirmed.some((item) => item.person_id === personId && item.analytics_person_group_id)) continue;
    already.confirmed.push({
      person_id: personId,
      display_name: person.display_name || group.display_name,
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

  const requestedPersonIds = new Set((args.personIds || []).map(canonicalPersonId).filter(Boolean));
  const scopedContacts = requestedPersonIds.size
    ? contacts.filter((contact) => {
        const entry = byContact.get(contact.rel);
        return (entry?.confirmed || []).some((row) =>
          requestedPersonIds.has(canonicalPersonId(row.person_id)),
        );
      })
    : contacts;
  const plannedContactUpdates = planContactReconciliation(scopedContacts, byContact, args);

  const existingUnknownFiles = new Set(fs.readdirSync(CONTACTS_ROOT)
    .filter((name) => /^unknown_voice_speaker_\d+\.md$/.test(name))
    .map((name) => path.join(CONTACTS_ROOT, name)));
  const recurringUnknown = (roster.roster || [])
    .filter((row) => !row.confirmed_person_id)
    .filter((row) => !reviewedVoiceClusters.has(row.voice_cluster_id) && row.review_status !== 'confirmed_by_ExampleCo' && row.review_status !== 'denied_by_ExampleCo')
    .filter((row) => (row.conversation_count || 0) >= args.unknownMinConversations || (row.segment_count || 0) >= args.unknownMinSegments)
    .sort(sortByImportance)
    .slice(0, args.maxUnknownFiles);
  const plannedUnknownFiles = [];
  if (args.writeUnknownFiles) {
    for (const row of recurringUnknown) {
      const file = path.join(CONTACTS_ROOT, safeUnknownFileName(row.voice_cluster_id));
      const nextText = renderUnknownFile(row);
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== nextText) {
        plannedUnknownFiles.push({
          file,
          rel: repoRel(file),
          voice_cluster_id: row.voice_cluster_id,
          conversation_count: row.conversation_count,
          segment_count: row.segment_count,
          top_name_guess: row.top_name_guess || null,
          nextText,
        });
      }
      existingUnknownFiles.delete(file);
    }
  }

  const cleanupFiles = requestedPersonIds.size
    ? []
    : [CONTACT_INDEX_PATH].filter((file) => fs.existsSync(file));
  const plannedCleanupFiles = cleanupFiles
    .map((file) => {
      const text = fs.readFileSync(file, 'utf8');
      const nextText = removeGeneratedBlock(text);
      return nextText !== text ? { file, rel: repoRel(file), nextText } : null;
    })
    .filter(Boolean);

  if (args.write) {
    // Fail closed BEFORE the first byte: one forbidden name anywhere in the
    // planned batch means nothing at all is written.
    for (const update of [...plannedContactUpdates, ...plannedUnknownFiles, ...plannedCleanupFiles]) {
      assertNoForbiddenPeople(update.nextText, `people-file write ${update.rel}`);
      if (update.voice_identity_changed) {
        assertNoForbiddenPeople(update.voice_identity_text, `voice identity write ${update.voice_identity_file}`);
      }
    }
    for (const update of plannedContactUpdates) {
      if (update.voice_identity_changed) {
        fs.mkdirSync(path.dirname(update.voice_identity_file), { recursive: true });
        fs.writeFileSync(update.voice_identity_file, update.voice_identity_text, 'utf8');
      }
      if (update.nextText !== fs.readFileSync(update.file, 'utf8')) {
        fs.writeFileSync(update.file, update.nextText, 'utf8');
      }
    }
    for (const update of plannedUnknownFiles) fs.writeFileSync(update.file, update.nextText, 'utf8');
    for (const update of plannedCleanupFiles) fs.writeFileSync(update.file, update.nextText, 'utf8');
  }

  const report = {
    schema: 'life_archive_people_voiceprint_sync.v1',
    generated_at: generatedAt,
    wrote_files: Boolean(args.write),
    source_roster_path: repoRel(ROSTER_PATH),
    source_roster_present: fs.existsSync(ROSTER_PATH),
    source_registry_path: repoRel(VOICE_IDENTITY_REGISTRY_PATH),
    contacts_seen: contacts.length,
    requested_person_ids: [...requestedPersonIds].sort(),
    contacts_with_voice_evidence: Array.from(byContact.values()).filter(hasVoiceEvidence).length,
    confirmed_identities_evaluated: new Set(
      enrollments
        .filter((row) => !isQuarantinedEnrollment(row))
        .map((row) => canonicalPersonId(row.person_id))
        .filter(Boolean),
    ).size,
    contact_files_planned_updates: plannedContactUpdates.length,
    contact_files_written: args.write ? plannedContactUpdates.length : 0,
    unknown_voice_files_planned_or_updated: plannedUnknownFiles.length,
    unknown_voice_file_writes_enabled: Boolean(args.writeUnknownFiles),
    recurring_unknown_voice_files_targeted: recurringUnknown.length,
    stale_unknown_files_not_touched: Array.from(existingUnknownFiles).map(repoRel),
    cleanup_files_updated: plannedCleanupFiles.map((item) => item.rel),
    updated_contacts: plannedContactUpdates.map((item) => ({
      file: item.rel,
      confirmed_voiceprints: item.confirmed_voiceprints,
      likely_voice_clusters: item.likely_voice_clusters,
      quarantined_voiceprints: item.quarantined_voiceprints,
      removed_stale_voiceprint_block: item.removed_stale_voiceprint_block,
      voice_identity_file: item.voice_identity_file ? repoRel(item.voice_identity_file) : null,
    })),
    unknown_voice_files: plannedUnknownFiles.map((item) => ({
      file: item.rel,
      voice_cluster_id: item.voice_cluster_id,
      conversation_count: item.conversation_count,
      segment_count: item.segment_count,
      top_name_guess: item.top_name_guess,
    })),
  };
  if (args.write) {
    const currentConfirmedPersonIds = new Set(
      [...byContact.values()].flatMap((entry) =>
        (entry.confirmed || []).map((row) => canonicalPersonId(row.person_id)).filter(Boolean),
      ),
    );
    report.projection_event = appendProjectionEvent({
      dataDir: DATA_ROOT,
      producer: 'voiceprint_identity',
      generatedAt,
      identitiesEvaluated: report.confirmed_identities_evaluated,
      identitiesCurrent: currentConfirmedPersonIds.size,
      filesPlanned: plannedContactUpdates.map((item) => item.rel),
      filesWritten: plannedContactUpdates.map((item) => item.rel),
    });
    saveJson(STATUS_PATH, report);
  }
  return report;
}

function formatReport(report) {
  return [
    `People voiceprint sync: ${report.contact_files_planned_updates} contact file change(s) planned; ${report.contact_files_written} written; ${report.unknown_voice_files_planned_or_updated} unknown voice file change(s) planned.`,
    `Contacts seen: ${report.contacts_seen}; recurring unknown voice files targeted: ${report.recurring_unknown_voice_files_targeted}.`,
    `Unknown-voice contact writes: ${report.unknown_voice_file_writes_enabled ? 'enabled explicitly' : 'disabled by default'}.`,
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
  assertPeopleFileWriteAllowed,
  replaceGeneratedBlock,
  removeGeneratedBlock,
  planContactReconciliation,
  renderPersonBlock,
  renderUnknownFile,
  hasVoiceEvidence,
  parseArgs,
  groupHasConfirmedVoiceprintEvidence,
};
