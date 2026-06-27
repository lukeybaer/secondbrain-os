'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { evaluateSharedTreeWrite } = require('./shared-tree-write-guard.js');
const { evaluateSharedTreeOp } = require('./shared-tree-guard.js');
const { validateMutationSurfaceMatrix } = require('./mutation-surface-matrix.js');

function parseAheadBehind(branchLine) {
  const ahead = Number((String(branchLine).match(/ahead (\d+)/) || [])[1] || 0);
  const behind = Number((String(branchLine).match(/behind (\d+)/) || [])[1] || 0);
  return { ahead, behind };
}

function classifyStatusPorcelain(raw) {
  const lines = String(raw || '').split(/\r?\n/).filter(Boolean);
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
    return { ok: false, path: settingsResult.path, problems: [`settings unreadable: ${settingsResult.error}`] };
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
} = {}) {
  const root = mainRoot.replace(/\\/g, '/');
  const gitStatus = runGitStatus
    ? runGitStatus(root)
    : execFileSync('git', ['-C', root, 'status', '--porcelain', '--branch'], {
        encoding: 'utf8',
        timeout: 10000,
      });
  const status = classifyStatusPorcelain(gitStatus);
  const repoSettings = classifySettings(
    readSettings(repoSettingsPath || path.join(root, '.claude', 'settings.json'), readFile),
  );
  const canonicalSettings = classifySettings(
    readSettings(canonicalSettingsPath || path.join(root, 'claude-config', 'settings.json'), readFile),
  );
  const userSettings = classifySettings(readSettings(userSettingsPath, readFile));
  const guard = checkGuardPolicy(root);
  const matrix = validateMutationSurfaceMatrix();
  const problems = [];
  if (status.dirty > 0) problems.push(`${status.dirty} dirty shared-checkout item(s)`);
  if (status.ahead > 0 || status.behind > 0) {
    problems.push(`shared checkout ahead ${status.ahead}, behind ${status.behind}`);
  }
  if (!guard.ok) {
    if (guard.failedWrites.length) problems.push(`write guard allowed ${guard.failedWrites.join(', ')}`);
    if (!guard.isolatedAllowed) problems.push('write guard blocks isolated worktree writes');
    if (!guard.bareEnvWriteBlocked || !guard.bareEnvGitBlocked) {
      problems.push('integration env var bypasses guard without lease');
    }
  }
  if (!repoSettings.ok) problems.push(`repo hooks: ${repoSettings.problems.join('; ')}`);
  if (!canonicalSettings.ok) {
    problems.push(`canonical hooks: ${canonicalSettings.problems.join('; ')}`);
  }
  if (!userSettings.ok) problems.push(`user hooks: ${userSettings.problems.join('; ')}`);
  if (!matrix.ok) problems.push(`mutation matrix: ${matrix.problems.join('; ')}`);
  const healthStatus = problems.length ? 'red' : 'green';
  const detail =
    healthStatus === 'green'
      ? 'shared checkout clean/synced; write guard blocks shared paths; repo and user hooks wired; integration bypass requires a live lease; mutation surface matrix valid'
      : problems.join('; ');
  return {
    status: healthStatus,
    detail,
    sharedCheckout: status,
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
  hookCommands,
  settingsHasHook,
  classifySettings,
  checkGuardPolicy,
  probeDevOpsHealth,
};
