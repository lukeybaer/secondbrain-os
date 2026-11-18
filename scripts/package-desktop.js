#!/usr/bin/env node
'use strict';

const path = require('path');
const packager = require('electron-packager');

const repoRoot = path.resolve(__dirname, '..');
const allowedTopLevel = new Set([
  // Runtime policy read at startup (model-routing.json); missing it crashes launch.
  'config',
  'memory',
  'node_modules',
  'out',
  'package.json',
  'resources',
  'scripts',
]);

function relativeParts(filePath) {
  const normalizedRoot = repoRoot.replace(/\\/g, '/');
  const normalizedPath = String(filePath).replace(/\\/g, '/');
  const relative = normalizedPath.startsWith(normalizedRoot)
    ? normalizedPath.slice(normalizedRoot.length)
    : normalizedPath;
  return relative.replace(/^\/+/, '').split('/').filter(Boolean);
}

function ignoreDesktopSource(filePath) {
  const parts = relativeParts(filePath);
  if (parts.length === 0) return false;
  if (!allowedTopLevel.has(parts[0])) return true;

  if (parts.some((part) => /^\.env(?:\.|$)/i.test(part))) return true;
  if (parts[0] === 'node_modules' && parts[1] === '.bin') return true;
  if (parts[0] === 'scripts' && parts[1] === '__tests__') return true;

  return false;
}

async function packageDesktop() {
  const appPaths = await packager({
    dir: repoRoot,
    name: 'secondbrain',
    platform: 'win32',
    arch: 'x64',
    out: path.join(repoRoot, 'dist-pkg'),
    overwrite: true,
    appBundleId: 'com.secondbrain.app',
    electronVersion: '28.3.3',
    derefSymlinks: true,
    prune: true,
    ignore: ignoreDesktopSource,
  });

  for (const appPath of appPaths) {
    console.log(`[package-desktop] Packaged app: ${appPath}`);
  }
}

if (require.main === module) {
  packageDesktop().catch((error) => {
    console.error('[package-desktop] Packaging failed:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  ignoreDesktopSource,
  packageDesktop,
};
