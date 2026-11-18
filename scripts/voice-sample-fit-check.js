#!/usr/bin/env node
/**
 * Report only: how well each voice sample sits with the person's other samples.
 *
 * Flags a new sample whose fit is under the bar, or cannot be proved. It sets
 * nothing aside and changes nothing; the owner decides, with voice-sample-set-aside.js.
 * New means created after the naming rule's baseline was frozen, or in the last
 * 30 days when there is no baseline. Older samples are counted, never flagged.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const R = require('./voice-global-recluster');
const { saveJsonAtomic } = require('./lib/recluster-publish-lock');
const { canonicalPersonId } = require('./lib/canonical-speaker-identity');
const { clipIsMixed } = require('./lib/voice-clip-purity');
const { SAMPLE_FIT, readNamingBaseline, sampleFit, sampleIsSetAside } = require('./lib/voice-naming-rule');

const NEW_DAYS_WITHOUT_BASELINE = 30;

function audioOf(row) {
  return row.reference_audio_rel || row.reference_audio_path || row.audio_path || '';
}

function run({ dataDir, write = false, now = new Date() } = {}) {
  const paths = R.resolvePaths(dataDir);
  const registry = JSON.parse(fs.readFileSync(paths.registry, 'utf8').replace(/^﻿/, ''));
  const baseline = readNamingBaseline(paths.dataDir);
  const newSince = baseline?.frozen_at
    ? Date.parse(baseline.frozen_at)
    : now.getTime() - NEW_DAYS_WITHOUT_BASELINE * 24 * 60 * 60 * 1000;
  const index = R.loadEmbeddingIndex(paths.embedCacheDir);
  const vectorOf = (row) => {
    const audio = audioOf(row);
    if (!audio || clipIsMixed(paths.dataDir, audio)) return null;
    return R.lookupEmbedding(index, audio, paths)?.vector || null;
  };
  const byPerson = new Map();
  let setAsideSkipped = 0;
  for (const row of registry.enrollments || []) {
    if (sampleIsSetAside(row)) {
      setAsideSkipped += 1;
      continue;
    }
    const id = canonicalPersonId(row?.person_id);
    if (!id) continue;
    if (!byPerson.has(id)) byPerson.set(id, []);
    byPerson.get(id).push({ row, vector: vectorOf(row) });
  }
  const flagged = [];
  const counts = { samples_checked: 0, new_samples: 0, no_embedding: 0, older_under_bar: 0, older_unproven: 0 };
  for (const [id, samples] of byPerson) {
    samples.forEach(({ row, vector }, i) => {
      counts.samples_checked += 1;
      if (!vector) counts.no_embedding += 1;
      const others = samples.filter((_, j) => j !== i).map((other) => other.vector).filter(Boolean);
      const fit = sampleFit(vector, others);
      const under = fit != null && fit < SAMPLE_FIT;
      const isNew = Date.parse(row.created_at || '') > newSince;
      if (!isNew) {
        if (under) counts.older_under_bar += 1;
        if (fit == null) counts.older_unproven += 1;
        return;
      }
      counts.new_samples += 1;
      if (under || fit == null) {
        flagged.push({
          enrollment_id: row.enrollment_id || null,
          person_id: id,
          otid: row.otid || null,
          created_at: row.created_at || null,
          fit: fit == null ? null : Math.round(fit * 1000) / 1000,
          reason: fit == null ? 'fit_unproven' : 'fit_under_bar',
        });
      }
    });
  }
  const report = {
    schema: 'voice_sample_fit_check.v1',
    generated_at: now.toISOString(),
    fit_bar: SAMPLE_FIT,
    new_since: new Date(newSince).toISOString(),
    people: byPerson.size,
    ...counts,
    set_aside_skipped: setAsideSkipped,
    flagged_count: flagged.length,
    flagged,
    // This check never takes a sample out of anyone's set.
    set_aside: 0,
  };
  if (write) saveJsonAtomic(path.join(paths.vpDir, 'voice-sample-fit-check-latest.json'), report);
  return report;
}

if (require.main === module) {
  const report = run({ write: process.argv.includes('--write') });
  process.stdout.write(`${JSON.stringify({ ...report, flagged: undefined }, null, 2)}\n`);
}

module.exports = { run };
