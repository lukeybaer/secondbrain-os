#!/usr/bin/env node
'use strict';

/**
 * Dispatch the orphaned name-judge targets that could NOT be recovered for free.
 *
 * A "re-judge" verdict sitting in an artifact is not a repair. Without this the
 * targets wait for the resolver's recency window, which their old calls can
 * never satisfy, so the proposal stays invisible exactly as before. This turns
 * the verdict into an actual resolver run, in durable batches, from every path
 * that publishes new cluster membership.
 *
 * It is deliberately its own entry point rather than inline logic in the two
 * pipelines, so both the full rebuild and the routine post-ingest path get the
 * identical behavior and neither can drift.
 *
 * Usage:
 *   node scripts/voice-name-judge-orphan-rejudge.js [--batch 20] [--max 200] [--dry-run] [--rescan-first]
 *
 * --rescan-first runs the orphan report before dispatching, for the scheduled
 * owner that has no fresh targets file from a pipeline run.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadJudgmentsByTarget } = require('./lib/voice-name-judge-orphans.js');
const { fingerprintCluster } = require('./lib/voice-name-judge-coverage.js');

const ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(ROOT, 'data'));
const TARGETS_PATH = path.join(DATA_ROOT, 'agent', 'voice-name-judge-rejudge-targets.json');
const STATE_PATH = path.join(DATA_ROOT, 'agent', 'voice-name-judge-rejudge-state.json');
const VP_DIR = path.join(DATA_ROOT, 'life-archive', 'voiceprints');
const RECLUSTER_PATH = path.join(VP_DIR, 'recluster-latest.json');
const JUDGE_DIR = path.join(VP_DIR, 'llm-name-judges');
const QUEUE_PUBLICATION_PATH = path.join(DATA_ROOT, 'agent', 'voice-name-judge-queue-publication.json');

/**
 * Targets that now resolve under their CURRENT cluster fingerprint.
 *
 * The resolver exits 0 even when individual targets failed, so its exit code is
 * not evidence that a target was repaired. The only honest receipt is the
 * artifact: a target counts as done when a judgment for it exists under the
 * fingerprint its cluster carries now. Anything else stays pending, because
 * durable state claiming "dispatched" for a target that silently failed would
 * strand it permanently, which is the exact defect this whole change exists to
 * remove.
 */
function repairedTargets(candidates = [], deps = {}) {
  const wanted = new Set(candidates.map(String));
  if (!wanted.size) return new Set();
  const recluster = deps.recluster || readJson(RECLUSTER_PATH, { clusters: [] });
  const judgments = loadJudgmentsByTarget(deps.judgeDir || JUDGE_DIR);
  const clusterById = new Map(
    (recluster?.clusters || []).map((entry) => [String(entry?.cluster_id || ''), entry]),
  );
  const repaired = new Set();
  for (const target of wanted) {
    // POSITIVE proof only. "Not in the orphan list" is not evidence of repair:
    // a target with no judgment at all is also not in that list, and a target
    // whose cluster vanished is not in it either. The only thing that proves a
    // re-judge landed is a complete judgment recorded under the fingerprint the
    // cluster carries right now. Anything else stays pending, because marking a
    // silent failure as dispatched is exactly the permanent stranding this
    // whole change exists to remove.
    const cluster = clusterById.get(target);
    if (!cluster) continue;
    const currentFingerprint = fingerprintCluster(cluster);
    if (!currentFingerprint) continue;
    const entries = judgments.get(target) || [];
    if (entries.some((entry) => entry.fingerprint === currentFingerprint)) {
      repaired.add(target);
    }
  }
  return repaired;
}

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

/**
 * Targets still owed a re-judge, minus the ones already dispatched for this
 * recluster run. Progress is recorded per run id, so a rebuild that is
 * interrupted resumes instead of restarting, and a new recluster starts clean.
 */
function pendingTargets({ targetsPath = TARGETS_PATH, statePath = STATE_PATH } = {}) {
  const file = readJson(targetsPath, null);
  if (!file) return { runId: '', targets: [], done: [] };
  const runId = String(file.recluster_run_id || '');
  const state = readJson(statePath, {});
  const done = String(state.recluster_run_id || '') === runId ? state.dispatched || [] : [];
  const doneSet = new Set(done);
  const targets = [...new Set((file.targets || []).map(String).filter(Boolean))].filter(
    (target) => !doneSet.has(target),
  );
  return { runId, targets, done };
}

