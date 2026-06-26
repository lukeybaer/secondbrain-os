'use strict';

// Worktree-isolated heal session (step-3 safety, closes the gap that kept the
// orchestrator sequential). To fan out heal sessions in parallel safely, each
// session must run in its OWN git checkout so concurrent file edits do not collide,
// and the landing (push to master) must serialize so two heals never race the remote.
//
// This runs one heal session in a fresh worktree cut from origin/master: the session
// edits files there (told NOT to commit or push), and the coordinator commits,
// rebases onto the latest origin/master, then pushes HEAD:master inside the caller's
// serializer so only one heal lands at a time. The worktree is always cleaned up.
//
// All git ops and the session runner are injectable so the orchestration is unit-
// testable without real git or a real claude session.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const DEFAULT_CLEANUP_GIT_TIMEOUT_MS = 15_000;

function defaultGit(args, cwd, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs || DEFAULT_GIT_TIMEOUT_MS,
  });
}

function cleanupGit(git, args, cwd, timeoutMs) {
  try {
    git(args, cwd, { timeoutMs });
  } catch (e) {
    /* best effort */
  }
}

function normalizeAbs(p, base) {
  const raw = String(p || '');
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base || '', raw);
  return resolved.replace(/\\/g, '/').toLowerCase();
}

function isSameOrInside(candidate, root) {
  const rel = path.posix.relative(normalizeAbs(root), normalizeAbs(candidate, root));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.posix.isAbsolute(rel));
}

function assertSafeGeneratedWorktreeTarget(wt, repoRoot) {
  const rawWt = String(wt || '');
  const absWt = path.isAbsolute(rawWt) ? path.resolve(rawWt) : path.resolve(repoRoot || '', rawWt);
  const absRepo = path.resolve(String(repoRoot || ''));
  if (!path.basename(absWt).startsWith('sb-heal-')) {
    throw new Error(`refusing unsafe self-heal worktree target: ${absWt}`);
  }
  if (isSameOrInside(absWt, absRepo) || isSameOrInside(absRepo, absWt)) {
    throw new Error(`refusing self-heal cleanup near coordinator repo: ${absWt}`);
  }
}

function slugify(s) {
  return (
    String(s || 'heal')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'heal'
  );
}

function gitTrim(git, args, cwd, opts = {}) {
  try {
    return String(git(args, cwd, opts) || '').trim();
  } catch {
    return '';
  }
}

function isGenuineWallResult(result) {
  const attempts = Array.isArray(result && result.attempts) ? result.attempts : [];
  if ((result && result.category) === 'genuine-wall') return true;
  if (attempts.length && attempts.every((a) => a && a.category === 'genuine-wall')) return true;
  const reason = String(
    (result && (result.escalationReason || result.escalation_reason || result.summary)) || '',
  );
  return /\b(ExampleCo|credential|password|api[\s-]?key|approve|approval|decision|decide|consent)\b|external\s+(?:approval|decision|access|account|credential|permission|consent)\b/i.test(
    reason,
  );
}

function isSelfHealFalseClearBlocker(blocker) {
  return /SELF-HEAL-FALSE-CLEAR|false-clear loop/i.test(blockerClueText(blocker));
}

function falseClearSurvivorGroups(blocker) {
  const evidence = blockerClueText(blocker);
  const survived = evidence.match(/survived live QC:\s*([\s\S]*?)(?:\.\s*Live QC|\.\s*Recent|\.\s*Worker|$)/i);
  const text = survived ? survived[1] : evidence;
  return [...text.matchAll(/Live render QC ([A-Z0-9-]+) on ([a-z0-9_]+)/gi)].map((match) => ({
    label: `Live render QC ${String(match[1] || '').toUpperCase()} on ${String(match[2] || '').toLowerCase()}`,
    defectType: String(match[1] || '').toLowerCase(),
    cardId: String(match[2] || '').toLowerCase(),
  }));
}

