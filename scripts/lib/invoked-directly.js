'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

// Task Scheduler starts PC jobs through the sb-runtime\amy-code junction, but
// Node reports import.meta.url at the real release path. Comparing the raw
// argv path skipped main() on every scheduled run since the 2026-10-16
// junction runtime: Session Sweep exited 0 in 0.1s having done nothing, and
// the transcript backlog grew to 10,000+ (2026-10-27). Compare real paths.
function realOrResolved(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function isInvokedDirectly(argv1, metaUrl) {
  if (!argv1 || !metaUrl) return false;
  const a = realOrResolved(argv1);
  const b = realOrResolved(fileURLToPath(metaUrl));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

module.exports = { isInvokedDirectly };
