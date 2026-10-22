'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { proveWorktreeIsolation, resolveCodexSourceRoot } = require('./codex-worktree.js');
const { landScanOutputs } = require('./scan-output-lander.js');
const { archiveRuntimeArtifacts } = require('./scheduled-runtime-archive.js');
const {
  assertRuntimeDataRoot,
  gitOutputRootsForJob,
  loadStateOwnership,
  pathspecCovers,
} = require('./scheduled-write-ownership.js');
const {
  cleanupRuntimeArtifactsStage,
  publishRuntimeArtifacts,
  preserveHistoricalNightlySnapshot,
  recoverRuntimeArtifactsStage,
  runtimeFilesForSkill,
  STAGING_RELATIVE_ROOT,
  VIDEO_RESEARCH_SKILL,
  validateGenericRuntimeArtifacts,
  verifyPublishedRuntimeArtifacts,
} = require('./scheduled-skill-runtime-artifacts.js');

const EVENT_SCHEMA = 'amy.scheduled_skill_promotion_event.v1';
const QUEUE_BASENAME = 'scheduled-skill-promotion-queue.jsonl';
const LEASE_TTL_MS = 2 * 60 * 60 * 1000;
const MODULE_REPO_ROOT = path.resolve(__dirname, '..', '..');

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function queueFile(dataDir) {
  const proven = assertRuntimeDataRoot(dataDir);
  return path.join(proven.dataDir, 'agent', QUEUE_BASENAME);
}

function appendEvent(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    JSON.stringify({ schema: EVENT_SCHEMA, ts: new Date().toISOString(), ...row }) + '\n',
  );
}

function readEvents(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw new Error(`promotion queue is unreadable: ${error.message || error}`);
  }
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      let row;
      try {
        row = JSON.parse(line);
      } catch (error) {
        throw new Error(`promotion queue line ${index + 1} is invalid JSON: ${error.message}`);
      }
      if (!row || row.schema !== EVENT_SCHEMA) {
        throw new Error(`promotion queue line ${index + 1} has an unsupported schema`);
      }
      return row;
    });
}

function repairCorruptTail(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { repaired: false };
    throw new Error(`promotion queue is unreadable: ${error.message || error}`);
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const row = JSON.parse(lines[index]);
      if (!row || row.schema !== EVENT_SCHEMA) {
        throw new Error('unsupported schema');
      }
    } catch (error) {
      if (index !== lines.length - 1) {
        throw new Error(`promotion queue line ${index + 1} is corrupt before the tail`);
      }
      const quarantineDir = path.join(path.dirname(file), 'scheduled-skill-promotion-quarantine');
      fs.mkdirSync(quarantineDir, { recursive: true });
      const quarantine = path.join(quarantineDir, `${path.basename(file)}.corrupt-${Date.now()}`);
      const repairFile = `${file}.repair.tmp`;
      fs.copyFileSync(file, quarantine, fs.constants.COPYFILE_EXCL);
      const valid = lines.slice(0, index);
      const repairedEvent = {
        schema: EVENT_SCHEMA,
        ts: new Date().toISOString(),
        op: 'corrupt-tail-quarantined',
        quarantine,
        line: index + 1,
        error: String(error.message || error),
      };
      fs.writeFileSync(
        repairFile,
        [...valid, JSON.stringify(repairedEvent)].join('\n') + '\n',
        'utf8',
      );
      fs.renameSync(repairFile, file);
      return { repaired: true, quarantine, line: index + 1 };
    }
  }
  return { repaired: false };
}

function promotionStates(file) {
  const states = new Map();
  for (const event of readEvents(file)) {
    if (event.op === 'enqueue' && event.job && event.job.id) {
      if (states.has(event.job.id)) continue;
      states.set(event.job.id, {
        job: event.job,
        status: 'pending',
        attemptCount: 0,
        lastAttemptAt: '',
        completedStages: new Set(),
        cleanupComplete: false,
      });
      continue;
    }
    const state = states.get(event.jobId);
    if (!state) continue;
    if (event.op === 'attempt') {
      state.attemptCount += 1;
      state.lastAttemptAt = event.ts || '';
    } else if (event.op === 'legacy-runtime-recovery') {
      state.job = {
        ...state.job,
        runtimeStagingDataDir: event.runtimeStagingDataDir,
        runtimeArchive: event.runtimeArchive,
        runtimePublish: event.runtimePublish,
        runtimeLiveRead: event.runtimeLiveRead,
        ignoredRuntimePaths: event.ignoredRuntimePaths,
        legacyRuntimeRecovery: event.legacyRuntimeRecovery,
      };
      state.completedStages = new Set(event.completedStages || []);
    } else if (event.op === 'stage-complete' && event.stage) {
      state.completedStages.add(event.stage);
    } else if (event.op === 'complete') {
      state.status = 'complete';
    } else if (event.op === 'cancel') {
      state.status = 'cancelled';
    } else if (event.op === 'cleanup-complete') {
      state.cleanupComplete = true;
    }
  }
  return states;
}

function jobWithQueueState(state) {
  return {
    ...state.job,
    queueState: {
      attemptCount: state.attemptCount,
      lastAttemptAt: state.lastAttemptAt,
      completedStages: [...state.completedStages],
    },
  };
}

function pendingPromotions(file) {
  return [...promotionStates(file).values()]
    .filter((state) => state.status === 'pending')
    .sort(
      (a, b) =>
        a.attemptCount - b.attemptCount ||
        (Number.isFinite(Date.parse(a.job.createdAt || ''))
          ? Date.parse(a.job.createdAt)
          : Number.MAX_SAFE_INTEGER) -
          (Number.isFinite(Date.parse(b.job.createdAt || ''))
            ? Date.parse(b.job.createdAt)
            : Number.MAX_SAFE_INTEGER),
    )
    .map(jobWithQueueState);
}

function pendingCleanupJobs(file) {
  return [...promotionStates(file).values()]
    .filter((state) => state.status === 'complete' && !state.cleanupComplete)
    .map(jobWithQueueState);
}

function runGit(args, cwd, options = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: options.encoding === null ? null : 'utf8',
    timeout: options.timeout || 120_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || (options.encoding === null ? Buffer.alloc(0) : ''),
    stderr: result.stderr || (options.encoding === null ? Buffer.alloc(0) : ''),
  };
}

function gitText(args, cwd) {
  const result = runGit(args, cwd);
  if (!result.ok) {
    throw new Error(String(result.stderr || `git ${args[0]} exited ${result.status}`).trim());
  }
  return String(result.stdout || '').trim();
}

function normalizedRelative(value) {
  const relative = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (
    !relative ||
    path.posix.isAbsolute(relative) ||
    /^[A-Za-z]:\//.test(relative) ||
    relative.split('/').includes('..')
  ) {
    throw new Error(`unsafe promotion-relative path: ${value}`);
  }
  return relative;
}

function containedPath(root, relative) {
  const safe = normalizedRelative(relative);
  const absolute = path.resolve(root, safe);
  const relation = path.relative(path.resolve(root), absolute);
  if (relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error(`promotion path escapes its root: ${relative}`);
  }
  let existing = absolute;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    existing = path.dirname(existing);
  }
  const realRelation = path.relative(realComparable(root), realComparable(existing));
  if (realRelation.startsWith('..') || path.isAbsolute(realRelation)) {
    throw new Error(`promotion path traverses outside its root: ${relative}`);
  }
  return { relative: safe, absolute };
}

function assertContainedRoot(parentRoot, childRoot, label) {
  const parent = realComparable(parentRoot);
  const child = realComparable(childRoot);
  const relation = path.relative(parent, child);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error(`${label} must remain below ${parentRoot}`);
  }
  return path.resolve(childRoot);
}

