#!/usr/bin/env node
'use strict';

/**
 * import-smoke-check.js -- the missing-EXPORT gate (ExampleCo 2026-07-13).
 *
 * WHY THIS EXISTS (the failure require-scan cannot see):
 *   scripts/lib/require-scan.js only RESOLVES a relative `require('./x')` spec to
 *   a file on disk. It never LOADS the module. So a lib that is PRESENT but
 *   STALE -- an older copy that no longer exports a symbol a newer entrypoint
 *   calls -- passes require-scan clean, then throws at call time:
 *       const { scrubInternalIdsFromFace } = require('./lib/foo');
 *       scrubInternalIdsFromFace(...);   // TypeError: ... is not a function
 *   That is exactly the version-skew crash-loop the atomic-release primitive
 *   exists to prevent (an entrypoint shipped newer than a lib it needs).
 *
 * WHAT IT DOES:
 *   For each entry file it spawns a CHILD `node -e "require(entry)"`. A child
 *   require() actually EVALUATES the module -- top-level `require`s resolve AND
 *   any top-level calls run -- so a missing-export "X is not a function" throw
 *   surfaces here even though require-scan is blind to it.
 *
 * CLASSIFICATION (per entry):
 *   - exit 0                     -> OK  (module loaded; CLI scripts guarded by
 *                                        `require.main === module` just export)
 *   - timed out (still running)  -> OK  (module loaded and started a long-lived
 *                                        server/interval without throwing)
 *   - stderr contains EADDRINUSE -> OK  (the module fully evaluated past EVERY
 *                                        top-level require + call; only the
 *                                        socket bind lost the race to the
 *                                        already-running prod process. The
 *                                        skew we care about throws BEFORE
 *                                        listen(), so a port clash is a pass.)
 *   - any other nonzero exit     -> FAIL (MODULE_NOT_FOUND, "is not a function",
 *                                         SyntaxError, ReferenceError, ...)
 *
 * Used by scripts/lib/atomic-release.sh AFTER staging a release tree and BEFORE
 * the atomic symlink swap. Pure node + child_process so it runs identically on
 * the EC2 release host and under vitest on any dev machine.
 *
 * Usage:
 *   node import-smoke-check.js --root <releaseDir> [--timeout-ms N]
 *                              [--server-port N] <entry> [<entry>...]
 *   entry paths may be absolute or relative to --root.
 * Exit 0 = every entry loaded. Exit 1 = at least one entry threw at load.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// The crash signatures worth surfacing verbatim ahead of a generic first line.
const KEY_ERROR_RE =
  /\bis not a function\b|MODULE_NOT_FOUND|Cannot find module|SyntaxError|ReferenceError|TypeError|is not defined/;

function firstErrorLine(stderr) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.find((l) => KEY_ERROR_RE.test(l)) || lines[lines.length - 1] || '';
}

/**
 * Turn a raw spawnSync-shaped result into an ok/reason verdict.
 * @param {{status:?number, signal:?string, stderr:?string, timedOut:boolean}} res
 * @returns {{ok:boolean, reason:string}}
 */
function classifyRequireResult(res) {
  if (res && res.timedOut) {
    return { ok: true, reason: 'loaded (started a long-running server/interval without throwing)' };
  }
  const stderr = String((res && res.stderr) || '');
  if (res && res.status === 0) return { ok: true, reason: 'loaded' };
  // EADDRINUSE proves the module evaluated past every top-level require + call
  // (including the skew point); only the listen() bind lost to the live process.
  if (/EADDRINUSE/.test(stderr)) {
    return { ok: true, reason: 'loaded (port busy; module evaluated past all top-level calls)' };
  }
  const reason = firstErrorLine(stderr) || `exited ${res ? res.status : 'ExampleCo'}`;
  return { ok: false, reason };
}

/**
 * Child-process require() a single entry file and classify the outcome.
 * @param {string} absEntry absolute path to the entry file
 * @param {object} [opts]
 * @returns {{ok:boolean, reason:string, stderr:string}}
 */
