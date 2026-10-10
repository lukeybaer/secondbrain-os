'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  DESKTOP_RUNTIME_FILES,
  installDesktopRuntime,
} = require('../scripts/provision-desktop-capability-relay.js');

test('desktop provisioner installs a durable minimal runtime bundle', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'amy-desktop-source-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'amy-desktop-target-'));
  try {
    for (const relative of DESKTOP_RUNTIME_FILES) {
      const file = path.join(source, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${relative}\n`);
    }
    const installed = installDesktopRuntime(source, target);
    assert.deepStrictEqual(installed, { root: path.resolve(target), files: DESKTOP_RUNTIME_FILES.length, reused: false });
    for (const relative of DESKTOP_RUNTIME_FILES) {
      assert.strictEqual(fs.readFileSync(path.join(target, relative), 'utf8'), `${relative}\n`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(target, 'runtime-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.schema, 'amy.desktop-capability-runtime.v1');
    assert.deepStrictEqual(manifest.files, DESKTOP_RUNTIME_FILES);
    assert.strictEqual(installDesktopRuntime(source, target).files, DESKTOP_RUNTIME_FILES.length);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('desktop provisioner can reuse an explicitly selected source runtime', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'amy-desktop-reuse-'));
  try {
    assert.deepStrictEqual(installDesktopRuntime(source, source), {
      root: path.resolve(source),
      files: DESKTOP_RUNTIME_FILES.length,
      reused: true,
    });
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
});
