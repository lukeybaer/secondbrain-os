'use strict';

const GRAPHITI_PATH_PATTERNS = [
  /^docker-compose\.graphiti\.yml$/i,
  /^config\/graphiti-[^/]+\.json$/i,
  /^infra\/graphiti\//i,
  /^scripts\/[^/]*graphiti[^/]*$/i,
  /^scripts\/lib\/[^/]*graphiti[^/]*$/i,
  /^scripts\/ensure-neo4j-cpu-cap\.js$/i,
  /^scripts\/lib\/neo4j-resource-cap\.js$/i,
  /^skills\/memory\/graphiti-consult-for-prompts\//i,
];

function normalizeChangedPath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function isGraphitiRuntimePath(value) {
  const rel = normalizeChangedPath(value);
  return Boolean(rel && GRAPHITI_PATH_PATTERNS.some((pattern) => pattern.test(rel)));
}

// Owner decision: the real self-call proof runs only on deploys that
// change what a caller hears, the voice release surface. Other deploys keep
// the existing proof and place no call.
function voiceSurfaceFiles() {
  try {
    return new Set(require('./voice-release-proof.js').DEFAULT_SURFACE_FILES);
  } catch {
    return null;
  }
}

// A changed surface file whose hashed text is the same at both releases (the
// server file's phone slice, owner decision) changes nothing a caller hears.
// `sameSurfaceText(rel)` answers that; any doubt keeps the path.
function classifyDeployDelta(paths, { surfaceFiles = voiceSurfaceFiles(), sameSurfaceText = null } = {}) {
  const changedPaths = [...new Set((paths || []).map(normalizeChangedPath).filter(Boolean))].sort();
  const graphitiPaths = changedPaths.filter(isGraphitiRuntimePath);
  const voicePaths = surfaceFiles
    ? changedPaths.filter((rel) => surfaceFiles.has(rel) && !safeSame(sameSurfaceText, rel))
    : changedPaths;
  return {
    schema: 'secondbrain.deploy-delta-scope.v1',
    provable: true,
    changed_paths: changedPaths,
    graphiti_changed: graphitiPaths.length > 0,
    graphiti_paths: graphitiPaths,
    // Unknown surface list fails safe: the proof runs.
    voice_changed: !surfaceFiles || voicePaths.length > 0,
    voice_paths: voicePaths,
  };
}

function safeSame(sameSurfaceText, rel) {
  try {
    return Boolean(sameSurfaceText && sameSurfaceText(rel) === true);
  } catch {
    return false;
  }
}

// Compares a path's hashed surface text at two commits of one checkout.
function gitSurfaceComparator({ root, base, target }) {
  const { execFileSync } = require('node:child_process');
  const { surfaceText } = require('./voice-release-proof.js');
  const show = (ref, rel) => execFileSync('git', ['-C', root, 'show', `${ref}:${rel}`], {
    encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return (rel) => surfaceText(rel, show(base, rel)) === surfaceText(rel, show(target, rel));
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv = process.argv.slice(2)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  const root = argValue(argv, '--root');
  const base = argValue(argv, '--base');
  const target = argValue(argv, '--target');
  const sameSurfaceText = root && base && target ? gitSurfaceComparator({ root, base, target }) : null;
  process.stdout.write(`${JSON.stringify(classifyDeployDelta(raw.split(/\r?\n/), { sameSurfaceText }))}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[deploy-delta-scope] ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { classifyDeployDelta, gitSurfaceComparator, isGraphitiRuntimePath, normalizeChangedPath };
