'use strict';
// PC-wide limit on concurrent test runs (ship-jam S-6, owner decision).
//
// Land checks failed under load when five sessions ran vitest at once. A run
// takes one of SB_TEST_SLOTS (default 2) slot files in the OS temp folder and
// starts only when free memory is at least SB_TEST_MIN_FREE_MB (default 2048).
// A slot whose owner process is gone is reclaimed. This is a safety net, never
// a gate: after SB_TEST_SLOT_WAIT_MS (default 20 minutes) the run starts anyway
// and says so.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.tmpdir(), 'sb-test-slots');

function intEnv(env, name, fallback) {
  const n = Number.parseInt(env[name] || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryTake(slotFile, label, pid) {
  try {
    fs.writeFileSync(slotFile, JSON.stringify({ pid, label, at: new Date().toISOString() }), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  let owner = null;
  try {
    owner = JSON.parse(fs.readFileSync(slotFile, 'utf8'));
  } catch {
    owner = null;
  }
  if (owner && Number.isInteger(owner.pid) && alive(owner.pid)) return false;
  try {
    fs.rmSync(slotFile, { force: true });
    fs.writeFileSync(slotFile, JSON.stringify({ pid, label, at: new Date().toISOString() }), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Take a test slot, waiting while all slots are busy or memory is low.
 * @returns {{release: () => void, waitedMs: number, forced: boolean}}
 */
function acquireTestSlot({
  label = 'tests',
  env = process.env,
  dir = DIR,
  freemem = os.freemem,
  now = Date.now,
  sleep = sleepMs,
  pid = process.pid,
  log = (m) => process.stderr.write(`[test-slots] ${m}\n`),
} = {}) {
  const slots = Math.max(1, intEnv(env, 'SB_TEST_SLOTS', 2));
  const minFreeBytes = intEnv(env, 'SB_TEST_MIN_FREE_MB', 2048) * 1024 * 1024;
  const waitMs = intEnv(env, 'SB_TEST_SLOT_WAIT_MS', 20 * 60 * 1000);
  fs.mkdirSync(dir, { recursive: true });
  const started = now();
  let announced = false;
  for (;;) {
    if (freemem() >= minFreeBytes) {
      for (let i = 0; i < slots; i += 1) {
        const slotFile = path.join(dir, `slot-${i}.json`);
        if (tryTake(slotFile, label, pid)) {
          let released = false;
          return {
            waitedMs: now() - started,
            forced: false,
            release() {
              if (released) return;
              released = true;
              try {
                const owner = JSON.parse(fs.readFileSync(slotFile, 'utf8'));
                if (owner.pid === pid) fs.rmSync(slotFile, { force: true });
              } catch {
                /* already gone */
              }
            },
          };
        }
      }
    }
    if (now() - started >= waitMs) {
      log(`no test slot after ${Math.round(waitMs / 1000)}s; running ${label} anyway.`);
      return { waitedMs: now() - started, forced: true, release() {} };
    }
    if (!announced) {
      log(`waiting for a test slot (${slots} PC-wide, ${Math.round(minFreeBytes / 1048576)} MB free memory) for ${label}.`);
      announced = true;
    }
    sleep(2000);
  }
}

module.exports = { acquireTestSlot, DIR };
