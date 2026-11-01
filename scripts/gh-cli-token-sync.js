#!/usr/bin/env node
/**
 * gh-cli-token-sync.js
 *
 * Keeps `gh` CLI's hosts.yml in sync with the git credential helper so
 * Claude Code's "PR status" check never goes stale and emits the pink
 * "GitHub CLI authentication expired" toast that the owner never asked for.
 *
 * Behavior:
 *   1. Ask git for the github.com password via `git credential fill`.
 *   2. Compare with whatever oauth_token is currently in hosts.yml.
 *   3. For cloud sync, validate the temporary token as owner before atomic install.
 *   4. If the local token differs (or is missing), rewrite hosts.yml and verify `gh auth status`.
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
const os = require('node:os');

const HOSTS_PATH = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming'),
  'GitHub CLI',
  'hosts.yml',
);
const USER = 'owner';
const HOST = 'github.com';

function log(msg) {
  const stamp = new Date().toISOString();
  process.stdout.write(`[${stamp}] ${msg}\n`);
}

function getCredentialHelperToken(spawnSyncFn = spawnSync) {
  const res = spawnSyncFn('git', ['credential', 'fill'], {
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

function ghAuthStatusOk(spawnSyncFn = spawnSync) {
  const res = spawnSyncFn('gh', ['auth', 'status'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return res.status === 0;
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || '') : '';
}

function cloudCredentialInstallScript(remoteDir = '/var/lib/agent/credentials/github') {
  if (!/^(?:\/[A-Za-z0-9_./-]+|[A-Za-z]:\/[A-Za-z0-9_./-]+)$/.test(remoteDir) || remoteDir.includes('..')) {
    throw new Error('cloud credential directory is unsafe');
  }
  const remoteFile = `${remoteDir}/owner-token`;
  const remoteReceipt = `${remoteDir}/owner-token-sync.json`;
  return [
    'set -eu',
    'umask 077',
    `install -d -m 700 ${remoteDir}`,
    `tmp=${remoteFile}.tmp.$$`,
    `receipt_tmp=${remoteReceipt}.tmp.$$`,
    'trap \'rm -f "$tmp" "$receipt_tmp"\' EXIT HUP INT TERM',
    'cat > "$tmp"',
    'chmod 600 "$tmp"',
    'test -s "$tmp"',
    'login=$(GH_TOKEN="$(cat "$tmp")" gh api user --jq .login)',
    'test "$login" = "owner"',
    `mv -f "$tmp" ${remoteFile}`,
    'synced_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    `printf '{"schema":"amy.github-owner-token-sync.v1","synced_at":"%s","login":"%s","credential_path":"${remoteFile}","token_in_receipt":false}\n' "$synced_at" "$login" > "$receipt_tmp"`,
    'chmod 600 "$receipt_tmp"',
    `mv -f "$receipt_tmp" ${remoteReceipt}`,
    'trap - EXIT HUP INT TERM',
  ].join('\n');
}

function syncCloudCredential(token, argv, spawnSyncFn = spawnSync) {
  const host = argValue(argv, '--host');
  const identity = argValue(argv, '--identity');
  if (!/^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error('--host must be an SSH user and host');
  }
  if (!identity || !path.isAbsolute(identity)) throw new Error('--identity must be an absolute key path');
  const remoteDir = '/var/lib/agent/credentials/github';
  const remoteFile = `${remoteDir}/owner-token`;
  const remoteReceipt = `${remoteDir}/owner-token-sync.json`;
  const remote = cloudCredentialInstallScript(remoteDir);
  const result = spawnSyncFn('ssh', ['-i', identity, host, remote], {
    input: `${token}\n`,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error('cloud GitHub credential sync failed');
  return { ok: true, host, remoteFile, remoteReceipt };
}

function main(argv = process.argv.slice(2), deps = {}) {
  const spawnSyncFn = deps.spawnSync || spawnSync;
  const fresh = getCredentialHelperToken(spawnSyncFn);
  if (!fresh) {
    log('NO_TOKEN: git credential helper returned no password. Skipping.');
    return 1;
  }
  if (argv.includes('--sync-cloud')) {
    syncCloudCredential(fresh, argv, spawnSyncFn);
    log('SYNCED: protected cloud GitHub credential refreshed from Windows credential manager.');
  }
  const current = readCurrentHostsToken();
  if (current === fresh) {
    if (ghAuthStatusOk(spawnSyncFn)) {
      log('OK: hosts.yml already in sync and gh auth status is green.');
      return 0;
    }
    log('STALE: token matches but gh auth status fails. Rewriting.');
  } else {
    log(current ? 'ROTATED: credential helper token differs from hosts.yml.' : 'INIT: hosts.yml had no token, populating.');
  }
  writeHosts(fresh);
  if (ghAuthStatusOk(spawnSyncFn)) {
    log('SYNCED: hosts.yml rewritten and gh auth status is now green.');
    return 0;
  }
  log('FAIL: wrote hosts.yml but gh auth status still failing. Token may lack required scopes.');
  return 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    log(`FAIL: ${String(error?.message || error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  HOST,
  HOSTS_PATH,
  USER,
  argValue,
  cloudCredentialInstallScript,
  getCredentialHelperToken,
  ghAuthStatusOk,
  main,
  syncCloudCredential,
};
