#!/usr/bin/env node
'use strict';

// Resolution + receipt helper for scripts/ec2-release-rollback.sh.
//
// WHY THIS IS A NODE HELPER AND NOT MORE BASH
// The release-shape vocabulary already exists once, in
// scripts/prune-atomic-releases.js: RELEASE_NAME defines what a retained
// release directory is called, and buildPlan defines how the retained set is
// enumerated (real direct children only, symlinked lookalikes ignored, newest
// first by mtime). Re-implementing that in shell would give the rollback a
// SECOND, silently divergent idea of which directories are rollback targets.
// So the rollback reuses the pruner's vocabulary directly: the set this file
// can roll back to is exactly the set the pruner protects.
//
// The shell script stages this file plus prune-atomic-releases.js into a
// bounded temp dir on the target host (the same shape deploy-ec2-server.sh
// uses for the voice-provenance preflight) so the rollback never depends on the
// possibly-broken live release for its own decision logic.
//
// MODES
//   --mode resolve   reads SB_ROLLBACK_* env, prints SIX lines on stdout:
//                      1 live release dir      4 target release dir
//                      2 live sha              5 target sha
//                      3 live dir name         6 target dir name
//                    and exits nonzero with a named reason on any refusal.
//   --mode receipt   reads SB_ROLLBACK_* env, appends ONE durable JSON line to
//                    <data-dir>/agent/ec2-release-rollbacks.jsonl and echoes it.

const fs = require('node:fs');
const path = require('node:path');

const { RELEASE_NAME } = require('../prune-atomic-releases.js');

const SHA40 = /^[0-9a-f]{40}$/;
const RECEIPT_DIR = 'agent';
const RECEIPT_FILE = 'ec2-release-rollbacks.jsonl';
const DEPLOY_RECEIPT_FILE = 'ec2-deploy-receipts.jsonl';

function releaseSha(name) {
  const match = /^[0-9a-f]{40}/.exec(name);
  return match ? match[0] : '';
}

// The retained release set, in the pruner's own terms: real, direct-child,
// release-shaped directories, newest first. A symlinked lookalike is ignored
// here for the same reason the pruner ignores it, so a rollback can never
// point the live link at something outside the releases root.
function listRetainedReleases(releasesRoot) {
  const root = fs.realpathSync(releasesRoot);
  if (!fs.statSync(root).isDirectory() || path.parse(root).root === root) {
    throw new Error(`unsafe releases root: ${root}`);
  }
  const rows = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RELEASE_NAME.test(entry.name)) continue;
    const candidate = path.join(root, entry.name);
    const resolved = fs.realpathSync(candidate);
    if (resolved !== candidate || path.dirname(resolved) !== root) continue;
    rows.push({
      path: candidate,
      name: entry.name,
      sha: releaseSha(entry.name),
      mtimeMs: fs.statSync(candidate).mtimeMs,
    });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return { root, rows };
}

