#!/usr/bin/env node
// memory-consolidation-tier1-hold.js
//
// Tier 1 hold for the weekly memory pass (owner decision). MEMORY.md must not
// grow week over week, but the week's other work grows it and the pass never
// trimmed it back, so a run that met its merge target still went red. The pass
// now rewords the file back to the card's baseline before it scans. This tool
// says how far over it is and checks that the rewording dropped nothing.
//
// Method owner: dev-plans/core/memory-consolidation.md

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { lfByteLength } = require('./memory-md-cap.js');

const REPO = path.resolve(__dirname, '..', '..');

// The corpus the card grades growth against. A re-render of one session keeps
// that session's baseline; a new session compares with the last run's corpus.
// The report and the hold share this, so they cannot disagree.
function growthBaselineCorpus(previousState, reviewSessionId) {
  const sameSession =
    previousState?.review_session_id === reviewSessionId &&
    Object.prototype.hasOwnProperty.call(previousState, 'growth_baseline_corpus');
  return sameSession ? previousState.growth_baseline_corpus : previousState?.corpus || null;
}

// Called before the scan, so the run has no session id yet: always a new session.
function tier1Status(text, previousState) {
  const bytes = lfByteLength(text);
  const baseline = growthBaselineCorpus(previousState, null)?.memory_md_bytes;
  const known = Number.isFinite(baseline);
  return {
    memory_md_bytes: bytes,
    baseline_bytes: known ? baseline : null,
    excess_bytes: known ? Math.max(0, bytes - baseline) : 0,
  };
}

// What a rewording must keep: headings, core-component rows, bold rule labels
// and code spans (file pointers, commands, ids). Wording around them is free.
function tier1Anchors(text) {
  const anchors = new Set();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^#{1,6} /.test(trimmed) || /^[a-z0-9-]+ \| .+ \| \S+$/.test(trimmed)) anchors.add(trimmed);
  }
  for (const match of text.matchAll(/\*\*([^*\n]+)\*\*/g)) anchors.add(match[1]);
  for (const match of text.matchAll(/`([^`\n]+)`/g)) anchors.add(match[1]);
  return anchors;
}

// A pointer to a memory file that is gone or now a redirect stub may leave:
// the hygiene step has to fix dead pointers.
function pointerRetired(anchor, memoryDir) {
  if (!/^[\w.-]+\.md$/.test(anchor)) return false;
  const file = path.join(memoryDir, anchor);
  if (!fs.existsSync(file)) return true;
  return /^stub: true\s*$/m.test(fs.readFileSync(file, 'utf8'));
}

function lostAnchors(before, after, memoryDir) {
  const kept = tier1Anchors(after);
  return [...tier1Anchors(before)].filter((anchor) => !kept.has(anchor) && !pointerRetired(anchor, memoryDir));
}

// The MEMORY.md this run started from: where its worktree left master. HEAD
// moves with any commit the run makes, so it would hide what the run removed.
function runStartTier1(repoRoot) {
  const git = (...args) =>
    execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const base = git('merge-base', 'HEAD', 'origin/master').trim();
  return git('show', `${base}:memory/MEMORY.md`);
}

// The report's backstop for the hold. It refuses when it cannot read the start,
// so an unverified file never passes as a preserved one. A test fixture passes
// its own baseline text.
function requireTier1Structure(repoRoot, memoryDir, baselineText) {
  let before = baselineText;
  if (before === undefined) {
    try {
      before = runStartTier1(repoRoot);
    } catch (error) {
      throw new Error(`cannot read the MEMORY.md this run started from, so nothing proves the rewording kept its rules: ${error.message}`);
    }
  }
  if (!before) return;
  const lost = lostAnchors(before, fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8'), memoryDir);
  if (lost.length) {
    throw new Error(`MEMORY.md lost ${lost.length} rule anchor(s) this run; reword only, restore: ${lost.slice(0, 5).join(' ; ')}`);
  }
}

module.exports = { growthBaselineCorpus, tier1Status, tier1Anchors, lostAnchors, requireTier1Structure };

if (require.main === module) {
  const memoryDir = path.join(REPO, 'memory');
  const text = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  let previousState = null;
  try {
    previousState = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'agent', 'memory-consolidation-state.json'), 'utf8'));
  } catch {
    /* first run, or unreadable prior receipt: no baseline to hold to */
  }
  const out = { ...tier1Status(text, previousState), lost_anchors: [] };
  try {
    out.lost_anchors = lostAnchors(runStartTier1(REPO), text, memoryDir);
  } catch (error) {
    out.baseline_error = error.message;
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(out.excess_bytes === 0 && out.lost_anchors.length === 0 && !out.baseline_error ? 0 : 1);
}
