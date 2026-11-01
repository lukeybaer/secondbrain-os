'use strict';

// bounded-recovery-log.js -- caps night-supervisor.js's per-briefing-date
// recovery log (Packet S, 2026-09-01).
//
// night-supervisor.js spawns its recovery wrapper (the card-controller or
// watcher run script) with stdio wired to a raw append file descriptor on
// data/agent/night-supervisor-recovery-<date>.log, then calls child.unref()
// so the supervisor's own short cron-invoked process can exit while the
// recovery wrapper keeps running detached. That log reached 11.5 million
// lines (725MB) for one briefing date because the card-controller prints full
// pretty-printed JSON receipts to stdout on every heal cycle, with nothing
// bounding growth.
//
// A raw fd handed to a detached child cannot be capped from the PARENT
// process after the parent exits (the fd is OS-level, invisible to Node's
// stream layer once handed off), and pipes into a still-running Node parent
// are not an option either: `detached` + `unref()` exist specifically so the
// supervisor process CAN exit immediately, and stdio 'pipe' streams need a
// live reader or the child blocks on a full pipe buffer, or gets SIGPIPE once
// the parent actually exits.
//
// The fix: interpose THIS script, run as its own process inside the SAME
// detached pipeline (`recoveryScript 2>&1 | node bounded-recovery-log.js
// <file> <capBytes>`), so capping happens in a sibling process that survives
// exactly as long as the recovery script does, independent of whether
// night-supervisor.js itself is still running. `appendBounded` is the pure,
// directly-testable core; `runCli` is the thin stdin-draining wrapper this
// file runs as when invoked as a subprocess.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CAP_BYTES = 32 * 1024 * 1024; // 32 MB per briefing date

function truncationLine(capBytes) {
  return (
    `\n[night-supervisor] recovery log capped at ${capBytes} bytes for this briefing date; ` +
    'further child output is discarded here (not lost -- the full pretty-printed receipt ' +
    'still lives in its own card-controller run; the receipt path is already logged above ' +
    'this line before output volume grows).\n'
  );
}

// Appends `chunk` to `file`, honoring a hard byte cap for the WHOLE file
// (across every call, and across separate process invocations that reuse the
// same file, since the cap is re-derived from the file's actual size rather
// than from any in-memory counter). Writes exactly one truncation marker the
// moment the cap is crossed, and is a silent no-op forever after -- callers
// must keep draining their input after that (never blocking upstream), they
// just stop asking this function to write anything more.
function appendBounded({ file, chunk, capBytes = DEFAULT_CAP_BYTES, currentSize = null }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = currentSize;
  if (size == null) {
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
  }
  if (size >= capBytes) {
    return { size, wroteBytes: 0, crossedCap: false, alreadyCapped: true };
  }
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
  const remaining = capBytes - size;
  const fd = fs.openSync(file, 'a');
  try {
    if (buffer.length <= remaining) {
      fs.writeSync(fd, buffer);
      return {
        size: size + buffer.length,
        wroteBytes: buffer.length,
        crossedCap: false,
        alreadyCapped: false,
      };
    }
    const slice = buffer.subarray(0, remaining);
    fs.writeSync(fd, slice);
    const marker = Buffer.from(truncationLine(capBytes), 'utf8');
    fs.writeSync(fd, marker);
    return {
      size: size + slice.length + marker.length,
      wroteBytes: slice.length + marker.length,
      crossedCap: true,
      alreadyCapped: false,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// CLI mode: reads stdin to EOF, appending bounded. Keeps draining after the
// cap (discarding, never writing) so the upstream side of the pipe never sees
// backpressure once the log stops growing -- a stalled recovery-script write
// would otherwise look like a hang, not a full log.
function runCli({ file, capBytes = DEFAULT_CAP_BYTES, stdin = process.stdin } = {}) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }
  stdin.on('data', (chunk) => {
    const result = appendBounded({ file, chunk, capBytes, currentSize: size });
    size = result.size;
  });
  stdin.on('end', () => process.exit(0));
  stdin.resume();
}

module.exports = { DEFAULT_CAP_BYTES, truncationLine, appendBounded, runCli };

if (require.main === module) {
  const [, , file, capArg] = process.argv;
  if (!file) {
    process.stderr.write('usage: bounded-recovery-log.js <logFile> [capBytes]\n');
    process.exit(2);
  }
  runCli({ file, capBytes: Number(capArg) > 0 ? Number(capArg) : DEFAULT_CAP_BYTES });
}
