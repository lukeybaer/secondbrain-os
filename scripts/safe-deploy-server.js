#!/usr/bin/env node
'use strict';

// scripts/safe-deploy-server.js
//
// CLI wrapper that promotes a locally-patched server file to the live host through the
// HARD-gated runSafeDeploy orchestration (scripts/self-heal/safe-deploy.js, unit-tested).
// This is the ONE sanctioned path for a surgical server.js deploy after the 2026-06-19
// incident; it cannot bypass its own syntax gate the way the ad-hoc bash deploy did.
//
//   node scripts/safe-deploy-server.js <localPatchedFile>
//
// Config (env, with EC2 defaults): SAFE_DEPLOY_HOST, SAFE_DEPLOY_KEY, SAFE_DEPLOY_LIVE,
// SAFE_DEPLOY_STAGE, SAFE_DEPLOY_PM2, SAFE_DEPLOY_HEALTH, SAFE_DEPLOY_WAIT_MS.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSafeDeploy } = require('./self-heal/safe-deploy.js');

const LOCAL = process.argv[2];
const HOST = process.env.SAFE_DEPLOY_HOST || 'ec2-user@ExampleCo';
const KEY = process.env.SAFE_DEPLOY_KEY || path.join(os.homedir(), '.ssh', 'sb-key.pem');
const LIVE = process.env.SAFE_DEPLOY_LIVE || '/opt/secondbrain/server.js';
const STAGE = process.env.SAFE_DEPLOY_STAGE || '/tmp/safe-deploy-new.js';
const PM2 = process.env.SAFE_DEPLOY_PM2 || 'secondbrain-backend';
const HEALTH = process.env.SAFE_DEPLOY_HEALTH || 'localhost:3001/health';
const WAIT_MS = Number(process.env.SAFE_DEPLOY_WAIT_MS || 7000);

const SSH_OPTS = ['-i', KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=12'];
const ssh = (cmd) =>
  execFileSync('ssh', [...SSH_OPTS, HOST, cmd], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const okFromExit = (fn) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const healthy = (s) => /"status":"ok"/.test(String(s || ''));

async function main() {
  if (!LOCAL || !fs.existsSync(LOCAL)) {
    console.error('usage: node scripts/safe-deploy-server.js <localPatchedFile>');
    process.exit(2);
  }
  const deps = {
    localSyntaxOk: async () =>
      okFromExit(() => execFileSync('node', ['--check', LOCAL], { stdio: 'ignore' })),
    stage: async () => {
      try {
        execFileSync('scp', [...SSH_OPTS, LOCAL, `${HOST}:${STAGE}`], { stdio: 'ignore' });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: String(e.message) };
      }
    },
    remoteSyntaxOk: async () => okFromExit(() => ssh(`node --check ${STAGE}`)),
    backup: async () => {
      try {
        const ref = ssh(`TS=$(date +%s); B=${LIVE}.bak-$TS; cp ${LIVE} "$B"; echo "$B"`).trim();
        return { ok: !!ref, ref };
      } catch (e) {
        return { ok: false, reason: String(e.message) };
      }
    },
    deployLive: async () => {
      try {
        ssh(`cp ${STAGE} ${LIVE}`);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: String(e.message) };
      }
    },
    restart: async () => {
      try {
        ssh(`pm2 restart ${PM2}`);
      } catch {
        /* health gate is the real check */
      }
      return { ok: true };
    },
    health: async () => {
      await sleep(WAIT_MS);
      try {
        const h = ssh(`curl -s -m 8 ${HEALTH}`);
        return { ok: healthy(h), reason: String(h).slice(0, 140) };
      } catch (e) {
        return { ok: false, reason: String(e.message) };
      }
    },
    rollback: async (ref) => {
      try {
        ssh(`cp ${ref} ${LIVE}; pm2 restart ${PM2}`);
        await sleep(6000);
        return { ok: true, healthOk: healthy(ssh(`curl -s -m 8 ${HEALTH}`)) };
      } catch {
        return { ok: false, healthOk: false };
      }
    },
  };
  const result = await runSafeDeploy(deps);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'deployed' ? 0 : result.status === 'rolled-back' ? 3 : 1);
}

main();
