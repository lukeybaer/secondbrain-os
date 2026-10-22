#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function reconcileAllowlist({ trackedFile, runtimeFile, write = false } = {}) {
  const tracked = readJson(trackedFile);
  if (!tracked || !tracked.exemptions || typeof tracked.exemptions !== 'object') {
    throw new Error('tracked API audit allowlist is missing or invalid');
  }
  const runtime = readJson(runtimeFile, { exemptions: {} });
  const merged = {
    ...runtime,
    _doc: tracked._doc,
    exemptions: { ...(runtime.exemptions || {}), ...tracked.exemptions },
  };
  if (write) writeAtomic(runtimeFile, merged);
  const readback = write ? readJson(runtimeFile) : merged;
  const missing = Object.keys(tracked.exemptions).filter(
    (key) => readback?.exemptions?.[key] !== tracked.exemptions[key],
  );
  const bytes = `${JSON.stringify(readback, null, 2)}\n`;
  return {
    schema: 'secondbrain.api-audit-allowlist-parity.v1',
    ok: missing.length === 0,
    trackedExemptions: Object.keys(tracked.exemptions).length,
    runtimeExemptions: Object.keys(readback?.exemptions || {}).length,
    missing,
    runtimeSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

function main(argv = process.argv.slice(2)) {
  const root = path.resolve(process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..'));
  const dataDir = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(root, 'data'));
  const result = reconcileAllowlist({
    trackedFile: path.join(root, 'config', 'api-audit-allowlist.json'),
    runtimeFile: path.join(dataDir, 'agent', 'api-audit-allowlist.json'),
    write: argv.includes('--write'),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[api-audit-allowlist-parity] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main, reconcileAllowlist };
