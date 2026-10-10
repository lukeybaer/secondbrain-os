'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { evaluateSharedTreeWrite, isIsolatedPath } = require('./shared-tree-write-guard.js');
const { evaluateSharedTreeOp } = require('./shared-tree-guard.js');
const { validateMutationSurfaceMatrix } = require('./mutation-surface-matrix.js');
const { evaluateSharedDirtTripwire } = require('./shared-dirt-tripwire.js');
const { expandHookSettings, readRegisteredBoundaryManifest } = require('./hook-delivery.js');

// The FIXED reference. Shared-checkout freshness is measured against this and
// nothing else.
//
// 2026-08-25. This constant exists because the alternative killed us. Freshness
// used to come from parseAheadBehind() over the porcelain `## branch...upstream
// [ahead N, behind M]` line, i.e. from the CURRENT BRANCH's own upstream. On
// 2026-08-12 a session branched off master inside the shared checkout. The new
// branch had no upstream, so the porcelain line carried no ahead/behind at all,
// both parsed as 0, the row printed `synced with origin`, and `clean` came out
// true-shaped while the checkout drifted ~870 commits behind master for
// thirteen days. The reference moved with the defect, so the health check
// certified the defect.
//
// A health check must never measure itself against a reference that moves with
// the defect. Everything below is the mechanical form of that rule: green
// requires a relation PROVEN against SHARED_TARGET_REF, an unproven relation is
// red rather than green, and a relation proven against any other reference buys
// nothing. Category spec: scripts/__tests__/health-fixed-reference-freshness.test.js
const SHARED_TARGET_BRANCH = 'master';
const SHARED_TARGET_REF = 'origin/master';

function mutationMatrixRepoRoot({ mainRoot, hermeticGit = false, moduleRoot } = {}) {
  return hermeticGit
    ? moduleRoot || path.resolve(__dirname, '..', '..')
    : String(mainRoot || '').replace(/\\/g, '/');
}

/**
 * Ahead/behind as DECLARED by the porcelain branch line. Informational only:
 * it describes the current branch's own upstream, which is the moving
 * reference. It must never reach a green verdict. Kept because the raw numbers
 * are still worth showing next to the real ones.
 */
function parseAheadBehind(branchLine) {
  const ahead = Number((String(branchLine).match(/ahead (\d+)/) || [])[1] || 0);
  const behind = Number((String(branchLine).match(/behind (\d+)/) || [])[1] || 0);
  return { ahead, behind };
}

