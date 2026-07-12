'use strict';

// scripts/lib/ec2-deploy-receipts.js
//
// W5 Stage 4 single code authority (ExampleCo 2026-07-11 R6/R7: one authoritative
// code copy; kill the healer-reverts-prod class). Every deploy-ec2-server.sh
// run records a RECEIPT: what commit the deploying checkout was on, how that
// commit relates to origin/master, and the CRLF-normalized sha256 of the
// exact server content pushed to /opt/secondbrain. Receipts are appended to
// data/agent/ec2-deploy-receipts.jsonl locally AND mirrored to the EC2 live
// data dir, where the independent EC2-side probe
// (scripts/verify-deploy-parity.js, running from the git build path) checks:
//
//   1. receipt-hash-mismatch: /opt server content no longer matches the last
//      receipt (something overwrote prod after the last legitimate deploy,
//      e.g. the 2026-07-05 stale-healer scp class), and
//   2. non-master-deploy: the last deploy itself shipped content that did not
//      match origin/master (feedback_ec2_build_path_silent_revert.md).
//
// An UNRECEIPTED deploy (pushing to /opt without this script) is caught by
// check 1: the live content stops matching the last receipt. The check is
// INDEPENDENT of the deployer (Codex 2026-07-12 finding 9): the probe runs on
// EC2 from the git build path, hashes /opt itself, and compares origin/master
// content hashes recorded at deploy time, so a lying or bypassed deployer
// surfaces as a named defect either way.
//
// A missing receipts file (before the first receipted deploy) is a WARNING,
// never drift (Codex finding 10), so this lands green and tightens on first
// use.

const fs = require('node:fs');
const path = require('node:path');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
const RECEIPTS_FILE = path.join(REPO, 'data', 'agent', 'ec2-deploy-receipts.jsonl');

// Relation of the deploying HEAD to origin/master from two ancestry booleans
// (git merge-base --is-ancestor in each direction). Only 'equal' is a clean
// single-code-authority deploy (Codex finding 11: ahead means unlanded code
// on prod, behind/diverged means a stale or forked deploy).
function relationFromAncestry({
  headEqualsMaster,
  headIsAncestorOfMaster,
  masterIsAncestorOfHead,
}) {
  if (headEqualsMaster) return 'equal';
  if (headIsAncestorOfMaster) return 'behind';
  if (masterIsAncestorOfHead) return 'ahead';
  return 'diverged';
}

function buildReceipt({
  repoHead,
  originMasterHead,
  relation,
  serverSha256,
  originMasterServerSha256,
  deployedBy,
  now = new Date(),
}) {
  const matchesOriginMaster =
    Boolean(serverSha256) &&
    Boolean(originMasterServerSha256) &&
    serverSha256 === originMasterServerSha256;
  return {
    ts: now.toISOString(),
    repoHead: repoHead || null,
    originMasterHead: originMasterHead || null,
    relation: relation || 'ExampleCo',
    serverSha256: serverSha256 || null,
    originMasterServerSha256: originMasterServerSha256 || null,
    matchesOriginMaster,
    deployedBy: deployedBy || 'deploy-ec2-server.sh',
  };
}

function appendReceipt(receipt, file = RECEIPTS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(receipt) + '\n');
  return receipt;
}

// Last parseable line wins. ENOENT -> null (no receipt yet, warning-class).
function readLatestReceipt(file = RECEIPTS_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s) continue;
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* torn tail line, keep walking back */
    }
  }
  return null;
}

/**
 * Pure receipt-vs-live check consumed by the deploy-parity probe. An
 * UNRECEIPTED deploy (someone pushed different content to /opt without the
 * receipt-writing script) is inherently caught by receipt-hash-mismatch: the
 * live content no longer matches the last receipt. A re-copy of IDENTICAL
 * content is harmless and stays ok regardless of mtime.
 * @param {{receipt:object|null, liveServerSha256:string|null}} args
 * @returns {{ok:boolean, kind:'deploy-receipt', warning?:string, drift?:object}}
 */
function checkReceiptAgainstLive({ receipt, liveServerSha256 }) {
  if (!receipt) {
    return {
      ok: true,
      kind: 'deploy-receipt',
      warning:
        'no deploy receipt recorded yet (first receipted deploy pending); receipt checks begin then',
    };
  }
  if (!liveServerSha256) {
    return {
      ok: false,
      kind: 'deploy-receipt',
      drift: {
        file: 'server.js (live /opt)',
        kind: 'receipt-hash-mismatch',
        detail: 'live server content unreadable, cannot verify against the deploy receipt',
      },
    };
  }
  if (receipt.serverSha256 && receipt.serverSha256 !== liveServerSha256) {
    return {
      ok: false,
      kind: 'deploy-receipt',
      drift: {
        file: 'server.js (live /opt)',
        kind: 'receipt-hash-mismatch',
        detail:
          'live /opt server content does not match the last deploy receipt (' +
          String(receipt.ts) +
          '): something overwrote prod outside the receipted deploy path',
        receiptSha256: receipt.serverSha256,
        liveSha256: liveServerSha256,
      },
    };
  }
  if (receipt.matchesOriginMaster === false) {
    return {
      ok: false,
      kind: 'deploy-receipt',
      drift: {
        file: 'server.js (live /opt)',
        kind: 'non-master-deploy',
        detail:
          'the last receipted deploy (' +
          String(receipt.ts) +
          ', relation ' +
          String(receipt.relation) +
          ') shipped content that did not match origin/master: single code authority violated',
        relation: receipt.relation || 'ExampleCo',
        repoHead: receipt.repoHead || null,
      },
    };
  }
  return { ok: true, kind: 'deploy-receipt' };
}

module.exports = {
  RECEIPTS_FILE,
  relationFromAncestry,
  buildReceipt,
  appendReceipt,
  readLatestReceipt,
  checkReceiptAgainstLive,
};
