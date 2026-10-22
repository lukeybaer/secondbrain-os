'use strict';

// Attended deploy entrypoint for tracked global Amy adapter copies. Settings
// carry machine-local non-hook configuration. Only their reviewed
// hooks object is projected; all other profile settings stay machine-local.
const path = require('node:path');
const { syncGlobalClaudeMd, syncGlobalCodexAgents, syncGlobalClaudeHooks } = require('./lib/global-config-sync.js');

// EC2 releases are immutable and intentionally do not carry .git.  The
// canonical landed-source guard therefore reads the clean build checkout when
// deploy supplies it; local/desktop callers retain the script's own repo root.
const sourceRoot = path.resolve(process.env.SECONDBRAIN_BUILD_PATH_ROOT || path.resolve(__dirname, '..'));
const sourcePaths = {
  trackedClaudeMd: path.join(sourceRoot, 'claude-config', 'CLAUDE.global.md'),
  trackedCodexAgents: path.join(sourceRoot, 'codex-config', 'AGENTS.global.md'),
  trackedSettings: path.join(sourceRoot, 'claude-config', 'settings.json'),
  repoRoot: sourceRoot,
};

const results = {
  schema: 'amy.global_adapter_projection_receipt.v1',
  projected_at: new Date().toISOString(),
  source_root: sourceRoot,
  claude: syncGlobalClaudeMd(sourcePaths),
  codex: syncGlobalCodexAgents(sourcePaths),
  claude_hooks: syncGlobalClaudeHooks(sourcePaths),
};
process.stdout.write(`${JSON.stringify(results)}\n`);
if (![results.claude.status, results.codex.status, results.claude_hooks.status].every((status) => status === 'in-sync' || status === 'healed')) {
  process.exitCode = 1;
}
