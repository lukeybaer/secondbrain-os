#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  DEFAULT_TTL_MS,
  createIntegrationSession,
  clearIntegrationSession,
  validateIntegrationSession,
  checkLeaseCloseout,
} = require('./lib/integration-session.js');

function usage() {
  return [
    'Usage:',
    '  node scripts/integration-session.js --reason "why" -- <command>',
    '  node scripts/integration-session.js --status',
    '  node scripts/integration-session.js --clear',
    '  node scripts/integration-session.js --closeout [--lock <path>]',
  ].join('\n');
}

function parseArgs(argv) {
  const out = {
    reason: '',
    ttlMs: DEFAULT_TTL_MS,
    status: false,
    clear: false,
    closeout: false,
    lockPath: null,
    command: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.command = argv.slice(i + 1);
      break;
    }
    if (a === '--reason') {
      out.reason = argv[++i] || '';
    } else if (a === '--ttl-min') {
      out.ttlMs = Math.max(1, Number(argv[++i] || 60)) * 60 * 1000;
    } else if (a === '--status') {
      out.status = true;
    } else if (a === '--clear') {
      out.clear = true;
    } else if (a === '--closeout') {
      out.closeout = true;
    } else if (a === '--lock') {
      out.lockPath = argv[++i] || null;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const mainRoot = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.status) {
    const status = validateIntegrationSession({
      env: { ...process.env, SB_INTEGRATION_SESSION: '1' },
      mainRoot,
    });
    console.log(JSON.stringify(status, null, 2));
    return status.valid ? 0 : 1;
  }
  if (args.clear) {
    const result = clearIntegrationSession({ mainRoot });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (args.closeout) {
    // Do NOT pass cwd here: checkLeaseCloseout prefers the LEASE's own
    // recorded cwd/mainRoot over process.cwd() so `--closeout` reports on the
    // repo the lease actually opened against, regardless of where this CLI
    // command happens to be invoked from (Codex review finding, 2026-07-02).
    const result = checkLeaseCloseout({
      lockPath: args.lockPath,
      mainRoot,
    });
    console.log(JSON.stringify(result, null, 2));
    return result.count > 0 ? 1 : 0;
  }
  if (!args.command.length) {
    console.error(usage());
    return 2;
  }
  const reason = args.reason || 'manual integration session';
  const { lockPath, lease } = createIntegrationSession({ mainRoot, reason, ttlMs: args.ttlMs });
  console.error(`[integration-session] lease active: ${lockPath}`);
  console.error(`[integration-session] reason: ${lease.reason}`);
  try {
    const child = spawnSync(args.command[0], args.command.slice(1), {
      cwd: mainRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        SB_INTEGRATION_SESSION: '1',
        SB_INTEGRATION_SESSION_LOCK: lockPath,
      },
    });
    if (child.error) {
      console.error(`[integration-session] command failed: ${child.error.message}`);
      return 1;
    }
    return child.status == null ? 1 : child.status;
  } finally {
    clearIntegrationSession({ lockPath, mainRoot });
  }
}

if (require.main === module) process.exit(main());

module.exports = { main, parseArgs };
