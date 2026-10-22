'use strict';

// SECONDBRAIN_ROOT names the code/People root. On 2026-09-27 the EC2 PM2 fleet
// carried a desktop value (C:/path/to/secondbrain) in its saved
// environment. On Linux that is not absolute, so path.resolve() turned it into
// a folder under the release, the People-file sync wrote nowhere, and one
// voice confirmation job failed and retried every minute all day, rewriting
// call files and keeping the RECORDER SPEAKER PARETO card red.
//
// A root that cannot exist on this platform is ignored in favor of the
// caller's own root, so an inherited desktop value can never redirect a
// cloud process.

const fs = require('node:fs');
const path = require('node:path');

const WINDOWS_ROOT_RE = /^[A-Za-z]:[\\/]/;

function usableRuntimeRoot(
  value,
  { platform = process.platform, pathExists = fs.existsSync } = {},
) {
  const root = String(value || '').trim();
  if (!root) return '';
  if (platform === 'win32') return root;
  if (WINDOWS_ROOT_RE.test(root) || root.includes('\\') || !path.posix.isAbsolute(root)) return '';
  // Release cleanup can leave a long-running process with an absolute but
  // vanished release path in SECONDBRAIN_ROOT. This helper serves People-file
  // readers and writers, so a root without their canonical directory is no
  // more usable than a desktop path on Linux. Falling back to the executing
  // release keeps an exact voice Save from retrying forever after cleanup.
  if (!pathExists(path.join(root, 'memory', 'contacts'))) return '';
  return root;
}

// Returns the effective root and, when the inherited value was unusable,
// rewrites env.SECONDBRAIN_ROOT so child processes inherit the corrected one.
function sanitizeRuntimeRootEnv(
  env = process.env,
  { fallbackRoot, platform = process.platform, pathExists = fs.existsSync } = {},
) {
  const inherited = String(env.SECONDBRAIN_ROOT || '');
  const usable = usableRuntimeRoot(inherited, { platform, pathExists });
  if (usable) {
    if (usable !== inherited) env.SECONDBRAIN_ROOT = usable;
    return { root: usable, replaced: false };
  }
  if (!inherited) return { root: fallbackRoot || '', replaced: false };
  if (fallbackRoot) env.SECONDBRAIN_ROOT = fallbackRoot;
  else delete env.SECONDBRAIN_ROOT;
  return { root: fallbackRoot || '', replaced: true, ignored: inherited };
}

module.exports = { usableRuntimeRoot, sanitizeRuntimeRootEnv };
