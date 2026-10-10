#!/usr/bin/env node
'use strict';

/**
 * Orphaned name-judge report and recovery.
 *
 * Counts, from the artifacts themselves, every completed name proposal that no
 * longer resolves to its cluster because a recluster moved the membership
 * fingerprint, and splits them into what can be recovered from evidence we
 * already own versus what genuinely has to be re-judged.
 *
 * With --apply it also performs the free half of the recovery: every judgment
 * that still covers its cluster exactly is rewritten under the cluster's
 * current fingerprint, so the ordinary exact-key lookup in the queue builder
 * finds it again with no model spend and no change to the admissibility bar.
 *
 * The artifact it writes is the input to the SYSTEM HEALTH row
 * `Voice name-judge orphans`, so a future recluster that strands proposals
 * turns the board red instead of deferring in silence.
 *
 * Usage:
 *   node scripts/voice-name-judge-orphan-report.js               # count only
 *   node scripts/voice-name-judge-orphan-report.js --apply       # count + re-key
 *   node scripts/voice-name-judge-orphan-report.js --json
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const {
  ACTION,
  buildRecoveredJudgeReport,
  classifyOrphanedNameJudgments,
  numericJudgeConfidence,
  readOrphanBaseline,
} = require('./lib/voice-name-judge-orphans.js');
const {
  recentUnknownTargetIdsFromArtifacts,
} = require('./lib/otter-speaker-hypothesis-projection.js');

const ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(ROOT, 'data'));
const VP_DIR = path.join(DATA_ROOT, 'life-archive', 'voiceprints');
const RECLUSTER_PATH = path.join(VP_DIR, 'recluster-latest.json');
const ROSTER_PATH = path.join(VP_DIR, 'otter-call-speaker-rosters-latest.json');
const JUDGE_DIR = path.join(VP_DIR, 'llm-name-judges');
const ENRICHED_DIR = path.join(DATA_ROOT, 'otter', 'enriched');
const CONTACTS_DIR = path.join(ROOT, 'memory', 'contacts');
const OUT_PATH = path.join(DATA_ROOT, 'agent', 'voice-name-judge-orphans-latest.json');
const BASELINE_PATH = path.join(DATA_ROOT, 'agent', 'voice-name-judge-orphan-baseline.json');

/**
 * Write through a temp file and rename, so a crash mid-write can never leave a
 * truncated artifact that a later run would read as "no baseline" and re-seed
 * from whatever is stranded at that moment.
 */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}
const REJUDGE_TARGETS_PATH = path.join(DATA_ROOT, 'agent', 'voice-name-judge-rejudge-targets.json');

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

