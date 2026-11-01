#!/usr/bin/env node
'use strict';

// Bound generated immutable-release disk use after a successful live health
// probe. Durable data, logs, secrets, and shared node_modules live outside this
// tree; this pruner only accepts direct child directories named like releases.

const fs = require('node:fs');
const path = require('node:path');

const RELEASE_NAME = /^[0-9a-f]{40}(?:\.reland-\d+-\d+)?$/;
const DEFAULT_KEEP = 20;

function parseArgs(argv) {
  const args = {
    releasesRoot: process.env.SB_RELEASES_ROOT || '/opt/secondbrain-releases',
    liveLink: process.env.SB_OPT_LINK || '/opt/secondbrain',
    keep: Number(process.env.SB_RELEASE_RETENTION || DEFAULT_KEEP),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--releases-root') args.releasesRoot = argv[++i];
    else if (arg === '--live-link') args.liveLink = argv[++i];
    else if (arg === '--keep') args.keep = Number(argv[++i]);
    else if (arg === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function freeBytes(target) {
  if (typeof fs.statfsSync !== 'function') return null;
  const stat = fs.statfsSync(target, { bigint: true });
  return Number(stat.bavail * stat.bsize);
}

function readProcessCwds({ procRoot = '/proc', fsApi = fs } = {}) {
  if (process.platform !== 'linux') return { known: false, cwds: new Set() };
  let pids = [];
  try {
    pids = fsApi.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return { known: false, cwds: new Set() };
  }
  const cwds = new Set();
  for (const pid of pids) {
    try {
      cwds.add(path.resolve(fsApi.readlinkSync(path.join(procRoot, pid, 'cwd'))));
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') continue;
      return { known: false, cwds };
    }
  }
  return { known: true, cwds };
}

function processOwnsRelease(releasePath, processCwds) {
  const root = path.resolve(releasePath);
  const prefix = `${root}${path.sep}`;
  return [...(processCwds || [])].some((cwd) => cwd === root || cwd.startsWith(prefix));
}

function buildPlan({ releasesRoot, liveLink, keep = DEFAULT_KEEP, processCwdProof = readProcessCwds() }) {
  if (!Number.isSafeInteger(keep) || keep < 2) {
    throw new Error('--keep must be an integer of at least 2');
  }

  const root = fs.realpathSync(releasesRoot);
  if (!fs.statSync(root).isDirectory() || path.parse(root).root === root) {
    throw new Error(`unsafe releases root: ${root}`);
  }

  const live = fs.realpathSync(liveLink);
  if (path.dirname(live) !== root || !RELEASE_NAME.test(path.basename(live))) {
    throw new Error(`live target is not a valid direct child release: ${live}`);
  }

  const ignored = [];
  const candidates = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RELEASE_NAME.test(entry.name)) {
      ignored.push(entry.name);
      continue;
    }
    const candidate = path.join(root, entry.name);
    const resolved = fs.realpathSync(candidate);
    if (path.dirname(resolved) !== root || resolved !== candidate) {
      ignored.push(entry.name);
      continue;
    }
    candidates.push({ path: candidate, name: entry.name, mtimeMs: fs.statSync(candidate).mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const protectedPaths = new Set(candidates.slice(0, keep).map((row) => row.path));
  protectedPaths.add(live);
  const protectedByProcess = [];
  if (processCwdProof?.known === true) {
    for (const row of candidates) {
      if (!processOwnsRelease(row.path, processCwdProof.cwds)) continue;
      protectedPaths.add(row.path);
      protectedByProcess.push(row.path);
    }
  }
  // If process ownership cannot be enumerated, retain every release. A worker
  // pinned to an old physical root is part of the compatible-deploy contract;
  // reclaiming that root would turn bounded drain into a mid-run code deletion.
  const remove = processCwdProof?.known === true
    ? candidates.filter((row) => !protectedPaths.has(row.path))
    : [];
  return {
    root,
    live,
    keep,
    candidateCount: candidates.length,
    protected: [...protectedPaths].sort(),
    protectedByProcess: protectedByProcess.sort(),
    processCwdProofKnown: processCwdProof?.known === true,
    remove,
    ignored: ignored.sort(),
  };
}

function pruneAtomicReleases(options) {
  const plan = buildPlan(options);
  const freeBefore = freeBytes(plan.root);
  const removed = [];
  const failed = [];

  if (!options.dryRun) {
    for (const row of plan.remove) {
      try {
        // Selection restricts deletion to real direct-child release dirs.
        // Symlinks inside one are unlinked, never followed into durable state.
        fs.rmSync(row.path, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
        removed.push(row.name);
      } catch (error) {
        failed.push({ name: row.name, error: error.message });
      }
    }
  }

  const freeAfter = freeBytes(plan.root);
  return {
    status: !plan.processCwdProofKnown ? 'blocked-process-proof' : failed.length ? 'partial' : 'ok',
    dryRun: Boolean(options.dryRun),
    releasesRoot: plan.root,
    liveRelease: path.basename(plan.live),
    retention: plan.keep,
    candidates: plan.candidateCount,
    selectedForRemoval: plan.remove.length,
    removed,
    failed,
    protectedByProcess: plan.protectedByProcess.map((entry) => path.basename(entry)),
    processCwdProofKnown: plan.processCwdProofKnown,
    ignored: plan.ignored,
    freeBytesBefore: freeBefore,
    freeBytesAfter: freeAfter,
    freedBytes: freeBefore == null || freeAfter == null ? null : Math.max(0, freeAfter - freeBefore),
  };
}

if (require.main === module) {
  try {
    const receipt = pruneAtomicReleases(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    if (receipt.status !== 'ok') process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`[release-retention] ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_KEEP,
  RELEASE_NAME,
  buildPlan,
  parseArgs,
  processOwnsRelease,
  pruneAtomicReleases,
  readProcessCwds,
};
