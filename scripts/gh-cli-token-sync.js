#!/usr/bin/env node
/**
 * gh-cli-token-sync.js
 *
 * Keeps `gh` CLI's hosts.yml in sync with the git credential helper so
 * Claude Code's "PR status" check never goes stale and emits the pink
 * "GitHub CLI authentication expired" toast that ExampleCo never asked for.
 *
 * Behavior:
 *   1. Ask git for the github.com password via `git credential fill`.
 *   2. Compare with whatever oauth_token is currently in hosts.yml.
 *   3. If different (or missing), rewrite hosts.yml.
 *   4. Run `gh auth status`. If still failing, log and exit 1.
 *
 * Scheduled by register-scheduled-tasks.ps1 (SecondBrain-GhCliTokenSync,
 * every 6 hours) and invoked through silent-node-launcher.vbs so the
 * task never pops a cmd window. Rule:
 * memory/feedback_scheduled_tasks_must_be_silent.md.
 *
 * No external deps; only Node stdlib + git/gh on PATH.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HOSTS_PATH = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Roaming'),
  'GitHub CLI',
  'hosts.yml',
);
const USER = 'ExampleCoyExampleCo';
const HOST = 'github.com';

function log(msg) {
  const stamp = new Date().toISOString();
  process.stdout.write(`[${stamp}] ${msg}\n`);
}

function getCredentialHelperToken() {
  const res = spawnSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=${HOST}\n\n`,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (res.status !== 0) return null;
  const line = res.stdout.split(/\r?\n/).find((l) => l.startsWith('password='));
  return line ? line.slice('password='.length) : null;
}

function readCurrentHostsToken() {
  try {
    const src = fs.readFileSync(HOSTS_PATH, 'utf8');
    const m = src.match(/oauth_token:\s*(\S+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function writeHosts(token) {
  fs.mkdirSync(path.dirname(HOSTS_PATH), { recursive: true });
  const yml = [
    `${HOST}:`,
    `    users:`,
    `        ${USER}:`,
    `            oauth_token: ${token}`,
    `    git_protocol: https`,
    `    user: ${USER}`,
    `    oauth_token: ${token}`,
    ``,
  ].join('\n');
  fs.writeFileSync(HOSTS_PATH, yml, 'utf8');
}

function ghAuthStatusOk() {
  const res = spawnSync('gh', ['auth', 'status'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return res.status === 0;
}

function main() {
  const fresh = getCredentialHelperToken();
  if (!fresh) {
    log('NO_TOKEN: git credential helper returned no password. Skipping.');
    process.exit(1);
  }
  const current = readCurrentHostsToken();
  if (current === fresh) {
    if (ghAuthStatusOk()) {
      log('OK: hosts.yml already in sync and gh auth status is green.');
      process.exit(0);
    }
    log('STALE: token matches but gh auth status fails. Rewriting.');
  } else {
    log(current ? 'ROTATED: credential helper token differs from hosts.yml.' : 'INIT: hosts.yml had no token, populating.');
  }
  writeHosts(fresh);
  if (ghAuthStatusOk()) {
    log('SYNCED: hosts.yml rewritten and gh auth status is now green.');
    process.exit(0);
  }
  log('FAIL: wrote hosts.yml but gh auth status still failing. Token may lack required scopes.');
  process.exit(1);
}

main();