function coversFalseClearSurvivorGroups(text, blocker) {
  const groups = falseClearSurvivorGroups(blocker);
  if (!groups.length) return true;
  const haystack = String(text || '').toLowerCase();
  return groups.every((group) => haystack.includes(String(group.label || '').toLowerCase()));
}

function falseClearLiveQcDefectCount(blocker) {
  const evidence = blockerClueText(blocker);
  const match = evidence.match(/Live QC still reports\s+(\d+)\s+defect/i);
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isFinite(count) ? count : null;
}

function coversFalseClearLiveQcCount(text, blocker) {
  const count = falseClearLiveQcDefectCount(blocker);
  if (count == null) return true;
  const haystack = String(text || '').toLowerCase();
  const n = String(count).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\bauthenticated\\s+live\\s+qc[\\s\\S]{0,80}\\b${n}\\s+defect`, 'i').test(
    haystack,
  );
}

function coversFalseClearSurvivorContractInOneField(texts, blocker) {
  const groups = falseClearSurvivorGroups(blocker);
  const count = falseClearLiveQcDefectCount(blocker);
  if (!groups.length && count == null) return true;
  return (texts || []).some((text) => {
    const chunk = String(text || '');
    return (
      (!groups.length || coversFalseClearSurvivorGroups(chunk, blocker)) &&
      (count == null || coversFalseClearLiveQcCount(chunk, blocker))
    );
  });
}

function falseClearProofRejectionReason(blocker) {
  const groups = falseClearSurvivorGroups(blocker)
    .map((group) => `${group.defectType} on ${group.cardId}`)
    .join(', ');
  const count = falseClearLiveQcDefectCount(blocker);
  return [
    'false-clear proof rejected: final verification/reflection must name each current survivor group',
    groups ? `(${groups})` : '',
    count == null ? '' : `and authenticated live QC count (${count} defects)`,
  ]
    .filter(Boolean)
    .join(' ');
}

function boundedTranscriptText(s) {
  return String(s || '').slice(-3000);
}

function hasUnresolvedFailureProof(proofText) {
  const text = String(proofText || '');
  if (!text) return false;
  const acceptedBeforeAfter = /\b(?:assertion|test|check|verification|command|node)?\s*failed before (?:the )?fix\b[\s\S]{0,240}\b(?:pass(?:ed|ing)?|green|verified)\b/gi;
  const scan = text.replace(acceptedBeforeAfter, '');
  return /\b(?:(?:tests?|verification|command|check|assertion|vitest)\s+(?:failed|failing)|(?:still|currently|remains?)\s+(?:failed|failing|red)|not\s+run|no\s+tests?)\b/i.test(
    scan,
  );
}

function hasVerificationEvidence(result, blocker = null) {
  const attemptTexts = Array.isArray(result && result.attempts)
    ? result.attempts
        .flatMap((a) => [
          a && a.tests,
          a && a.verification,
          a && a.summary,
          a && a.stdoutTail,
          a && a.stderrTail,
        ])
        .filter(Boolean)
    : [];
  const proofTexts = result
    ? [
        result.tests,
        result.verification,
        boundedTranscriptText(result.stdout),
        boundedTranscriptText(result.stderr),
        result.stdoutTail,
        result.stderrTail,
      ]
        .filter(Boolean)
        .concat(
          Array.isArray(result.attempts)
            ? result.attempts
                .flatMap((a) => [
                  a && a.tests,
                  a && a.verification,
                  a && a.stdoutTail,
                  a && a.stderrTail,
                ])
                .filter(Boolean)
            : [],
        )
    : [];
  const directTexts = result
    ? [
        result.tests,
        result.verification,
        result.summary,
        result.reflection,
        boundedTranscriptText(result.stdout),
        boundedTranscriptText(result.stderr),
        result.stdoutTail,
        result.stderrTail,
      ].filter(Boolean)
    : [];
  const text = [...directTexts, ...attemptTexts].join('\n').slice(-6000);
  const proofText = proofTexts.join('\n').slice(-3000);
  if (!text) return false;
  if (hasUnresolvedFailureProof(proofText)) return false;
  const hasPassingProof =
    /\b(?:pass(?:ed|ing)?|green|verified|verification\s+passed|tests?\s+passed|vitest\s+green)\b/i.test(
      proofText || text,
    );
  if (!hasPassingProof) return false;
  if (!isSelfHealFalseClearBlocker(blocker)) return true;
  const hasMechanismProof =
    /\b(?:self[-\s]?heal|verifier|publish[-\s]?refresh|proof\s+contract|loop\s+planner|same\s+card\s+retr(?:y|ies)|false[-\s]?clear\s+survivors?)\b/i.test(
      text,
    );
  return (
    hasMechanismProof &&
    coversFalseClearSurvivorContractInOneField(directTexts, blocker)
  );
}

function shouldAutoCommitDirtyWorkerDiff(result) {
  return !isGenuineWallResult(result) && hasVerificationEvidence(result);
}

function collectWorkerLandingDiff(git, wt, baseSha, headSha) {
  const chunks = [];
  const addDiff = (args) => {
    try {
      const text = String(git(args, wt, { timeoutMs: DEFAULT_GIT_TIMEOUT_MS }) || '').trim();
      if (text) chunks.push(text);
    } catch (e) {
      /* best effort */
    }
  };
  if (baseSha && headSha && headSha !== baseSha) {
    addDiff(['diff', `${baseSha}..${headSha}`]);
  }
  addDiff(['diff']);
  addDiff(['diff', '--cached']);
  return chunks.join('\n');
}

function blockerClueText(blocker) {
  return [
    blocker && blocker.title,
    blocker && blocker.evidence,
    blocker && blocker.requirement,
    blocker && blocker.repair,
    ...(Array.isArray(blocker && blocker.rawDefects) ? blocker.rawDefects : []),
  ]
    .filter(Boolean)
    .map(String)
    .join('\n');
}

function isRedCardStatusDemotion({ blocker, diffText } = {}) {
  const clue = blockerClueText(blocker);
  if (!/\bBLOCKED-TILE\b/i.test(clue)) return false;
  const diff = String(diffText || '');
  if (!diff.trim()) return false;
  const removedRedStatus = /^-\s*(?:status\s*:|.*\bstatus\s*:).*['"]red['"]/im.test(diff);
  const addedYellowGreenStatus = /^\+\s*(?:status\s*:|.*\bstatus\s*:)(?!.*['"]red['"]).*['"]yellow['"].*['"]green['"]/im.test(
    diff,
  );
  const addedAntiRedAssertion = /^\+.*(?:not\.toContain|without turning|does not hard-block).*red/im.test(
    diff,
  );
  return removedRedStatus && (addedYellowGreenStatus || addedAntiRedAssertion);
}

function validateWorkerDiffBeforeLanding(blocker, { diffText } = {}) {
  if (isRedCardStatusDemotion({ blocker, diffText })) {
    return {
      ok: false,
      kind: 'red-card-status-demotion',
      reason:
        'red-card-status-demotion: BLOCKED-TILE workers must not clear live red cards by changing the renderer/test from red to yellow/green; fix the underlying source or escalate',
    };
  }
  return { ok: true };
}

function selfHealCommitMessage(blocker) {
  const id = slugify((blocker && (blocker.blocker_id || blocker.title)) || 'briefing-blocker');
  return `fix(briefing): self-heal ${id}`.slice(0, 72);
}

function trimGitError(e, n = 200) {
  return String((e && e.message) || e || '').slice(0, n);
}

function cleanLandingInfrastructure(git, wt) {
  // node_modules is a linked verification helper inside worker checkouts. It
  // must never keep the checkout dirty or land as source.
  git(['reset', '--', 'node_modules'], wt);
  git(['clean', '-fd', '--', 'node_modules'], wt);
}

function commitWorkerDiff(git, wt, blocker, opts = {}) {
  let autoCommitError = '';
  git(['add', '-A'], wt);
  if (!opts.infrastructureAlreadyCleaned) {
    cleanLandingInfrastructure(git, wt);
  }
  try {
    git(['diff', '--cached', '--check'], wt);
  } catch (e) {
    autoCommitError = `diff --check: ${trimGitError(e, 180)}`;
  }
  git(['commit', '-m', selfHealCommitMessage(blocker)], wt);
  return { autoCommitError };
}

// runIsolatedHealSession(blocker, opts):
//   opts.repoRoot   - the shared repo (where `git worktree add` runs)
//   opts.runSession - async (blocker, sessionOpts) => result  (the claude/codex run)
//   opts.serialize  - (fn) => Promise  (the orchestrator's git-landing mutex)
//   opts.uniq       - a unique token for the branch/worktree (e.g. index)
//   opts.git, opts.worktreeRoot - injectable for tests
// Returns the session result augmented with { pushed, branch } (pushed reflects the
// serialized landing, not the session's self-report).
async function runIsolatedHealSession(blocker, opts = {}) {
  const repoRoot = opts.repoRoot;
  const runSession = opts.runSession;
  const serialize = opts.serialize || ((fn) => fn());
  const git = opts.git || defaultGit;
  const worktreeRoot = opts.worktreeRoot || os.tmpdir();
  const dependencyRoot = opts.dependencyRoot || repoRoot;
  const afterPush = opts.afterPush || null;
  const cleanupGitTimeoutMs = opts.cleanupGitTimeoutMs || DEFAULT_CLEANUP_GIT_TIMEOUT_MS;
  const id = slugify(blocker && blocker.title);
  const uniq = String(opts.uniq != null ? opts.uniq : id);
  // branch/wt are LET because an un-removable leftover dir forces a unique-suffixed retry
  // (see the worktree-add try/catch below). Deterministic in the happy path (uniq -> name).
  let branch = `heal/${id}-${uniq}`.replace(/[^a-zA-Z0-9/_-]/g, '-');
  let wt = path.join(worktreeRoot, `sb-heal-${id}-${uniq}`);
  // Injectable so the retry path is testable; real default is a base36 timestamp token.
  const uniqueSuffix = opts.uniqueSuffix || (() => Date.now().toString(36));

  const linkDeps = opts.linkDeps || ((target, link) => fs.symlinkSync(target, link, 'junction'));
  let originalBaseSha = '';
  // Physically remove an orphaned worktree directory. A run killed before its finally
  // (Ctrl-C, session compaction, OOM) leaves the worktree DIR on disk while git no
  // longer registers it; `git worktree remove`/`prune` cannot delete an unregistered
  // dir, so the next `git worktree add` aborts "already exists" and EVERY heal escalates
  // in seconds with 0 worktrees (observed live 2026-06-16). rmrf the target before add.
  const rmrf =
    opts.rmrf ||
    ((p) => {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (e) {
        /* best effort */
      }
    });
  // SERIALIZE worktree creation. `git worktree add` (plus the pre-clean remove/prune
  // and branch delete) all write the shared .git (index.lock, the worktree registry),
  // so running them concurrently RACES and fails (observed live 2026-06-15: a parallel
  // run escalated all 3 blockers in 4s with 0 worktrees, while a manual add worked).
  // Only the SESSION work runs in parallel; every git op serializes through this mutex.
  // Pre-clean removes any leftover worktree/branch with this exact name from a prior
  // interrupted run so the add cannot fail on a name collision.
  await serialize(async () => {
    assertSafeGeneratedWorktreeTarget(wt, repoRoot);
    cleanupGit(git, ['worktree', 'remove', wt, '--force'], repoRoot, cleanupGitTimeoutMs);
    cleanupGit(git, ['worktree', 'prune'], repoRoot, cleanupGitTimeoutMs);
    cleanupGit(git, ['branch', '-D', branch], repoRoot, cleanupGitTimeoutMs);
    // Orphaned-dir guard: git's remove/prune above only clean registered worktrees; an
    // unregistered leftover dir survives and makes the add fail. Delete it physically.
    rmrf(wt);
    try {
      git(['worktree', 'add', '-b', branch, wt, 'origin/master'], repoRoot);
      originalBaseSha = gitTrim(git, ['rev-parse', 'HEAD'], wt);
    } catch (e) {
      // A killed run can leave a worktree dir whose holder process keeps it EPERM-locked,
      // so rmrf above fails silently and `git worktree add` still aborts "already exists",
      // escalating EVERY heal in seconds (observed live 2026-06-16). Don't escalate: cut a
      // FRESH unique-suffixed branch/worktree and retry the add so this heal still runs.
      const altUniq = `${uniq}-${uniqueSuffix()}`;
      branch = `heal/${id}-${altUniq}`.replace(/[^a-zA-Z0-9/_-]/g, '-');
      wt = path.join(worktreeRoot, `sb-heal-${id}-${altUniq}`);
      assertSafeGeneratedWorktreeTarget(wt, repoRoot);
      rmrf(wt);
      git(['worktree', 'add', '-b', branch, wt, 'origin/master'], repoRoot);
      originalBaseSha = gitTrim(git, ['rev-parse', 'HEAD'], wt);
    }
    // Junction node_modules from the shared repo so the session can run vitest/npx (a
    // fresh worktree has none); without this the session cannot verify and burns budget.
    try {
      linkDeps(path.join(dependencyRoot, 'node_modules'), path.join(wt, 'node_modules'));
    } catch (e) {
      /* best effort: non-Windows or already-linked */
    }
  });
  let preserveFailedLanding = false;
  let preservedLandingWorktree = '';
  let preservedLandingBranch = '';
  try {
    const result = await runSession(blocker, {
      ...opts.sessionOpts,
      repoRoot: wt,
      cwd: wt,
      noPush: true,
      budgetMs: opts.budgetMs,
      deadlineIso: opts.deadlineIso,
      coordinatorRoot: repoRoot,
      protectedRoots: [repoRoot],
      branchSummary: branch,
      uniq,
    });
    // Ground truth over self-report: a worker can finish useful edits but fail
    // the machine contract. Codex workers also cannot commit from a workspace
    // sandbox because a git worktree's metadata lives under the coordinator
    // repo's .git/worktrees directory, outside the worker write scope. Keep git
    // authority here: if the isolated checkout is dirty and the session did not
    // hit a genuine owner wall and left verification evidence, commit that dirty
    // diff in the coordinator before landing.
    let headSha = gitTrim(git, ['rev-parse', 'HEAD'], wt);
    let baseSha = originalBaseSha;
    let dirtyStatus = gitTrim(git, ['status', '--porcelain'], wt);
    const landingDiff = collectWorkerLandingDiff(git, wt, baseSha, headSha);
    const landingValidation = validateWorkerDiffBeforeLanding(blocker, { diffText: landingDiff });
    if (!landingValidation.ok) {
      const { escalation_reason, ...resultForReturn } = result || {};
      return {
        ...resultForReturn,
        status: 'escalated',
        pushed: false,
        branch,
        committed: false,
        autoCommitted: false,
        landingAutoCommitted: false,
        dirtyStatus: dirtyStatus || '',
        deploy: null,
        deployError: '',
        landingError: '',
        preservedWorktree: '',
        preservedBranch: '',
        escalationReason: landingValidation.reason,
        rejectedDiffGuard: landingValidation.kind,
        autoCommitError: '',
        commit_sha: '',
      };
    }
    const selfStatus = String((result && result.status) || 'escalated').toLowerCase();
    const existingCommit = !!(headSha && baseSha && headSha !== baseSha);
    const falseClearProofRejected =
      selfStatus === 'cleared' &&
      isSelfHealFalseClearBlocker(blocker) &&
      !hasVerificationEvidence(result, blocker);
    if (falseClearProofRejected) {
      if (dirtyStatus || existingCommit) {
        preserveFailedLanding = true;
        preservedLandingWorktree = wt;
        preservedLandingBranch = branch;
      }
      const { escalation_reason, ...resultForReturn } = result || {};
      return {
        ...resultForReturn,
        status: 'escalated',
        pushed: false,
        branch,
        committed: existingCommit,
        autoCommitted: false,
        landingAutoCommitted: false,
        dirtyStatus: dirtyStatus || '',
        deploy: null,
        deployError: '',
        landingError: '',
        preservedWorktree: preserveFailedLanding ? preservedLandingWorktree : '',
        preservedBranch: preserveFailedLanding ? preservedLandingBranch : '',
        escalationReason: falseClearProofRejectionReason(blocker),
        rejectedDiffGuard: 'false-clear-proof',
        autoCommitError: '',
        commit_sha: '',
      };
    }
    let autoCommitted = false;
    let landingAutoCommitted = false;
    let autoCommitError = '';
    if (
      headSha &&
      baseSha &&
      headSha === baseSha &&
      dirtyStatus &&
      !isGenuineWallResult(result) &&
      hasVerificationEvidence(result, blocker)
    ) {
      try {
        const commitResult = commitWorkerDiff(git, wt, blocker);
        autoCommitError = commitResult.autoCommitError || autoCommitError;
        autoCommitted = true;
        headSha = gitTrim(git, ['rev-parse', 'HEAD'], wt);
        dirtyStatus = gitTrim(git, ['status', '--porcelain'], wt);
      } catch (e) {
        const message = trimGitError(e);
        autoCommitError = autoCommitError ? `${autoCommitError}; commit: ${message}` : message;
      }
    }
    const committed = !!(headSha && baseSha && headSha !== baseSha);
    let pushed = false;
    let deploy = null;
    let deployError = '';
    let landingError = '';
    if (committed) {
      // Serialized landing: only one heal rebases+pushes at a time.
      try {
        pushed = !!(await serialize(async () => {
          cleanLandingInfrastructure(git, wt);
          dirtyStatus = gitTrim(git, ['status', '--porcelain'], wt);
          if (dirtyStatus && !isGenuineWallResult(result) && hasVerificationEvidence(result, blocker)) {
            try {
              const commitResult = commitWorkerDiff(git, wt, blocker, {
                infrastructureAlreadyCleaned: true,
              });
              autoCommitError = [autoCommitError, commitResult.autoCommitError].filter(Boolean).join(
                '; ',
              );
              autoCommitted = true;
              landingAutoCommitted = true;
              headSha = gitTrim(git, ['rev-parse', 'HEAD'], wt) || headSha;
              dirtyStatus = gitTrim(git, ['status', '--porcelain'], wt);
            } catch (e) {
              const message = trimGitError(e);
              autoCommitError = autoCommitError
                ? `${autoCommitError}; landing commit: ${message}`
                : message;
              dirtyStatus = gitTrim(git, ['status', '--porcelain'], wt) || dirtyStatus;
            }
          }
          if (dirtyStatus) {
            // Caught by the outer landing-error handler, which preserves the
            // worker checkout for inspection instead of trying a dirty rebase.
            throw new Error(`worktree dirty before landing: ${dirtyStatus.slice(0, 180)}`);
          }
          git(['fetch', 'origin', 'master'], wt);
          git(['rebase', 'origin/master'], wt);
          headSha = gitTrim(git, ['rev-parse', 'HEAD'], wt) || headSha;
          git(['push', 'origin', 'HEAD:master'], wt);
          if (afterPush) {
            try {
              deploy = await Promise.resolve(
                afterPush({ worktree: wt, commitSha: headSha, baseSha, branch }),
              );
              if (deploy && deploy.ok === false) {
                deployError = String(deploy.error || 'deploy returned ok:false').slice(0, 200);
              }
            } catch (e) {
              deployError = String((e && e.message) || e).slice(0, 200);
              deploy = { ok: false, error: deployError };
            }
          }
          return true;
        }));
      } catch (e) {
        landingError = String((e && e.message) || e).slice(0, 240);
        preserveFailedLanding = true;
        preservedLandingWorktree = wt;
        preservedLandingBranch = branch;
        pushed = false;
      }
    }
    const unlandedClear = !pushed && selfStatus === 'cleared';
    const deployFailed = !!(deploy && deploy.ok === false);
    if (unlandedClear && dirtyStatus) {
      preserveFailedLanding = true;
      preservedLandingWorktree = wt;
      preservedLandingBranch = branch;
    }
    const status = deployFailed
      ? 'escalated'
      : pushed
        ? 'cleared'
        : unlandedClear
          ? 'escalated'
          : selfStatus;
    const escalationReason = unlandedClear
      ? committed
        ? `isolated session committed but landing push failed${landingError ? `: ${landingError}` : ''}`
        : dirtyStatus
          ? `isolated session reported cleared with dirty verified work but produced no commit to land${autoCommitError ? `: ${autoCommitError}` : ''}`
          : 'isolated session reported cleared but produced no commit to land'
      : deployFailed
        ? `isolated session pushed but deploy failed${deployError ? `: ${deployError}` : ''}`
        : (result && (result.escalationReason || result.escalation_reason)) || '';
    const { escalation_reason, ...resultForReturn } = result || {};
    return {
      ...resultForReturn,
      status,
      pushed,
      branch,
      committed,
      autoCommitted,
      landingAutoCommitted,
      dirtyStatus: dirtyStatus || '',
      deploy,
      deployError,
      landingError,
      preservedWorktree: preserveFailedLanding ? preservedLandingWorktree : '',
      preservedBranch: preserveFailedLanding ? preservedLandingBranch : '',
      escalationReason,
      autoCommitError,
      commit_sha: committed ? headSha : (result && result.commit_sha) || '',
    };
  } finally {
    if (preserveFailedLanding) {
      cleanupGit(git, ['worktree', 'prune'], repoRoot, cleanupGitTimeoutMs);
      console.error(
        `[isolated-heal-session] preserved failed landing worktree ${wt} on ${branch}`,
      );
    } else {
      try {
        assertSafeGeneratedWorktreeTarget(wt, repoRoot);
        cleanupGit(git, ['worktree', 'remove', '--force', wt], repoRoot, cleanupGitTimeoutMs);
        cleanupGit(git, ['branch', '-D', branch], repoRoot, cleanupGitTimeoutMs);
        // Belt and suspenders: if `git worktree remove` left the dir (it can, on a busy
        // shared .git), delete it so the next run does not inherit an orphan.
        rmrf(wt);
      } catch {
        cleanupGit(git, ['worktree', 'prune'], repoRoot, cleanupGitTimeoutMs);
        console.error(
          `[isolated-heal-session] skipped unsafe cleanup target ${wt}; leaving evidence on disk`,
        );
      }
    }
  }
}

module.exports = {
  assertSafeGeneratedWorktreeTarget,
  runIsolatedHealSession,
  slugify,
  selfHealCommitMessage,
  isGenuineWallResult,
  hasVerificationEvidence,
  shouldAutoCommitDirtyWorkerDiff,
  collectWorkerLandingDiff,
  isRedCardStatusDemotion,
  validateWorkerDiffBeforeLanding,
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_CLEANUP_GIT_TIMEOUT_MS,
};
