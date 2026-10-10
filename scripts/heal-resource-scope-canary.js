#!/usr/bin/env node
'use strict';

// Prove the worker boundary from the actual system-service environment,
// before any card spends an attempt. No model, credentials or production data.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { resourceScopedSpawn, userScopeEnv, stopResourceScope } = require('./lib/heal-executor.js');

async function canary({spawnFn = spawn, run = spawnSync, readFile = fs.readFileSync,
  scope = resourceScopedSpawn, environment = userScopeEnv, stop = stopResourceScope} = {}) {
  const env = environment(process.env);
  const spec = scope(process.execPath, ['-e',
    'console.log(process.pid);setInterval(()=>{},1000)'], {budgetMs: 15000});
  if (!spec.resourceScoped) throw new Error('resource scope is required on the production canary host');
  const child = spawnFn(spec.command, spec.args, {env, detached: spec.detached, stdio: ['ignore','pipe','pipe']});
  child.secondbrainScopeUnit = spec.scopeUnit;
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  try {
    const pid = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker scope did not start: ${stderr}`)), 10000);
      child.once('error', error => {clearTimeout(timer); reject(error);});
      child.once('exit', code => {clearTimeout(timer); reject(new Error(`worker scope exited ${code}: ${stderr}`));});
      child.stdout.once('data', data => {clearTimeout(timer); resolve(Number(String(data).trim()));});
    });
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('worker did not return its PID');
    const shown = run('systemctl', ['--user','show',spec.scopeUnit,
      '-p','ControlGroup','-p','MemoryHigh','-p','MemoryMax','-p','TasksMax','-p','CPUQuotaPerSecUSec'],
    {env, encoding:'utf8', timeout:5000});
    if (shown.status !== 0) throw new Error('worker scope properties unavailable');
    const properties = Object.fromEntries(shown.stdout.trim().split('\n').map(line => {
      const at = line.indexOf('='); return [line.slice(0,at),line.slice(at+1)];
    }));
    if (properties.MemoryHigh !== '943718400' || properties.MemoryMax !== '1258291200' ||
        properties.TasksMax !== '96' || properties.CPUQuotaPerSecUSec !== '1s' ||
        !properties.ControlGroup?.endsWith(`/${spec.scopeUnit}`) ||
        !readFile(`/proc/${pid}/cgroup`,'utf8').includes(properties.ControlGroup)) {
      throw new Error(`worker resource boundary mismatch: ${JSON.stringify(properties)}`);
    }
    const cleanup = stop(child);
    if (cleanup.exitCode !== 0) throw new Error('worker scope cleanup failed');
    const active = run('systemctl', ['--user','is-active',spec.scopeUnit], {env,encoding:'utf8',timeout:5000});
    if (active.status === 0) throw new Error('worker scope remained active after cleanup');
    return {ok:true, modelCalls:0, scope:spec.scopeUnit, properties, cleanup: 'inactive'};
  } finally {
    stop(child);
    child.kill();
  }
}
if (require.main === module) canary().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
module.exports = {canary};