function runOneImportSmoke(
  absEntry,
  { timeoutMs = 10000, env = process.env, cwd, spawnFn = spawnSync } = {},
) {
  // Pass the entry via argv (not interpolated into -e) so Windows backslashes
  // and any odd characters need no escaping.
  const res = spawnFn(process.execPath, ['-e', 'require(process.argv[1])', absEntry], {
    cwd: cwd || path.dirname(absEntry),
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  const errCode = res && res.error && res.error.code;
  const timedOut =
    errCode === 'ETIMEDOUT' ||
    (!!(res && res.signal) && !!(res && res.error) && /ETIMEDOUT|timed out/i.test(String(res.error.message || '')));
  // spawnSync surfaces spawn failures (ENOENT etc.) only on .error, never stderr.
  const stderr =
    String((res && res.stderr) || '') +
    (res && res.error && !timedOut ? `\n${res.error.message || ''}` : '');
  const verdict = classifyRequireResult({
    status: res ? res.status : null,
    signal: res ? res.signal : null,
    stderr,
    timedOut,
  });
  return { ...verdict, stderr };
}

/**
 * Run the import-smoke over a set of entry files under a release root.
 * @param {object} args
 * @param {string} args.root release root the entries resolve against
 * @param {string[]} args.entries entry files (absolute or relative to root)
 * @param {number} [args.timeoutMs]
 * @param {number} [args.serverPort] PORT env handed to server*.js entries so a
 *   future no-side-effects smoke mode can bind a scratch port
 * @param {object} [args.env]
 * @param {function} [args.spawnFn]
 * @returns {{ok:boolean, results:Array<{entry:string, ok:boolean, reason:string}>}}
 */
function runImportSmoke({ root, entries, timeoutMs = 10000, serverPort, env = process.env, spawnFn = spawnSync }) {
  const results = [];
  for (const entry of entries || []) {
    const abs = path.isAbsolute(entry) ? entry : path.join(root, entry);
    if (!fs.existsSync(abs)) {
      results.push({ entry, ok: false, reason: 'entry file does not exist on the staged tree' });
      continue;
    }
    const isServer = /(^|[\\/])(server|ec2-server)\.js$/.test(abs);
    const childEnv = isServer && serverPort ? { ...env, PORT: String(serverPort) } : env;
    const r = runOneImportSmoke(abs, { timeoutMs, env: childEnv, cwd: root, spawnFn });
    results.push({ entry, ok: r.ok, reason: r.reason });
  }
  return { ok: results.every((r) => r.ok), results };
}

function parseArgs(argv) {
  const args = { root: null, entries: [], timeoutMs: 10000, serverPort: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i]) || 10000;
    else if (a === '--server-port') args.serverPort = Number(argv[++i]) || undefined;
    else args.entries.push(a);
  }
  return args;
}

function main() {
  const { root, entries, timeoutMs, serverPort } = parseArgs(process.argv.slice(2));
  if (!root || entries.length === 0) {
    console.error(
      'Usage: node import-smoke-check.js --root <dir> [--timeout-ms N] [--server-port N] <entry> [entry...]',
    );
    process.exit(2);
  }
  const { ok, results } = runImportSmoke({ root, entries, timeoutMs, serverPort });
  for (const r of results) {
    console.log(`  import-smoke ${r.ok ? 'OK  ' : 'FAIL'} ${r.entry}${r.ok ? '' : ` -- ${r.reason}`}`);
  }
  if (ok) {
    console.log(`import-smoke: OK (${results.length} entrypoint(s) loaded, 0 threw at require)`);
    process.exit(0);
  }
  const failed = results.filter((r) => !r.ok);
  console.error(`import-smoke: FAIL (${failed.length}/${results.length} entrypoint(s) threw at require)`);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  classifyRequireResult,
  runOneImportSmoke,
  runImportSmoke,
  firstErrorLine,
  parseArgs,
};