function recordDispatched({ runId, dispatched, statePath = STATE_PATH }) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    `${JSON.stringify({ recluster_run_id: runId, dispatched, updated_at: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
}

// A child that could not start, was killed, or exited non-zero is a failure
// the caller must see, never a silent success (Codex review 70a5b911753e).
function runChild(script, args = [], deps = {}) {
  const result =
    (deps.spawnSync || spawnSync)(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    }) || {};
  if (result.error) return { ok: false, detail: `${script} could not start: ${result.error.message}` };
  if (result.signal) return { ok: false, detail: `${script} was killed by ${result.signal}` };
  if (result.status !== 0) return { ok: false, detail: `${script} exited ${result.status}` };
  return { ok: true, detail: '' };
}

function runOrphanReport(deps = {}) {
  return runChild('voice-name-judge-orphan-report.js', ['--apply'], deps);
}

/**
 * One dispatch round. Returns { work, verified, stopped }. `skip` holds
 * targets an earlier round of this invocation already attempted, so a target
 * the judge could not repair is not paid for twice in one run. `budget` is
 * what is left of the invocation-wide --max.
 */
function main({ skip = new Set(), budget = Infinity, failures = [] } = {}) {
  const batchSize = Math.max(1, Number(arg('--batch', '20')) || 20);
  const dryRun = process.argv.includes('--dry-run');
  const pending = pendingTargets();
  const { runId, done } = pending;
  const targets = pending.targets.filter((target) => !skip.has(target));
  if (!targets.length) {
    process.stdout.write(
      `no orphaned targets owed a re-judge for recluster ${runId || 'unknown'}\n`,
    );
    return { work: [], verified: 0, stopped: false };
  }
  const work = targets.slice(0, Math.max(0, budget));
  const dispatched = [...done];
  for (let i = 0; i < work.length; i += batchSize) {
    const batch = work.slice(i, i + batchSize);
    process.stdout.write(
      `re-judging ${batch.length} orphaned targets (${i + batch.length}/${work.length})\n`,
    );
    if (!dryRun) {
      const result = spawnSync(
        process.execPath,
        [
          path.join(ROOT, 'scripts', 'voice-identity-overnight-name-resolver.js'),
          '--unknown-only',
          '--targets',
          batch.join(','),
          '--status-scope',
          'orphan-rejudge',
          '--resume-existing',
          // Precompleted means what the orphan report means by resolved: a
          // judgment under the cluster's current whole-cluster fingerprint.
          '--resume-current-fingerprint-only',
          '--concurrency',
          '2',
          '--batch-size',
          '1',
          '--no-refresh',
        ],
        {
          cwd: ROOT,
          stdio: 'inherit',
          // No forced rung order: the brain switch (Claude first, Codex
          // fallback) decides unless the caller set an explicit override,
          // per ExampleCo 2026-09-22 (never pin a single model).
          env: { ...process.env },
        },
      );
      // A failing batch stops the run rather than burning the rest of the night
      // on the same fault, and everything already REPAIRED stays recorded so the
      // next pass resumes instead of repeating.
      if (result.status !== 0) {
        const kept = [...dispatched, ...repairedTargets(batch)];
        recordDispatched({ runId, dispatched: kept });
        process.stdout.write(`resolver exited ${result.status}; stopping and keeping progress\n`);
        failures.push(`name resolver exited ${result.status}`);
        return { work: work.slice(0, i + batch.length), verified: kept.length - done.length, stopped: true };
      }
    }
    // Only targets that actually resolve now are recorded. A resolver exit code
    // of 0 is not proof that a target was repaired.
    const repaired = dryRun ? batch : [...repairedTargets(batch)];
    const failed = batch.length - repaired.length;
    if (failed) {
      process.stdout.write(`${failed} of ${batch.length} still orphaned after the pass, staying pending\n`);
    }
    dispatched.push(...repaired);
  }
  if (!dryRun) recordDispatched({ runId, dispatched });
  // Remaining is computed from what was actually REPAIRED, not from what was
  // attempted. Reporting "none remaining" off the attempted count is how a run
  // that fixed nothing still reads like success.
  const verified = dispatched.length - done.length;
  const remaining = targets.length - verified;
  process.stdout.write(
    `attempted ${work.length}, verified repaired ${verified}, for recluster ${runId || 'unknown'}${remaining > 0 ? `, ${remaining} still owed a re-judge` : ', none remaining'}\n`,
  );
  // Re-scan so System Health describes the world AFTER the repair. Without this
  // a successful re-judge leaves the board red on pre-repair counts.
  //
  // Pass --apply so that any SAME_MEMBERSHIP orphans whose fresh judgments now
  // carry member_track_keys (from the fix that makes re-key provable) are
  // immediately recovered in this same pass. Without --apply the re-key window
  // stays open until the next separate recovery run, which means a recluster
  // that runs between the re-judge and that separate run can re-orphan the
  // cluster before it ever reaches the board as clean.
  if (!dryRun) {
    const rescan = runOrphanReport();
    if (!rescan.ok) {
      failures.push(`post-dispatch orphan re-scan failed: ${rescan.detail}`);
      return { work, verified, stopped: true };
    }
  }
  return { work, verified, stopped: false };
}

/**
 * REBUILD THE QUEUE once per invocation, after the repairs are verified. A
 * re-judged proposal that never reaches the review surface has not been
 * recovered in any sense ExampleCo would recognise. A failed rebuild is durable:
 * the pending flag makes every later run retry it, even one with no re-judge
 * targets left, so the names cannot be judged and then silently never shown.
 */
function publishQueueIfOwed({ repaired, statePath = QUEUE_PUBLICATION_PATH, deps = {} } = {}) {
  const prior = readJson(statePath, {}) || {};
  if (!repaired && !prior.pending) return { ok: true, skipped: true, detail: '' };
  process.stdout.write('rebuilding the voice confirmation queue so the recovered names reach the review surface\n');
  const build = runChild('voice-confirmation-queue-build.js', ['--write'], deps);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    `${JSON.stringify({ pending: !build.ok, detail: build.detail, updated_at: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  return build;
}

// 2026-09-29: unknown_voice_ecapa_46932f329d91715f (16 calls, last judged on
// 7) was never re-judged. An attended 11:50 CT pass dispatched the targets file
// it found, then its own post-pass re-scan listed five newly grown clusters and
// the run exited. Nothing scheduled on EC2 ran this script again (the Fargate
// tail defers it), so those targets sat in a file nobody read. Targets the
// re-scan surfaces are dispatched in the same run, bounded so a recluster that
// keeps moving cannot loop forever.
const MAX_DISPATCH_ROUNDS = 3;

// --max bounds the whole invocation, not each round, so follow-up rounds can
// never multiply the judge spend (Codex review 70a5b911753e).
function dispatchRounds({ dispatch, maxRounds = MAX_DISPATCH_ROUNDS, maxTargets = Infinity } = {}) {
  const attempted = new Set();
  let remaining = maxTargets;
  let verified = 0;
  for (let round = 0; round < maxRounds && remaining > 0; round += 1) {
    const result = dispatch({ skip: new Set(attempted), budget: remaining }) || {};
    const work = result.work || [];
    verified += Number(result.verified || 0);
    if (!work.length) break;
    for (const target of work) attempted.add(target);
    remaining -= work.length;
    if (result.stopped) break;
  }
  return { attempted: [...attempted], verified };
}

function run() {
  const dryRun = process.argv.includes('--dry-run');
  // The scheduled owner passes --rescan-first; its receipt must go red when
  // any step failed. Pipeline callers keep exit 0 (see below).
  const scheduled = process.argv.includes('--rescan-first');
  const failures = [];
  if (scheduled && !dryRun) {
    const rescan = runOrphanReport();
    if (!rescan.ok) failures.push(`orphan re-scan before dispatch failed: ${rescan.detail}`);
  }
  const maxTargets = Math.max(1, Number(arg('--max', '200')) || 200);
  const result = dispatchRounds({ dispatch: (round) => main({ ...round, failures }), maxTargets });
  if (!dryRun) {
    const published = publishQueueIfOwed({ repaired: result.verified > 0 });
    if (!published.ok) {
      failures.push(`queue rebuild failed (${published.detail}); the names are judged but not yet on the card`);
    }
  }
  for (const failure of failures) process.stdout.write(`orphan re-judge failure: ${failure}\n`);
  if (failures.length && scheduled) process.exitCode = 1;
  return { ...result, failures };
}

// This runs inside two pipelines that both rebuild ExampleCo's review queue right
// after it. A recovery that could not finish must never be the reason the queue
// does not get rebuilt, so failures are reported in the artifact and on stdout
// and the process still exits 0. The red System Health row is what escalates,
// not a broken pipeline.
if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stdout.write(`orphan re-judge dispatch failed: ${error?.message || error}\n`);
    if (process.argv.includes('--rescan-first')) process.exitCode = 1;
  }
}

module.exports = {
  dispatchRounds,
  publishQueueIfOwed,
  runChild,
  QUEUE_PUBLICATION_PATH,
  pendingTargets,
  recordDispatched,
  repairedTargets,
  MAX_DISPATCH_ROUNDS,
  TARGETS_PATH,
  STATE_PATH,
};
