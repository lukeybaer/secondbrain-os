'use strict';
//
// global-config-sync.js -- keep the profile copy of the global CLAUDE.md
// identical to the tracked claude-config/CLAUDE.global.md.
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
// settings.json is deliberately compare-only, never healed: the live file
// ExampleCos machine-local values (bash path) and harness-written changes, so an
// automatic overwrite could break every hook on the machine. Drift there is
// reported so it gets reconciled intentionally.
//
// Law: AMY_GRAVITY.md G6 (one Amy). Companion test:
// scripts/__tests__/global-config-sync.test.js

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function defaultPaths() {
  return {
    trackedClaudeMd: path.join(REPO_ROOT, 'claude-config', 'CLAUDE.global.md'),
    profileClaudeMd: path.join(os.homedir(), '.claude', 'CLAUDE.md'),
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
function syncGlobalClaudeMd(opts = {}) {
  const { trackedClaudeMd, profileClaudeMd } = { ...defaultPaths(), ...opts };
  try {
    if (!fs.existsSync(trackedClaudeMd)) {
      return { status: 'missing-tracked', detail: trackedClaudeMd };
    }
    const tracked = normalized(trackedClaudeMd);
    const profileExists = fs.existsSync(profileClaudeMd);
    if (profileExists && normalized(profileClaudeMd) === tracked) {
      return { status: 'in-sync', detail: '' };
    }
    if (profileExists) {
      fs.copyFileSync(profileClaudeMd, `${profileClaudeMd}.pre-heal`);
    }
    fs.copyFileSync(trackedClaudeMd, profileClaudeMd);
    return {
      status: 'healed',
      detail: profileExists
        ? `profile copy drifted from tracked; overwritten (previous content kept at ${path.basename(profileClaudeMd)}.pre-heal)`
        : 'profile copy was missing; deployed from tracked',
    };
  } catch (err) {
    return { status: 'error', detail: err.message };
  }
}

/**
 * Compare-only settings drift check. Never writes anything.
 * Returns { status: 'in-sync' | 'drift' | 'missing', detail }.
 */
function checkSettingsDrift(opts = {}) {
  const { trackedSettings, profileSettings } = { ...defaultPaths(), ...opts };
  try {
    if (!fs.existsSync(trackedSettings) || !fs.existsSync(profileSettings)) {
      return { status: 'missing', detail: 'one of the settings files does not exist' };
    }
    if (normalized(trackedSettings) === normalized(profileSettings)) {
      return { status: 'in-sync', detail: '' };
    }
    return {
      status: 'drift',
      detail:
        'live ~/.claude/settings.json differs from tracked claude-config/settings.json; reconcile intentionally (never auto-heal settings)',
    };
  } catch (err) {
    return { status: 'missing', detail: err.message };
  }
}

module.exports = { syncGlobalClaudeMd, checkSettingsDrift, defaultPaths };
