#!/usr/bin/env node
'use strict';

// One-click owner approval of the SecondBrain Codex hooks (2026-09-27).
//
// Codex runs a hook only after its owner approves the exact definition; any
// definition change (matcher, command) makes it "modified" and Codex silently
// skips it. The Codex desktop app has no /hooks screen, so the owner asked for a
// command he can click. Run without flags to see what would be approved; the owner
// clicks it with --approve. It uses Codex's own app-server (hooks/list, then
// config/batchWrite of each hook's current hash, exactly what the CLI /hooks
// screen writes) and approves ONLY the "SecondBrain native harness"
// hooks that run scripts/codex-harness-hook.js from the runtime clone. It
// never approves any other hook, and an agent must not run --approve itself.
//
//   node scripts/approve-codex-harness-hooks.js            # show status
//   node scripts/approve-codex-harness-hooks.js --approve  # the owner's click

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { resolveDirectCodex } = require('./lib/codex-executable.js');

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

// The codex.exe Codex Desktop runs, newest build first. It is the engine these
// hooks are for, and every process can see it. The npm `codex` can live only in
// the Claude app's private AppData overlay, so a Command Prompt has no such
// command even though every Claude session does (2026-11-08).
function desktopCodexExe(env = process.env) {
  if (!env.LOCALAPPDATA) return null;
  const bin = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  let builds;
  try { builds = fs.readdirSync(bin); } catch { return null; }
  const exes = builds.map((build) => path.join(bin, build, 'codex.exe')).filter((file) => fs.existsSync(file));
  exes.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return exes[0] || null;
}

function codexLaunch(env = process.env) {
  const exe = desktopCodexExe(env);
  return exe ? { command: exe, prefix: [] } : resolveDirectCodex(process.platform, env);
}

function appServer(cwd, { command, prefix } = codexLaunch()) {
  const child = spawn(command, [...prefix, 'app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = '';
  let stderr = '';
  let next = 1;
  let failure = null;
  const pending = new Map();
  // A Codex that cannot start or dies early fails here at once, with its own
  // error, instead of looking like a slow answer until the timeout.
  const fail = (reason) => {
    failure = failure || new Error(`${reason}${stderr.trim() ? `\n${stderr.trim()}` : ''}`);
    for (const p of pending.values()) p.reject(failure);
    pending.clear();
  };
  child.on('error', (e) => fail(`Could not start ${command}: ${e.message}`));
  child.on('close', (code) => fail(`Codex app-server stopped (exit ${code}) before answering.`));
  child.stdin.on('error', () => {}); // The close handler above reports it.
  child.stderr.on('data', (d) => { stderr = `${stderr}${d}`.slice(-2000); });
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
    if (failure) { reject(failure); return; }
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
      console.log(`${edits.length} hook(s) need the owner's approval: re-run with --approve.`);
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

module.exports = { appServer, codexLaunch, isHarnessHook, trustEdits, trustKeyPath };
