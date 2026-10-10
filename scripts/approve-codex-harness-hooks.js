#!/usr/bin/env node
'use strict';

// One-click owner approval of the SecondBrain Codex hooks (2026-09-27).
//
// Codex runs a hook only after its owner approves the exact definition; any
// definition change (matcher, command) makes it "modified" and Codex silently
// skips it. The Codex desktop app has no /hooks screen, so ExampleCo asked for a
// command he can click. Run without flags to see what would be approved; ExampleCo
// clicks it with --approve. It uses Codex's own app-server (hooks/list, then
// config/batchWrite of each hook's current hash, exactly what the CLI /hooks
// screen writes) and approves ONLY the three "SecondBrain native harness"
// hooks that run scripts/codex-harness-hook.js from the runtime clone. It
// never approves any other hook, and an agent must not run --approve itself.
//
//   node scripts/approve-codex-harness-hooks.js            # show status
//   node scripts/approve-codex-harness-hooks.js --approve  # ExampleCo's click

const { spawn } = require('node:child_process');

const PREFIX = 'SecondBrain native harness: ';

function isHarnessHook(hook) {
  return (
    hook &&
    hook.source === 'user' &&
    String(hook.statusMessage || '').startsWith(PREFIX) &&
    /[\\/]sb-runtime[\\/]amy-code[\\/]scripts[\\/]codex-harness-hook\.js"?$/.test(String(hook.command || ''))
  );
}

// config keyPath with the hook key as one quoted segment (backslashes escaped).
function trustKeyPath(key) {
  return `hooks.state."${String(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}".trusted_hash`;
}

function trustEdits(hooks) {
  return hooks
    .filter((h) => isHarnessHook(h) && h.trustStatus !== 'trusted')
    .map((h) => ({ keyPath: trustKeyPath(h.key), value: h.currentHash, mergeStrategy: 'upsert' }));
}

function appServer(cwd) {
  const child = spawn('codex app-server', { cwd, shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let buf = '';
  let next = 1;
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const notify = (method) => child.stdin.write(`${JSON.stringify({ method })}\n`);
  return { request, notify, close: () => child.kill() };
}

async function listHarness(server, cwd) {
  const result = await server.request('hooks/list', { cwds: [cwd] });
  return (result.data || []).flatMap((g) => g.hooks || []).filter(isHarnessHook);
}

async function main(argv = process.argv.slice(2)) {
  const cwd = process.cwd();
  const server = appServer(cwd);
  const timer = setTimeout(() => { server.close(); console.error('Codex app-server did not answer in 45 s.'); process.exit(1); }, 45000);
  try {
    await server.request('initialize', { clientInfo: { name: 'secondbrain-hook-approval', title: 'SecondBrain hook approval', version: '1.0.0' } });
    server.notify('initialized');
    const before = await listHarness(server, cwd);
    if (!before.length) throw new Error('No SecondBrain harness hooks found in ~/.codex/hooks.json. Install them first.');
    for (const h of before) console.log(`${h.trustStatus.padEnd(9)} ${h.statusMessage}\n          ${h.command}`);
    const edits = trustEdits(before);
    if (!edits.length) {
      console.log('All SecondBrain Codex hooks are approved.');
      return 0;
    }
    if (!argv.includes('--approve')) {
      console.log(`${edits.length} hook(s) need ExampleCo's approval: re-run with --approve.`);
      return 2;
    }
    await server.request('config/batchWrite', { edits, reloadUserConfig: true });
    const after = await listHarness(server, cwd);
    const unapproved = after.filter((h) => h.trustStatus !== 'trusted');
    for (const h of after) console.log(`now ${h.trustStatus.padEnd(9)} ${h.statusMessage}`);
    if (unapproved.length) throw new Error('Some hooks are still not approved.');
    console.log('Approved. New Codex threads now run the SecondBrain guards.');
    return 0;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { isHarnessHook, trustEdits, trustKeyPath };