// A retained directory is NOT proof that a release was ever live. Codex review
// 2026-08-02, high finding: atomic-release.sh stages `<releases-root>/<sha>`
// BEFORE it verifies the tree and leaves that directory behind when
// verification fails, so "the newest retained directory older than live" can be
// a release that never passed a gate and never served a request. Rolling
// production onto one would be a worse outage than the one being undone.
//
// The durable successful-swap evidence already exists: deploy-ec2-server.sh
// appends `data/agent/ec2-deploy-receipts.jsonl` (top-level `repoHead`) the
// instant the swap is live, and this file's own receipts record every
// successful rollback target. A sha in either ledger was live at some point.
// Two grades of proof, because they are not equally strong:
//   releases: EXACT directory names proven live (this file's own ok receipts
//             record `toRelease`).
//   shas:     a sha proven live at some point (the deploy ledger records only
//             `repoHead`). A sha is weaker evidence than a directory, because
//             atomic-release.sh can stage several `<sha>.reland-<ts>-<pid>`
//             siblings for ONE sha and leave the failed ones behind. Sha-level
//             proof therefore cannot say WHICH of those directories served
//             traffic, and the caller must refuse rather than guess.
function readProvenLive(dataDir) {
  const shas = new Set();
  const releases = new Set();
  if (!dataDir) return { shas, releases };
  const sources = [
    { file: path.join(dataDir, RECEIPT_DIR, DEPLOY_RECEIPT_FILE), shaField: 'repoHead' },
    {
      file: path.join(dataDir, RECEIPT_DIR, RECEIPT_FILE),
      shaField: 'toSha',
      releaseField: 'toRelease',
      okOnly: true,
    },
  ];
  for (const source of sources) {
    let text;
    try {
      text = fs.readFileSync(source.file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (source.okOnly && row.status !== 'ok') continue;
      const sha = String(row[source.shaField] || '');
      if (SHA40.test(sha)) shas.add(sha);
      if (source.releaseField) {
        const name = String(row[source.releaseField] || '');
        if (RELEASE_NAME.test(name)) releases.add(name);
      }
    }
  }
  return { shas, releases };
}

// FAIL CLOSED on every unproven fact. A rollback that guesses which release is
// live is worse than no rollback: it can point production at a tree nobody
// asked for while the operator believes the bad release is gone.
function resolveRollback({
  releasesRoot,
  liveLink,
  expectLive,
  to,
  provenLive = null,
  allowUnprovenTarget = false,
}) {
  if (allowUnprovenTarget && !to) {
    throw new Error(
      '--allow-unproven-target requires an explicit --to; it lowers the proof bar, it does not license a guess',
    );
  }
  if (!expectLive || !SHA40.test(expectLive)) {
    throw new Error(
      '--expect-live requires a full 40 character git sha; this rollback never runs blind',
    );
  }

  const { root, rows } = listRetainedReleases(releasesRoot);

  let live;
  try {
    live = fs.realpathSync(liveLink);
  } catch {
    throw new Error(`live link does not resolve to anything: ${liveLink}`);
  }
  const liveName = path.basename(live);
  if (path.dirname(live) !== root || !RELEASE_NAME.test(liveName)) {
    throw new Error(
      `live link ${liveLink} does not resolve to a direct child release under ${root} (resolved ${live})`,
    );
  }

  const liveSha = releaseSha(liveName);
  if (liveSha !== expectLive) {
    throw new Error(
      `refusing to roll back blind: live release is ${liveSha} (${liveName}) but --expect-live said ${expectLive}`,
    );
  }

  const liveRow = rows.find((row) => row.path === live);
  if (!liveRow) {
    throw new Error(
      `live release ${liveName} is not part of the retained release set under ${root}`,
    );
  }

  // A staged-but-never-live directory is not a rollback target. When no proof
  // ledger is readable at all we refuse rather than silently downgrade.
  const provenShas = provenLive && provenLive.shas instanceof Set ? provenLive.shas : null;
  const provenReleases =
    provenLive && provenLive.releases instanceof Set ? provenLive.releases : new Set();
  const shaDirCount = (sha) => rows.filter((row) => row.sha === sha).length;
  const provenExactly = (row) => provenReleases.has(row.name);
  const provenOk = (row) =>
    allowUnprovenTarget || provenExactly(row) || Boolean(provenShas && provenShas.has(row.sha));
  const ambiguityError = (row) => {
    const siblings = rows
      .filter((candidate) => candidate.sha === row.sha)
      .map((candidate) => candidate.name)
      .join(', ');
    return new Error(
      `sha ${row.sha} has more than one retained directory (${siblings}) and the proof ledger records only the sha, ` +
        'so which one actually served traffic cannot be proven. Name the exact release directory with --to.',
    );
  };
  // Sha-level proof cannot choose between `<sha>` and its `.reland-*` siblings,
  // and atomic-release.sh leaves a failed reland directory behind. Prefer a
  // sibling this script proved EXACTLY; refuse by name when none exists rather
  // than picking one and hoping.
  const settleSiblings = (row) => {
    if (allowUnprovenTarget || provenExactly(row) || shaDirCount(row.sha) < 2) return row;
    const exact = rows.find(
      (candidate) =>
        candidate.sha === row.sha && candidate.path !== live && provenExactly(candidate),
    );
    if (exact) return exact;
    throw ambiguityError(row);
  };
  if (
    !allowUnprovenTarget &&
    (!provenShas || (provenShas.size === 0 && provenReleases.size === 0))
  ) {
    throw new Error(
      'no proven-live release evidence is readable (agent/ec2-deploy-receipts.jsonl); ' +
        'refusing to roll onto a directory that may never have served traffic. ' +
        'Repair the ledger, or re-run with --allow-unproven-target plus an explicit --to.',
    );
  }

  let target = null;
  if (to) {
    if (SHA40.test(to)) {
      // A reland stages <sha>.reland-<ts>-<pid> beside <sha>, so one sha can
      // own several retained dirs. Take the newest that is not live.
      target = rows.find((row) => row.sha === to && row.path !== live) || null;
      if (!target) {
        throw new Error(
          `--to ${to} matches no retained release under ${root} other than the live one`,
        );
      }
      if (!provenOk(target)) {
        throw new Error(
          `--to ${to} is retained but carries no proven-live receipt, so it may be a staged release that never passed verification. Re-run with --allow-unproven-target to accept that risk.`,
        );
      }
      // A bare sha cannot disambiguate its own reland siblings.
      target = settleSiblings(target);
    } else {
      let resolvedTo;
      try {
        resolvedTo = fs.realpathSync(to);
      } catch {
        throw new Error(`--to ${to} does not resolve to anything`);
      }
      target = rows.find((row) => row.path === resolvedTo) || null;
      if (!target) {
        throw new Error(
          `--to ${to} (resolved ${resolvedTo}) is not a retained direct child release under ${root}`,
        );
      }
      if (target.path === live) {
        throw new Error(
          `--to ${to} is the live release ${liveName}; there is nothing to roll back to`,
        );
      }
      if (!provenOk(target)) {
        throw new Error(
          `--to ${to} is retained but carries no proven-live receipt, so it may be a staged release that never passed verification. Re-run with --allow-unproven-target to accept that risk.`,
        );
      }
      // An explicit directory IS the disambiguation, so no ambiguity check here.
    }
  } else {
    // Default: the newest retained release strictly older than live that is
    // PROVEN to have been live, which is the release the failed deploy
    // replaced. Newer staged-but-failed directories are skipped, not chosen.
    const newest =
      rows.find((row) => row.path !== live && row.mtimeMs < liveRow.mtimeMs && provenOk(row)) ||
      null;
    if (!newest) {
      throw new Error(
        `no proven-live retained release older than the live ${liveName} exists under ${root}; name one explicitly with --to`,
      );
    }
    target = settleSiblings(newest);
  }

  if (target.path === live) {
    throw new Error(
      `rollback target is the live release ${liveName}; there is nothing to roll back to`,
    );
  }

  return {
    root,
    live,
    liveName,
    liveSha,
    target: target.path,
    targetName: target.name,
    targetSha: target.sha,
    targetProven: provenExactly(target) || Boolean(provenShas && provenShas.has(target.sha)),
    retained: rows.length,
  };
}

function splitList(value) {
  return String(value || '')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function healthResult(code) {
  if (!code) return 'unknown';
  return String(code) === '200' ? 'green' : 'red';
}

function buildReceipt(env = process.env, now = new Date()) {
  const code = String(env.SB_ROLLBACK_HEALTH_CODE || '').trim();
  const forward = String(env.SB_ROLLBACK_FORWARD_HEALTH || '').trim();
  return {
    ts: now.toISOString(),
    action: 'ec2-release-rollback',
    status: env.SB_ROLLBACK_STATUS === 'ok' ? 'ok' : 'failed',
    expectLive: env.SB_ROLLBACK_EXPECT_LIVE || null,
    fromSha: env.SB_ROLLBACK_FROM_SHA || null,
    fromRelease: env.SB_ROLLBACK_FROM_RELEASE || null,
    toSha: env.SB_ROLLBACK_TO_SHA || null,
    toRelease: env.SB_ROLLBACK_TO_RELEASE || null,
    optLink: env.SB_ROLLBACK_OPT_LINK || null,
    followersRestarted: splitList(env.SB_ROLLBACK_FOLLOWERS),
    followersSkipped: splitList(env.SB_ROLLBACK_FOLLOWERS_SKIPPED),
    health: { result: healthResult(code), httpCode: code || null },
    // Codex review 2026-08-02: a warn-only restore used to be receipted as a
    // successful roll forward. rolledForward is now a PROVEN claim: the live
    // link was re-read and equals the original release. When the second swap
    // itself fails, restoreVerified is false, rolledForward is false, and the
    // receipt says production is still on the rollback target.
    rolledForward:
      env.SB_ROLLBACK_ROLLED_FORWARD === '1' && env.SB_ROLLBACK_RESTORE_VERIFIED === '1',
    rollForwardAttempted: env.SB_ROLLBACK_ROLLED_FORWARD === '1',
    restoreVerified: env.SB_ROLLBACK_RESTORE_VERIFIED === '1',
    liveAfter: env.SB_ROLLBACK_LIVE_AFTER || null,
    rollForwardHealth: forward || null,
    targetProven: env.SB_ROLLBACK_TARGET_PROVEN === '1',
    reason: env.SB_ROLLBACK_REASON || null,
  };
}

function appendReceipt(dataDir, receipt) {
  if (!dataDir) throw new Error('receipt data dir is required');
  const dir = path.join(dataDir, RECEIPT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, RECEIPT_FILE);
  fs.appendFileSync(file, `${JSON.stringify(receipt)}\n`);
  return file;
}

// Emitted paths cross straight into a shell (`ln -sfn`, `readlink -f`), where a
// backslash is an escape character, not a separator. Hand the shell forward
// slashes: POSIX paths are unchanged, and Windows accepts C:/... everywhere
// Node and bash meet. The API keeps returning native paths for Node callers.
function toShellPath(value) {
  return String(value).replace(/\\/g, '/');
}

function readMode(argv) {
  const index = argv.indexOf('--mode');
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return process.env.SB_ROLLBACK_MODE || 'resolve';
}

if (require.main === module) {
  try {
    const mode = readMode(process.argv.slice(2));
    if (mode === 'resolve') {
      const resolution = resolveRollback({
        releasesRoot: process.env.SB_ROLLBACK_RELEASES_ROOT,
        liveLink: process.env.SB_ROLLBACK_LIVE_LINK,
        expectLive: process.env.SB_ROLLBACK_EXPECT_LIVE,
        to: process.env.SB_ROLLBACK_TO || '',
        provenLive: readProvenLive(process.env.SB_ROLLBACK_DATA_DIR),
        allowUnprovenTarget: process.env.SB_ROLLBACK_ALLOW_UNPROVEN === '1',
      });
      process.stdout.write(
        [
          toShellPath(resolution.live),
          resolution.liveSha,
          resolution.liveName,
          toShellPath(resolution.target),
          resolution.targetSha,
          resolution.targetName,
          resolution.targetProven ? '1' : '0',
        ].join('\n') + '\n',
      );
    } else if (mode === 'receipt') {
      const receipt = buildReceipt(process.env);
      appendReceipt(process.env.SB_ROLLBACK_DATA_DIR, receipt);
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
    } else {
      throw new Error(`unknown --mode: ${mode}`);
    }
  } catch (error) {
    process.stderr.write(`[release-rollback] REFUSED: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEPLOY_RECEIPT_FILE,
  RECEIPT_FILE,
  appendReceipt,
  buildReceipt,
  healthResult,
  listRetainedReleases,
  readProvenLive,
  releaseSha,
  resolveRollback,
};
