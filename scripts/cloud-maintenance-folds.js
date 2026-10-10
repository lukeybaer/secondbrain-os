#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// phase (Oct 5 night): 'pre-board' runs before the 11 PM production because
// System Health's Gravity row reads tonight's dated receipts in the first
// pass. 'post-board' has no first-pass reader (tests-blocked.json is read at
// any age, canaries feed the morning diagnostic, the token suggestion is for
// yesterday), so it starts only after production settled and never beside
// the card fan-out.
const ACTIVITIES = Object.freeze({
  'nightly-test-health': { id: 'night-owner-scoped-tests', script: 'scripts/scoped-test-snapshot.js', timeout: 260000, phase: 'post-board' },
  'provider-canaries': { id: 'night-owner-subscription-canaries', script: 'scripts/lib/provider-canary.js', timeout: 130000, phase: 'post-board' },
  'token-reduction-repair': { id: 'night-owner-token-reduction', script: 'scripts/suggest-token-reduction.js', timeout: 130000, phase: 'post-board' },
  // This finite local measurement remains inside the existing night-owner
  // resource/time envelope; do not invent a second per-activity wall deadline.
  // Dated law-evidence receipts the Gravity check reads; must run before it.
  'gravity-evidence': { id: 'night-owner-gravity-evidence', script: 'scripts/gravity-evidence-receipts.js', timeout: 540000, phase: 'pre-board' },
  'gravity-health': { id: 'night-owner-gravity', script: 'scripts/gravity-health.js', phase: 'pre-board' },
});
const PHASES = new Set(['pre-board', 'post-board']);
// No phase means every activity in declared order (receipts make reruns cheap).
function activitiesForPhase(phase) {
  if (phase == null) return Object.keys(ACTIVITIES);
  if (!PHASES.has(phase)) throw new Error(`unknown maintenance phase: ${phase}`);
  return Object.keys(ACTIVITIES).filter(activity => ACTIVITIES[activity].phase === phase);
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const { sourceSha } = require('./lib/runtime-source-sha.js');
function previousDate(date) { return new Date(Date.parse(`${date}T12:00:00Z`) - 86400000).toISOString().slice(0, 10); }
function outputPath(activity, dataDir, date) {
  const agent = path.join(dataDir, 'agent');
  return path.join(agent, activity === 'nightly-test-health' ? 'tests-blocked.json' : activity === 'provider-canaries' ? 'amy-provider-health.jsonl' : activity === 'gravity-health' ? `gravity-health-${date}.json` : activity === 'gravity-evidence' ? `gravity-evidence-${date}.json` : `token-reduction-suggestion-${previousDate(date)}.json`);
}
function validateOutput(activity, row, date) {
  if (activity === 'provider-canaries') return ['claude', 'codex'].every(name => typeof row?.[name] === 'boolean' && row.attempts?.[name]?.attempted === true && /^amy-canary-[a-f0-9]{24}$/.test(row.attempts[name].nonce));
  if (activity === 'nightly-test-health') return row?.scopeMode === 'canonical-core-guards' && row.runnerFailed === false && row.total > 0 && Array.isArray(row.scope) && row.scope.length > 0;
  if (activity === 'gravity-evidence') return row?.schema === 'amy.gravity_evidence_receipts.v1' && row.date === date && Object.keys(row.results || {}).length === 5;
  if (activity === 'gravity-health') return row?.schema === 'amy.gravity_health.v1' && row.date === date && Array.isArray(row.laws) && row.laws.length > 0;
  return row?.date === previousDate(date) && typeof row.suggestion === 'string' && row.suggestion.length > 0 && Object.hasOwn(row, 'diagnostics') && Object.hasOwn(row, 'summary');
}
function runActivity({ activity, date, root, dataDir, run = spawnSync, sha = sourceSha(root), now = Date.now, force = false } = {}) {
  const definition = ACTIVITIES[activity]; if (!definition) throw new Error('unknown maintenance activity');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('exact briefing date required');
  require('./lib/scheduled-write-ownership.js').assertRuntimeDataRoot(dataDir);
  const receiptPath = path.join(dataDir, 'agent', 'cloud-maintenance-folds', date, `${activity}.json`);
  const producerHash = hash(fs.readFileSync(path.join(root, definition.script)));
  if (!force && fs.existsSync(receiptPath)) {
    let prior; try { prior = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); } catch { /* corrupt receipt must be measured again */ }
    if (prior?.source_sha === sha && prior?.producer?.sha256 === producerHash) {
      return { ...prior, reused: true, reuse_reason: 'same-release-and-producer', receiptPath };
    }
  }
  const started = now(); const file = outputPath(activity, dataDir, date);
  const argv = [path.join(root, definition.script)];
  if (activity === 'gravity-health') argv.push(`--date=${date}`, '--json');
  if (activity === 'gravity-evidence') argv.push(`--date=${date}`);
  if (activity === 'token-reduction-repair') argv.push('--date', previousDate(date));
  const result = run(process.execPath, argv, { cwd: root, env: { ...process.env, SECONDBRAIN_DATA_DIR: dataDir, BRIEFING_DATE: date }, ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }), windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  let output = null; let outputHash = null; let error = result.error?.message || null;
  try {
    if (result.error || result.status !== 0) throw new Error(error || `producer exited ${result.status}${result.signal ? ` on ${result.signal}` : ''}`);
    if (fs.statSync(file).mtimeMs < started - 1000) throw new Error('producer left stale output');
    const bytes = fs.readFileSync(file); outputHash = hash(bytes);
    output = JSON.parse(file.endsWith('.jsonl') ? bytes.toString().trim().split(/\r?\n/).pop() : bytes);
    if (!validateOutput(activity, output, date)) throw new Error('native output does not prove the activity ran');
  } catch (failure) { error = failure.message; }
  const receipt = { schema: 'amy.desktop_task_replacement_native_receipt.v1', replacement_id: definition.id,
    activity, receipt_kind: 'cloud-maintenance-owner-receipt', source_sha: sha,
    started_at: new Date(started).toISOString(), completed_at: new Date(now()).toISOString(), ok: !error,
    owner: 'amy-night-run', owner_trigger: process.env.AMY_NIGHT_OWNER || null,
    native_output: { path: file, sha256: outputHash, measured_verdict: output?.status || (output?.failed ? 'red' : output?.source || null), evidence: output },
    producer: { script: definition.script, sha256: producerHash, exit_code: result.status },
    error, business_outcome_required_green: false };
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(`${receiptPath}.${process.pid}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`); fs.renameSync(`${receiptPath}.${process.pid}.tmp`, receiptPath);
  return { ...receipt, receiptPath };
}
if (require.main === module) {
  const args = process.argv.slice(2); const value = name => args[args.indexOf(name) + 1];
  const root = path.resolve(__dirname, '..'); const dataDir = process.env.SECONDBRAIN_DATA_DIR || '/opt/secondbrain/data';
  const date = value('--date'); const activity = args.includes('--activity') ? value('--activity') : null;
  const phase = args.includes('--phase') ? value('--phase') : null;
  const results = (activity ? [activity] : activitiesForPhase(phase)).map(activity => runActivity({ activity, date, root, dataDir, force: args.includes('--force') }));
  console.log(JSON.stringify(results)); process.exitCode = results.every(result => result.ok) ? 0 : 1;
}
module.exports = { ACTIVITIES, activitiesForPhase, outputPath, previousDate, validateOutput, runActivity, sourceSha };
