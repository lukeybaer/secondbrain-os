// good-output-quarantine.js
//
// Mechanical guarantee behind "do not delete the good video before a verified
// replacement exists" (FIX C(a), 2026-07-13).
//
// The rejected-video regen path used to rmSync the only valid youtube/<id>.mp4
// at the START of every rebuild attempt, so a false-positive rejection (the
// blank-detector bug, FIX A) permanently destroyed a good video whenever the
// doomed rebuild then failed. This module replaces that destructive delete
// with a quarantine: the good output is moved aside to a sibling backup so the
// build's candidate scan cannot mistake a stale copy for a fresh build, but the
// bytes survive. The original is only removed once a VERIFIED replacement
// exists (dropBackup); every failure path restores it (restoreGoodOutput).

const fs = require('fs');

/**
 * Move `goodPath` aside to a sibling backup (default `${goodPath}.regen-bak`)
 * without ever destroying it. Returns a state object to pass to
 * restoreGoodOutput / dropBackup. If `goodPath` does not exist, hadBackup is
 * false and both follow-ups are no-ops.
 */
function quarantineGoodOutput(goodPath, opts = {}) {
  const backupPath = opts.backupPath || `${goodPath}.regen-bak`;
  const state = { goodPath, backupPath, hadBackup: false };
  let exists = false;
  try {
    exists = fs.existsSync(goodPath);
  } catch {
    exists = false;
  }
  if (!exists) return state;
  try {
    fs.rmSync(backupPath, { force: true });
    fs.renameSync(goodPath, backupPath);
    state.hadBackup = true;
    return state;
  } catch {
    /* rename failed (e.g. cross-device) -- fall through to copy+remove */
  }
  try {
    // copy+remove still preserves a backup AND clears the original so the
    // candidate scan cannot mistake the stale copy for a fresh build. Never a
    // bare delete.
    fs.copyFileSync(goodPath, backupPath);
    fs.rmSync(goodPath, { force: true });
    state.hadBackup = true;
  } catch {
    // Could not quarantine at all -- leave the good file in place. Never delete.
    state.hadBackup = false;
  }
  return state;
}

/**
 * Restore the quarantined good output to its original path. Call on any
 * rebuild failure. Returns true if a restore happened.
 */
function restoreGoodOutput(state) {
  if (!state || !state.hadBackup) return false;
  try {
    if (fs.existsSync(state.backupPath)) {
      fs.rmSync(state.goodPath, { force: true });
      fs.renameSync(state.backupPath, state.goodPath);
      return true;
    }
  } catch {
    /* best effort -- the backup stays on disk for manual recovery */
  }
  return false;
}

/**
 * Discard the quarantined backup. ONLY call after a verified non-blank
 * replacement has taken the good output's place.
 */
function dropBackup(state) {
  if (!state) return;
  try {
    fs.rmSync(state.backupPath, { force: true });
  } catch {
    /* ignore */
  }
}

module.exports = { quarantineGoodOutput, restoreGoodOutput, dropBackup };
