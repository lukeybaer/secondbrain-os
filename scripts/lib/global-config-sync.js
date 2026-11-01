'use strict';
//
// global-config-sync.js -- keep profile copies of the global Claude and Codex
// adapters projected from their tracked deploy sources.
//
// Why this exists (2026-07-19 gravity audit, inconsistency #1): the two files
// were supposed to be hardlinked ("same inode, verified" per
// reference_amy_state_locations.md), but git rewrites a tracked file's inode
// on checkout/pull, so the link silently died (proven: different NTFS file
// IDs, and the profile copy still described a hook retired on 07-18). A
// hardlink to a git-tracked file cannot survive git. The durable model is:
// the TRACKED file is the write surface (memory-path-enforce.sh already
// redirects edits there), the profile file is a deploy target, and session
// start compares content hashes and heals tracked -> profile, loudly.
//
// Machine-local settings keys remain compare-only: the live file carries
// permissions, env, MCP, theme, and harness-written values. The reviewed hooks
// in the existing tracked settings.json are the narrow exception: they replace
// only the profile hooks object and prove every other key survived unchanged.
//
// Law: AMY_GRAVITY.md G6 (one Amy). Companion test:
// scripts/__tests__/global-config-sync.test.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isDeepStrictEqual } = require('util');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The tracked settings file is the Windows desktop source, so its hook
// commands intentionally name the immutable `sb-runtime/amy-code` checkout.
// A Linux profile cannot execute that drive-letter path.  Project only the
// command path for the host receiving the profile; the tracked source remains
// the Windows form and all unrelated profile keys remain machine-local.
const WINDOWS_RUNTIME_PREFIXES = Object.freeze([
  /C:[\\/]Users[\\/][^\\/]+[\\/]sb-runtime[\\/]amy-code((?:[\\/][^\s"';&|)]*)?)/i,
  /C:[\\/]Users[\\/][^\\/]+[\\/]secondbrain((?:[\\/][^\s"';&|)]*)?)/i,
  /C:[\\/]Users[\\/][^\\/]+[\\/]\.claude[\\/]hooks((?:[\\/][^\s"';&|)]*)?)/i,
]);

const WINDOWS_GIT_BASH = /C:[\\/]?(?:PROGRA~1[\\/]Git|Program Files[\\/]Git)[\\/]bin[\\/]bash\.exe/i;

function shellPathRoot(value) {
  const normalized = String(value).replace(/\\/g, '/');
  return /\s/.test(normalized) ? `'${normalized.replace(/'/g, "'\\''")}'` : normalized;
}

function replaceKnownPath(command, matcher, replacement) {
  return command.replace(matcher, (...args) => {
    const match = args[0];
    const hasSuffixCapture = args.length === 4;
    const suffix = hasSuffixCapture ? args[1] : '';
    const offset = args[hasSuffixCapture ? 2 : 1];
    const full = args[hasSuffixCapture ? 3 : 2];
    const before = full[offset - 1];
    // A path already inside a shell quote must not receive a nested quote.
    const projectedPath = `${String(replacement).replace(/\\/g, '/')}${String(suffix || '').replace(/\\/g, '/')}`;
    return before === '"' || before === "'" ? projectedPath : shellPathRoot(projectedPath);
  });
}

function repoRootForTrackedSettings(trackedSettings) {
  const configDir = path.dirname(path.resolve(trackedSettings));
  if (path.basename(configDir).toLowerCase() !== 'claude-config') return null;
  return path.dirname(configDir);
}

function projectHookCommand(command, { platform = process.platform, repoRoot } = {}) {
  if (platform === 'win32' || !repoRoot || typeof command !== 'string') return command;
  const rawRoot = String(repoRoot);
  const runtimeRoot = /^(?:[A-Za-z]:[\\/]|\/)/.test(rawRoot) ? rawRoot : path.resolve(rawRoot);
  let projected = command;
  projected = replaceKnownPath(projected, WINDOWS_GIT_BASH, 'bash');
  projected = replaceKnownPath(projected, WINDOWS_RUNTIME_PREFIXES[0], runtimeRoot);
  projected = replaceKnownPath(projected, WINDOWS_RUNTIME_PREFIXES[1], runtimeRoot);
  projected = replaceKnownPath(projected, WINDOWS_RUNTIME_PREFIXES[2], path.join(runtimeRoot, 'scripts', 'claude-hooks'));
  return projected;
}

function projectHookTree(value, options = {}) {
  if (Array.isArray(value)) return value.map((item) => projectHookTree(item, options));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = key === 'command' ? projectHookCommand(item, options) : projectHookTree(item, options);
  }
  return out;
}

function projectHooksForHost(hooks, options = {}) {
  return projectHookTree(hooks, options);
}

function boundaryDispatcherPath(command) {
  const match = String(command || '').match(/(?:^|\s)(?:node\s+|[^\s]+\s+)?("[^"]*hook-boundary-dispatcher\.mjs"|[^\s"]*hook-boundary-dispatcher\.mjs)(?:\s|$)/i);
  return match ? match[1].replace(/^"|"$/g, '') : null;
}

function validateProjectedBoundaryHooks(hooks) {
  const missing = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if (typeof value.command === 'string') {
      const dispatcher = boundaryDispatcherPath(value.command);
      if (dispatcher) {
        const manifest = path.join(path.dirname(dispatcher), 'hook-boundary-manifest.json');
        if (!fs.existsSync(dispatcher)) missing.push(`dispatcher missing: ${dispatcher}`);
        if (!fs.existsSync(manifest)) missing.push(`manifest missing: ${manifest}`);
      }
    }
    for (const item of Object.values(value)) visit(item);
  };
  visit(hooks);
  return missing;
}

// Narrow exception beside hooks: reviewed scalar settings the tracked source
// owns. autoCompactWindow (Claude Code 2.1.286 userSettings key) caps the
// auto-compact point so long sessions stop re-sending ~1M tokens per step.
const MANAGED_SETTING_KEYS = Object.freeze(['autoCompactWindow']);

function managedSettings(source) {
  const out = {};
  for (const key of MANAGED_SETTING_KEYS) if (source && key in source) out[key] = source[key];
  return out;
}

function defaultPaths() {
  return {
    trackedClaudeMd: path.join(REPO_ROOT, 'claude-config', 'CLAUDE.global.md'),
    profileClaudeMd: path.join(os.homedir(), '.claude', 'CLAUDE.md'),
    trackedCodexAgents: path.join(REPO_ROOT, 'codex-config', 'AGENTS.global.md'),
    profileCodexAgents: path.join(os.homedir(), '.codex', 'AGENTS.md'),
    trackedSettings: path.join(REPO_ROOT, 'claude-config', 'settings.json'),
    profileSettings: path.join(os.homedir(), '.claude', 'settings.json'),
  };
}

function normalized(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Compare tracked vs profile CLAUDE.md; on drift, back up the profile copy
 * next to itself (.pre-heal, single rotating slot) and copy tracked over it.
 * Returns { status: 'in-sync' | 'healed' | 'missing-tracked' | 'error', detail }.
 */
function syncDeployCopy(trackedPath, profilePath) {
  try {
    if (!fs.existsSync(trackedPath)) {
      return { status: 'missing-tracked', detail: trackedPath };
    }
    const tracked = normalized(trackedPath);
    const profileExists = fs.existsSync(profilePath);
    if (profileExists && normalized(profilePath) === tracked) {
      return { status: 'in-sync', detail: '' };
    }
    if (profileExists) {
      fs.copyFileSync(profilePath, `${profilePath}.pre-heal`);
    }
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.copyFileSync(trackedPath, profilePath);
    return {
      status: 'healed',
      detail: profileExists
        ? `profile copy drifted from tracked; overwritten (previous content kept at ${path.basename(profilePath)}.pre-heal)`
        : 'profile copy was missing; deployed from tracked',
    };
  } catch (err) {
    return { status: 'error', detail: err.message };
  }
}

function syncGlobalClaudeMd(opts = {}) {
  const { trackedClaudeMd, profileClaudeMd } = { ...defaultPaths(), ...opts };
  return syncDeployCopy(trackedClaudeMd, profileClaudeMd);
}

/** Keep the global Codex AGENTS.md adapter aligned with its tracked source. */
function syncGlobalCodexAgents(opts = {}) {
  const { trackedCodexAgents, profileCodexAgents } = { ...defaultPaths(), ...opts };
  return syncDeployCopy(trackedCodexAgents, profileCodexAgents);
}

/**
 * Atomically project only the reviewed hooks object into the machine-local
 * Claude settings. Hooks are extracted from the existing full tracked settings
 * source. Every non-hook key is carried forward from the profile JSON,
 * and the exact prior settings bytes are backed up before a replacement.
 */
function syncGlobalClaudeHooks(opts = {}) {
  const { trackedSettings, profileSettings, platform = process.platform } = { ...defaultPaths(), ...opts };
  try {
    if (!fs.existsSync(trackedSettings)) return { status: 'missing-tracked', detail: trackedSettings };
    if (!fs.existsSync(profileSettings)) return { status: 'missing-profile', detail: profileSettings };
    const source = JSON.parse(fs.readFileSync(trackedSettings, 'utf8'));
    const priorBytes = fs.readFileSync(profileSettings);
    const profile = JSON.parse(priorBytes.toString('utf8'));
    if (!source || typeof source !== 'object' || Array.isArray(source) || !source.hooks || typeof source.hooks !== 'object' || Array.isArray(source.hooks)) {
      return { status: 'invalid-tracked', detail: `${trackedSettings} must contain a hooks object` };
    }
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      return { status: 'invalid-profile', detail: `${profileSettings} is not a JSON object` };
    }
    const repoRoot = opts.repoRoot || repoRootForTrackedSettings(trackedSettings) || REPO_ROOT;
    const projectedHooks = projectHooksForHost(source.hooks, { platform, repoRoot });
    if (platform !== 'win32') {
      const missing = validateProjectedBoundaryHooks(projectedHooks);
      if (missing.length > 0) {
        return { status: 'error', detail: `host hook projection is not executable: ${missing.join('; ')}` };
      }
    }
    const managed = managedSettings(source);
    const managedInSync = MANAGED_SETTING_KEYS.every((key) => isDeepStrictEqual(profile[key], managed[key]));
    if (isDeepStrictEqual(profile.hooks, projectedHooks) && managedInSync) return { status: 'in-sync', detail: '' };

    // A development worktree must never install unlanded executable hooks.
    const git = (...args) => execFileSync('git', ['-C', path.dirname(trackedSettings), ...args], {encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}).trim();
    const sourceRoot = git('rev-parse', '--show-toplevel');
    const sourcePath = path.relative(sourceRoot, trackedSettings).replace(/\\/g, '/');
    git('ls-files', '--error-unmatch', '--', `:(top)${sourcePath}`);
    git('merge-base', '--is-ancestor', 'HEAD', 'origin/master');
    if (git('status', '--porcelain', '--untracked-files=no')) {
      return {status: 'error', detail: 'hook projection requires a clean tracked source at a landed SHA'};
    }

    const beforeNonHooks = { ...profile };
    delete beforeNonHooks.hooks;
    for (const key of MANAGED_SETTING_KEYS) delete beforeNonHooks[key];
    const next = { ...profile, hooks: projectedHooks, ...managed };
    const backup = `${profileSettings}.hooks-pre-projection`;
    fs.writeFileSync(backup, priorBytes);
    const temporary = `${profileSettings}.${process.pid}.hooks.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, profileSettings);
    const after = JSON.parse(fs.readFileSync(profileSettings, 'utf8'));
    const afterNonHooks = { ...after };
    delete afterNonHooks.hooks;
    for (const key of MANAGED_SETTING_KEYS) delete afterNonHooks[key];
    if (!isDeepStrictEqual(after.hooks, projectedHooks) || !isDeepStrictEqual(afterNonHooks, beforeNonHooks)
      || !MANAGED_SETTING_KEYS.every((key) => isDeepStrictEqual(after[key], managed[key]))) {
      return { status: 'error', detail: 'post-write settings verification failed' };
    }
    const hostDetail = platform === 'win32' ? 'canonical Windows hook paths' : `host-resolved hook paths for ${platform}`;
    return { status: 'healed', detail: `projected ${hostDetail}; previous settings bytes saved as ${path.basename(backup)}` };
  } catch (err) {
    return { status: 'error', detail: err.message };
  }
}

/**
 * Compare-only managed-hook drift check. Never writes anything. Hook-only
 * projection is separately explicit in syncGlobalClaudeHooks.
 * Returns { status: 'in-sync' | 'drift' | 'missing', detail }.
 */
function checkSettingsDrift(opts = {}) {
  const { trackedSettings, profileSettings, platform = process.platform } = { ...defaultPaths(), ...opts };
  try {
    if (!fs.existsSync(trackedSettings) || !fs.existsSync(profileSettings)) {
      return { status: 'missing', detail: 'one of the settings files does not exist' };
    }
    const tracked = JSON.parse(normalized(trackedSettings));
    const profile = JSON.parse(normalized(profileSettings));
    const repoRoot = opts.repoRoot || repoRootForTrackedSettings(trackedSettings) || REPO_ROOT;
    const projectedHooks = projectHooksForHost(tracked.hooks, { platform, repoRoot });
    const managed = managedSettings(tracked);
    if (isDeepStrictEqual(projectedHooks, profile.hooks)
      && MANAGED_SETTING_KEYS.every((key) => isDeepStrictEqual(profile[key], managed[key]))) {
      return { status: 'in-sync', detail: '' };
    }
    return {
      status: 'drift',
      detail:
        'live ~/.claude/settings.json hooks differ from tracked claude-config/settings.json; project the reviewed landed hooks',
    };
  } catch (err) {
    return { status: 'missing', detail: err.message };
  }
}

module.exports = {
  syncGlobalClaudeMd,
  syncGlobalCodexAgents,
  syncGlobalClaudeHooks,
  checkSettingsDrift,
  projectHooksForHost,
  projectHookCommand,
  validateProjectedBoundaryHooks,
  repoRootForTrackedSettings,
  defaultPaths,
};
