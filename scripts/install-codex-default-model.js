#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadModelRoutingPolicy } = require('./lib/model-routing-config.js');

const CODEX_DEFAULT = loadModelRoutingPolicy().defaults.codex;
const MODEL = CODEX_DEFAULT.model;
const EFFORT = CODEX_DEFAULT.effort;

function topLevelBoundary(text) {
  const source = String(text || '');
  const match = /^(?![ \t]*#)[ \t]*\[/m.exec(source);
  return match ? match.index : source.length;
}

function upsertTopLevel(text, key, value) {
  const line = `${key} = "${value}"`;
  const source = String(text || '');
  const boundary = topLevelBoundary(source);
  let head = source.slice(0, boundary);
  const tables = source.slice(boundary);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedKey}[ \\t]*=.*$`, 'm');
  if (pattern.test(head)) head = head.replace(pattern, line);
  else head = `${line}\n${head}`;
  return head + tables;
}

function updateCodexConfigText(source = '') {
  let next = String(source || '');
  next = upsertTopLevel(next, 'model', MODEL);
  next = upsertTopLevel(next, 'model_reasoning_effort', EFFORT);
  return next;
}

function configIsCurrent(source = '') {
  const head = String(source || '').slice(0, topLevelBoundary(source));
  return (
    new RegExp(`^model[ \\t]*=[ \\t]*"${MODEL.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}"[ \\t]*$`, 'm').test(head) &&
    new RegExp(`^model_reasoning_effort[ \\t]*=[ \\t]*"${EFFORT}"[ \\t]*$`, 'm').test(head)
  );
}

function argValue(name, argv) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : '';
}

function defaultConfigFile(env = process.env) {
  const codexHome = String(env.CODEX_HOME || '').trim() || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'config.toml');
}

function writeAtomicWithBackup(file, next, sourceExists) {
  const directory = path.dirname(file);
  const tmp = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    if (sourceExists) fs.copyFileSync(file, `${file}.bak`);
    fs.writeFileSync(tmp, next, {
      encoding: 'utf8',
      mode: sourceExists ? fs.statSync(file).mode : 0o600,
    });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function main(argv = process.argv.slice(2), env = process.env) {
  const file = path.resolve(argValue('--file', argv) || defaultConfigFile(env));
  const sourceExists = fs.existsSync(file);
  const source = sourceExists ? fs.readFileSync(file, 'utf8') : '';
  if (argv.includes('--check')) {
    if (!configIsCurrent(source)) throw new Error(`Codex default is not ${MODEL}/${EFFORT}: ${file}`);
    process.stdout.write(`Codex default is ${MODEL}/${EFFORT}: ${file}\n`);
    return file;
  }
  if (!argv.includes('--apply')) {
    throw new Error('usage: install-codex-default-model.js --apply|--check [--file FILE]');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = updateCodexConfigText(source);
  if (next !== source) writeAtomicWithBackup(file, next, sourceExists);
  if (!configIsCurrent(fs.readFileSync(file, 'utf8'))) throw new Error('Codex default write did not verify');
  process.stdout.write(`Codex default set to ${MODEL}/${EFFORT}: ${file}\n`);
  return file;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  EFFORT,
  MODEL,
  configIsCurrent,
  defaultConfigFile,
  main,
  topLevelBoundary,
  updateCodexConfigText,
  writeAtomicWithBackup,
};
