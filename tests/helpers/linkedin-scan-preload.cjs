'use strict';
// Test-only preload for running a real LinkedIn scanner script in a sandbox
// copy: fake Chromium, recording child_process, a recording notifier, and the
// repo's scripts/lib for the copy's ./lib/* requires. Events land in
// SCAN_EVENTS_OUT on exit. Never loaded outside tests.
const Module = require('module');
const fs = require('fs');
const path = require('path');
const realCp = require('child_process');

const events = [];
process.on('exit', (code) => fs.writeFileSync(process.env.SCAN_EVENTS_OUT, JSON.stringify({ events, code })));

const page = {
  goto: async () => {},
  url: () => process.env.SCAN_PAGE_URL || 'https://www.linkedin.com/messaging/',
  waitForTimeout: async () => {},
  waitForSelector: async () => { throw new Error('no conversation list in the fake page'); },
};
const context = {
  addInitScript: async () => {},
  pages: () => [page],
  newPage: async () => page,
  cookies: async () => JSON.parse(process.env.SCAN_COOKIES || '[]'),
  close: async () => { events.push({ op: 'context.close' }); },
};
const fakePlaywright = {
  chromium: { launchPersistentContext: async () => { events.push({ op: 'launch' }); return context; } },
};
const fakeCp = {
  ...realCp,
  execFileSync: (file, args) => {
    events.push({ op: 'execFileSync', file, args });
    if (process.env.DM_SCAN_FAILS === '1') {
      const e = new Error('dm scan failed');
      e.status = 4;
      throw e;
    }
    return Buffer.from('');
  },
  spawnSync: (cmd, args) => {
    events.push({ op: 'spawnSync', cmd, args });
    return { status: 0, stdout: '', stderr: '' };
  },
};
const fakeNotify = {
  notifyWithFallback: async (msg) => { events.push({ op: 'notify', kind: msg.kind, source: msg.source }); return { ok: true }; },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (parent && parent.filename && parent.filename.startsWith(process.env.SANDBOX_SCRIPTS) && request.startsWith('./lib/')) {
    return origResolve.call(this, path.join(process.env.REPO_SCRIPTS, request), parent, ...rest);
  }
  return origResolve.call(this, request, parent, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'playwright') return fakePlaywright;
  if (request === 'child_process') return fakeCp;
  if (/(^|\/)notify-with-fallback(\.js)?$/.test(request)) return fakeNotify;
  return origLoad.call(this, request, ...rest);
};