function assertRuntimePromotionStage(job) {
  const proven = assertRuntimeDataRoot(job.dataDir);
  const registeredRoot = path.join(proven.dataDir, 'staging', 'scheduled-skills');
  return assertContainedRoot(
    registeredRoot,
    job.runtimeArchive.stagingDataDir,
    'runtime promotion staging root',
  );
}

function realComparable(value) {
  const resolved = path.resolve(value);
  try {
    const real = fs.realpathSync.native(resolved);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

function assertQueuedDataRoot(job, queueDataDir) {
  if (!queueDataDir) throw new Error('promotion requires the active queue data root');
  const active = assertRuntimeDataRoot(queueDataDir).dataDir;
  if (realComparable(job.dataDir) !== realComparable(active)) {
    throw new Error('queued job data root does not match the active promotion queue');
  }
  return active;
}

function assertGitPromotionRoots(job, allowedSourceRepoRoot) {
  if (!allowedSourceRepoRoot) throw new Error('Git promotion requires a registered source root');
  if (realComparable(job.sourceRepoRoot) !== realComparable(allowedSourceRepoRoot)) {
    throw new Error('queued source root does not match the registered Codex source root');
  }
  const sourceTop = gitText(['rev-parse', '--show-toplevel'], job.sourceRepoRoot);
  if (realComparable(sourceTop) !== realComparable(job.sourceRepoRoot)) {
    throw new Error('queued source root is not its repository top level');
  }
  const sourceCommon = gitText(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    job.sourceRepoRoot,
  );
  const worktreeCommon = gitText(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    job.worktreeRoot,
  );
  if (realComparable(sourceCommon) !== realComparable(worktreeCommon)) {
    throw new Error('queued worktree does not belong to the registered source repository');
  }
}

function parsePorcelainPaths(raw) {
  const tokens = String(raw || '')
    .split('\0')
    .filter(Boolean);
  const paths = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const code = token.slice(0, 2);
    paths.push(normalizedRelative(token.slice(3)));
    if (/[RC]/.test(code) && index + 1 < tokens.length) {
      paths.push(normalizedRelative(tokens[++index]));
    }
  }
  return paths;
}

function discoverGitPromotionFiles(worktreeRoot, pathspecs) {
  const safePathspecs = [...new Set((pathspecs || []).map(normalizedRelative))];
  if (!safePathspecs.length) return [];
  const status = runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...safePathspecs],
    worktreeRoot,
  );
  if (!status.ok) throw new Error(`promotion status discovery failed: ${status.stderr}`);
  const delta = runGit(
    ['diff', '--name-only', '-z', 'origin/master...HEAD', '--', ...safePathspecs],
    worktreeRoot,
  );
  if (!delta.ok) throw new Error(`promotion branch discovery failed: ${delta.stderr}`);
  return [
    ...new Set([
      ...parsePorcelainPaths(status.stdout),
      ...String(delta.stdout || '')
        .split('\0')
        .filter(Boolean)
        .map(normalizedRelative),
    ]),
  ].sort();
}

// A queued job freezes its exact promotable file set at enqueue time. If the
// skill's registered Git output contract (config/state-ownership.json) widens
// AFTER a job is enqueued but before it lands (for example a producer starts
// emitting one more evidence file and the registry is updated to own it), the
// already-queued job's frozen allowlist never learns about the new path. Every
// retry then fails identically forever with "worktree has unqueued dirt",
// because the check only recognizes the enqueue-time snapshot. Reconcile such
// dirt against the CURRENT registry: a dirty path that the skill's live
// contract already owns is legitimate output, not unqueued drift, so land can
// proceed and pick it up. A path the current contract still does not own
// stays a hard failure.
function currentGitOutputRootsForJob(job) {
  try {
    const registry = loadStateOwnership({ repoRoot: job.sourceRepoRoot });
    return gitOutputRootsForJob({ skillName: job.skillName, registry });
  } catch {
    return [];
  }
}

function verifyPromotionScope(job) {
  const allowed = new Set((job.gitLand.files || []).map((row) => normalizedRelative(row.relative)));
  const ignoredRuntime = new Set((job.ignoredRuntimePaths || []).map(normalizedRelative));
  const status = runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    job.worktreeRoot,
  );
  if (!status.ok) return { ok: false, reason: `worktree status failed: ${status.stderr}` };
  const dirtyFiles = parsePorcelainPaths(status.stdout);
  const outsideDirty = dirtyFiles.filter(
    (relative) => !allowed.has(relative) && !ignoredRuntime.has(relative),
  );
  const delta = runGit(
    ['diff', '--name-only', '-z', 'origin/master...HEAD', '--'],
    job.worktreeRoot,
  );
  if (!delta.ok) return { ok: false, reason: `branch delta failed: ${delta.stderr}` };
  const committedFiles = String(delta.stdout || '')
    .split('\0')
    .filter(Boolean)
    .map(normalizedRelative);
  const outsideCommits = committedFiles.filter((relative) => !allowed.has(relative));
  const outsideFiles = [...new Set([...outsideDirty, ...outsideCommits])];
  const currentRoots = outsideFiles.length ? currentGitOutputRootsForJob(job) : [];
  const unownedDirty = outsideDirty.filter(
    (relative) => !currentRoots.some((root) => pathspecCovers(root, relative)),
  );
  if (unownedDirty.length) {
    return {
      ok: false,
      reason: `worktree has unqueued dirt: ${unownedDirty.join(', ')}`,
    };
  }
  const unownedCommits = outsideCommits.filter(
    (relative) => !currentRoots.some((root) => pathspecCovers(root, relative)),
  );
  if (unownedCommits.length) {
    return {
      ok: false,
      reason: `branch contains unqueued committed files: ${unownedCommits.join(', ')}`,
    };
  }
  const reconciledPathspecs = [
    ...new Set(
      outsideFiles.map((relative) => currentRoots.find((root) => pathspecCovers(root, relative))),
    ),
  ];
  const reconciledFiles = snapshotGitFiles(job.worktreeRoot, outsideFiles);
  return { ok: true, dirtyFiles, committedFiles, reconciledPathspecs, reconciledFiles };
}

function snapshotGitFiles(root, relativeFiles) {
  return [...new Set((relativeFiles || []).map(normalizedRelative))].sort().map((relative) => {
    const { absolute } = containedPath(root, relative);
    if (!fs.existsSync(absolute)) {
      return { relative, deleted: true, sha256: null, gitBlob: null, bytes: 0 };
    }
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile()) throw new Error(`promotion snapshot is not a file: ${absolute}`);
    const gitBlob = gitText(['hash-object', `--path=${relative}`, '--', absolute], root);
    if (!/^[a-f0-9]{40,64}$/i.test(gitBlob)) {
      throw new Error(`could not compute the Git blob id for ${relative}`);
    }
    return { relative, deleted: false, sha256: sha256File(absolute), gitBlob, bytes: stat.size };
  });
}

function snapshotFiles(root, relativeFiles) {
  return [...new Set((relativeFiles || []).map(normalizedRelative))].sort().map((relative) => {
    const { absolute } = containedPath(root, relative);
    if (!fs.existsSync(absolute)) return { relative, deleted: true, sha256: null, bytes: 0 };
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile()) throw new Error(`promotion snapshot is not a file: ${absolute}`);
    return { relative, deleted: false, sha256: sha256File(absolute), bytes: stat.size };
  });
}

function verifySnapshot(root, rows) {
  const failures = [];
  for (const row of rows || []) {
    const { absolute } = containedPath(root, row.relative);
    if (row.deleted) {
      if (fs.existsSync(absolute)) failures.push(`${row.relative} was recreated`);
      continue;
    }
    if (!fs.existsSync(absolute)) {
      failures.push(`${row.relative} is missing`);
      continue;
    }
    if (!fs.lstatSync(absolute).isFile()) {
      failures.push(`${row.relative} is not a regular file`);
      continue;
    }
    const observed = sha256File(absolute);
    if (observed !== row.sha256) failures.push(`${row.relative} changed after enqueue`);
  }
  return { ok: failures.length === 0, failures };
}

