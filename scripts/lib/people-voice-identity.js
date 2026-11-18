'use strict';

// Generated voice evidence is runtime data.  A People file keeps only this
// small durable pointer so handwritten relationship context remains readable.
const fs = require('node:fs');
const path = require('node:path');

const LINK_START = '<!-- amy-voice-identity-link:start -->';
const LINK_END = '<!-- amy-voice-identity-link:end -->';
const LEGACY_BLOCKS = [
  ['<!-- otter-speaker-intelligence:start -->', '<!-- otter-speaker-intelligence:end -->'],
  ['<!-- voiceprint-identity:start -->', '<!-- voiceprint-identity:end -->'],
];

function safePersonId(value) {
  return String(value || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function identityFile(dataRoot, personId) {
  return path.join(dataRoot, 'life-archive', 'voiceprints', 'people', `${safePersonId(personId)}.md`);
}

function identityRepoPath(personId) {
  return `data/life-archive/voiceprints/people/${safePersonId(personId)}.md`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeDelimitedBlock(text, start, end) {
  const expression = new RegExp(`\\n{0,2}${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\s*`, 'm');
  return String(text || '').replace(expression, '\n');
}

function normalizePeopleText(text) {
  return String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
    .concat('\n');
}

function voiceIdentityLinkBlock(personId) {
  return [
    LINK_START,
    `- Voice identity: \`${identityRepoPath(personId)}\``,
    LINK_END,
  ].join('\n');
}

function replacePeopleVoiceIdentityLink(text, personId) {
  let next = String(text || '');
  for (const [start, end] of LEGACY_BLOCKS) next = removeDelimitedBlock(next, start, end);
  next = removeDelimitedBlock(next, LINK_START, LINK_END).trimEnd();
  return `${next}\n\n${voiceIdentityLinkBlock(personId)}\n`;
}

function removePeopleVoiceIdentityLink(text) {
  let next = removeDelimitedBlock(text, LINK_START, LINK_END);
  for (const [start, end] of LEGACY_BLOCKS) next = removeDelimitedBlock(next, start, end);
  return normalizePeopleText(next);
}

function sectionMarkers(section) {
  const safe = String(section || 'voice').replace(/[^a-z0-9_-]+/gi, '-');
  return {
    start: `<!-- amy-voice-identity:${safe}:start -->`,
    end: `<!-- amy-voice-identity:${safe}:end -->`,
  };
}

function upsertVoiceIdentitySection(existing, { personId, section, content }) {
  const markers = sectionMarkers(section);
  const wrapped = [markers.start, String(content || '').trim(), markers.end].join('\n');
  const base = String(existing || '').trimEnd();
  const without = removeDelimitedBlock(base, markers.start, markers.end).trimEnd();
  const header = without || `# Voice identity: ${safePersonId(personId)}`;
  return `${header}\n\n${wrapped}\n`;
}

function writeVoiceIdentitySection({ dataRoot, personId, section, content }) {
  const file = identityFile(dataRoot, personId);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const nextText = upsertVoiceIdentitySection(current, { personId, section, content });
  if (nextText !== current) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, nextText, 'utf8');
  }
  return { file, repoPath: identityRepoPath(personId), changed: nextText !== current, nextText };
}

// Compatibility reader for callers that have not yet migrated an existing
// People file. External evidence wins; legacy generated blocks remain readable.
function readVoiceIdentity({ dataRoot, personId, peopleText = '' }) {
  const file = identityFile(dataRoot, personId);
  if (fs.existsSync(file)) return { source: 'external', file, text: fs.readFileSync(file, 'utf8') };
  const legacy = LEGACY_BLOCKS
    .map(([start, end]) => {
      const match = String(peopleText).match(new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, 'm'));
      return match ? match[0] : '';
    })
    .filter(Boolean)
    .join('\n\n');
  return { source: legacy ? 'legacy-people-file' : 'none', file, text: legacy };
}

module.exports = {
  LEGACY_BLOCKS,
  LINK_END,
  LINK_START,
  identityFile,
  identityRepoPath,
  readVoiceIdentity,
  removePeopleVoiceIdentityLink,
  replacePeopleVoiceIdentityLink,
  safePersonId,
  upsertVoiceIdentitySection,
  voiceIdentityLinkBlock,
  writeVoiceIdentitySection,
};
