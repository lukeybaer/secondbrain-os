#!/usr/bin/env node
'use strict';

// scripts/check-deploy-provenance.js
//
// FAIL-CLOSED provenance gate for the EC2 deploy. Called by
// deploy-ec2-server.sh BEFORE the atomic swap, so a stale tree never reaches
// /opt at all.
//
// Why this exists (2026-07-19): deploy-ec2-server.sh took
// `git rev-parse HEAD` and shipped it. Across ~498 lines there was no fetch,
// no comparison to origin/master, and no ancestry check before the swap. Every
// gate it did have was an INTEGRITY check (does the tree load and run), never a
// PROVENANCE check (is this the code we agreed to ship). A deploy shipped sha
// 59d92950 which was BEHIND master, passed every integrity gate, went live, and
// was caught only by a human reading the receipt afterward.
// record-ec2-deploy-receipt.js runs ~100 lines later, AFTER the swap is already
// live, and only WARNS. A warning after the fact is not a gate.
//
// This runs FIRST and exits non-zero, which under `set -e` aborts the deploy
// with /opt untouched.
//
// Override (documented, attended, emergencies only):
//   SB_DEPLOY_ALLOW_STALE_SOURCE=1 bash scripts/deploy-ec2-server.sh
// The override does not silence the finding: the refusal reason is still
// printed as a loud warning and the override is appended to
// data/agent/deploy-provenance-overrides.jsonl so it is auditable.

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { assessDeployProvenance } = require('./lib/deploy-source-freshness.js');
const { relationFromAncestry } = require('./lib/ec2-deploy-receipts.js');

// The DEPLOYING checkout is this script's own repo root, never SECONDBRAIN_ROOT
// (which points at the shared checkout while deploys run from worktrees).
// Same root resolution as record-ec2-deploy-receipt.js and the deploy script.
const REPO = path.resolve(__dirname, '..');
const OVERRIDE_ENV = 'SB_DEPLOY_ALLOW_STALE_SOURCE';

function git(args) {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', timeout: 60000 }).trim();
}

function gitOk(args) {
  try {
    execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', timeout: 60000 });
    return true;
  } catch {
    return false;
  }
}

// Returns '' on success, or the failure reason. The override is only tolerable
// because it is AUDITABLE, so an override that cannot be durably recorded is
// not an override, it is an untraceable stale deploy: refuse it (Codex peer
// review, 2026-07-19).
function recordOverride(result, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      JSON.stringify({
        ts: new Date().toISOString(),
        env: OVERRIDE_ENV,
        code: result.code,
        reason: result.reason,
        relation: result.relation,
        headSha: result.headSha,
        originMasterSha: result.originMasterSha,
      }) + '\n',
    );
    return '';
  } catch (e) {
    return String((e && e.message) || e);
  }
}

function gather() {
  let fetchError = '';
  let resolveError = '';
  let headSha = '';
  let originMasterSha = '';
  let relation = '';

  try {
    // EXPLICIT destination refspec, not `git fetch origin master`. The short
    // form updates FETCH_HEAD and only incidentally updates refs/remotes/
    // origin/master through whatever `remote.origin.fetch` happens to be
    // configured as. A remote whose refspec does not map master would leave
    // origin/master stale, and a stale authority silently turns this gate into
    // a rubber stamp (Codex peer review, 2026-07-19). Force-update the exact
    // ref we are about to compare against.
    git(['fetch', 'origin', '+refs/heads/master:refs/remotes/origin/master', '--quiet']);
  } catch (e) {
    fetchError = String((e && e.message) || e);
    return { fetchError, resolveError, headSha, originMasterSha, relation };
  }

  try {
    headSha = git(['rev-parse', 'HEAD']);
    originMasterSha = git(['rev-parse', 'origin/master']);
  } catch (e) {
    resolveError = String((e && e.message) || e);
    return { fetchError, resolveError, headSha, originMasterSha, relation };
  }

  relation = relationFromAncestry({
    headEqualsMaster: headSha === originMasterSha,
    headIsAncestorOfMaster: gitOk(['merge-base', '--is-ancestor', headSha, originMasterSha]),
    masterIsAncestorOfHead: gitOk(['merge-base', '--is-ancestor', originMasterSha, headSha]),
  });
  return { fetchError, resolveError, headSha, originMasterSha, relation };
}

