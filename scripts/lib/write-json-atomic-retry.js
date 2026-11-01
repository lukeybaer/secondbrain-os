'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Windows readers can briefly deny replacement. Never unlink the destination:
// readers must see either the previous complete JSON or the next complete JSON.
function writeJsonAtomicRetry(file, value, {
  io = fs,
  platform = process.platform,
  wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let primaryError;
  try {
    io.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      try { io.renameSync(temporary, file); return; }
      catch (error) {
        if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 20) throw error;
        wait(50);
      }
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try { io.unlinkSync(temporary); } catch (error) {
      if (error.code !== 'ENOENT' && primaryError) primaryError.cleanupError = error;
    }
  }
}

module.exports = { writeJsonAtomicRetry };
