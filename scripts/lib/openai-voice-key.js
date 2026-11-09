'use strict';

// Where the OpenAI key for auth-voice-paid-fallback actually lives.
//
// 2026-08-16: the first cut read only %APPDATA%. The proxy is started by a
// scheduled-task watchdog whose environment is not an interactive shell, so the
// lookup found nothing, the paid lane failed in 17ms, and Amy said "that lookup
// failed on my end" while the spend gate reported a full budget. The call
// sounded broken for a reason that had nothing to do with money or the model.
//
// Kept in its own module so it is testable without importing claude-proxy.js,
// which calls server.listen at import time.
//
// 2026-08-17: named in data/agent/api-audit-allowlist.json. This module only
// locates a credential; it never calls a paid API. Whether the voice paid lane
// may actually spend stays with the existing voice spend gate, which the paid
// API rule governs independently of this lookup.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MODEL = 'gpt-4o';

// os.homedir() reads USERPROFILE on Windows, so a launcher that sets that
// variable to the wrong directory silently poisons every derived path. The
// account record from os.userInfo() comes from the OS, not the environment,
// which is why it is tried as well rather than instead: under some service
// accounts userInfo() throws.
function accountHomedir() {
  try {
    const home = String(os.userInfo().homedir || '').trim();
    return home || '';
  } catch {
    return '';
  }
}

// os.userInfo().homedir also reads USERPROFILE on Windows, so it is NOT an
// independent source. The account NAME is, so rebuild the profile path from the
// system drive plus the real username. That survives a launcher that points
// USERPROFILE somewhere useless, which is the failure actually observed.
function accountUsername() {
  try {
    return String(os.userInfo().username || '').trim();
  } catch {
    return '';
  }
}

function candidatePaths(
  env = process.env,
  homedir = os.homedir(),
  account = accountHomedir(),
  username = accountUsername(),
) {
  const out = [];
  // Runtime-root file, checked before anything under AppData. 2026-08-16: the
  // proxy returned ENOENT for a file that had just been created and verified in
  // %APPDATA%\secondbrain, while still reading an older file from that same
  // directory. Its view of AppData is stale or redirected. The module's own
  // directory is provably reachable, because that is where its code loads from,
  // and sb-runtime sits outside every git tree so a secret there is not
  // committable.
  out.push(path.resolve(__dirname, '..', '..', '..', 'amy-voice-key.json'));
  // A dedicated single-purpose file, checked first. The shared config.json is
  // written by several processes; on 2026-08-16 the proxy read it successfully
  // and still saw an empty key while a direct read of the same path returned
  // the full value. This file has exactly one writer and one reader.
  if (env.APPDATA) out.push(path.join(env.APPDATA, 'secondbrain', 'openai-voice-key.json'));
  if (env.APPDATA) out.push(path.join(env.APPDATA, 'secondbrain', 'config.json'));
  for (const home of [homedir, account]) {
    if (!home) continue;
    out.push(path.join(home, 'AppData', 'Roaming', 'secondbrain', 'openai-voice-key.json'));
    out.push(path.join(home, 'AppData', 'Roaming', 'secondbrain', 'config.json'));
  }
  if (username) {
    const drive = String(env.SystemDrive || 'C:').replace(/\+$/, '');
    out.push(
      path.join(
        drive + path.sep,
        'Users',
        username,
        'AppData',
        'Roaming',
        'secondbrain',
        'config.json',
      ),
    );
  }
  return [...new Set(out)];
}

// readFile is injected so tests can prove the fallback order without touching
// the real filesystem or the owner's real key.
function resolveOpenAiVoiceKey({
  env = process.env,
  homedir = os.homedir(),
  account = accountHomedir(),
  username = accountUsername(),
  readFile = (file) => fs.readFileSync(file, 'utf8'),
} = {}) {
  const attempts = [];
  for (const file of candidatePaths(env, homedir, account, username)) {
    let config;
    let bytes = -1;
    try {
      const raw = readFile(file);
      bytes = typeof raw === 'string' ? raw.length : -1;
      config = JSON.parse(raw);
    } catch (error) {
      // Swallowing this made "cannot read the file" and "no key in the file"
      // look identical from outside, which cost three wrong diagnoses of a live
      // outage. Record why each candidate was rejected; paths and error codes
      // are not secrets.
      attempts.push(`${file}: ${error?.code || error?.message || 'unreadable'}`);
      continue;
    }
    const key = String(config?.openaiApiKey || '').trim();
    if (key) {
      return {
        key,
        model: String(config?.openaiModel || '').trim() || DEFAULT_MODEL,
        source: file,
        attempts,
      };
    }
    // Include what was actually parsed. A file that reads fine and still has no
    // key means either the wrong file or a different shape, and those are
    // indistinguishable without seeing the property names.
    const shape = Object.keys(config || {})
      .slice(0, 12)
      .join(',');
    attempts.push(
      `${file}: read ok (${bytes} chars), openaiApiKey empty, keys=[${shape}] typeof=${typeof config?.openaiApiKey}`,
    );
  }
  const envKey = String(env.OPENAI_API_KEY || '').trim();
  if (envKey) {
    return { key: envKey, model: DEFAULT_MODEL, source: 'env:OPENAI_API_KEY', attempts };
  }
  attempts.push('env:OPENAI_API_KEY: unset');
  return { key: '', model: DEFAULT_MODEL, source: '', attempts };
}

module.exports = {
  DEFAULT_MODEL,
  accountHomedir,
  accountUsername,
  candidatePaths,
  resolveOpenAiVoiceKey,
};
