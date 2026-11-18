#!/usr/bin/env node
'use strict';
// Quarantine a clip proposal whose source turned out not to be English.
//
// owner decision: "don't do videos in other languages like the second one
// you proposed today." The proposer now rejects such sources before any spend,
// but a proposal written before the gate (vtc-8a76efb341c8, a Turkish-host
// Karpathy recap: yt-dlp language=tr, original caption tracks tr-orig and
// en-orig) still sits in its day file as approved and built. This marks the
// proposal rejected with a failed `language_gate` receipt, and marks the
// approval-queue row rejected when it is still waiting on the owner. Rows the owner
// already decided (deleted, posted, rejected) are left as they are. Idempotent.
//
// Usage:
//   node scripts/quarantine-non-english-clip.js --id <proposal id> --date YYYY-MM-DD \
//     --language <tag> --evidence "<where the language came from>" [--dry-run]
// Env: SECONDBRAIN_DATA_DIR (day files), SECONDBRAIN_ROOT (approval queue).

const fs = require('fs');
const path = require('path');
const { normalizeLanguageTag, isEnglishLanguage } = require('./lib/clip-language-gate.js');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const DATA_DIR = process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data');
const OWNER_DECIDED = new Set(['deleted', 'posted', 'rejected', 'published']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'dry-run') out.dryRun = true;
    else out[key] = argv[++i];
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function quarantineNonEnglishClip({
  id,
  date,
  language,
  evidence,
  dryRun = false,
  dataDir = DATA_DIR,
  manifestPath = path.join(REPO, 'content-review', 'pending', 'manifest.json'),
  now = () => new Date(),
  lockOptions = undefined,
} = {}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) throw new Error('--id required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('--date YYYY-MM-DD required');
  const tag = normalizeLanguageTag(language);
  if (!tag || isEnglishLanguage(tag) !== false) throw new Error('--language must be a known non-English tag');
  if (!String(evidence || '').trim()) throw new Error('--evidence required (where the language came from)');
  const at = now().toISOString();
  const reason = `non-English source (${tag}): English-only channel (The owner)`;
  const result = { id, date, language: tag, reason, proposal: 'unchanged', queue: 'unchanged' };

  const dayFile = path.join(dataDir, 'agent', 'viral-tech-clips', `${date}.json`);
  if (!fs.existsSync(dayFile)) throw new Error(`day file not found: ${dayFile}`);
  const state = readJson(dayFile);
  const proposal = (state.proposals || []).find((row) => row && row.id === id);
  if (!proposal) throw new Error(`proposal ${id} is not in ${dayFile}`);
  const gate = proposal.language_gate || {};
  const alreadyQuarantined = proposal.status === 'rejected' && gate.ok === false && gate.audio_language === tag;
  if (!alreadyQuarantined) {
    proposal.status = 'rejected';
    proposal.rejected_at = proposal.rejected_at || at;
    proposal.rejected_by = 'amy-english-only-gate';
    proposal.reject_feedback = reason;
    proposal.audio_language = tag;
    proposal.audio_language_source = String(evidence).trim();
    proposal.language_gate = {
      ok: false,
      audio_language: tag,
      audio_language_source: String(evidence).trim(),
      spoken_language: normalizeLanguageTag(proposal.spoken_language),
      rule: 'English-only channel (The owner)',
      checked_at: at,
      quarantined_at: at,
    };
    if (!dryRun) require('./lib/proposal-file-lock.js').writeProposalById(dayFile, proposal, state);
    result.proposal = dryRun ? 'would quarantine' : 'quarantined';
  }

  if (fs.existsSync(manifestPath)) {
    // Codex review dc2c51103d63 (medium): the queue manifest is shared with
    // the approval server and the regen worker, so the read-modify-write runs
    // under the file lock and the write is atomic.
    const { withProposalFileLock, writeJsonAtomic } = require('./lib/proposal-file-lock.js');
    withProposalFileLock(manifestPath, () => {
      const manifest = readJson(manifestPath);
      const videos = Array.isArray(manifest.videos) ? manifest.videos : [];
      const row = videos.find((video) => video && video.id === id);
      if (row && row.status === 'rejected' && row.rejected_by === 'amy-english-only-gate') {
        result.queue = 'already quarantined';
      } else if (row && OWNER_DECIDED.has(String(row.status || ''))) {
        result.queue = `left as ${row.status} (owner decided)`;
      } else if (row) {
        row.status = 'rejected';
        row.rejected_at = row.rejected_at || at;
        row.rejected_by = 'amy-english-only-gate';
        row.reject_feedback = reason;
        row.language_gate = proposal.language_gate;
        if (!dryRun) writeJsonAtomic(manifestPath, manifest);
        result.queue = dryRun ? 'would reject' : 'rejected';
      } else {
        result.queue = 'no row';
      }
    }, lockOptions);
  } else {
    result.queue = 'no manifest';
  }
  return result;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = quarantineNonEnglishClip(args);
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(`[quarantine-non-english-clip] ${err.message}`);
    process.exit(1);
  }
}

module.exports = { quarantineNonEnglishClip, parseArgs };