function gitFileAt(root, ref, relative) {
  const result = runGit(['show', `${ref}:${normalizedRelative(relative)}`], root);
  return result.ok ? String(result.stdout || '') : null;
}

function indexRows(content) {
  return String(content || '')
    .split(/\r?\n/)
    .filter((line) => /^\| \d{4}-\d{2}-\d{2} \|/.test(line));
}

function indexRowIdentity(line) {
  const link = String(line || '').match(/\]\(([^)]+)\)/);
  return link ? link[1] : String(line || '');
}

function mergeDevPlansIndex(baseContent, currentContent, queuedContent) {
  const baseIds = new Set(indexRows(baseContent).map(indexRowIdentity));
  const additions = indexRows(queuedContent).filter((line) => !baseIds.has(indexRowIdentity(line)));
  const lines = String(currentContent || '').split(/\r?\n/);
  const currentIds = new Set(indexRows(currentContent).map(indexRowIdentity));
  for (const row of additions) {
    const identity = indexRowIdentity(row);
    if (currentIds.has(identity)) continue;
    const date = row.slice(2, 12);
    let insertAt = lines.findIndex(
      (line) => /^\| \d{4}-\d{2}-\d{2} \|/.test(line) && line.slice(2, 12) <= date,
    );
    if (insertAt < 0) insertAt = lines.length;
    lines.splice(insertAt, 0, row, '');
    currentIds.add(identity);
  }
  return lines.join('\n');
}

function semanticContributionProof(job, relative, observedContent) {
  const safe = normalizedRelative(relative);
  const baseContent = gitFileAt(job.worktreeRoot, `${job.headSha}^`, safe);
  const queuedContent = gitFileAt(job.worktreeRoot, job.headSha, safe);
  if (baseContent === null || queuedContent === null) return null;

  if (safe === 'dev-plans/INDEX.md') {
    const baseIds = new Set(indexRows(baseContent).map(indexRowIdentity));
    const additions = indexRows(queuedContent).filter(
      (line) => !baseIds.has(indexRowIdentity(line)),
    );
    const observedRows = new Map(
      indexRows(observedContent).map((line) => [indexRowIdentity(line), line]),
    );
    const failures = additions.filter((line) => observedRows.get(indexRowIdentity(line)) !== line);
    return {
      ok: additions.length > 0 && failures.length === 0,
      reason: failures.length
        ? `queued dev-plan index rows are missing: ${failures.map(indexRowIdentity).join(', ')}`
        : '',
    };
  }

  if (safe === 'dev-plans/records.json') {
    let base;
    let queued;
    let observed;
    try {
      base = JSON.parse(baseContent);
      queued = JSON.parse(queuedContent);
      observed = JSON.parse(observedContent);
    } catch {
      return { ok: false, reason: 'dev-plan records semantic proof could not parse JSON' };
    }
    if (!Array.isArray(base) || !Array.isArray(queued) || !Array.isArray(observed)) {
      return { ok: false, reason: 'dev-plan records semantic proof requires arrays' };
    }
    const baseFiles = new Set(base.map((row) => String(row?.file || '')));
    const additions = queued.filter((row) => !baseFiles.has(String(row?.file || '')));
    const observedByFile = new Map(observed.map((row) => [String(row?.file || ''), row]));
    const failures = additions.filter(
      (row) => JSON.stringify(observedByFile.get(String(row?.file || ''))) !== JSON.stringify(row),
    );
    return {
      ok: additions.length > 0 && failures.length === 0,
      reason: failures.length
        ? `queued dev-plan records are missing: ${failures.map((row) => row.file).join(', ')}`
        : '',
    };
  }

  if (/^scheduled-tasks\/[^/]+\/(?:LEARNINGS|LESSONS)\.md$/.test(safe)) {
    if (!queuedContent.startsWith(baseContent)) {
      return { ok: false, reason: `${safe} was not append-only in the queued commit` };
    }
    const addition = queuedContent.slice(baseContent.length).trim();
    return {
      ok: Boolean(addition) && String(observedContent || '').includes(addition),
      reason: `${safe} does not contain the queued append`,
    };
  }

  return null;
}

function verifyGitPromotionSnapshot(job) {
  const failures = [];
  for (const row of job.gitLand?.files || []) {
    const { absolute } = containedPath(job.worktreeRoot, row.relative);
    if (row.deleted) {
      if (fs.existsSync(absolute)) failures.push(`${row.relative} was recreated`);
      continue;
    }
    if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) {
      failures.push(`${row.relative} is missing`);
      continue;
    }
    if (sha256File(absolute) === row.sha256) continue;
    const semantic = semanticContributionProof(
      job,
      row.relative,
      fs.readFileSync(absolute, 'utf8'),
    );
    if (!semantic?.ok) failures.push(semantic?.reason || `${row.relative} changed after enqueue`);
  }
  return { ok: failures.length === 0, failures };
}

function preparePromotionBranchForLand(job) {
  const rebase = runGit(['rebase', 'origin/master'], job.worktreeRoot, {
    timeout: 20 * 60 * 1000,
  });
  if (rebase.ok) return { ok: true, rebased: true };
  const unresolved = runGit(['diff', '--name-only', '--diff-filter=U'], job.worktreeRoot);
  const conflicts = String(unresolved.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean);
  if (!unresolved.ok || conflicts.length !== 1 || conflicts[0] !== 'dev-plans/INDEX.md') {
    runGit(['rebase', '--abort'], job.worktreeRoot);
    return {
      ok: false,
      reason: `promotion rebase has unsupported conflicts: ${conflicts.join(', ') || rebase.stderr}`,
    };
  }

  const relative = 'dev-plans/INDEX.md';
  const baseContent = gitFileAt(job.worktreeRoot, ':1', relative);
  const currentContent = gitFileAt(job.worktreeRoot, ':2', relative);
  const queuedContent = gitFileAt(job.worktreeRoot, ':3', relative);
  if (baseContent === null || currentContent === null || queuedContent === null) {
    runGit(['rebase', '--abort'], job.worktreeRoot);
    return { ok: false, reason: 'promotion index conflict stages are unreadable' };
  }
  fs.writeFileSync(
    path.join(job.worktreeRoot, relative),
    mergeDevPlansIndex(baseContent, currentContent, queuedContent),
    'utf8',
  );
  const added = runGit(['add', '--', relative], job.worktreeRoot);
  const continued = added.ok
    ? runGit(['-c', 'core.editor=true', 'rebase', '--continue'], job.worktreeRoot, {
        timeout: 20 * 60 * 1000,
      })
    : added;
  if (!continued.ok) {
    runGit(['rebase', '--abort'], job.worktreeRoot);
    return {
      ok: false,
      reason: `promotion index reconciliation failed: ${continued.stderr || continued.status}`,
    };
  }
  return { ok: true, rebased: true, reconciled: [relative] };
}

