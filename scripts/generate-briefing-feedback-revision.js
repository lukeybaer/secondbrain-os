#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { renderOwnerFeedbackDeltaReport } = require('./lib/briefing-owner-feedback-delta-report.js');

function value(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : '';
}

function main(argv = process.argv.slice(2)) {
  const packetFile = value('--packet', argv);
  const outputFile = value('--out', argv);
  const originalFile = value('--original', argv);
  const protectedFiles = argv.flatMap((arg, index) => arg === '--protect' ? [argv[index + 1]] : []).filter(Boolean);
  if (!packetFile || !outputFile || !originalFile) {
    throw new Error('usage: generate-briefing-feedback-revision.js --packet FILE --original FILE --out FILE');
  }
  const original = path.resolve(originalFile);
  if (!fs.existsSync(original)) throw new Error(`frozen original report is missing: ${original}`);
  const packet = JSON.parse(fs.readFileSync(path.resolve(packetFile), 'utf8'));
  const html = renderOwnerFeedbackDeltaReport(packet);
  const out = path.resolve(outputFile);
  if (out === original) throw new Error('refusing to overwrite the frozen original report');
  const protectedResolved = protectedFiles.map((file) => path.resolve(file));
  if (protectedResolved.includes(out)) {
    throw new Error('refusing to overwrite a protected sibling report');
  }
  const base = path.basename(out).toLowerCase();
  if (!/-(?:revised|v[2-9][0-9]*)\.html$/.test(base)) {
    throw new Error('refusing to overwrite report history: --out must end in -revised.html or -vN.html');
  }
  const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const originalSha256Before = digest(original);
  const protectedSha256Before = Object.fromEntries(protectedResolved.map((resolved) => {
    return [resolved, digest(resolved)];
  }));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, html, 'utf8');
  fs.renameSync(tmp, out);
  const originalSha256After = digest(original);
  if (originalSha256After !== originalSha256Before) {
    throw new Error('frozen original report changed while the revised sibling was generated');
  }
  const protectedSha256After = Object.fromEntries(Object.keys(protectedSha256Before).map((file) => [file, digest(file)]));
  if (Object.keys(protectedSha256Before).some((file) => protectedSha256Before[file] !== protectedSha256After[file])) {
    throw new Error('a protected sibling report changed while the new revision was generated');
  }
  process.stdout.write(`${JSON.stringify({ out, original, originalSha256Before, originalSha256After, protectedSha256Before, protectedSha256After })}\n`);
  return out;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exit(1); }
}

module.exports = { main };
