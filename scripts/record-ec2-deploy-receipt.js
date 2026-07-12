#!/usr/bin/env node
'use strict';

// scripts/record-ec2-deploy-receipt.js
//
// W5 Stage 4: called by deploy-ec2-server.sh AFTER its post-deploy parity
// check passes. Computes the deploy receipt (deploying HEAD, relation to
// origin/master, CRLF-normalized sha256 of the shipped ec2-server.js and of
// origin/master's copy) and appends it to data/agent/ec2-deploy-receipts.jsonl.
// The deploy script then mirrors the receipts file to the EC2 live data dir,
// where scripts/verify-deploy-parity.js checks live /opt content against it
// (drift = named defect: receipt-hash-mismatch / non-master-deploy).
//
// Prints the receipt JSON on success, exits 1 on any failure so the deploy
// is LOUD about an unreceipted release (silent receipts were the point).

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { normalizedSha256 } = require('./lib/deploy-parity-check.js');
const {
  buildReceipt,
  appendReceipt,
  relationFromAncestry,
} = require('./lib/ec2-deploy-receipts.js');

// The DEPLOYING checkout is this script's own repo root, NEVER the
// SECONDBRAIN_ROOT env (which points at the shared checkout on this machine;
// deploys run from isolated worktrees, and hashing a different checkout than
// the one that shipped produced a false non-master receipt on the first live
// run, 2026-07-12). Matches deploy-ec2-server.sh's own
// `git rev-parse --show-toplevel` root resolution.
const REPO = path.resolve(__dirname, '..');

function git(args) {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', timeout: 15000 }).trim();
}

function gitOk(args) {
  try {
    execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const fileArgIdx = process.argv.indexOf('--receipts-file');
  // Default ledger lives in the DEPLOYING checkout so deploy-ec2-server.sh
  // (which resolves the same root) can mirror the exact file just written.
  const receiptsFile =
    fileArgIdx > -1
      ? process.argv[fileArgIdx + 1]
      : path.join(REPO, 'data', 'agent', 'ec2-deploy-receipts.jsonl');

  const repoHead = git(['rev-parse', 'HEAD']);
  const originMasterHead = git(['rev-parse', 'origin/master']);
  const relation = relationFromAncestry({
    headEqualsMaster: repoHead === originMasterHead,
    headIsAncestorOfMaster: gitOk(['merge-base', '--is-ancestor', repoHead, originMasterHead]),
    masterIsAncestorOfHead: gitOk(['merge-base', '--is-ancestor', originMasterHead, repoHead]),
  });

  // Hash the WORKING-TREE file actually shipped (deploys copy the file, not a
  // commit), and origin/master's committed copy for the authority comparison.
  const shipped = fs.readFileSync(path.join(REPO, 'ec2-server.js'), 'utf8');
  const serverSha256 = normalizedSha256(shipped);
  const originMasterServerSha256 = normalizedSha256(
    execFileSync('git', ['-C', REPO, 'show', 'origin/master:ec2-server.js'], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 64 * 1024 * 1024,
    }),
  );

  const receipt = buildReceipt({
    repoHead,
    originMasterHead,
    relation,
    serverSha256,
    originMasterServerSha256,
  });
  appendReceipt(receipt, receiptsFile);
  process.stdout.write(JSON.stringify(receipt) + '\n');
  if (!receipt.matchesOriginMaster) {
    process.stderr.write(
      '[deploy-receipt] WARNING: deployed content does not match origin/master (relation ' +
        relation +
        '). Receipt recorded honestly; the EC2 parity probe will name this as a non-master-deploy defect until a master deploy lands.\n',
    );
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    process.stderr.write('[deploy-receipt] FAILED: ' + String((e && e.message) || e) + '\n');
    process.exit(1);
  }
}

module.exports = { main };
