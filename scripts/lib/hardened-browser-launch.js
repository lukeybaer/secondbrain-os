'use strict';

// Hardened browser launch options (owner decision: Playwright 1.64.1, sandbox on,
// real Google Chrome for logged-in jobs). Playwright defaults chromiumSandbox to
// false and its bundled Chromium trails Chrome stable's security fixes, and some
// jobs browse while signed in to LinkedIn, mail and WhatsApp. Every launch site
// builds its options here so the policy lives in one place.
//
//   hardenedLaunchOptions(options, { loggedIn })  Playwright launch / launchPersistentContext options
//   hardenedChromiumArgs(args)                    the same arg scrub for Puppeteer launchers
//   findInstalledChrome()                         path of real Google Chrome on this host, or ''
//
// SB_PLAYWRIGHT_BUNDLED=1 forces bundled Chromium (emergency only; drops any channel).
// The sandbox is never switched off here. A host where it cannot start (root, no
// user namespaces, locked-down container) must fail loud and be reported, not be
// patched with --no-sandbox.

const fs = require('node:fs');
const path = require('node:path');

// Flags that switch the sandbox off or keep it from engaging (it needs the
// zygote, and --single-process runs renderers inside the browser process).
const SANDBOX_DEFEATING_ARGS = new Set([
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu-sandbox',
  '--disable-namespace-sandbox',
  '--disable-seccomp-filter-sandbox',
  '--no-zygote',
  '--single-process',
]);

const warned = new Set();
function defaultWarn(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[hardened-browser] ${message}`);
}

function chromeCandidates(platform, env) {
  if (platform === 'win32') {
    const roots = [
      env.ProgramFiles || 'C:\\Program Files',
      env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      env.LOCALAPPDATA || (env.USERPROFILE ? path.win32.join(env.USERPROFILE, 'AppData', 'Local') : ''),
    ].filter(Boolean);
    return roots.map((root) => path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  // Google's package installs all three; Playwright's chrome channel runs /opt/google/chrome/chrome.
  return ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
}

function findInstalledChrome({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  return (
    chromeCandidates(platform, env).find((candidate) => {
      try {
        return exists(candidate);
      } catch {
        return false;
      }
    }) || ''
  );
}

function hardenedChromiumArgs(args, { warn = defaultWarn } = {}) {
  const list = Array.isArray(args) ? args : [];
  const removed = list.filter((arg) => SANDBOX_DEFEATING_ARGS.has(String(arg).split('=')[0]));
  if (removed.length) warn(`removed sandbox-defeating browser flag(s): ${[...new Set(removed)].join(', ')}`);
  return list.filter((arg) => !removed.includes(arg));
}

function hardenedLaunchOptions(
  options = {},
  { loggedIn = false, env = process.env, platform = process.platform, exists = fs.existsSync, warn = defaultWarn } = {},
) {
  const out = { ...options, chromiumSandbox: true };
  if (options.chromiumSandbox === false) warn('chromiumSandbox:false was requested and ignored; the sandbox stays on');
  if (Array.isArray(options.args)) out.args = hardenedChromiumArgs(options.args, { warn });

  if (env.SB_PLAYWRIGHT_BUNDLED === '1') {
    if (loggedIn || out.channel) warn('SB_PLAYWRIGHT_BUNDLED=1: using bundled Chromium instead of real Chrome');
    delete out.channel;
  } else if (loggedIn && !out.channel && !out.executablePath) {
    if (findInstalledChrome({ env, platform, exists })) out.channel = 'chrome';
    else warn('real Google Chrome not found on this host; logged-in job falls back to bundled Chromium');
  }
  if (out.channel === undefined) delete out.channel;
  return out;
}

module.exports = {
  SANDBOX_DEFEATING_ARGS,
  findInstalledChrome,
  hardenedChromiumArgs,
  hardenedLaunchOptions,
};
