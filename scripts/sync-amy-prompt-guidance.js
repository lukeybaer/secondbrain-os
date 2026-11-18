#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const SOURCE = 'memory/requirements/prompt-surface-guidance.md';
const ADAPTERS = ['claude-config/CLAUDE.global.md', 'codex-config/AGENTS.global.md'];
const MODULE = 'scripts/lib/amy-prompt-guidance.js';
const START = '<!-- AMY_SHARED_PROMPT_GUIDANCE:START -->';
const END = '<!-- AMY_SHARED_PROMPT_GUIDANCE:END -->';
function rulesFrom(text) {
  const rules = {};
  for (const match of text.matchAll(/<!-- rule: ([a-z][a-z0-9-]*) -->\n([\s\S]*?)\n<!-- \/rule -->/g)) {
    if (rules[match[1]]) throw new Error('Duplicate shared rule: ' + match[1]);
    rules[match[1]] = match[2].trim();
    if (!rules[match[1]]) throw new Error('Empty shared rule: ' + match[1]);
  }
  for (const id of ['fast-trigger', 'fast-context', 'tool-access', 'owner-profile']) {
    if (!rules[id]) throw new Error('Missing shared rule: ' + id);
  }
  const starts = [...text.matchAll(/<!-- rule:/g)].length;
  if (starts !== Object.keys(rules).length) throw new Error('Malformed shared rule block');
  return rules;
}
function projection(rules) {
  return START + '\nCanonical source: ' + SOURCE + '. Generated; edit the source and run node scripts/sync-amy-prompt-guidance.js --write.\n\n'
    + Object.entries(rules).map(([id, text]) => '<!-- shared-rule: ' + id + ' -->\n' + text).join('\n\n') + '\n' + END;
}
function replaceProjection(text, block) {
  const starts = text.split(START).length - 1, ends = text.split(END).length - 1;
  if (starts !== ends || starts > 1 || (starts && text.indexOf(END) < text.indexOf(START))) throw new Error('Malformed adapter projection');
  const base = starts
    ? (text.slice(0, text.indexOf(START)).trimEnd() + '\n\n' + text.slice(text.indexOf(END) + END.length).trimStart()).trimEnd()
    : text.trimEnd();
  if (!/^#[^\n]*\n/.test(base)) throw new Error('Adapter requires a leading title');
  // Deliver fast fallback before ordinary startup reads in each global adapter.
  return base.replace(/^(#[^\n]*\n)/, heading => heading + '\n' + block + '\n\n') + '\n';
}
function expectedFiles(root) {
  const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
  const rules = rulesFrom(read(SOURCE));
  const files = Object.fromEntries(ADAPTERS.map(file => [file, replaceProjection(read(file), projection(rules))]));
  files[MODULE] = "'use strict';\n// Generated from " + SOURCE + "; do not edit.\nmodule.exports = Object.freeze(" + JSON.stringify(rules, null, 2) + ');\n';
  return files;
}
function checkDrift(root) {
  const failures = [];
  try {
    for (const [file, expected] of Object.entries(expectedFiles(root))) {
      let actual = ''; try { actual = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n'); } catch {}
      if (actual !== expected) failures.push('Shared guidance projection drift: ' + file);
    }
  } catch (error) { failures.push(error.message); }
  return failures;
}
if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  if (process.argv.includes('--write')) for (const [file, content] of Object.entries(expectedFiles(root))) fs.writeFileSync(path.join(root, file), content);
  const failures = checkDrift(root);
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
  else console.log('OK: shared Amy prompt guidance projections match canonical rules.');
}
module.exports = { SOURCE, ADAPTERS, MODULE, rulesFrom, projection, replaceProjection, expectedFiles, checkDrift };