/** The local branch name from a porcelain `## ...` line, or '' when detached. */
function parseBranchName(branchLine) {
  const raw = String(branchLine || '')
    .replace(/^##\s*/, '')
    .trim();
  if (!raw) return '';
  // Detached HEAD reads `## HEAD (no branch)`.
  if (/^HEAD\b/.test(raw) && /\(no branch\)/i.test(raw)) return '';
  const head = raw.split(/\s+/)[0] || '';
  const sep = head.indexOf('...');
  return sep === -1 ? head : head.slice(0, sep);
}

/**
 * Parse `git rev-list --left-right --count HEAD...<reference>` into a proven
 * relation. Anything unparseable is UNMEASURED, never a convenient zero.
 */
function classifyFixedReferenceRelation(
  raw,
  { reference = SHARED_TARGET_REF, fetched = true } = {},
) {
  const text = String(raw == null ? '' : raw).trim();
  const match = text.match(/^(\d+)\s+(\d+)$/);
  if (!match) return { measured: false, reference, fetched, ahead: null, behind: null };
  return {
    measured: true,
    reference,
    fetched,
    ahead: Number(match[1]),
    behind: Number(match[2]),
  };
}

const UNMEASURED = (reason) => ({
  measured: false,
  reference: SHARED_TARGET_REF,
  fetched: false,
  ahead: null,
  behind: null,
  reason,
});

/**
 * Positive proof that a root really is an isolated worktree, rather than merely
 * carrying an isolation marker somewhere in its path string.
 *
 * Codex review 09174e989ae6 finding 3: `isIsolatedPath()` is a substring match,
 * so `<shared>/tools/sb-isolation` reads as isolated and would take the
 * carve-out that skips the branch and freshness gates. Git settles it: a real
 * worktree IS its own top level and does NOT own the common git dir. A
 * subdirectory of the shared checkout fails the first test, and the shared
 * checkout itself fails the second.
 *
 * Fails CLOSED. If git cannot answer, isolation is not proven, so the full
 * branch and freshness gates apply. Granting the carve-out on an error would
 * hand it to exactly the paths least able to justify it.
 */
function proveIsolatedRoot(root, { runGitRevParse } = {}) {
  if (!isIsolatedPath(root)) return false;
  const run =
    runGitRevParse ||
    ((target, what) =>
      execFileSync('git', ['-C', target, 'rev-parse', what], {
        encoding: 'utf8',
        timeout: 5000,
      }));
  try {
    const norm = (p) =>
      path
        .resolve(String(p || ''))
        .replace(/\\/g, '/')
        .toLowerCase();
    const topLevel = String(run(root, '--show-toplevel') || '').trim();
    if (!topLevel || norm(topLevel) !== norm(root)) return false;
    const commonRaw = String(run(root, '--git-common-dir') || '').trim();
    if (!commonRaw) return false;
    const common = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(root, commonRaw);
    return norm(common) !== norm(path.join(root, '.git'));
  } catch {
    return false;
  }
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Is this relation admissible as proof of freshness?
 *
 * Codex review 09174e989ae6 finding 4: a hand-built `{measured: true,
 * reference: 'origin/master'}` used to pass, and the missing ahead/behind then
 * defaulted to 0 downstream, manufacturing a green with the phrase `synced with
 * origin/master`. Proof fields are now required to be real counts; a missing
 * number is missing proof, never zero.
 *
 * Finding 1: the local `origin/master` ref only advances on fetch. Without a
 * successful SAME-RUN fetch it is a snapshot that can lag the real trunk, which
 * is the same category of defect one level out, so `fetched` is part of the
 * proof rather than an optimisation.
 */
function provenAgainstTarget(freshness) {
  return Boolean(
    freshness &&
    freshness.measured === true &&
    freshness.reference === SHARED_TARGET_REF &&
    freshness.fetched === true &&
    isCount(freshness.ahead) &&
    isCount(freshness.behind),
  );
}

function classifyStatusPorcelain(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .filter(Boolean);
  const branch = lines.find((l) => l.startsWith('##')) || '';
  const changes = lines.filter((l) => !l.startsWith('##'));
  const { ahead, behind } = parseAheadBehind(branch);
  const source = changes.filter((l) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i.test(l)).length;
  const memory = changes.filter((l) => /\smemory\//.test(l) || l.includes(' memory/')).length;
  const data = changes.filter((l) => /\sdata\//.test(l) || l.includes(' data/')).length;
  const untracked = changes.filter((l) => l.startsWith('??')).length;
  return {
    branch,
    branchName: parseBranchName(branch),
    dirty: changes.length,
    ahead,
    behind,
    source,
    memory,
    data,
    untracked,
    raw: String(raw || ''),
  };
}

/**
 * WRONG BRANCH is its own Dev Ops condition, not a footnote on cleanliness.
 *
 * A shared checkout that is not on master is a checkout the sole automated
 * shared checkout is read-only and must remain on master for direct inspection.
 * Isolated worktrees are exempt, because being on their own branch is the entire
 * point of them.
 */
function sharedCheckoutBranchMetric(status, options = {}) {
  const branch = parseBranchName(status?.branch) || String(status?.branchName || '');
  const base = { name: 'Shared checkout branch', branch, target: SHARED_TARGET_BRANCH };
  if (options.gitUnavailable) {
    return {
      ...base,
      status: 'unknown',
      onTargetBranch: null,
      detail: 'Shared checkout branch: not measured on this host (no git checkout)',
    };
  }
  if (options.isolatedRoot) {
    return {
      ...base,
      status: 'green',
      onTargetBranch: null,
      detail: `Shared checkout branch: isolated worktree on ${branch || 'an unnamed branch'}; branch is not gated here`,
    };
  }
  if (!branch) {
    return {
      ...base,
      status: 'red',
      onTargetBranch: false,
      detail:
        'Shared checkout branch: DETACHED or UNKNOWN HEAD; the shared checkout must sit on ' +
        `${SHARED_TARGET_BRANCH} so freshness can be proven against ${SHARED_TARGET_REF}`,
    };
  }
  if (branch !== SHARED_TARGET_BRANCH) {
    return {
      ...base,
      status: 'red',
      onTargetBranch: false,
      detail:
        `Shared checkout branch: WRONG BRANCH - on ${branch}, must be ${SHARED_TARGET_BRANCH}. ` +
        'Work committed here is invisible to the promoter and every session on this machine ' +
        'inherits whatever code this branch happens to carry.',
    };
  }
  return {
    ...base,
    status: 'green',
    onTargetBranch: true,
    detail: `Shared checkout branch: on ${SHARED_TARGET_BRANCH}`,
  };
}

function sharedCheckoutCleanlinessMetric(status, options = {}) {
  const dirty = Number(status?.dirty || 0);
  const ahead = Number(status?.ahead || 0);
  const behind = Number(status?.behind || 0);
  const source = Number(status?.source || 0);
  const memory = Number(status?.memory || 0);
  const data = Number(status?.data || 0);
  const untracked = Number(status?.untracked || 0);
  const branch = String(status?.branch || '')
    .replace(/^##\s*/, '')
    .trim();
  const branchName = parseBranchName(status?.branch) || String(status?.branchName || '');
  const isolatedRoot = Boolean(options.isolatedRoot);
  const freshness = options.freshness || null;
  const proven = provenAgainstTarget(freshness);
  const aheadOfTarget = proven ? Number(freshness.ahead || 0) : null;
  const behindTarget = proven ? Number(freshness.behind || 0) : null;
  const onTargetBranch = branchName === SHARED_TARGET_BRANCH;

  // The one place the phrase is produced. It is reachable only through a
  // relation PROVEN against the fixed reference and reporting zero in both
  // directions, so `synced with origin` cannot be printed while behind master.
  let sync;
  if (!proven) {
    const why = freshness && freshness.reason ? ` (${freshness.reason})` : '';
    sync = `${SHARED_TARGET_REF} relation UNMEASURED${why}`;
  } else if (aheadOfTarget || behindTarget) {
    sync = `ahead ${aheadOfTarget}, behind ${behindTarget} vs ${SHARED_TARGET_REF}`;
  } else {
    sync = `synced with ${SHARED_TARGET_REF}`;
  }

  if (options.gitUnavailable) {
    return {
      name: 'Shared checkout cleanliness',
      status: 'unknown',
      clean: null,
      dirty,
      source,
      memory,
      data,
      untracked,
      ahead,
      behind,
      aheadOfTarget,
      behindTarget,
      measuredAgainst: proven ? SHARED_TARGET_REF : null,
      onTargetBranch: null,
      branch,
      branchName,
      detail:
        'Shared checkout cleanliness: not measured on this host; requires a fresh desktop checkout snapshot',
    };
  }

  // An isolated worktree is EXPECTED to be on its own branch and behind master,
  // so freshness is informational there and only dirt gates it. The shared
  // checkout gets the full proof.
  const clean = isolatedRoot
    ? dirty === 0
    : dirty === 0 && onTargetBranch && proven && aheadOfTarget === 0 && behindTarget === 0;

  const dirtyDetail =
    dirty > 0
      ? `${dirty} dirty (${source} source, ${memory} memory, ${data} data, ${untracked} untracked)`
      : '0 dirty';
  const where = branch ? ` on ${branch}` : '';
  const syncDetail = isolatedRoot && !proven ? `${SHARED_TARGET_REF} relation not measured` : sync;

  let detail;
  if (clean) {
    detail = `Shared checkout cleanliness: clean and ${syncDetail}${where}`;
  } else if (dirty > 0) {
    detail = `Shared checkout cleanliness: DIRTY - ${dirtyDetail}; ${syncDetail}${where}`;
  } else if (!onTargetBranch && !isolatedRoot) {
    detail =
      `Shared checkout cleanliness: OFF ${SHARED_TARGET_BRANCH} - working tree is ${dirtyDetail} but the ` +
      `checkout is${where || ' on an unnamed branch'}; ${syncDetail}. A tidy tree is not freshness.`;
  } else if (!proven) {
    detail =
      `Shared checkout cleanliness: UNPROVEN - ${dirtyDetail} but ${syncDetail}, so freshness ` +
      `cannot be certified${where}`;
  } else {
    detail = `Shared checkout cleanliness: STALE - ${dirtyDetail}; ${syncDetail}${where}`;
  }

  return {
    name: 'Shared checkout cleanliness',
    status: clean ? 'green' : 'red',
    clean,
    dirty,
    source,
    memory,
    data,
    untracked,
    ahead,
    behind,
    aheadOfTarget,
    behindTarget,
    measuredAgainst: proven ? SHARED_TARGET_REF : null,
    onTargetBranch,
    branch,
    branchName,
    detail,
  };
}

function matcherHasTool(matcher, tool) {
  return String(matcher || '')
    .split('|')
    .map((s) => s.trim().toLowerCase())
    .includes(String(tool || '').toLowerCase());
}

function hookCommands(settings, event, tool) {
  const groups = (settings && settings.hooks && settings.hooks[event]) || [];
  return groups
    .filter((g) => !tool || matcherHasTool(g.matcher, tool))
    .flatMap((g) => (g.hooks || []).map((h) => String(h.command || '')));
}

function parseCommandArgv(command) {
  const out = [];
  let current = '';
  let quoted = false;
  for (const char of String(command || '')) {
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && /\s/.test(char)) {
      if (current) {
        out.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) out.push(current);
  return out;
}

function registeredScriptPath(command, { mainRoot, homeDir = os.homedir() } = {}) {
  const argv = parseCommandArgv(command);
  if (argv.length < 2) return null;
  const interpreter = argv[0].replace(/\\/g, '/').toLowerCase();
  const isInterpreter =
    interpreter === 'node' ||
    interpreter === 'bash' ||
    interpreter.endsWith('/bash.exe') ||
    interpreter.endsWith('/bash');
  if (!isInterpreter || argv[1].startsWith('-')) return null;
  if (!/\.(sh|mjs|cjs|js|ts)$/i.test(argv[1])) return null;
  let script = argv[1].replace(/\\/g, '/');
  if (script.startsWith('~/')) script = path.join(homeDir, script.slice(2));
  if (!/^([a-zA-Z]:)?\//.test(script)) script = path.join(mainRoot, script);

  // Settings intentionally register through the stable shared-checkout alias.
  // While gating an isolated worktree, check the candidate file in that
  // worktree so a newly added hook can land and a deleted hook cannot be
  // hidden by a stale shared checkout.
  const canonicalPrefix = 'c:/users/ExampleCo/secondbrain/';
  const normalized = script.replace(/\\/g, '/');
  if (
    mainRoot &&
    normalized.toLowerCase().startsWith(canonicalPrefix) &&
    mainRoot.replace(/\\/g, '/').toLowerCase() !== canonicalPrefix.slice(0, -1)
  ) {
    script = path.join(mainRoot, normalized.slice(canonicalPrefix.length));
  }
  return script;
}

function commandLaunchProblem(command) {
  const argv = parseCommandArgv(command);
  if (!argv.length) return null;
  const executable = argv[0].replace(/\\/g, '/');
  const lower = executable.toLowerCase();
  if (executable.startsWith('~/')) {
    return 'home shorthand is not expanded by the shell-free hook runner';
  }
  if (/\.(sh|mjs|cjs|js|ts)$/i.test(executable)) {
    return 'script is registered without an explicit node or bash interpreter';
  }
  if (['echo', 'export', 'set', 'test', '['].includes(lower)) {
    return 'shell builtin is registered without an explicit shell';
  }
  return null;
}

function hookRegistrationIntegrityMetric(
  sources,
  { mainRoot, homeDir = os.homedir(), fileExists = fs.existsSync } = {},
) {
  const dead = [];
  let checked = 0;
  let readable = 0;
  for (const source of sources || []) {
    if (!source?.result?.ok) continue;
    readable += 1;
    const events = source.result.settings?.hooks || {};
    for (const groups of Object.values(events)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        for (const hook of group?.hooks || []) {
          if (typeof hook?.command !== 'string') continue;
          const launchProblem = commandLaunchProblem(hook.command);
          if (launchProblem) {
            checked += 1;
            dead.push({
              source: source.label,
              command: hook.command,
              script: parseCommandArgv(hook.command)[0],
              reason: launchProblem,
            });
            continue;
          }
          const script = registeredScriptPath(hook.command, { mainRoot, homeDir });
          if (!script) continue;
          checked += 1;
          if (!fileExists(script)) {
            dead.push({
              source: source.label,
              command: hook.command,
              script: script.replace(/\\/g, '/'),
              reason: 'script missing on disk',
            });
          }
        }
      }
    }
  }
  if (dead.length) {
    return {
      name: 'Hook registration integrity',
      status: 'red',
      checked,
      dead,
      detail: `Hook registration integrity: BROKEN - ${dead.length} dead script registration(s): ${dead
        .map((item) => `${item.source}:${path.basename(item.script)} (${item.reason})`)
        .join(', ')}`,
    };
  }
  if (!readable) {
    return {
      name: 'Hook registration integrity',
      status: 'unknown',
      checked,
      dead,
      detail: 'Hook registration integrity: UNKNOWN - no hook settings were readable on this host',
    };
  }
  return {
    name: 'Hook registration integrity',
    status: 'green',
    checked,
    dead,
    detail: `Hook registration integrity: ${checked} registered script path(s) exist`,
  };
}

function settingsHasHook(settings, event, tool, fragment) {
  return hookCommands(settings, event, tool).some((cmd) => cmd.includes(fragment));
}

function readSettings(file, readFile) {
  try {
    return { ok: true, path: file, settings: JSON.parse(readFile(file, 'utf8')) };
  } catch (e) {
    return { ok: false, path: file, error: (e.message || '').slice(0, 160) };
  }
}

function classifySettings(settingsResult) {
  if (!settingsResult.ok) {
    return {
      ok: false,
      path: settingsResult.path,
      problems: [`settings unreadable: ${settingsResult.error}`],
    };
  }
  const settings = settingsResult.settings;
  const problems = [];
  if (!settingsHasHook(settings, 'PreToolUse', 'Bash', 'shared-tree-guard.mjs')) {
    problems.push('missing Bash shared-tree guard');
  }
  for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
    if (!settingsHasHook(settings, 'PreToolUse', tool, 'shared-tree-write-guard.mjs')) {
      problems.push(`missing ${tool} shared-tree write guard`);
    }
  }
  return { ok: problems.length === 0, path: settingsResult.path, problems };
}

function checkGuardPolicy(mainRoot) {
  if (isIsolatedPath(mainRoot)) {
    return {
      ok: true,
      failedWrites: [],
      isolatedAllowed: true,
      bareEnvWriteBlocked: true,
      bareEnvGitBlocked: true,
      isolatedRoot: true,
    };
  }
  const sharedCases = [
    'memory/MEMORY.md',
    'data/agent/escalations.jsonl',
    'content-review/video-quality-rubric.json',
    'dev-plans/core/session-isolation.md',
    'scripts/manual-briefing-v3.js',
  ];
  const writeResults = sharedCases.map((rel) => ({
    rel,
    blocked: evaluateSharedTreeWrite({
      filePath: `${mainRoot}/${rel}`,
      cwd: mainRoot,
      mainRoot,
    }).blocked,
  }));
  const isolatedAllowed = !evaluateSharedTreeWrite({
    filePath: `${path.dirname(mainRoot).replace(/\\/g, '/')}/sb-sessions/devops-test/memory/MEMORY.md`,
    cwd: `${path.dirname(mainRoot).replace(/\\/g, '/')}/sb-sessions/devops-test`,
    mainRoot,
  }).blocked;
  const bareEnvWriteBlocked = evaluateSharedTreeWrite({
    filePath: `${mainRoot}/memory/MEMORY.md`,
    cwd: mainRoot,
    mainRoot,
    env: { SB_INTEGRATION_SESSION: '1' },
  }).blocked;
  const bareEnvGitBlocked = evaluateSharedTreeOp({
    command: 'git reset --hard origin/master',
    cwd: mainRoot,
    mainRoot,
    env: { SB_INTEGRATION_SESSION: '1' },
  }).blocked;
  const failedWrites = writeResults.filter((r) => !r.blocked).map((r) => r.rel);
  const ok =
    failedWrites.length === 0 && isolatedAllowed && bareEnvWriteBlocked && bareEnvGitBlocked;
  return { ok, failedWrites, isolatedAllowed, bareEnvWriteBlocked, bareEnvGitBlocked };
}

function probeDevOpsHealth({
  mainRoot = process.env.SECONDBRAIN_ROOT || path.join(os.homedir(), 'secondbrain'),
  repoSettingsPath,
  canonicalSettingsPath,
  userSettingsPath = path.join(os.homedir(), '.claude', 'settings.json'),
  readFile = fs.readFileSync,
  runGitStatus,
  runGitRelation,
  runGitFetch,
  runGitRevParse,
  cloudHost,
  tripwire,
  publicMirror,
  fileExists,
} = {}) {
  const root = mainRoot.replace(/\\/g, '/');
  // The EC2 briefing build is a FILE-DEPLOYED copy (not a git checkout) under
  // /opt/secondbrain with an empty .git stub, and the cloud host has no Claude
  // Code home config (~/.claude/settings.json). On that host a non-repo git
  // status and a missing user settings file are EXPECTED, not a real DevOps
  // regression, so they must not force a hard RED that blocks the publish gate.
  // Off the cloud host they remain real problems. ExampleCo 2026-06-29 green-tomorrow.
  const onCloudHost =
    cloudHost != null
      ? Boolean(cloudHost)
      : process.platform === 'linux' && root.startsWith('/opt/secondbrain');
  let gitStatus = '';
  let gitUnavailable = false;
  try {
    gitStatus = runGitStatus
      ? runGitStatus(root)
      : execFileSync('git', ['-C', root, 'status', '--porcelain', '--branch'], {
          encoding: 'utf8',
          timeout: 10000,
        });
  } catch (e) {
    // Off the cloud host this is a real failure: rethrow so the caller can
    // honest-block (the cloud-morning-briefing snapshot fallback). On the cloud
    // host ONLY the expected file-deploy non-repo stub ("not a git repository") is
    // informational; any OTHER git failure (permissions, timeout, corrupt repo,
    // dubious-ownership/safe.directory) is a REAL problem that must still surface as
    // non-green, never silently downgraded to green. Codex Wave 1 HOLD #3.
    const detail = `${(e && e.stderr) || ''} ${(e && e.message) || e}`;
    const isNonRepoStub = /not a git repository/i.test(detail);
    if (!onCloudHost || !isNonRepoStub) throw e;
    gitUnavailable = true;
  }
  const status = classifyStatusPorcelain(gitStatus);

  // Freshness against the FIXED reference, measured separately from the status
  // line precisely so it cannot inherit the current branch's upstream. A
  // hermetic caller that injected runGitStatus but no runGitRelation gets an
  // UNMEASURED relation, which is red, never green: the false-green shape is
  // unavailable to tests too.
  // Production proves isolation through git worktree identity so a
  // marker-named subdirectory cannot claim the carve-out (Codex finding 3). A
  // hermetic caller that injected git has no repo to ask, so it falls back to
  // the path marker, exactly as before.
  const hermeticGit = Boolean(runGitStatus || runGitRelation);
  const isolatedRoot = runGitRevParse
    ? proveIsolatedRoot(root, { runGitRevParse })
    : hermeticGit
      ? isIsolatedPath(root)
      : proveIsolatedRoot(root);
  let freshness = UNMEASURED('not-attempted');
  if (!gitUnavailable) {
    const hermetic = Boolean(runGitStatus);
    const relationRunner =
      runGitRelation ||
      (hermetic
        ? null
        : (target, reference) =>
            execFileSync(
              'git',
              ['-C', target, 'rev-list', '--left-right', '--count', `HEAD...${reference}`],
              { encoding: 'utf8', timeout: 10000 },
            ));
    // The local origin/master ref only advances on fetch, so a same-run fetch
    // is part of the proof, not a nicety. A fetch that fails leaves the
    // reference stale and the relation therefore UNPROVEN, which is red.
    const fetchRunner =
      runGitFetch ||
      (hermetic || runGitRelation
        ? null
        : (target) =>
            execFileSync('git', ['-C', target, 'fetch', 'origin', SHARED_TARGET_BRANCH], {
              encoding: 'utf8',
              timeout: 20000,
            }));
    if (relationRunner) {
      let fetched = true;
      if (fetchRunner) {
        try {
          fetchRunner(root, SHARED_TARGET_BRANCH);
        } catch {
          fetched = false;
        }
      }
      if (!fetched) {
        freshness = UNMEASURED('fetch-failed');
      } else {
        try {
          freshness = classifyFixedReferenceRelation(relationRunner(root, SHARED_TARGET_REF), {
            reference: SHARED_TARGET_REF,
            fetched: true,
          });
        } catch {
          // Cannot prove it, so do not claim it. Fail closed to UNMEASURED.
          freshness = UNMEASURED('relation-failed');
        }
      }
    }
  }

  const sharedCheckoutMetric = sharedCheckoutCleanlinessMetric(status, {
    gitUnavailable,
    freshness,
    isolatedRoot,
  });
  const sharedBranchMetric = sharedCheckoutBranchMetric(status, { gitUnavailable, isolatedRoot });
  // Shared-dirt writer tripwire (2026-07-12): a differential, allowlisted view
  // of the same porcelain data. The cleanliness metric above says "the tree is
  // dirty"; the tripwire names WHICH paths are new writer violations (vs
  // landed-awaiting-sync or baselined history) and emits one guard-telemetry
  // line per new file. Injectable for tests. The REAL tripwire (which runs
  // git and writes state/telemetry) only runs when this probe is doing real
  // git itself: a caller that injected runGitStatus is a hermetic test and
  // must not touch the live repo. Skipped where git is unavailable (EC2
  // file-deploy) exactly like the cleanliness metric.
  let dirtTripwire = null;
  if (!gitUnavailable && (tripwire || !runGitStatus)) {
    try {
      dirtTripwire = (tripwire || evaluateSharedDirtTripwire)({ mainRoot: root });
    } catch (e) {
      dirtTripwire = {
        status: 'red',
        newDirt: [],
        detail: `Shared-dirt tripwire: failed to evaluate: ${String((e && e.message) || e).slice(0, 160)}`,
      };
    }
  }
  const repoSettingsResult = readSettings(
    repoSettingsPath || path.join(root, '.claude', 'settings.json'),
    readFile,
  );
  const canonicalSettingsResult = readSettings(
    canonicalSettingsPath || path.join(root, 'claude-config', 'settings.json'),
    readFile,
  );
  const userSettingsResult = readSettings(userSettingsPath, readFile);
  let canonicalManifest;
  try { canonicalManifest = JSON.parse(readFile(path.join(root, 'scripts', 'claude-hooks', 'hook-boundary-manifest.json'), 'utf8')); } catch { canonicalManifest = null; }
  const runtimeManifest = readRegisteredBoundaryManifest(userSettingsResult.settings, root, readFile);
  const installedSettings = userSettingsResult.settings;
  // Source settings use the source manifest; live settings use the installed
  // dispatcher's manifest. Project children are inherited from live globals.
  canonicalSettingsResult.settings = expandHookSettings(canonicalSettingsResult.settings, { manifest: canonicalManifest });
  userSettingsResult.settings = expandHookSettings(installedSettings, { manifest: runtimeManifest });
  repoSettingsResult.settings = expandHookSettings(repoSettingsResult.settings, { manifest: runtimeManifest, scopes: ['project'], inheritedSettings: installedSettings });
  const repoSettings = classifySettings(repoSettingsResult);
  const canonicalSettings = classifySettings(canonicalSettingsResult);
  const userSettings = classifySettings(userSettingsResult);
  const hookRegistrationMetric = hookRegistrationIntegrityMetric(
    [
      { label: 'repo', result: repoSettingsResult },
      { label: 'canonical', result: canonicalSettingsResult },
      { label: 'user', result: userSettingsResult },
    ],
    { mainRoot: root, fileExists: fileExists || fs.existsSync },
  );
  const guard = checkGuardPolicy(root);
  // The desktop snapshot producer runs from a deliberately narrow installed
  // capability runtime, but the matrix audits the complete shared source
  // checkout named by mainRoot. Resolving relative to this module made every
  // non-bundled enforcement file look absent even when the source was sound.
  // Hermetic tests retain the module checkout because their synthetic
  // mainRoot intentionally has no files to inspect.
  const matrix = validateMutationSurfaceMatrix(undefined, {
    repoRoot: mutationMatrixRepoRoot({ mainRoot: root, hermeticGit }),
  });
  const problems = [];
  if (!gitUnavailable && sharedBranchMetric.status === 'red') {
    problems.push(sharedBranchMetric.detail);
  }
  if (!gitUnavailable && sharedCheckoutMetric.status === 'red') {
    problems.push(sharedCheckoutMetric.detail);
  }
  if (dirtTripwire && dirtTripwire.status === 'red') {
    problems.push(dirtTripwire.detail);
  }
  if (!guard.ok) {
    if (guard.failedWrites.length)
      problems.push(`write guard allowed ${guard.failedWrites.join(', ')}`);
    if (!guard.isolatedAllowed) problems.push('write guard blocks isolated worktree writes');
    if (!guard.bareEnvWriteBlocked || !guard.bareEnvGitBlocked) {
      problems.push('integration env var bypasses guard without lease');
    }
  }
  // On the cloud file-deploy the repo and canonical settings directories
  // (.claude/ and claude-config/) are NOT deployed — the hooks run on the
  // desktop/CI, not on the cloud host. A missing (unreadable) settings file
  // on the cloud host is expected. A file that IS present but mis-wired is
  // still a real problem, so only the 'unreadable' (ENOENT/missing) case is
  // carved out. Same logic as the user-settings carve-out below.
  const repoSettingsExpectedMissing =
    onCloudHost &&
    !repoSettings.ok &&
    repoSettings.problems.some((p) => /settings unreadable/i.test(p));
  const canonicalSettingsExpectedMissing =
    onCloudHost &&
    !canonicalSettings.ok &&
    canonicalSettings.problems.some((p) => /settings unreadable/i.test(p));
  if (!repoSettings.ok && !repoSettingsExpectedMissing)
    problems.push(`repo hooks: ${repoSettings.problems.join('; ')}`);
  if (!canonicalSettings.ok && !canonicalSettingsExpectedMissing) {
    problems.push(`canonical hooks: ${canonicalSettings.problems.join('; ')}`);
  }
  // On the cloud host an unreadable (missing) ~/.claude/settings.json is
  // expected: the file-deploy carries no Claude Code home config. A settings
  // file that IS present but mis-wired is still a real problem even on the
  // cloud host, so only the 'unreadable' (missing) case is carved out.
  const userSettingsExpectedMissing =
    onCloudHost &&
    !userSettings.ok &&
    userSettings.problems.some((p) => /settings unreadable/i.test(p));
  if (!userSettings.ok && !userSettingsExpectedMissing) {
    problems.push(`user hooks: ${userSettings.problems.join('; ')}`);
  }
  if (hookRegistrationMetric.status === 'red') {
    problems.push(hookRegistrationMetric.detail);
  }
  if (!matrix.ok) problems.push(`mutation matrix: ${matrix.problems.join('; ')}`);
  const publicMirrorMetric =
    publicMirror && typeof publicMirror === 'object'
      ? publicMirror
      : {
          name: 'Public mirror currency',
          status: 'unknown',
          current: null,
          behind: null,
          detail:
            'Public mirror currency: UNKNOWN - no fresh desktop public-payload comparison was supplied',
        };
  if (publicMirrorMetric.status === 'red') {
    problems.push(publicMirrorMetric.detail);
  }
  // Informational (not problem) notes for the cloud file-deploy carve-outs, so
  // the green detail line still tells the truth about why git/user-hooks were
  // not evaluated instead of silently claiming they are wired.
  const cloudNotes = [];
  if (gitUnavailable) {
    cloudNotes.push(
      'shared checkout not a git checkout (cloud file-deploy); sync verified upstream',
    );
  }
  if (userSettingsExpectedMissing) {
    cloudNotes.push('no Claude Code home config on the cloud host (expected for the file-deploy)');
  }
  if (repoSettingsExpectedMissing || canonicalSettingsExpectedMissing) {
    cloudNotes.push(
      'repo/canonical settings absent on the cloud file-deploy (hooks run on desktop/CI, not on this host)',
    );
  }
  const healthStatus = problems.length ? 'red' : 'green';
  const detail =
    healthStatus === 'green'
      ? [
          `${sharedCheckoutMetric.detail}; write guard blocks shared paths; repo and user hooks wired; integration bypass requires a live lease; mutation surface matrix valid`,
          sharedBranchMetric.detail,
          hookRegistrationMetric.detail,
          publicMirrorMetric.detail,
          ...cloudNotes,
        ].join('; ')
      : problems.join('; ');
  return {
    status: healthStatus,
    detail,
    sharedCheckout: status,
    freshness,
    metrics: {
      sharedCheckoutCleanliness: sharedCheckoutMetric,
      sharedCheckoutBranch: sharedBranchMetric,
      sharedDirtTripwire: dirtTripwire,
      hookRegistrationIntegrity: hookRegistrationMetric,
      publicMirrorCurrency: publicMirrorMetric,
    },
    guard,
    matrix,
    repoSettings,
    canonicalSettings,
    userSettings,
  };
}

module.exports = {
  SHARED_TARGET_BRANCH,
  SHARED_TARGET_REF,
  mutationMatrixRepoRoot,
  parseAheadBehind,
  parseBranchName,
  classifyFixedReferenceRelation,
  provenAgainstTarget,
  proveIsolatedRoot,
  classifyStatusPorcelain,
  sharedCheckoutCleanlinessMetric,
  sharedCheckoutBranchMetric,
  hookCommands,
  registeredScriptPath,
  commandLaunchProblem,
  hookRegistrationIntegrityMetric,
  settingsHasHook,
  classifySettings,
  checkGuardPolicy,
  probeDevOpsHealth,
};
