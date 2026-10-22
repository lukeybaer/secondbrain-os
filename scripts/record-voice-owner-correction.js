#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HASH_RE = /^[a-f0-9]{64}$/;
const VOICE_ID_RE = /^(?:speaker_\d+|unknown_voice_(?:ecapa|wavlm)_[a-f0-9_-]+)$/i;
const ACTIONS = new Set(['correct', 'not_them']);

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function correctionId(row) {
  return crypto.createHash('sha256').update(stable({
    otid: row.otid,
    sourceRevision: row.sourceRevision,
    speakerModelLabel: row.speakerModelLabel,
    voiceClusterId: row.voiceClusterId,
    action: row.action,
    guessedName: row.guessedName,
    correctedName: row.correctedName,
    selectedPersonId: row.selectedPersonId,
    deniedPersonId: row.deniedPersonId,
  })).digest('hex');
}

function buildOwnerCorrection(input = {}) {
  const row = {
    ts: String(input.ts || new Date().toISOString()),
    date: String(input.ts || new Date().toISOString()).slice(0, 10),
    section: 'VOICE OWNER CORRECTION',
    voiceClusterId: String(input.voiceClusterId || '').trim(),
    action: String(input.action || '').trim(),
    guessedName: String(input.guessedName || '').trim(),
    correctedName: String(input.correctedName || '').trim(),
    selectedPersonId: String(input.selectedPersonId || '').trim(),
    deniedPersonId: String(input.deniedPersonId || '').trim(),
    personFilePath: String(input.personFilePath || '').trim(),
    personFileName: String(input.personFileName || input.correctedName || '').trim(),
    notes: String(input.notes || '').trim(),
    source: 'owner-direct-correction',
    status: 'queued_for_backpropagation',
    otid: String(input.otid || '').trim(),
    sourceRevision: String(input.sourceRevision || '').trim().toLowerCase(),
    speakerModelLabel: String(input.speakerModelLabel || '').trim(),
  };
  const problems = [];
  if (!VOICE_ID_RE.test(row.voiceClusterId)) problems.push('valid voiceClusterId is required');
  if (!ACTIONS.has(row.action)) problems.push('action must be correct or not_them');
  if (!row.otid) problems.push('exact otid is required');
  if (!HASH_RE.test(row.sourceRevision)) problems.push('exact sourceRevision SHA-256 is required');
  if (!row.speakerModelLabel) problems.push('exact speakerModelLabel is required');
  if (!row.guessedName) problems.push('guessedName is required');
  if (row.action === 'not_them' && !row.deniedPersonId) {
    problems.push('not_them requires deniedPersonId');
  }
  if (row.action === 'correct' && (!row.correctedName || !row.selectedPersonId || !row.personFilePath)) {
    problems.push('correct requires correctedName, selectedPersonId, and personFilePath');
  }
  if (problems.length) throw new Error(problems.join('; '));
  row.owner_correction_id = correctionId(row);
  return row;
}

function parseJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function recordOwnerCorrection({ file, row, write = false } = {}) {
  const existing = parseJsonl(file);
  if (existing.some((item) => item.owner_correction_id === row.owner_correction_id)) {
    return { written: false, idempotent: true, row };
  }
  if (write) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  }
  return { written: Boolean(write), idempotent: false, row };
}

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function main() {
  const root = path.resolve(process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..'));
  const dataDir = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(root, 'data'));
  const file = path.join(dataDir, 'life-archive', 'people', 'voice-confirmation-actions.jsonl');
  const row = buildOwnerCorrection({
    voiceClusterId: arg('--voice-cluster-id'),
    action: arg('--action'),
    guessedName: arg('--guessed-name'),
    correctedName: arg('--corrected-name'),
    selectedPersonId: arg('--selected-person-id'),
    deniedPersonId: arg('--denied-person-id'),
    personFilePath: arg('--person-file-path'),
    personFileName: arg('--person-file-name'),
    notes: arg('--notes'),
    otid: arg('--otid'),
    sourceRevision: arg('--source-revision'),
    speakerModelLabel: arg('--speaker-model-label'),
  });
  const result = recordOwnerCorrection({ file, row, write: process.argv.includes('--write') });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    file,
    written: result.written,
    idempotent: result.idempotent,
    owner_correction_id: row.owner_correction_id,
  })}\n`);
}

if (require.main === module) main();

module.exports = { buildOwnerCorrection, correctionId, recordOwnerCorrection };