function originContainsSnapshot(job) {
  if (!job.gitLand || !job.gitLand.required) return { ok: true, failures: [] };
  const fetch = runGit(
    ['fetch', 'origin', 'master:refs/remotes/origin/master'],
    job.sourceRepoRoot,
  );
  if (!fetch.ok) {
    return {
      ok: false,
      proofUnavailable: true,
      failures: [`origin fetch failed: ${String(fetch.stderr || fetch.status)}`],
    };
  }
  const failures = [];
  let proofUnavailable = false;
  for (const row of job.gitLand.files || []) {
    const relative = normalizedRelative(row.relative);
    const listed = runGit(['ls-tree', 'origin/master', '--', relative], job.sourceRepoRoot);
    if (!listed.ok) {
      failures.push(`${relative} could not be read from origin/master: ${listed.stderr}`);
      proofUnavailable = true;
      continue;
    }
    if (row.deleted) {
      if (String(listed.stdout || '').trim())
        failures.push(`${relative} still exists on origin/master`);
      continue;
    }
    if (!String(listed.stdout || '').trim()) {
      failures.push(`${relative} is absent from origin/master`);
      continue;
    }
    const blob = runGit(['rev-parse', `origin/master:${relative}`], job.sourceRepoRoot);
    if (!blob.ok) {
      failures.push(`${relative} blob proof failed: ${blob.stderr}`);
      proofUnavailable = true;
      continue;
    }
    if (String(blob.stdout || '').trim() !== row.gitBlob) {
      const observed = gitFileAt(job.sourceRepoRoot, 'origin/master', relative);
      const semantic =
        observed === null ? null : semanticContributionProof(job, relative, observed);
      if (!semantic?.ok) {
        failures.push(
          semantic?.reason || `${relative} on origin/master does not match the queued Git blob`,
        );
      }
    }
  }
  return { ok: failures.length === 0, proofUnavailable, failures };
}