function main() {
  const overridesFileIdx = process.argv.indexOf('--overrides-file');
  const overridesFile =
    overridesFileIdx > -1
      ? process.argv[overridesFileIdx + 1]
      : path.join(REPO, 'data', 'agent', 'deploy-provenance-overrides.jsonl');

  // The caller passes --emit-sha-file so it can pin the EXACT sha this gate
  // approved. Without that pin the shell would re-run `git rev-parse HEAD`
  // later and could ship a different commit if the ref moved in between
  // (TOCTOU; the worktree lock stops the janitor, not a checkout or reset).
  const shaFileIdx = process.argv.indexOf('--emit-sha-file');
  const shaFile = shaFileIdx > -1 ? process.argv[shaFileIdx + 1] : '';

  const overrideRequested = process.env[OVERRIDE_ENV] === '1';
  const result = assessDeployProvenance({ ...gather(), overrideRequested });

  const emitSha = () => {
    if (!shaFile || !result.headSha) return;
    fs.mkdirSync(path.dirname(path.resolve(shaFile)), { recursive: true });
    fs.writeFileSync(shaFile, String(result.headSha) + '\n');
  };

  if (result.ok && !result.overridden) {
    emitSha();
    process.stdout.write(
      '[deploy-provenance] PASS: deploying ' +
        String(result.headSha).slice(0, 12) +
        ', which IS origin/master (' +
        String(result.originMasterSha).slice(0, 12) +
        ')\n',
    );
    return 0;
  }

  const detail =
    '  deploying sha  : ' +
    String(result.headSha || 'unresolved') +
    '\n  origin/master  : ' +
    String(result.originMasterSha || 'unresolved') +
    '\n  relation       : ' +
    String(result.relation) +
    '\n  reason         : ' +
    String(result.reason) +
    '\n';

  if (result.overridden) {
    const recordError = recordOverride(result, overridesFile);
    if (recordError) {
      process.stderr.write(
        '\n[deploy-provenance] REFUSED (override-unauditable): ' +
          OVERRIDE_ENV +
          '=1 was set, but the override could not be recorded to ' +
          overridesFile +
          ': ' +
          recordError +
          '\n' +
          detail +
          '\nAn override that leaves no audit trail is just an untraceable stale deploy.\n' +
          'Fix the ledger path (or its permissions) and re-run.\n\n',
      );
      return 1;
    }
    emitSha();
    process.stderr.write(
      '\n' +
        '################################################################\n' +
        '[deploy-provenance] OVERRIDDEN via ' +
        OVERRIDE_ENV +
        '=1\n' +
        'A deploy that FAILED the provenance gate is proceeding anyway.\n' +
        detail +
        'This override has been recorded to ' +
        overridesFile +
        '\n' +
        '################################################################\n\n',
    );
    return 0;
  }

  process.stderr.write(
    '\n[deploy-provenance] REFUSED (' +
      result.code +
      '): this deploy would put unverified code on prod.\n' +
      detail +
      '\nFix it: land your work (node scripts/land.js --apply), then re-run the deploy\n' +
      'from a checkout whose HEAD equals origin/master.\n' +
      'Genuine emergency only: re-run with ' +
      OVERRIDE_ENV +
      '=1 (loud, recorded, auditable).\n\n',
  );
  return 1;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    // Fail closed on anything unexpected: an unprovable deploy is a refused
    // deploy.
    process.stderr.write(
      '[deploy-provenance] REFUSED (gate-error): ' + String((e && e.message) || e) + '\n',
    );
    process.exit(1);
  }
}

module.exports = { main };
