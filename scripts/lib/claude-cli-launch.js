'use strict';

/**
 * claude-cli-launch.js
 *
 * One resolver for "how do I start the Claude CLI that this caller used to
 * find as cli.js". Claude Code up to 2.1.9x shipped a JavaScript entry point
 * (`@anthropic-ai/claude-code/cli.js`) that callers ran as `node cli.js`.
 * Newer packages (2.1.2xx, measured on EC2 2026-09-23 with 2.1.281 and on the
 * PC with 2.1.214) ship only a native binary at `bin/claude.exe` in the same
 * package directory, and cli.js is gone. A caller that only looked for cli.js
 * then silently dropped its Claude call (the video builder fell back to its
 * hardcoded emphasis list, the shorts proposer returned no CLI).
 *
 * Contract:
 *   - cli.js stays preferred whenever it exists, launched with this node.
 *   - Otherwise the native binary of the SAME install (the `bin/claude.exe`
 *     sibling of each cli.js candidate) is launched directly, no shell, so a
 *     multi-line prompt is never mangled by cmd.exe.
 *   - No new install location is searched. A caller whose candidates never
 *     existed on a host still finds nothing there, so this changes which file
 *     starts the CLI, never whether a host starts one.
 */

const fs = require('node:fs');
const path = require('node:path');

function nativeSibling(cliJsPath) {
  return path.join(path.dirname(cliJsPath), 'bin', 'claude.exe');
}

function safeExists(existsFn, file) {
  try {
    return Boolean(existsFn(file));
  } catch {
    return false;
  }
}

/**
 * @param {string[]} cliJsCandidates cli.js paths in the caller's own order
 * @param {{existsFn?: Function, execPath?: string}} opts
 * @returns {{exec:string, baseArgs:string[], layout:'cli-js'|'native', path:string}|null}
 */
function resolveClaudeLaunch(cliJsCandidates, { existsFn = fs.existsSync, execPath = process.execPath } = {}) {
  const list = (Array.isArray(cliJsCandidates) ? cliJsCandidates : [cliJsCandidates]).filter(Boolean);
  for (const candidate of list) {
    if (safeExists(existsFn, candidate)) {
      return { exec: execPath, baseArgs: [candidate], layout: 'cli-js', path: candidate };
    }
  }
  for (const candidate of list) {
    const native = nativeSibling(candidate);
    if (safeExists(existsFn, native)) return { exec: native, baseArgs: [], layout: 'native', path: native };
  }
  return null;
}

/**
 * Like resolveClaudeLaunch for one cli.js path, but never null: when neither
 * layout exists it returns the old `node cli.js` launch so the caller fails
 * exactly as it did before (a spawn error it already handles).
 */
function claudeCliLaunch(cliJsPath, opts = {}) {
  const execPath = opts.execPath || process.execPath;
  return (
    resolveClaudeLaunch([cliJsPath], opts) || { exec: execPath, baseArgs: [cliJsPath], layout: 'cli-js', path: cliJsPath }
  );
}

module.exports = { claudeCliLaunch, nativeSibling, resolveClaudeLaunch };
