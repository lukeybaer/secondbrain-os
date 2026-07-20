'use strict';

// scripts/lib/append-deploy-receipt.js
//
// Runs ON the EC2 host, streamed in via `node -` by deploy-ec2-server.sh, with
// the receipt handed over in SB_DEPLOY_RECEIPT_B64. Base64 plus stdin keeps
// JSON quoting out of the SSH command line entirely; the same reason
// deploy-graphiti-indexed.sh is sent over `bash -s`.
//
// WHY THIS EXISTS. Codex gate ff30fbb4d641 found that mirroring the local
// ledger with `cp` truncated real deploy history, because the local file is
// gitignored and absent from every fresh worktree. Replacing that with a plain
// `tee -a` then traded truncation for DOUBLE COUNTING (gate 05a8e5b45303
// finding 3): the deploy script tells the operator to retry on a mirror
// failure, and a retry appended a second row for one release, which
// overnight-watch-report.js counts as two deploy events.
//
// So the append has to be idempotent. The dedupe key is (repoHead,
// serverSha256) read from the receipt itself. A retry of the same attempt
// reproduces both and is suppressed. A genuinely different release changes
// serverSha256 and appends.
//
// ACCEPTED TRADE-OFF, stated plainly: deploying byte-identical content twice
// records one row. That is correct for a ledger whose subject is what /opt
// CONTAINS, and it is the safer direction to err, since an undercount of
// redundant deploys is less misleading than an overcount of real ones.

const fs = require('fs');
const path = require('path');

const LEDGER =
  process.env.SB_DEPLOY_RECEIPT_LEDGER || '/opt/secondbrain/data/agent/ec2-deploy-receipts.jsonl';

function fail(message) {
  process.stderr.write(`[append-deploy-receipt] ${message}\n`);
  process.exit(1);
}

const b64 = process.env.SB_DEPLOY_RECEIPT_B64 || '';
if (!b64) fail('SB_DEPLOY_RECEIPT_B64 is empty; nothing to append.');

let receipt;
try {
  receipt = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
} catch (err) {
  fail(`receipt did not decode to JSON: ${err.message}`);
}

const repoHead = String((receipt && receipt.repoHead) || '');
const serverSha256 = String((receipt && receipt.serverSha256) || '');
// Refuse rather than append an undedupable row. A receipt with neither field
// cannot be recognised on a retry, so accepting it reintroduces the duplicate.
if (!repoHead && !serverSha256) {
  fail(
    'receipt ExampleCos neither repoHead nor serverSha256, so it cannot be deduplicated. Refusing.',
  );
}
const key = `${repoHead}|${serverSha256}`;

fs.mkdirSync(path.dirname(LEDGER), { recursive: true });

// Read-then-append under one process. Concurrent deploys are already
// serialized upstream by the land lock and the atomic release; this guards the
// retry case, which is sequential by construction.
let existing = '';
try {
  existing = fs.readFileSync(LEDGER, 'utf8');
} catch {
  existing = '';
}

let alreadyPresent = false;
for (const line of existing.split('\n')) {
  if (!line.trim()) continue;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    // A corrupt historical row must not make this one look absent, but it also
    // must not abort the scan. Skip it and keep looking.
    continue;
  }
  if (`${String(row.repoHead || '')}|${String(row.serverSha256 || '')}` === key) {
    alreadyPresent = true;
    break;
  }
}

if (alreadyPresent) {
  process.stdout.write(
    `[append-deploy-receipt] receipt for ${key} already present, not duplicating\n`,
  );
  process.exit(0);
}

const needsNewline = existing.length > 0 && !existing.endsWith('\n');
fs.appendFileSync(LEDGER, `${needsNewline ? '\n' : ''}${JSON.stringify(receipt)}\n`);
process.stdout.write(`[append-deploy-receipt] appended receipt for ${key}\n`);
