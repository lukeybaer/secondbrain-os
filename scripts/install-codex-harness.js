#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { defaultConfigFile, writeAtomicWithBackup } = require('./install-codex-default-model');
const { loadModelRoutingPolicy } = require('./lib/model-routing-config.js');

const CODEX_DEFAULT = loadModelRoutingPolicy().defaults.codex;

const PREFIX = 'SecondBrain native harness: ';

// Split complete TOML statements without confusing notify arrays or multiline
// instruction strings with table headers. Preserve unrelated source bytes.
function statements(text) {
  const result = [];
  let start = 0, depth = 0, quote = '', triple = false, comment = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (comment) { if (c !== '\n') continue; comment = false; }
    else if (quote) {
      if (quote === '"' && c === '\\') { i += 1; continue; }
      if (triple && text.slice(i, i + 3) === quote.repeat(3)) { i += 2; quote = ''; triple = false; }
      else if (!triple && c === quote) quote = '';
      continue;
    } else if (c === '#') comment = true;
    else if (c === '"' || c === "'") {
      quote = c; triple = text.slice(i, i + 3) === c.repeat(3);
      if (triple) i += 2;
    } else if ('[{'.includes(c)) depth += 1;
    else if (']}'.includes(c)) depth -= 1;
    if (c === '\n' && !quote && depth === 0) { result.push(text.slice(start, i + 1)); start = i + 1; }
  }
  if (quote || depth !== 0) throw new Error('Cannot safely edit incomplete TOML config');
  if (start < text.length) result.push(text.slice(start));
  return result;
}

