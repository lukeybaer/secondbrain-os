'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { evaluateSharedTreeWrite, isIsolatedPath } = require('./shared-tree-write-guard.js');
const { evaluateSharedTreeOp } = require('./shared-tree-guard.js');
const { validateMutationSurfaceMatrix } = require('./mutation-surface-matrix.js');
const { evaluateSharedDirtTripwire } = require('./shared-dirt-tripwire.js');

function parseAheadBehind(branchLine) {
  const ahead = Number((String(branchLine).match(/ahead (\d+)/) || [])[1] || 0);
  const behind = Number((String(branchLine).match(/behind (\d+)/) || [])[1] || 0);
  return { ahead, behind };
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
  const sync = ahead || behind ? `ahead ${ahead}, behind ${behind}` : 'synced with origin';
  if (options.gitUnavailable) {
    return {
      name: 'Shared checkout cleanliness',
      status: 'ExampleCo',
      clean: null,
      dirty,
      source,
      memory,
      data,
      untracked,
      ahead,
      behind,
      branch,
      detail:
        'Shared checkout cleanliness: not measured on this host; requires a fresh desktop checkout snapshot',
    };
  }
  const clean = dirty === 0 && ahead === 0 && behind === 0;
  const dirtyDetail =
    dirty > 0
      ? `${dirty} dirty (${source} source, ${memory} memory, ${data} data, ${untracked} untracked)`
      : '0 dirty';
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
    branch,
    detail: clean
      ? `Shared checkout cleanliness: clean and ${sync}${branch ? ` on ${branch}` : ''}`
      : `Shared checkout cleanliness: DIRTY - ${dirtyDetail}; ${sync}${
          branch ? ` on ${branch}` : ''
        }`,
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
  if (!settingsHasHook(settings, 'SessionStart', null, 'session-isolation-guard.mjs')) {
    problems.push('missing SessionStart isolation guard');
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
  cloudHost,
  tripwire,
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
  const sharedCheckoutMetric = sharedCheckoutCleanlinessMetric(status, { gitUnavailable });
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
  const repoSettings = classifySettings(
    readSettings(repoSettingsPath || path.join(root, '.claude', 'settings.json'), readFile),
  );
  const canonicalSettings = classifySettings(
    readSettings(
      canonicalSettingsPath || path.join(root, 'claude-config', 'settings.json'),
      readFile,
    ),
  );
  const userSettings = classifySettings(readSettings(userSettingsPath, readFile));
  const guard = checkGuardPolicy(root);
  const matrix = validateMutationSurfaceMatrix();
  const problems = [];
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
  // expected: the file-deploy ExampleCos no Claude Code home config. A settings
  // file that IS present but mis-wired is still a real problem even on the
  // cloud host, so only the 'unreadable' (missing) case is carved out.
  const userSettingsExpectedMissing =
    onCloudHost &&
    !userSettings.ok &&
    userSettings.problems.some((p) => /settings unreadable/i.test(p));
  if (!userSettings.ok && !userSettingsExpectedMissing) {
    problems.push(`user hooks: ${userSettings.problems.join('; ')}`);
  }
  if (!matrix.ok) problems.push(`mutation matrix: ${matrix.problems.join('; ')}`);
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
          ...cloudNotes,
        ].join('; ')
      : problems.join('; ');
  return {
    status: healthStatus,
    detail,
    sharedCheckout: status,
    metrics: {
      sharedCheckoutCleanliness: sharedCheckoutMetric,
      sharedDirtTripwire: dirtTripwire,
    },
    guard,
    matrix,
    repoSettings,
    canonicalSettings,
    userSettings,
  };
}

module.exports = {
  parseAheadBehind,
  classifyStatusPorcelain,
  sharedCheckoutCleanlinessMetric,
  hookCommands,
  settingsHasHook,
  classifySettings,
  checkGuardPolicy,
  probeDevOpsHealth,
};