function runLandScript(worktreeRoot, sourceRepoRoot) {
  const landScript = path.join(worktreeRoot, 'scripts', 'land.js');
  if (!fs.existsSync(landScript)) {
    return { ok: false, output: `land script is missing: ${landScript}` };
  }
  const result = spawnSync(process.execPath, [landScript, '--apply'], {
    cwd: worktreeRoot,
    env: {
      ...process.env,
      NODE_PATH: [
        path.join(worktreeRoot, 'node_modules'),
        sourceRepoRoot ? path.join(sourceRepoRoot, 'node_modules') : '',
        process.env.NODE_PATH,
      ]
        .filter(Boolean)
        .join(path.delimiter),
    },
    encoding: 'utf8',
    timeout: 20 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n').slice(-4000),
  };
}

const LAND_CONFLICT_MAX_ATTEMPTS = 3;

function isConflictLikeReason(reason) {
  return /conflict|could not apply|rebase/i.test(String(reason || ''));
}

// preparePromotionBranchForLand() rebases the queued branch onto
// origin/master and only knows how to auto-resolve one conflict shape
// (dev-plans/INDEX.md row union). Any other conflicting path -- for example a
// generated state file (data/agent/memory-consolidation-state.json) that a
// second promotion mechanism (the deploy-time receipt reconciler) also
// touched on origin/master since this job was enqueued -- makes the rebase
// fail permanently, stranding an otherwise-clean job red until some
// unrelated later run happens to rebase cleanly (observed: memory_hygiene
// red for the ~2 days Aug 29-31 2026 on 6 straight rebase-conflict
// `attempt` failures, before finally landing Sep 1 05:00:40 with the exact
// SAME queued content -- proving the conflict was mechanical, not semantic).
//
// Recover mechanically: abandon the stale rebase, fetch+reset the worktree
// branch onto the CURRENT origin/master, and reapply the job's own already
// snapshotted queued file content (job.gitLand.files at job.headSha) on top
// of that fresh base as one new commit. This is "regenerate the outputs on
// top of current origin/master" -- the queued content is the proven,
// already-verified output of this run, so replaying it onto a non-stale
// parent is safe; it is not a second source of truth for what the content
// should be.
function regenerateQueuedFilesOntoOriginMaster(job) {
  const fetch = runGit(['fetch', 'origin', 'master:refs/remotes/origin/master'], job.worktreeRoot);
  if (!fetch.ok)
    return { ok: false, reason: `origin fetch failed: ${fetch.stderr || fetch.status}` };
  const reset = runGit(['reset', '--hard', 'origin/master'], job.worktreeRoot);
  if (!reset.ok) {
    return {
      ok: false,
      reason: `reset onto origin/master failed: ${reset.stderr || reset.status}`,
    };
  }
  for (const row of job.gitLand?.files || []) {
    const { absolute } = containedPath(job.worktreeRoot, row.relative);
    if (row.deleted) {
      if (fs.existsSync(absolute)) fs.rmSync(absolute);
      continue;
    }
    const content = gitFileAt(job.worktreeRoot, job.headSha, row.relative);
    if (content === null) {
      return {
        ok: false,
        reason: `queued content for ${row.relative} is unreadable at ${job.headSha}`,
      };
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
  }
  const add = runGit(['add', '--', ...(job.gitLand?.pathspecs || [])], job.worktreeRoot);
  if (!add.ok) return { ok: false, reason: `regenerate add failed: ${add.stderr}` };
  const staged = runGit(['diff', '--cached', '--name-only'], job.worktreeRoot);
  if (!String(staged.stdout || '').trim()) return { ok: true, regenerated: false };
  const commit = runGit(
    [
      'commit',
      '-m',
      `chore(scheduled): ${job.skillName} run outputs (regenerated on origin/master)\n\n` +
        'no-test-justification: scheduled scan outputs (data/memory), no production code',
    ],
    job.worktreeRoot,
  );
  if (!commit.ok) return { ok: false, reason: `regenerate commit failed: ${commit.stderr}` };
  return { ok: true, regenerated: true };
}

// Best-effort receipt for one land attempt/retry, appended to the same
// promotion queue ledger the outer drain loop already writes 'attempt'
// events to. A ledger-append failure must never block the retry loop.
function recordLandConflictReceipt(job, row) {
  try {
    appendEvent(queueFile(job.dataDir), {
      op: 'attempt',
      jobId: job.id,
      skillName: job.skillName,
      scheduleDate: job.scheduleDate,
      stage: 'land',
      ...row,
    });
  } catch {
    // best-effort receipt only
  }
}

// Bounded land retry with mechanical rebase-conflict recovery. Each attempt
// (and each regeneration) is receipted so the exact retry history is
// forensically visible in scheduled-skill-promotion-queue.jsonl instead of a
// silent internal loop.
function landWithConflictRecovery(
  job,
  { maxAttempts = LAND_CONFLICT_MAX_ATTEMPTS, runLand = runLandScript } = {},
) {
  let lastReason = 'land-not-attempted';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prepared = preparePromotionBranchForLand(job);
    const result = prepared.ok
      ? runLand(job.worktreeRoot, job.sourceRepoRoot)
      : { ok: false, output: prepared.reason };
    lastReason = result.reason || result.output || 'land failed';
    recordLandConflictReceipt(job, {
      ok: Boolean(result.ok),
      attempt,
      maxAttempts,
      reason: lastReason,
    });
    if (result.ok) return { ok: true, attempts: attempt };
    if (attempt === maxAttempts || !isConflictLikeReason(lastReason)) break;
    const regenerated = regenerateQueuedFilesOntoOriginMaster(job);
    if (!regenerated.ok) {
      lastReason = regenerated.reason;
      recordLandConflictReceipt(job, {
        ok: false,
        attempt,
        maxAttempts,
        stage: 'land-regenerate',
        reason: lastReason,
      });
      break;
    }
  }
  return {
    ok: false,
    reason: `land-conflict-retry-exhausted after ${maxAttempts} attempt(s): ${lastReason}`,
  };
}

function promoteGitStage(job, { allowedSourceRepoRoot } = {}) {
  const stage = job.gitLand;
  if (!stage || !stage.required) return { ok: true, skipped: true, proof: 'not-required' };
  assertGitPromotionRoots(job, allowedSourceRepoRoot);
  const isolation = proveWorktreeIsolation(job.worktreeRoot);
  if (!isolation || !isolation.proven) {
    return {
      ok: false,
      reason: `worktree isolation is not proven: ${isolation?.reason || 'unknown'}`,
    };
  }
  const snapshot = verifyGitPromotionSnapshot(job);
  if (!snapshot.ok) return { ok: false, reason: snapshot.failures.join('; ') };

  const scope = verifyPromotionScope(job);
  if (!scope.ok) return { ok: false, reason: scope.reason };
  const proofJob = scope.reconciledFiles.length
    ? {
        ...job,
        gitLand: {
          ...stage,
          files: [...stage.files, ...scope.reconciledFiles],
        },
      }
    : job;
  const already = originContainsSnapshot(proofJob);
  if (already.proofUnavailable) {
    return { ok: false, reason: already.failures.join('; ') };
  }
  if (already.ok) return { ok: true, skipped: true, proof: 'origin-master-content-hash' };

  // A file the enqueue-time snapshot never knew about (scope.reconciledPathspecs)
  // must ride along with the frozen pathspecs, or land only picks up the
  // originally-recorded files and leaves the reconciled path uncommitted, so
  // the worktree never goes clean and cleanup can never remove it.
  const landPathspecs = [...new Set([...stage.pathspecs, ...(scope.reconciledPathspecs || [])])];
  const dirty = gitText(['status', '--porcelain', '--', ...landPathspecs], job.worktreeRoot);
  let result;
  if (dirty) {
    result = landScanOutputs({
      repoRoot: job.worktreeRoot,
      pathspecs: landPathspecs,
      message: `chore(scheduled): ${job.skillName} run outputs`,
      purpose: `promotion-${job.skillName}`,
      log: () => {},
    });
  } else {
    result = landWithConflictRecovery(job);
  }
  if (!result.ok) return { ok: false, reason: result.reason || result.output || 'land failed' };
  const proven = originContainsSnapshot(proofJob);
  return proven.ok
    ? { ok: true, proof: 'origin-master-content-hash' }
    : { ok: false, reason: proven.failures.join('; ') };
}

function promoteArchiveStage(job) {
  const stage = job.runtimeArchive;
  if (!stage || !stage.required) return { ok: true, skipped: true, proof: 'not-required' };
  assertRuntimePromotionStage(job);
  const snapshot = verifySnapshot(stage.stagingDataDir, stage.files);
  if (!snapshot.ok) return { ok: false, reason: snapshot.failures.join('; ') };
  try {
    const result = archiveRuntimeArtifacts({
      skillName: job.skillName,
      runtimeDataDir: stage.stagingDataDir,
      scheduleDate: job.scheduleDate,
    });
    return result.ok
      ? { ok: true, proof: 'versioned-s3-manifest', manifest: result.manifestReceipt }
      : { ok: false, reason: result.reason || 'runtime archive returned non-green' };
  } catch (error) {
    return { ok: false, reason: String(error.message || error) };
  }
}

function promotePublishStage(job) {
  const stage = job.runtimePublish;
  if (!stage || !stage.required) return { ok: true, skipped: true, proof: 'not-required' };
  assertRuntimePromotionStage({
    ...job,
    runtimeArchive: { stagingDataDir: stage.stagingDataDir },
  });
  const snapshot = verifySnapshot(stage.stagingDataDir, stage.files);
  if (!snapshot.ok) return { ok: false, reason: snapshot.failures.join('; ') };
  try {
    const result = publishRuntimeArtifacts({
      skillName: job.skillName,
      stagingDataDir: stage.stagingDataDir,
      runtimeDataDir: job.dataDir,
      scheduleDate: job.scheduleDate,
    });
    return result.ok
      ? { ok: true, proof: 'published-snapshot', files: result.files }
      : { ok: false, reason: (result.failures || []).join('; ') || 'runtime publish failed' };
  } catch (error) {
    return { ok: false, reason: String(error.message || error) };
  }
}

function promoteLiveReadStage(job) {
  const stage = job.runtimeLiveRead;
  if (!stage || !stage.required) return { ok: true, skipped: true, proof: 'not-required' };
  assertRuntimePromotionStage({
    ...job,
    runtimeArchive: { stagingDataDir: stage.stagingDataDir },
  });
  try {
    const snapshot = verifySnapshot(stage.stagingDataDir, stage.files);
    if (!snapshot.ok) return { ok: false, reason: snapshot.failures.join('; ') };
    const historicalSnapshotDir = job.skillName === 'secondbrain-nightly-enhancement'
      ? preserveHistoricalNightlySnapshot({ stagingDataDir: stage.stagingDataDir, runtimeDataDir: job.dataDir, scheduleDate: job.scheduleDate })
      : null;
    return verifyPublishedRuntimeArtifacts({
      skillName: job.skillName,
      stagingDataDir: stage.stagingDataDir,
      runtimeDataDir: job.dataDir,
      scheduleDate: job.scheduleDate,
      historicalSnapshotDir,
    });
  } catch (error) {
    return { ok: false, reason: String(error.message || error) };
  }
}

// Before dated video research was registered as runtime state, the Sep 8
// producer left its already-complete receipt in the retained isolated
// worktree. Hydrate that exact receipt into the normal runtime promotion
// stage so the existing queue can publish/archive/live-read it without
// dispatching the research again. The source remains in the isolated
// worktree until every promotion stage succeeds; cleanup removes it only
// after the staged hash has been rechecked.
function recoverLegacyVideoRuntimePromotion(job) {
  if (
    job.skillName !== VIDEO_RESEARCH_SKILL ||
    job.runtimeArchive?.required ||
    job.runtimePublish?.required ||
    job.runtimeLiveRead?.required
  ) {
    return job;
  }
  const runtimeRel = runtimeFilesForSkill(job.skillName, job.scheduleDate)[0];
  if (!runtimeRel || runtimeRel.includes('<date>')) return job;
  const sourceRelative = normalizedRelative(path.join('data', runtimeRel));
  const source = path.resolve(job.worktreeRoot, sourceRelative);
  if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) return job;

  const safeId = String(job.id || 'legacy-video-research').replace(/[^A-Za-z0-9._-]+/g, '-');
  const stagingDataDir = path.join(job.dataDir, STAGING_RELATIVE_ROOT, `legacy-${safeId}`);
  if (fs.existsSync(stagingDataDir)) {
    assertRuntimePromotionStage({
      ...job,
      runtimeArchive: { stagingDataDir },
    });
    cleanupRuntimeArtifactsStage({
      stagingDataDir,
      runtimeDataDir: job.dataDir,
    });
  }
  const target = path.join(stagingDataDir, runtimeRel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  const validation = validateGenericRuntimeArtifacts(stagingDataDir, [runtimeRel], {
    skillName: job.skillName,
    scheduleDate: job.scheduleDate,
  });
  if (!validation.ok) {
    assertRuntimePromotionStage({
      ...job,
      runtimeArchive: { stagingDataDir },
    });
    cleanupRuntimeArtifactsStage({
      stagingDataDir,
      runtimeDataDir: job.dataDir,
    });
    return {
      ...job,
      legacyRuntimeRecoveryFailure: validation.failures.join('; '),
    };
  }
  const priorCompletedStages = new Set(job.queueState?.completedStages || []);
  const file = {
    relative: runtimeRel,
    deleted: false,
    sha256: sha256File(target),
    bytes: fs.statSync(target).size,
  };
  const stage = { required: true, stagingDataDir, files: [file] };
  return {
    ...job,
    runtimeStagingDataDir: stagingDataDir,
    runtimeArchive: stage,
    runtimePublish: stage,
    runtimeLiveRead: stage,
    queueState: {
      ...(job.queueState || {}),
      // The legacy queue recorded skipped publish/archive stages as complete
      // because video research was not yet a runtime-owned artifact. Those
      // checkpoints carry no publication proof and must be replayed now.
      completedStages: [...priorCompletedStages].filter(
        (stageName) => !['publish', 'archive', 'live-read'].includes(stageName),
      ),
    },
    ignoredRuntimePaths: [sourceRelative],
    legacyRuntimeRecovery: {
      sourceRelative,
      stagedRelative: runtimeRel,
    },
  };
}

function persistLegacyVideoRuntimeRecovery(job, effectiveJob, queueDataDir) {
  if (!effectiveJob.legacyRuntimeRecovery) return false;
  appendEvent(queueFile(queueDataDir), {
    op: 'legacy-runtime-recovery',
    jobId: job.id,
    skillName: job.skillName,
    scheduleDate: job.scheduleDate,
    runtimeStagingDataDir: effectiveJob.runtimeStagingDataDir,
    runtimeArchive: effectiveJob.runtimeArchive,
    runtimePublish: effectiveJob.runtimePublish,
    runtimeLiveRead: effectiveJob.runtimeLiveRead,
    ignoredRuntimePaths: effectiveJob.ignoredRuntimePaths,
    legacyRuntimeRecovery: effectiveJob.legacyRuntimeRecovery,
    completedStages: effectiveJob.queueState?.completedStages || [],
  });
  return true;
}

function cleanupCompletedJob(job, { queueDataDir } = {}) {
  assertQueuedDataRoot(job, queueDataDir);
  const results = [];
  let ok = true;
  let legacySourceReady = false;
  const runtimeStage = [job.runtimeArchive, job.runtimePublish, job.runtimeLiveRead].find(
    (stage) => stage && stage.required && stage.stagingDataDir,
  );
  if (job.legacyRuntimeRecovery) {
    try {
      const source = containedPath(job.worktreeRoot, job.legacyRuntimeRecovery.sourceRelative).absolute;
      const staged = runtimeStage
        ? containedPath(
            runtimeStage.stagingDataDir,
            job.legacyRuntimeRecovery.stagedRelative,
          ).absolute
        : '';
      if (fs.existsSync(source)) {
        if (!staged || !fs.existsSync(staged) || sha256File(source) !== sha256File(staged)) {
          throw new Error('legacy runtime source changed before cleanup');
        }
      }
      legacySourceReady = true;
    } catch (error) {
      results.push(`legacy-runtime-source-retained:${error.message}`);
      ok = false;
    }
  }
  const retainLegacyStage = Boolean(job.legacyRuntimeRecovery && !legacySourceReady);
  if (runtimeStage && fs.existsSync(runtimeStage.stagingDataDir) && !retainLegacyStage) {
    try {
      assertRuntimePromotionStage({
        ...job,
        runtimeArchive: { stagingDataDir: runtimeStage.stagingDataDir },
      });
      cleanupRuntimeArtifactsStage({
        stagingDataDir: runtimeStage.stagingDataDir,
        runtimeDataDir: job.dataDir,
      });
      results.push('runtime-stage-removed');
    } catch (error) {
      results.push(`runtime-stage-retained:${error.message}`);
      ok = false;
    }
  } else if (runtimeStage) {
    results.push(retainLegacyStage ? 'runtime-stage-retained:source-mismatch' : 'runtime-stage-absent');
  }
  if (ok && legacySourceReady && job.legacyRuntimeRecovery) {
    try {
      const source = containedPath(job.worktreeRoot, job.legacyRuntimeRecovery.sourceRelative).absolute;
      if (fs.existsSync(source)) fs.rmSync(source, { force: true });
      results.push('legacy-runtime-source-removed');
    } catch (error) {
      results.push(`legacy-runtime-source-retained:${error.message}`);
      ok = false;
    }
  }
  if (job.worktreeRoot && job.sourceRepoRoot && fs.existsSync(job.worktreeRoot)) {
    const status = runGit(['status', '--porcelain', '--untracked-files=all'], job.worktreeRoot);
    if (!status.ok || String(status.stdout || '').trim()) {
      results.push(status.ok ? 'worktree-retained-dirty' : 'worktree-retained-status-unproven');
      ok = false;
    } else {
      const remove = runGit(['worktree', 'remove', job.worktreeRoot], job.sourceRepoRoot, {
        timeout: 60_000,
      });
      results.push(remove.ok ? 'worktree-removed' : 'worktree-retained');
      if (remove.ok && job.branch) {
        const branch = runGit(['branch', '-d', '--', job.branch], job.sourceRepoRoot);
        results.push(
          branch.ok
            ? 'branch-deleted'
            : `branch-retained:${String(branch.stderr || branch.status).trim()}`,
        );
      }
      if (!remove.ok) ok = false;
    }
  }
  return { ok, results };
}

function promoteScheduledSkillJob(job, options = {}) {
  assertQueuedDataRoot(job, options.queueDataDir);
  const effectiveJob = recoverLegacyVideoRuntimePromotion(job);
  if (effectiveJob.legacyRuntimeRecoveryFailure) {
    return {
      ok: false,
      stage: 'publish',
      publish: { ok: false, reason: effectiveJob.legacyRuntimeRecoveryFailure },
    };
  }
  if (effectiveJob !== job) {
    persistLegacyVideoRuntimeRecovery(job, effectiveJob, options.queueDataDir);
    Object.assign(job, effectiveJob);
  }
  const completedStages = new Set(effectiveJob.queueState?.completedStages || []);
  const publish = completedStages.has('publish')
    ? { ok: true, skipped: true, proof: 'queued-stage-proof' }
    : promotePublishStage(effectiveJob);
  if (!publish.ok) return { ok: false, stage: 'publish', publish };
  const archive = completedStages.has('archive')
    ? { ok: true, skipped: true, proof: 'queued-stage-proof' }
    : promoteArchiveStage(effectiveJob);
  if (!archive.ok) return { ok: false, stage: 'archive', publish, archive };
  const land = completedStages.has('land')
    ? { ok: true, skipped: true, proof: 'queued-stage-proof' }
    : promoteGitStage(effectiveJob, options);
  if (!land.ok) return { ok: false, stage: 'land', publish, archive, land };
  const liveRead = completedStages.has('live-read')
    ? { ok: true, skipped: true, proof: 'queued-stage-proof' }
    : promoteLiveReadStage(effectiveJob);
  if (!liveRead.ok) {
    return { ok: false, stage: 'live-read', publish, archive, land, liveRead };
  }
  return { ok: true, publish, archive, land, liveRead };
}

function queueLeaseFile(file) {
  return `${file}.lease`;
}

function queueLeaseReclaimFile(leaseFile) {
  return `${leaseFile}.reclaim`;
}

function localBootIdentity(now = Date.now()) {
  let bootId = '';
  try {
    bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    // Windows and restricted Linux containers retain the conservative uptime proof.
  }
  return {
    hostname: os.hostname(),
    bootId,
    bootStartedAtMs: Math.max(0, Number(now) - Math.floor(os.uptime() * 1000)),
  };
}

function processState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error && error.code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

function processStartTicks(pid) {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return '';
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const startTicks = fields[19]; // proc stat field 22; fields begin at field 3.
    return /^\d+$/.test(startTicks || '') ? startTicks : '';
  } catch {
    return '';
  }
}

