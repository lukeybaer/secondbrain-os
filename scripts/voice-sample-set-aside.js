#!/usr/bin/env node
/**
 * Take one voice sample out of a person's set on the owner's word, or put it back.
 *
 *   node scripts/voice-sample-set-aside.js --enrollment-id <id> --reason "<text>" [--undo] [--write]
 *
 * Dry by default. The sample stays on record: every reader of the registry
 * already skips a quarantined sample, and the automatic sample step never adds
 * its clip again. --undo also puts back a sample the calibration gate set aside,
 * which had no manual way back. The gate leaves the owner's decision alone from then
 * on (sampleDecidedByOwner). An unknown id, or an undo of a sample that is not
 * set aside, exits 2 and changes nothing.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const R = require('./voice-global-recluster');
const { saveJsonAtomic, withReclusterPublishLock } = require('./lib/recluster-publish-lock');
const { sampleIsSetAside } = require('./lib/voice-naming-rule');

function readJsonStrict(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

/** The person's own enrollment files carrying this sample, as the gate patches them. */
function enrollmentFiles(paths, personId, enrollmentId) {
  const dir = path.join(paths.vpDir, 'enrollments', String(personId || ''));
  if (!personId || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        return readJsonStrict(file)?.enrollment_id === enrollmentId;
      } catch {
        return false;
      }
    });
}

function applyDecision({ dataDir, enrollmentId, reason, undo = false, write = false, now = new Date().toISOString() }) {
  const paths = R.resolvePaths(dataDir);
  const decide = () => {
    const registry = readJsonStrict(paths.registry);
    const rows = (registry.enrollments || []).filter((row) => row?.enrollment_id === enrollmentId);
    const base = { enrollment_id: enrollmentId, action: undo ? 'put_back' : 'set_aside', wrote: false };
    if (!rows.length) return { ...base, ok: false, error: 'unknown_enrollment' };
    const asideNow = rows.some(sampleIsSetAside);
    const personId = rows[0].person_id;
    if (undo && !asideNow) return { ...base, ok: false, error: 'sample_is_not_set_aside', person_id: personId };
    if (!undo && asideNow && rows.every((row) => row.calibration_quarantine_source === 'owner')) {
      return { ...base, ok: true, changed: false, person_id: personId };
    }
    const patch = undo
      ? {
          calibration_quarantine_status: 'released',
          calibration_release_source: 'owner',
          calibration_released_at: now,
          calibration_release_reason: reason,
        }
      : {
          calibration_quarantine_status: 'quarantined',
          calibration_quarantine_source: 'owner',
          calibration_quarantined_at: now,
          calibration_quarantine_reason: reason,
        };
    if (write) {
      for (const row of rows) Object.assign(row, patch);
      for (const file of enrollmentFiles(paths, personId, enrollmentId)) {
        saveJsonAtomic(file, { ...readJsonStrict(file), ...patch });
      }
      registry.manual_corrections ||= [];
      registry.manual_corrections.push({
        type: undo ? 'voiceprint_enrollment_released_by_owner' : 'voiceprint_enrollment_set_aside_by_owner',
        created_at: now,
        person_id: personId,
        enrollment_id: enrollmentId,
        source: 'owner',
        reason,
      });
      registry.updated_at = now;
      saveJsonAtomic(paths.registry, registry);
    }
    return { ...base, ok: true, changed: true, wrote: Boolean(write), person_id: personId, patch };
  };
  return write ? withReclusterPublishLock(paths.latest, decide) : decide();
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

if (require.main === module) {
  const enrollmentId = arg('--enrollment-id');
  const reason = arg('--reason');
  if (!enrollmentId || !reason) {
    console.error('usage: voice-sample-set-aside.js --enrollment-id <id> --reason "<text>" [--undo] [--write]');
    process.exit(2);
  }
  const report = applyDecision({
    enrollmentId,
    reason,
    undo: process.argv.includes('--undo'),
    write: process.argv.includes('--write'),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exit(2);
}

module.exports = { applyDecision };
