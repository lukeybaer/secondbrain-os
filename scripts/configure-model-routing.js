#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SOURCE_POLICY, readPolicyFile, runtimePolicyPath, validatePolicy, withSourceModels } = require('./lib/model-routing-config.js');

function usage() {
  return 'Usage: node scripts/configure-model-routing.js show | model <model-id> on|off | tier <codex|claude> <0|1|2|3> <model-id> <effort> | default <model-id> <effort> [--runtime|--all]';
}

function writeAtomic(file, policy) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function applyCommand(policy, argv) {
  const [command, a, b, c, d] = argv.filter((arg) => !['--runtime', '--all'].includes(arg));
  if (command === 'show') return policy;
  if (command === 'model' && policy.models[a] && ['on', 'off'].includes(b)) {
    if (policy.models[a].explicitCurrentPromptOnly) {
      // An explicit-only model never routes automatically (enabled stays
      // false); on/off is the operational switch for the owner route that
      // names it, such as the adversarial reviewer.
      if (b === 'off') policy.models[a].ownerRouteOff = true;
      else delete policy.models[a].ownerRouteOff;
    } else {
      policy.models[a].enabled = b === 'on';
    }
  } else if (command === 'tier' && ['codex', 'claude'].includes(a) && /^[0-3]$/.test(b) && policy.models[c] && d) {
    policy.tiers[a][b] = { ...policy.tiers[a][b], model: c, effort: d };
  } else if (command === 'default' && policy.models[a] && b) {
    policy.defaults.codex = { model: a, effort: b };
  } else {
    throw new Error(usage());
  }
  return validatePolicy(policy);
}

function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  if (!argv.length) throw new Error(usage());
  const useRuntime = argv.includes('--runtime');
  const updateAll = argv.includes('--all');
  const sourcePolicy = deps.sourcePolicy || SOURCE_POLICY;
  const runtime = deps.runtimeFile || runtimePolicyPath(env);
  const file = useRuntime ? runtime : sourcePolicy;
  // A runtime file older than a source model registration must still accept
  // `model <new-id> off`, so it inherits the source models it lacks.
  const base = !fs.existsSync(file) ? readPolicyFile(sourcePolicy)
    : useRuntime ? withSourceModels(readPolicyFile(file), readPolicyFile(sourcePolicy))
      : readPolicyFile(file);
  const policy = applyCommand(structuredClone(base), argv);
  const written = [];
  if (argv[0] !== 'show') {
    const localTargets = useRuntime ? [runtime] : [...new Set([sourcePolicy, runtime])];
    if (updateAll) {
      const host = env.SECONDBRAIN_EC2_HOST || 'ec2-user@your-ec2-host';
      const key = env.SECONDBRAIN_EC2_KEY || path.join(os.homedir(), '.ssh', 'sb-key.pem');
      const remoteArgs = argv.filter((arg) => arg !== '--all').concat('--runtime');
      const result = (deps.spawnSyncFn || spawnSync)('ssh', ['-i', key, '-o', 'BatchMode=yes', host, 'node', '/opt/secondbrain/scripts/configure-model-routing.js', ...remoteArgs], { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) throw new Error(`EC2 policy update failed; local policy was not changed: ${String(result.stderr || result.stdout).trim()}`);
    }
    for (const target of localTargets) { (deps.writeAtomicFn || writeAtomic)(target, policy); written.push(target); }
  }
  process.stdout.write(`${JSON.stringify({ written, effectiveImmediately: argv[0] !== 'show', policy }, null, 2)}\n`);
  return policy;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { applyCommand, main, usage, writeAtomic };
