#!/usr/bin/env node
/**
 * Report only: how each way of naming a speaker scores against the owner's own clicks.
 *
 * A click on the voice-name conflict page records the label the track carried
 * just before it. That label was right when the owner's answer names the same person,
 * wrong when it names someone else or nobody. "Two people" is counted apart,
 * since it says the clip was bad, not who spoke. Undone clicks do not count.
 * Changes nothing, and is never a problem on System Health, only a fact.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { saveJsonAtomic } = require('./lib/recluster-publish-lock');
const { RENAME_EVIDENCE, sameCanonicalPerson } = require('./lib/voice-track-name-check');
const { liveDecisions, queuePaths, readLedger } = require('./lib/voice-name-conflict-queue');

const REPO = path.resolve(__dirname, '..');

function readJsonQuiet(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** The way this label got onto the track, as the click recorded it. */
function namingPath(prior) {
  const parts = [String(prior?.identity_tier || 'no_tier')];
  if (prior?.voice_check?.source) parts.push(String(prior.voice_check.source));
  if (Array.isArray(prior?.evidence) && prior.evidence.includes(RENAME_EVIDENCE)) parts.push('renamed_by_voice');
  return parts.join(' | ');
}

function score(ledger, aliases) {
  const out = {
    live_clicks: 0,
    undone_or_replaced: 0,
    not_sure: 0,
    answers: { name: 0, voice: 0, neither: 0, two_people: 0 },
    label_right: 0,
    label_wrong: 0,
    two_people: 0,
    by_path: {},
  };
  const live = liveDecisions(ledger);
  out.undone_or_replaced = ledger.filter((row) => row.type === 'decision').length - live.size;
  for (const row of live.values()) {
    if (row.answer === 'unsure') {
      out.not_sure += 1;
      continue;
    }
    out.live_clicks += 1;
    if (row.answer in out.answers) out.answers[row.answer] += 1;
    const pathName = namingPath(row.prior_identity);
    const tally = (out.by_path[pathName] ||= { clicks: 0, right: 0, wrong: 0, two_people: 0 });
    tally.clicks += 1;
    if (row.answer === 'two_people') {
      out.two_people += 1;
      tally.two_people += 1;
    } else if (row.person_id && sameCanonicalPerson(row.prior_identity?.person_id, row.person_id, aliases)) {
      out.label_right += 1;
      tally.right += 1;
    } else {
      out.label_wrong += 1;
      tally.wrong += 1;
    }
  }
  return out;
}

function run({ dataDir = process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data'), write = false, now = new Date() } = {}) {
  const paths = queuePaths(dataDir);
  const vp = path.dirname(paths.decisions);
  const registry = readJsonQuiet(path.join(dataDir, 'life-archive', 'voice-identity-registry.json')) || {};
  const corrections = {};
  for (const row of registry.manual_corrections || []) {
    const type = String(row?.type || 'none');
    corrections[type] = (corrections[type] || 0) + 1;
  }
  const fit = readJsonQuiet(path.join(vp, 'voice-sample-fit-check-latest.json'));
  const report = {
    schema: 'voice_naming_scorecard.v1',
    generated_at: now.toISOString(),
    ...score(readLedger(paths.decisions), registry.person_id_aliases),
    registry_corrections: corrections,
    sample_fit_flagged: fit ? Number(fit.flagged_count || 0) : null,
  };
  if (write) saveJsonAtomic(path.join(vp, 'voice-naming-scorecard-latest.json'), report);
  return report;
}

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(run({ write: process.argv.includes('--write') }), null, 2)}\n`);
}

module.exports = { namingPath, run, score };
