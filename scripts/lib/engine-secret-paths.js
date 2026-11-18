'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// The real places this host keeps secrets, for both engines' sandboxes. On EC2 the
// release folder's .env and data are symlinks (.env into /opt/secondbrain-durable,
// data into /opt/secondbrain-shared), and a sandbox rule on the link alone is not
// enough, so every entry is the resolved path of something that exists (review
// 2026-11-10). Folders are masked whole; in the env folder, matching files; in data,
// everything but the chat sessions folder.
const HOME_SECRET_FILES = ['.ssh', '.aws', '.config/gh', '.docker', '.secrets', '.claude-auth-backups', '.claude/.credentials.json', '.claude.json', '.codex/auth.json', '.git-credentials', '.netrc'];
// Only .env is anchored; the other words match anywhere in a name on purpose, which
// denies more rather than less. Do not narrow it.
const SECRET_FILE_NAME = /^\.env|cookies|token|secret|credential|oauth|\.pem$|\.key$/i;
// Spend and usage reports say "token" in their names and hold no secret.
const SPEND_REPORT_NAME = /^(?:codex-)?token-(?:usage|reduction|spend)|token-snapshot/i;
// The one data folder the sandboxed shell may read: the chat sessions, where each
// turn's workspace lives (telegram-agent-harness.js runTurn).
const DATA_SESSIONS_FOLDER = 'amy-sessions';
const SECRET_SCAN_MAX = 400;

function secretReadPaths({ repoRoot, home = os.homedir(), fsImpl = fs } = {}) {
  const found = new Set();
  const real = (target) => {
    try {
      return fsImpl.realpathSync(target);
    } catch {
      return null;
    }
  };
  const add = (target) => {
    const resolved = target && real(target);
    if (resolved) found.add(resolved.replace(/\\/g, '/'));
  };
  const entries = (dir) => {
    try {
      return fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const rel of HOME_SECRET_FILES) add(path.join(home, rel));
  for (const entry of entries(home)) if (/^\.claude-oauth-token/.test(entry.name)) add(path.join(home, entry.name));
  const root = repoRoot ? path.resolve(repoRoot) : null;
  if (root) {
    // The folder holding the live .env (the durable folder on EC2), and the repo itself.
    const envDirs = new Set([root]);
    const envReal = real(path.join(root, '.env'));
    if (envReal) envDirs.add(path.dirname(envReal));
    for (const dir of envDirs) {
      for (const entry of entries(dir)) {
        if (SECRET_FILE_NAME.test(entry.name) || (entry.isDirectory() && ['github', '.claude'].includes(entry.name) && dir !== root)) add(path.join(dir, entry.name));
      }
    }
    const dataRoot = real(path.join(root, 'data'));
    if (dataRoot) {
      // Data is denied by default: one rule per top-level entry except the chat
      // sessions folder, which holds the turn workspace with its attachments copied in.
      // Everything else the engine needs from data comes through the broker, outside
      // the sandbox. A name scan of all 1.4M files took 35 seconds on EC2 and a depth
      // cap left deeper secrets readable (review 2026-11-10), so nothing is scanned here.
      for (const entry of entries(dataRoot)) if (entry.name !== DATA_SESSIONS_FOLDER) add(path.join(dataRoot, entry.name));
      // Inside the sessions folder (small: 180 entries on EC2), secret-named files at any depth.
      let scanned = 0;
      const walk = (dir) => {
        for (const entry of entries(dir)) {
          const full = path.join(dir, entry.name);
          if (SECRET_FILE_NAME.test(entry.name) && !SPEND_REPORT_NAME.test(entry.name)) {
            // Past the cap the rule list would grow without end, so the whole folder is
            // denied instead of the file: the list fails closed, never open.
            add(scanned < SECRET_SCAN_MAX ? full : dir);
            scanned += 1;
          } else if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
        }
      };
      walk(path.join(dataRoot, DATA_SESSIONS_FOLDER));
    }
  }
  return [...found].sort();
}

function isDirectory(target, fsImpl = fs) {
  try {
    return fsImpl.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// Codex 0.163 takes a permission profile: read everywhere, write the workspace, and
// no access at all to each secret path. Probed on EC2 2026-11-10: .env, ~/.ssh and
// auth.json refused, repo write refused, no network, workspace write ok.
function codexSandboxArgs({ secrets }) {
  const cells = [':root', ':workspace_roots'].map((key, i) => `${JSON.stringify(key)}=${JSON.stringify(i ? 'write' : 'read')}`);
  for (const target of secrets) cells.push(`${JSON.stringify(target)}="none"`);
  return [
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    'default_permissions="amy_telegram"',
    '-c',
    `permissions.amy_telegram.filesystem={${cells.join(', ')}}`,
  ];
}
module.exports = { DATA_SESSIONS_FOLDER, SECRET_SCAN_MAX, codexSandboxArgs, isDirectory, secretReadPaths };