function reclusterSourceReceipt(file, fallback = null) {
  try {
    const bytes = fs.readFileSync(file);
    return {
      value: JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    return { value: fallback, sha256: '' };
  }
}

function releaseShaFromDeployReceipt(receipt) {
  return String(
    receipt?.sha ||
      receipt?.release_sha ||
      receipt?.repoHead ||
      receipt?.originMasterHead ||
      receipt?.commit ||
      '',
  ).trim();
}

/**
 * The release this box is actually running. Read from the deployed release
 * receipt so the baseline records the build it was taken against, not whatever
 * a developer checkout happens to be on.
 */
function currentReleaseSha() {
  // An EC2 release is built with `git archive` and carries no .git directory, so
  // `git rev-parse` answers nothing there. The authoritative record on the box is
  // the mirrored deploy receipt, so that is read FIRST and the git fallback is
  // only for a developer checkout.
  try {
    const lines = fs
      .readFileSync(path.join(DATA_ROOT, 'agent', 'ec2-deploy-receipts.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const receipt = JSON.parse(lines[i]);
        const sha = releaseShaFromDeployReceipt(receipt);
        if (sha) return sha;
      } catch {
        // a malformed line is not a reason to stop looking
      }
    }
  } catch {
    // no receipt mirror here, fall through
  }
  for (const candidate of [
    path.join(ROOT, 'RELEASE_SHA'),
    path.join(ROOT, '.release-sha'),
    path.join(DATA_ROOT, 'agent', 'release-sha.txt'),
  ]) {
    try {
      const value = fs.readFileSync(candidate, 'utf8').trim();
      if (value) return value;
    } catch {
      // try the next candidate
    }
  }
  try {
    return require('child_process')
      .execSync('git rev-parse HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function slug(value) {
  return String(value || 'target')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/**
 * First names that already have a People file. Reported only so ExampleCo can see
 * how many stranded names point at somebody he already knows. It never links a
 * cluster to a person, which stays a confirmation decision he makes.
 */
function knownFirstNames(contactsDir = CONTACTS_DIR) {
  const names = new Set();
  let files = [];
  try {
    files = fs.readdirSync(contactsDir);
  } catch {
    return names;
  }
  for (const file of files) {
    if (!file.endsWith('.md') || file === 'INDEX.md') continue;
    const first = file.replace(/\.md$/i, '').split('_')[0];
    if (first) names.add(first.toLowerCase());
  }
  return names;
}

function buildReport({ recentDays = 7 } = {}) {
  const reclusterSource = reclusterSourceReceipt(RECLUSTER_PATH, { clusters: [] });
  const recluster = reclusterSource.value;
  const roster = readJson(ROSTER_PATH, { calls: [] });
  const recent = recentUnknownTargetIdsFromArtifacts({ recluster, roster, days: recentDays });
  const {
    counts,
    orphans,
    grownWithoutProposal,
    judgments,
    missingClusterTargets,
    unresolvableTargets,
    lineageBlockedTargets,
  } = classifyOrphanedNameJudgments({
    recluster,
    judgeDir: JUDGE_DIR,
    enrichedDir: ENRICHED_DIR,
    recentTargetIds: recent.ids,
  });
  const people = knownFirstNames();
  for (const orphan of orphans) {
    orphan.has_people_file = people.has(String(orphan.best_name || '').toLowerCase());
  }
  const confident = orphans.filter(
    (row) => numericJudgeConfidence(row.confidence) >= 0.9 && row.counterevidence_count === 0,
  );
  // The baseline is its OWN durable receipt, established once and never rewritten
  // by a later scan. It deliberately does not live in this report: losing or
  // truncating the report would then re-seed it from whatever is stranded at that
  // moment, quietly relabelling a fresh regression as known backlog.
  const existingBaseline = readOrphanBaseline({ baselinePath: BASELINE_PATH });
  const currentTargets = [
    ...orphans.map((row) => String(row.target)),
    ...missingClusterTargets.map((row) => String(row.target)),
    // Unresolvable retired targets are NOT eligible for the baseline. Nothing
    // that a human still has to adjudicate may ever be filed as "known backlog
    // being worked", because nothing is working on it.
  ];
  const baselineCohort = existingBaseline.present ? existingBaseline.cohort : [];
  const remaining = currentTargets.filter((target) => baselineCohort.includes(target)).length;
  if (existingBaseline.present) {
    // last_progress_at moves only on a STRICT shrink. Stall is measured from
    // real progress, so a backlog that drops by one and then freezes still
    // trips.
    const shrank =
      existingBaseline.last_remaining != null && remaining < existingBaseline.last_remaining;
    // The anchors are carried through untouched. Dropping them here would make
    // the reader reject the very baseline that was just initialized, on the very
    // next scan, and the row would fall back to the survey state forever.
    writeJsonAtomic(
      BASELINE_PATH,
      baselineUpdatePayload({
        existing: existingBaseline,
        cohort: baselineCohort,
        remaining,
        shrank,
        initialCount: Number(readJson(BASELINE_PATH, {})?.initial_count ?? baselineCohort.length),
        unresolvable: unresolvableTargets.length,
      }),
    );
  }
  // An ordinary run NEVER creates a baseline. Recreating it from whatever is
  // stranded right now is exactly how a lost receipt would relabel a fresh
  // regression as known backlog, and the health row would never see the loss
  // because the producer had already papered over it. A missing receipt stays
  // missing, health stays red, and only an explicit one-time
  // --init-baseline run may create it.
  const report = {
    schema: 'voice_name_judge_orphans.v1',
    generated_at: new Date().toISOString(),
    baseline_receipt: BASELINE_PATH,
    baseline_cohort_size: baselineCohort.length,
    baseline_remaining: remaining,
    // The scan is bound to the recluster it read. System Health compares this
    // with the live recluster and goes red on a mismatch, so a recluster that
    // strands new proposals can never sit behind a stale green.
    recluster_run_id: String(recluster?.run_id || ''),
    recluster_generated_at: String(recluster?.generated_at || ''),
    recluster_sha256: reclusterSource.sha256,
    recent_days: recentDays,
    recent_cutoff_date: recent.cutoffDate,
    counts: {
      ...counts,
      // Exact current-window denominator. A current unknown cluster belongs to
      // this set when the source inventory proves that at least one call in the
      // cluster falls inside the requested recent window. The lifetime metric
      // remains separate and does not borrow this severity.
      past_week_orphaned_with_admissible_proposal: orphans.filter(
        (row) => row.outside_recency_window === false,
      ).length,
      high_confidence_zero_counterevidence: confident.length,
      weaker_proposals: counts.orphaned_with_admissible_proposal - confident.length,
      names_with_existing_people_file: orphans.filter((row) => row.has_people_file).length,
    },
    by_relation: orphans.reduce((acc, row) => {
      acc[row.relation] = (acc[row.relation] || 0) + 1;
      return acc;
    }, {}),
    orphans,
    judgments_for_missing_clusters: missingClusterTargets,
    // Named rows, not just a count. A number nobody can attribute cannot be told
    // apart from new stranding, and cannot be handed to anyone to fix.
    retired_targets_unresolvable_rows: unresolvableTargets,
    // Named, not just counted. A defect nobody can point at is a defect nobody
    // fixes, and this one needs a worker built for it.
    retired_targets_lineage_blocked_rows: lineageBlockedTargets,
    grown_without_proposal: grownWithoutProposal,
  };
  return { report, recluster, judgments };
}

/**
 * Targets the judge has to look at again: everything that could not be re-keyed.
 * Written where the rebuild wrapper can hand it straight to the resolver, so a
 * re-judge verdict is an actual dispatch and not a label in a report nobody
 * reads.
 */
function rejudgeTargets(report) {
  const targets = [
    ...report.orphans.filter((row) => row.action !== ACTION.REKEY).map((row) => row.target),
    // Grown clusters whose stale judgment found no name get a fresh look.
    ...(report.grown_without_proposal || []).map((row) => row.target),
    // A retired id is not dispatchable: the resolver only accepts cluster ids
    // that exist today, so send the unknown cluster that now holds those calls.
    ...(report.judgments_for_missing_clusters || []).flatMap(
      (row) => row.rejudge_targets || [],
    ),
  ];
  // Unresolvable rows are deliberately NOT dispatched. Call-level evidence
  // cannot say which voice they became, so re-judging one would pick a speaker
  // at random. They stay named in the artifact and red on the board until a
  // lineage-aware pass or ExampleCo resolves them.
  return [...new Set(targets)];
}

/**
 * Write the recovered judgments. Only ACTION.REKEY qualifies, so every artifact
 * written here is a verbatim copy of evidence that still covers exactly the
 * cluster it is being re-keyed onto.
 */
function applyRecoveries({ report, recluster, judgments }) {
  const clusterById = new Map(
    (recluster?.clusters || []).map((cluster) => [String(cluster?.cluster_id || ''), cluster]),
  );
  const written = [];
  for (const orphan of report.orphans) {
    if (orphan.action !== ACTION.REKEY) continue;
    const cluster = clusterById.get(orphan.target);
    const entries = judgments.get(orphan.target) || [];
    const entry = entries.find(
      (candidate) =>
        candidate.fingerprint === orphan.judged_input_fingerprint &&
        candidate.artifact === orphan.artifact,
    );
    if (!cluster || !entry) continue;
    const recovered = buildRecoveredJudgeReport({
      entry,
      cluster,
      currentFingerprint: orphan.current_input_fingerprint,
      generatedAt: report.generated_at,
    });
    const file = path.join(JUDGE_DIR, `name-judge-recovered-${slug(orphan.target)}.json`);
    fs.mkdirSync(JUDGE_DIR, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(recovered, null, 2)}\n`, 'utf8');
    written.push({ target: orphan.target, best_name: orphan.best_name, file });
    orphan.recovered_artifact = file;
  }
  return written;
}

/**
 * Recovery has always rescanned once after writing recovered artifacts, so the
 * published counts describe the world the health row will read rather than the
 * world before the repair. That single before/after pass silently assumed the
 * recluster held still across both reads.
 *
 * It does not: `data/life-archive/voiceprints/recluster-latest.json` is
 * rewritten independently and often, by the overnight name resolver, while
 * this scan is busy reading a judge directory of thousands of artifacts. When
 * the recluster moves between the initial build and the rescan, the recovered
 * judge artifacts just written on disk were re-keyed onto a cluster fingerprint
 * that is already the PRIOR generation by the time the rescan reads a newer
 * one, so the published report can describe a snapshot that its own just-written
 * recoveries do not actually match, and the exact past-week health check (which
 * requires the report's bound recluster id and SHA-256 to equal the live file)
 * goes red on a self-inflicted mismatch instead of a real orphan.
 *
 * This loops the build-apply-rescan cycle until the recluster snapshot used for
 * the recovered artifacts equals the recluster snapshot the rescan reports
 * against, or a bounded attempt budget is spent. A budget, not an infinite
 * loop, because a recluster that never stops moving is a fact the health row
 * has to see, not something this producer can spin its way out of.
 */
function applyWithConvergence({ recentDays, initial, maxAttempts = 3, build = buildReport }) {
  let built = initial || build({ recentDays });
  let written = [];
  let report = built.report;
  let stable = false;
  let attempts = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    attempts = attempt + 1;
    written = applyRecoveries(built);
    const after = build({ recentDays });
    after.report.counts_before_recovery = built.report.counts;
    report = after.report;
    stable =
      after.report.recluster_run_id === built.report.recluster_run_id &&
      after.report.recluster_sha256 === built.report.recluster_sha256;
    if (stable) break;
    // The recluster moved during this cycle. The recoveries just written are
    // keyed to a snapshot that is no longer current, so redo the whole
    // build-apply pass against the fresh one instead of publishing a report
    // that is already inconsistent with its own recovered artifacts.
    built = after;
  }
  report.recluster_convergence_attempts = attempts;
  report.recluster_stable = stable;
  return { report, written, attempts, stable };
}

/**
 * One-time baseline initialization. Deliberately a separate, explicit mode.
 *
 * Uses exclusive creation, so it can never overwrite an existing receipt even
 * if two runs race. That is what makes "the baseline was established once" a
 * property of the filesystem rather than a promise in a comment.
 */
function initBaseline({ cohort, unresolvable = [], releaseSha = '', reclusterRunId = '' }) {
  const eligible = cohort.filter((target) => !unresolvable.includes(target));
  // The cohort is only meaningful as "everything stranded as of THIS build and
  // THIS clustering". Without both, "stranded since the baseline" is an
  // assertion rather than something the artifact can prove, so the reader
  // refuses a baseline that lacks either.
  const sha = String(releaseSha || currentReleaseSha() || '').trim();
  const runId = String(reclusterRunId || '').trim();
  if (!sha || !runId) {
    return {
      created: false,
      reason: `cannot anchor the baseline: ${!sha ? 'no release SHA' : 'no recluster run id'}`,
    };
  }
  const payload = {
    schema: 'voice_name_judge_orphan_baseline.v1',
    cohort: eligible,
    initialized_at: new Date().toISOString(),
    release_sha: sha,
    recluster_run_id: runId,
    initial_count: eligible.length,
    last_remaining: eligible.length,
    last_progress_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  try {
    // wx: fail if it already exists. No CAS window, no silent overwrite.
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return { created: true, count: eligible.length };
  } catch (error) {
    if (error?.code === 'EEXIST') return { created: false, reason: 'a baseline receipt already exists' };
    throw error;
  }
}

/**
 * The baseline record after an ordinary scan.
 *
 * The anchors are carried through UNTOUCHED. Dropping them here made the reader
 * reject the very baseline that had just been initialized, on the very next
 * scan, so the row fell back to the survey state forever and no stranding could
 * ever be called new. Extracted so that property is directly testable rather
 * than only reachable through a full data directory.
 */
function baselineUpdatePayload({ existing, cohort, remaining, shrank, initialCount, unresolvable = 0 }) {
  return {
    schema: 'voice_name_judge_orphan_baseline.v1',
    cohort,
    initialized_at: existing.initialized_at,
    release_sha: existing.release_sha,
    recluster_run_id: existing.recluster_run_id,
    initial_count: initialCount,
    last_remaining: remaining,
    last_unresolvable: unresolvable,
    last_progress_at: shrank ? new Date().toISOString() : existing.last_progress_at,
  };
}

function main() {
  const recentDays = Number(arg('--recent-days', '7')) || 7;
  const limit = Number(arg('--limit', '40')) || 40;
  const apply = process.argv.includes('--apply');
  const built = buildReport({ recentDays });
  if (process.argv.includes('--init-baseline')) {
    const cohort = [
      ...built.report.orphans.map((row) => String(row.target)),
      ...(built.report.judgments_for_missing_clusters || []).map((row) => String(row.target)),
    ];
    const unresolvable = (built.report.retired_targets_unresolvable_rows || []).map((row) =>
      String(row.target),
    );
    const result = initBaseline({
      cohort,
      unresolvable,
      reclusterRunId: built.report.recluster_run_id,
    });
    process.stdout.write(
      result.created
        ? `baseline established with ${result.count} known stranded proposals at ${BASELINE_PATH}\n`
        : `baseline NOT created: ${result.reason}\n`,
    );
    // "Already exists" is the intended outcome of a second run. Anything else is
    // a real failure to anchor, and exiting zero on it would let a deploy report
    // success while the baseline silently does not exist.
    if (!result.created && !/already exists/i.test(String(result.reason || ''))) {
      process.exitCode = 1;
    }
  }
  let report = built.report;
  let written = [];
  if (apply) {
    // Re-scan after writing, looping until the recluster snapshot the
    // recoveries were keyed against matches the snapshot the final report
    // describes, or the attempt budget runs out. A single before/after pass
    // silently assumed the recluster held still across both reads; it does
    // not, because the overnight resolver rewrites it independently.
    const converged = applyWithConvergence({ recentDays, initial: built });
    written = converged.written;
    report = converged.report;
  }
  report.recovered_artifacts_written = written.length;
  report.applied = apply;
  report.rejudge_targets = rejudgeTargets(report);
  writeJsonAtomic(OUT_PATH, report);
  // A separate, tiny file so the rebuild wrapper can hand these straight to the
  // resolver. A re-judge verdict has to become a dispatch, otherwise it is just
  // a word in a report.
  writeJsonAtomic(REJUDGE_TARGETS_PATH, {
    generated_at: report.generated_at,
    recluster_run_id: report.recluster_run_id,
    targets: report.rejudge_targets,
  });
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report.counts, null, 2)}\n`);
    return;
  }
  const c = report.counts;
  const lines = [
    `unknown clusters scanned              ${c.clusters_scanned}`,
    `clusters with any judgment on disk    ${c.targets_with_any_judgment}`,
    `resolve under current fingerprint     ${c.resolves_under_current_fingerprint}`,
    `ORPHANED clusters                     ${c.orphaned_targets}`,
    `  carrying a usable proposal          ${c.orphaned_with_admissible_proposal}`,
    `    high confidence, 0 counter        ${c.high_confidence_zero_counterevidence}`,
    `    weaker                            ${c.weaker_proposals}`,
    `    name has a People file            ${c.names_with_existing_people_file}`,
    `    outside recency, never revisited  ${c.outside_recency_window}`,
    `  judged but no admissible name       ${c.orphaned_without_admissible_proposal}`,
    `RE-KEYABLE now, no model spend        ${c.rekeyable}`,
    `SURFACEABLE with a coverage gap       ${c.surfaceable}`,
    `NEEDS re-judge                        ${c.needs_rejudge}`,
    `judgments whose cluster id is gone    ${c.judgments_for_missing_clusters}`,
    `re-judge targets dispatched           ${report.rejudge_targets.length}`,
    `by relation                           ${JSON.stringify(report.by_relation)}`,
    `recovered artifacts written           ${written.length}${apply ? '' : ' (dry run, pass --apply)'}`,
    `written                               ${OUT_PATH}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n\n`);
  for (const row of report.orphans.slice(0, limit)) {
    process.stdout.write(
      `${String(row.action).padEnd(8)} ${String(row.best_name).padEnd(14)} ` +
        `conf=${String(row.confidence).padEnd(12)} ev=${row.clear_evidence_count} ` +
        `counter=${row.counterevidence_count} ${row.relation} ` +
        `calls ${row.judged_call_count}->${row.current_call_count} ` +
        `people_file=${row.has_people_file} ${row.target}\n`,
    );
  }
}

if (require.main === module) main();

module.exports = {
  BASELINE_PATH,
  baselineUpdatePayload,
  buildReport,
  initBaseline,
  applyRecoveries,
  applyWithConvergence,
  knownFirstNames,
  releaseShaFromDeployReceipt,
  reclusterSourceReceipt,
  rejudgeTargets,
  OUT_PATH,
  REJUDGE_TARGETS_PATH,
};