function leaseOwnerState(existing, {
  now = Date.now(),
  boot = localBootIdentity(now),
  getProcessState = processState,
  getProcessStartTicks = processStartTicks,
} = {}) {
  if (!existing || String(existing.hostname || '') !== boot.hostname) {
    return { state: 'unknown', reason: 'foreign-or-missing-host' };
  }
  const recordedBoot = String(existing.bootId || '');
  const acquiredAtMs = Number(existing.acquiredAtMs);
  const sameBoot = recordedBoot
    ? Boolean(boot.bootId && recordedBoot === boot.bootId)
    : Number.isFinite(acquiredAtMs) && acquiredAtMs >= boot.bootStartedAtMs;
  if (!sameBoot) return { state: 'unknown', reason: 'boot-unproven' };
  const pid = Number(existing.pid);
  const state = getProcessState(pid);
  if (state !== 'alive') return { state, reason: state === 'dead' ? 'dead-owner' : 'unreadable-owner' };
  const recordedStart = String(existing.processStartTicks || '');
  if (!recordedStart) return { state: 'alive', reason: 'legacy-live-owner' };
  const currentStart = String(getProcessStartTicks(pid) || '');
  if (!currentStart) return { state: 'unknown', reason: 'process-start-unreadable' };
  return currentStart === recordedStart
    ? { state: 'alive', reason: 'matching-owner' }
    : { state: 'dead', reason: 'pid-reused' };
}

