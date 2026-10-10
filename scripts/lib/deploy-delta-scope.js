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

function classifyDeployDelta(paths) {
  const changedPaths = [...new Set((paths || []).map(normalizeChangedPath).filter(Boolean))].sort();
  const graphitiPaths = changedPaths.filter(isGraphitiRuntimePath);
  return {
    schema: 'secondbrain.deploy-delta-scope.v1',
    provable: true,
    changed_paths: changedPaths,
    graphiti_changed: graphitiPaths.length > 0,
    graphiti_paths: graphitiPaths,
  };
}

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  process.stdout.write(`${JSON.stringify(classifyDeployDelta(raw.split(/\r?\n/)))}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[deploy-delta-scope] ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { classifyDeployDelta, isGraphitiRuntimePath, normalizeChangedPath };
