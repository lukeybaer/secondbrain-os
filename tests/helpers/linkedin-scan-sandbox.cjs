'use strict';
// Runs a real scripts/linkedin-*-scan.js end to end in a throwaway copy of the
// repo layout (own memory/, data/, profile dirs) under linkedin-scan-preload.cjs.
// Returns { events, code, dataDir, stdout, stderr }; the caller removes root.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_SCRIPTS = path.resolve(__dirname, '..', '..', 'scripts');
const PRELOAD = path.join(__dirname, 'linkedin-scan-preload.cjs');

function runLinkedInScan(script, { args = [], env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'li-scan-'));
  const sandboxScripts = path.join(root, 'scripts');
  fs.mkdirSync(sandboxScripts, { recursive: true });
  fs.mkdirSync(path.join(root, 'memory', 'contacts'), { recursive: true });
  fs.copyFileSync(path.join(REPO_SCRIPTS, script), path.join(sandboxScripts, script));
  const dataDir = path.join(root, 'data');
  const eventsOut = path.join(root, 'events.json');
  const run = spawnSync(process.execPath, ['--require', PRELOAD, path.join(sandboxScripts, script), ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      SCAN_EVENTS_OUT: eventsOut,
      SANDBOX_SCRIPTS: sandboxScripts,
      REPO_SCRIPTS,
      SECONDBRAIN_DATA_DIR: dataDir,
      SECONDBRAIN_LINKEDIN_PROFILE_DIR: path.join(root, 'profile'),
      APPDATA: path.join(root, 'appdata'),
      LINKEDIN_SESSION_SEED: '0',
      LINKEDIN_SKIP_LAND: '1',
      LINKEDIN_EC2_SSH_KEY: '',
      EC2_SSH_KEY: '',
      ...env,
    },
  });
  const result = fs.existsSync(eventsOut) ? JSON.parse(fs.readFileSync(eventsOut, 'utf8')) : { events: [], code: run.status };
  return { ...result, root, dataDir, stdout: run.stdout, stderr: run.stderr };
}

module.exports = { runLinkedInScan, REPO_SCRIPTS };
