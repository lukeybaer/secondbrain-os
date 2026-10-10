'use strict';

const fs = require('node:fs');
const path = require('node:path');

function resolveDirectCodex(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return { command: 'codex', prefix: [] };
  // Desktop places its current CLI on PATH. An older npm shim may reject
  // current models and the desktop model-cache schema; prefer native execution.
  const roots = [...String(env.PATH || env.Path || '').split(path.delimiter),
    env.APPDATA && path.join(env.APPDATA, 'npm')].filter(Boolean);
  const native = roots.map((root) => path.join(root, 'codex.exe')).find((file) => fs.existsSync(file));
  if (native) return { command: native, prefix: [] };
  const entry = roots.map((root) => path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')).find((file) => fs.existsSync(file));
  if (!entry) throw new Error('Installed Codex executable not found on PATH; work remains unfinished.');
  // Execute npm's entry point directly, without shell interpolation.
  return { command: process.execPath, prefix: [entry] };
}

module.exports = { resolveDirectCodex };