function waitForLeaseChange(deadline) {
  if (Date.now() >= deadline) return false;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  return true;
}

function reclaimLease(file, expectedRaw, { now = Date.now(), boot = localBootIdentity(now) } = {}) {
  const reclaimFile = queueLeaseReclaimFile(file);
  let fd;
  try {
    fd = fs.openSync(reclaimFile, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      hostname: boot.hostname,
      bootId: boot.bootId,
      processStartTicks: processStartTicks(process.pid),
      acquiredAtMs: now,
    }) + '\n');
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    let current;
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return true;
      throw error;
    }
    if (current !== expectedRaw) return false;
    const staleDir = path.join(path.dirname(file), 'scheduled-skill-promotion-quarantine');
    fs.mkdirSync(staleDir, { recursive: true });
    const staleFile = path.join(staleDir, `${path.basename(file)}.stale-${crypto.randomBytes(16).toString('hex')}`);
    // The reclaim file is an exclusive compare-and-swap fence. New acquirers
    // wait for it, then this atomic rename moves only the bytes just verified.
    fs.renameSync(file, staleFile);
    return true;
  } finally {
    try { fs.unlinkSync(reclaimFile); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  }
}

function acquireQueueLease(file, {
  now,
  ttlMs = LEASE_TTL_MS,
  waitMs = 0,
  boot,
  getProcessState,
  getProcessStartTicks,
} = {}) {
  const leaseFile = queueLeaseFile(file);
  const reclaimFile = queueLeaseReclaimFile(leaseFile);
  fs.mkdirSync(path.dirname(leaseFile), { recursive: true });
  const token = crypto.randomBytes(16).toString('hex');
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  for (;;) {
    const observedNow = Number.isFinite(now) ? Number(now) : Date.now();
    const localBoot = boot || localBootIdentity(observedNow);
    if (fs.existsSync(reclaimFile)) {
      let reclaimOwnerState = { state: 'unknown', reason: 'unreadable-reclaim-fence' };
      try {
        reclaimOwnerState = leaseOwnerState(JSON.parse(fs.readFileSync(reclaimFile, 'utf8')), {
          now: observedNow,
          boot: localBoot,
          getProcessState,
          getProcessStartTicks,
        });
      } catch {
        // A crashed or malformed reclaimer needs attended reconciliation; an
        // automatic rename could move a replacement fence created concurrently.
      }
      if (!waitForLeaseChange(deadline)) {
        return {
          ok: false,
          file: leaseFile,
          reclaiming: true,
          reason: 'reclaim-fence-attended-reconciliation-required',
          reclaimOwnerState,
        };
      }
      continue;
    }
    const row = {
      token,
      pid: process.pid,
      hostname: localBoot.hostname,
      bootId: localBoot.bootId,
      processStartTicks: processStartTicks(process.pid),
      acquiredAtMs: observedNow,
    };
    try {
      const fd = fs.openSync(leaseFile, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(row) + '\n', 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      // A stale-owner reclaimer fences this transition before renaming the
      // old lease. Do not create a new owner behind that fence.
      if (fs.existsSync(reclaimFile)) {
        fs.unlinkSync(leaseFile);
        if (!waitForLeaseChange(deadline)) return { ok: false, file: leaseFile, reclaiming: true };
        continue;
      }
      return { ok: true, file: leaseFile, token };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      let existing;
      let existingRaw;
      try {
        existingRaw = fs.readFileSync(leaseFile, 'utf8');
        existing = JSON.parse(existingRaw);
      } catch (readError) {
        const ageMs = observedNow - fs.statSync(leaseFile).mtimeMs;
        if (ageMs < ttlMs) {
          throw new Error(`promotion lease is unreadable: ${readError.message || readError}`);
        }
        existing = null;
      }
      const owner = leaseOwnerState(existing, {
        now: observedNow,
        boot: localBoot,
        getProcessState,
        getProcessStartTicks,
      });
      // Time alone never steals a verified live or unprovable owner. A new
      // attempt needs same-host/boot PID proof before moving lease bytes.
      const reclaimable = owner.state === 'dead';
      if (reclaimable && reclaimLease(leaseFile, existingRaw, {
        now: observedNow,
        boot: localBoot,
      })) continue;
      if (!waitForLeaseChange(deadline)) {
        return { ok: false, file: leaseFile, owner: existing, ownerState: owner };
      }
    }
  }
}

function renewQueueLease(lease, now = Date.now()) {
  if (!lease || !lease.ok) throw new Error('cannot renew an unowned promotion lease');
  const current = JSON.parse(fs.readFileSync(lease.file, 'utf8'));
  if (current.token !== lease.token) {
    throw new Error('promotion lease token changed before renewal');
  }
  fs.writeFileSync(
    lease.file,
    JSON.stringify({ ...current, acquiredAtMs: Number(now) }) + '\n',
    'utf8',
  );
  return true;
}

function releaseQueueLease(lease) {
  if (!lease || !lease.ok) return false;
  try {
    const current = JSON.parse(fs.readFileSync(lease.file, 'utf8'));
    if (current.token !== lease.token) {
      throw new Error('promotion lease token changed while the executor was active');
    }
    fs.unlinkSync(lease.file);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    throw error;
  }
}

function enqueueScheduledSkillPromotion({
  skillName,
  scheduleDate,
  dataDir,
  sourceRepoRoot,
  worktreeRoot,
  branch,
  pathspecs = [],
  files = [],
  requireGitLand = false,
  runtimeStagingDataDir = '',
  requireRuntimeArchive = false,
  requireRuntimePublish = false,
  requireLiveRead = false,
  reason = '',
} = {}) {
  if (!skillName || !scheduleDate || !dataDir) {
    throw new Error('promotion enqueue requires skillName, scheduleDate, and dataDir');
  }
  const file = queueFile(dataDir);
  let resolvedBranch = branch || '';
  let headSha = '';
  let gitFiles = [];
  if (requireGitLand) {
    if (!worktreeRoot || !sourceRepoRoot || !pathspecs.length || !files.length) {
      throw new Error('Git promotion requires source/worktree roots, pathspecs, and files');
    }
    const isolation = proveWorktreeIsolation(worktreeRoot);
    if (!isolation || !isolation.proven) {
      throw new Error(
        `promotion worktree isolation is not proven: ${isolation?.reason || 'unknown'}`,
      );
    }
    assertGitPromotionRoots({ sourceRepoRoot, worktreeRoot }, sourceRepoRoot);
    resolvedBranch = resolvedBranch || gitText(['rev-parse', '--abbrev-ref', 'HEAD'], worktreeRoot);
    headSha = gitText(['rev-parse', 'HEAD'], worktreeRoot);
    gitFiles = snapshotGitFiles(worktreeRoot, files);
  }

  let runtimeFiles = [];
  if (requireRuntimePublish || requireRuntimeArchive || requireLiveRead) {
    if (!runtimeStagingDataDir) throw new Error('runtime promotion requires a staging root');
    assertRuntimePromotionStage({
      dataDir,
      runtimeArchive: { stagingDataDir: runtimeStagingDataDir },
    });
    if (worktreeRoot) {
      const isolation = proveWorktreeIsolation(worktreeRoot);
      if (!isolation || !isolation.proven) {
        throw new Error(
          `runtime promotion worktree isolation is not proven: ${isolation?.reason || 'unknown'}`,
        );
      }
      const recovered = recoverRuntimeArtifactsStage({
        skillName,
        stagingDataDir: runtimeStagingDataDir,
        fallbackDataDir: path.join(worktreeRoot, 'data'),
        runtimeDataDir: dataDir,
        scheduleDate,
      });
      if (!recovered.ok) {
        throw new Error(`runtime promotion source is invalid: ${recovered.failures.join('; ')}`);
      }
    }
    runtimeFiles = snapshotFiles(
      runtimeStagingDataDir,
      runtimeFilesForSkill(skillName, scheduleDate),
    );
    if (!runtimeFiles.length) throw new Error('runtime promotion has no registered files');
  }

  const identity = {
    skillName,
    scheduleDate,
    headSha,
    gitFiles,
    runtimeFiles,
    requireRuntimePublish: Boolean(requireRuntimePublish),
    requireRuntimeArchive: Boolean(requireRuntimeArchive),
    requireLiveRead: Boolean(requireLiveRead),
  };
  const id = sha256Buffer(JSON.stringify(identity));
  const job = {
    id,
    skillName,
    scheduleDate,
    createdAt: new Date().toISOString(),
    dataDir: path.resolve(dataDir),
    sourceRepoRoot: sourceRepoRoot ? path.resolve(sourceRepoRoot) : '',
    worktreeRoot: worktreeRoot ? path.resolve(worktreeRoot) : '',
    branch: resolvedBranch,
    headSha,
    inputHash: sha256Buffer(JSON.stringify({ gitFiles, runtimeFiles })),
    reason,
    gitLand: {
      required: Boolean(requireGitLand),
      pathspecs: [...pathspecs].map(normalizedRelative),
      files: gitFiles,
    },
    runtimeArchive: {
      required: Boolean(requireRuntimeArchive),
      stagingDataDir: runtimeStagingDataDir ? path.resolve(runtimeStagingDataDir) : '',
      files: runtimeFiles,
    },
    runtimePublish: {
      required: Boolean(requireRuntimePublish),
      stagingDataDir: runtimeStagingDataDir ? path.resolve(runtimeStagingDataDir) : '',
      files: runtimeFiles,
    },
    runtimeLiveRead: {
      required: Boolean(requireLiveRead),
      stagingDataDir: runtimeStagingDataDir ? path.resolve(runtimeStagingDataDir) : '',
      files: runtimeFiles,
    },
  };
  const lease = acquireQueueLease(file, { waitMs: 30_000 });
  if (!lease.ok) throw new Error('promotion enqueue could not acquire the queue lease');
  try {
    repairCorruptTail(file);
    const existing = promotionStates(file).get(id);
    if (existing) {
      return { queued: false, duplicate: true, job: jobWithQueueState(existing), file };
    }
    appendEvent(file, { op: 'enqueue', job });
    return { queued: true, duplicate: false, job, file };
  } finally {
    releaseQueueLease(lease);
  }
}

function drainScheduledSkillPromotions({
  dataDir,
  scheduleDate = '',
  skillName = '',
  maxJobs = 4,
  promote = promoteScheduledSkillJob,
  allowedSourceRepoRoot,
  resolveSourceRoot = resolveCodexSourceRoot,
} = {}) {
  const file = queueFile(dataDir);
  const numericMaxJobs = Number(maxJobs);
  if (!Number.isInteger(numericMaxJobs) || numericMaxJobs <= 0) {
    throw new Error('promotion drain maxJobs must be a positive integer');
  }
  const lease = acquireQueueLease(file);
  if (!lease.ok) {
    return {
      file,
      busy: true,
      attempted: [],
      completed: [],
      cleanup: [],
      pending: [],
      pendingUnobserved: true,
    };
  }
  const completed = [];
  const attempted = [];
  const cleanup = [];
  let pending = [];
  try {
    repairCorruptTail(file);
    const resolvedSource = allowedSourceRepoRoot || resolveSourceRoot(MODULE_REPO_ROOT).repoRoot;
    const matchesRequestedJob = (job) =>
      (!scheduleDate || job.scheduleDate === scheduleDate) &&
      (!skillName || job.skillName === skillName);
    const cleanupOne = (job) => {
      renewQueueLease(lease);
      const result = cleanupCompletedJob(job, { queueDataDir: dataDir });
      cleanup.push({ job, result });
      if (result.ok) {
        appendEvent(file, {
          op: 'cleanup-complete',
          jobId: job.id,
          skillName: job.skillName,
          scheduleDate: job.scheduleDate,
          result,
        });
      }
    };
    for (const job of pendingCleanupJobs(file).filter(matchesRequestedJob)) cleanupOne(job);

    const selected = pendingPromotions(file).filter(matchesRequestedJob).slice(0, numericMaxJobs);
    for (const job of selected) {
      renewQueueLease(lease);
      let result;
      try {
        result = promote(job, {
          allowedSourceRepoRoot: resolvedSource,
          queueDataDir: dataDir,
        });
      } catch (error) {
        result = { ok: false, stage: 'unknown', reason: String(error.message || error) };
      }
      attempted.push({ job, result });
      appendEvent(file, {
        op: 'attempt',
        jobId: job.id,
        skillName: job.skillName,
        scheduleDate: job.scheduleDate,
        ok: Boolean(result && result.ok),
        result,
      });
      const previouslyComplete = new Set(job.queueState?.completedStages || []);
      if (result?.publish?.ok && !previouslyComplete.has('publish')) {
        appendEvent(file, {
          op: 'stage-complete',
          stage: 'publish',
          jobId: job.id,
          skillName: job.skillName,
          scheduleDate: job.scheduleDate,
          proof: result.publish,
        });
      }
      if (result?.archive?.ok && !previouslyComplete.has('archive')) {
        appendEvent(file, {
          op: 'stage-complete',
          stage: 'archive',
          jobId: job.id,
          skillName: job.skillName,
          scheduleDate: job.scheduleDate,
          proof: result.archive,
        });
      }
      if (result?.land?.ok && !previouslyComplete.has('land')) {
        appendEvent(file, {
          op: 'stage-complete',
          stage: 'land',
          jobId: job.id,
          skillName: job.skillName,
          scheduleDate: job.scheduleDate,
          proof: result.land,
        });
      }
      if (result?.liveRead?.ok && !previouslyComplete.has('live-read')) {
        appendEvent(file, {
          op: 'stage-complete',
          stage: 'live-read',
          jobId: job.id,
          skillName: job.skillName,
          scheduleDate: job.scheduleDate,
          proof: result.liveRead,
        });
      }
      if (result && result.ok) {
        appendEvent(file, {
          op: 'complete',
          jobId: job.id,
          skillName: job.skillName,
          scheduleDate: job.scheduleDate,
          inputHash: job.inputHash,
          proof: result,
        });
        completed.push({ job, result });
        cleanupOne(job);
      }
    }
    pending = pendingPromotions(file);
  } finally {
    releaseQueueLease(lease);
  }
  return {
    file,
    attempted,
    completed,
    cleanup,
    pending,
  };
}

module.exports = {
  EVENT_SCHEMA,
  LEASE_TTL_MS,
  QUEUE_BASENAME,
  acquireQueueLease,
  discoverGitPromotionFiles,
  drainScheduledSkillPromotions,
  enqueueScheduledSkillPromotion,
  pendingPromotions,
  pendingCleanupJobs,
  promotionStates,
  promoteScheduledSkillJob,
  recoverLegacyVideoRuntimePromotion,
  persistLegacyVideoRuntimeRecovery,
  cleanupCompletedJob,
  promoteLiveReadStage,
  queueFile,
  readEvents,
  releaseQueueLease,
  renewQueueLease,
  snapshotGitFiles,
  snapshotFiles,
  verifyPromotionScope,
  preparePromotionBranchForLand,
  landWithConflictRecovery,
  regenerateQueuedFilesOntoOriginMaster,
  originContainsSnapshot,
  verifySnapshot,
};