function updateConfig(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let table = '', model = false, effort = false, hooks = false, featuresIndex = -1;
  const updated = statements(source).map((statement, index) => {
    const heading = /^\s*\[([^\]\r\n]+)\]\s*(?:#.*)?(?:\r?\n)?$/.exec(statement);
    if (heading) {
      table = heading[1].trim().replace(/^(?:"features"|'features')$/, 'features');
      if (table === 'features') featuresIndex = index;
      return statement;
    }
    // Array-of-table and quoted unfamiliar sections must end root scope too.
    if (/^\s*\[/.test(statement)) { table = '<other>'; return statement; }
    const keyMatch = /^([ \t]*)([A-Za-z_][\w.]*)[ \t]*=/.exec(statement);
    if (!keyMatch) {
      if (/^\s*["'](?:model|model_reasoning_effort|features|hooks)["']\s*=/.test(statement)) {
        throw new Error('Quoted managed config keys require a manual config merge; no files changed');
      }
      return statement;
    }
    const key = keyMatch[2];
    let value;
    if (table === '' && key === 'model') { model = true; value = `"${CODEX_DEFAULT.model}"`; }
    if (table === '' && key === 'model_reasoning_effort') { effort = true; value = `"${CODEX_DEFAULT.effort}"`; }
    if ((table === 'features' && key === 'hooks') || (table === '' && key === 'features.hooks')) { hooks = true; value = 'true'; }
    if (table === '' && key === 'features') throw new Error('Inline features table requires a manual config merge; no files changed');
    if (value === undefined) return statement;
    return `${keyMatch[1]}${key} = ${value}${newline}`;
  });
  if (!hooks && featuresIndex >= 0) {
    updated[featuresIndex] = updated[featuresIndex].replace(/(?:\r?\n)?$/, `${newline}hooks = true${newline}`);
    hooks = true;
  }
  let text = updated.join('');
  if (!model) text = `model = "${CODEX_DEFAULT.model}"${newline}` + text;
  if (!effort) text = `model_reasoning_effort = "${CODEX_DEFAULT.effort}"${newline}` + text;
  if (!hooks) {
    text += `${text.endsWith('\n') || !text ? '' : newline}${newline}[features]${newline}hooks = true${newline}`;
  }
  return text;
}

function definition(scriptFile, nodeFile = process.execPath) {
  // JSON uses commandWindows (TOML also accepts command_windows). Paths are
  // absolute; do not depend on the active project's PATH or working directory.
  for (const value of [scriptFile, nodeFile]) {
    if (/["\r\n%$`]/.test(value)) throw new Error('Hook command path contains unsupported shell characters');
  }
  const posixQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
  const command = `${posixQuote(nodeFile)} ${posixQuote(scriptFile)}`;
  // Codex runs Windows hook commands through PowerShell, where a quoted path is
  // a string expression, not an invocation: the old `"node.exe" "hook.js"`
  // form failed silently for every Codex hook until 2026-09-27 (live probe:
  // no hook run was ever recorded). The call operator makes it execute.
  const commandWindows = `& "${nodeFile}" "${scriptFile}"`;
  const make = (event) => ({
    type: 'command',
    command,
    commandWindows,
    timeout: 10,
    // Stop hooks can block or repair the final response, but Codex does not
    // accept additional context from that event. Registering this field on a
    // Stop hook emits a configuration error at the start of every fresh run.
    ...(event === 'Stop' ? {} : { additionalContextLimit: 12000 }),
    statusMessage: PREFIX + event,
  });
  return {
    SessionStart: [{ matcher: '^(startup|resume|clear|compact)$', hooks: [make('SessionStart')] }],
    PreToolUse: [{ matcher: '^(Bash|exec_command|apply_patch|ApplyPatch|write_stdin|exec|js)$', hooks: [make('PreToolUse')] }],
    Stop: [{ hooks: [make('Stop')] }],
  };
}

function mergeHooks(source, expected) {
  const result = structuredClone(source);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('hooks.json must be an object');
  if (result.hooks !== undefined && (!result.hooks || typeof result.hooks !== 'object' || Array.isArray(result.hooks))) throw new Error('Invalid hooks map');
  result.hooks ||= {};
  for (const [event, groups] of Object.entries(expected)) {
    const current = result.hooks[event] || [];
    if (!Array.isArray(current)) throw new Error(`Invalid ${event} hook groups`);
    result.hooks[event] = current.map((group) => {
      if (!Array.isArray(group.hooks)) throw new Error(`Invalid ${event} hook handlers`);
      return { ...group, hooks: group.hooks.filter((hook) => !(hook.statusMessage === PREFIX + event
        && /codex-harness-hook\.js/.test(hook.command || ''))) };
    }).filter((group) => group.hooks.length).concat(groups);
  }
  return result;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const value = (key) => { const i = argv.indexOf(key); if (i < 0) return ''; if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing ${key} value`); return argv[i + 1]; };
  if (!argv.includes('--apply') && !argv.includes('--check')) throw new Error('usage: install-codex-harness.js --apply|--check [--file config.toml] [--script-file PATH]');
  const configFile = path.resolve(value('--file') || defaultConfigFile(env));
  const scriptFile = path.resolve(value('--script-file') || path.join(__dirname, 'codex-harness-hook.js'));
  if (!fs.existsSync(scriptFile)) throw new Error('Native hook script is missing');
  const hooksFile = path.join(path.dirname(configFile), 'hooks.json');
  const configSource = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  const hooksSource = fs.existsSync(hooksFile) ? fs.readFileSync(hooksFile, 'utf8') : '{}';
  const expected = definition(scriptFile);
  const nextConfig = updateConfig(configSource);
  const parsedHooks = JSON.parse(hooksSource);
  const nextHooks = mergeHooks(parsedHooks, expected);
  const definitionsMatch = JSON.stringify(parsedHooks) === JSON.stringify(nextHooks);
  const configMatches = configSource === nextConfig;
  // Calculate and validate both replacements before any write. Never edit
  // notify, authentication, plugin config, trust records or managed policy.
  if (argv.includes('--apply')) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    if (!configMatches) writeAtomicWithBackup(configFile, nextConfig, fs.existsSync(configFile));
    if (!definitionsMatch) writeAtomicWithBackup(hooksFile, JSON.stringify(nextHooks, null, 2) + '\n', fs.existsSync(hooksFile));
  }
  const actualConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  const actualHooks = fs.existsSync(hooksFile) ? JSON.parse(fs.readFileSync(hooksFile, 'utf8')) : {};
  const installed = actualConfig === nextConfig && JSON.stringify(actualHooks) === JSON.stringify(nextHooks);
  if (argv.includes('--apply') && !installed) throw new Error('Native harness installation did not verify');
  const result = {
    installed, configFile, hooksFile, scriptFile,
    defaultModel: installed ? CODEX_DEFAULT.model : null, defaultEffort: installed ? CODEX_DEFAULT.effort : null,
    desiredDefaults: { ...CODEX_DEFAULT },
    definitionSha256: crypto.createHash('sha256').update(JSON.stringify(expected)).digest('hex'),
    hookTrust: 'not-verified', effectiveNativeEnforcement: 'not-proven',
    nextAction: 'Review these exact hook definitions in the native Codex /hooks UI. Installation cannot grant trust. Restart or reload the task, then verify a real SessionStart and Stop hook run. Existing task model/effort overrides remain unchanged.',
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!installed) process.exitCode = 1;
  return result;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { definition, main, mergeHooks, statements, updateConfig };
