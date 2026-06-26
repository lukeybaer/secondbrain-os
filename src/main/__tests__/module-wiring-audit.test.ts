import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  auditModuleWiring,
  scanSrcDir,
  buildWiringDigest,
  renderWiringHeadline,
  checkWiringRatchet,
  type ModuleNode,
} from '../module-wiring-audit';

function node(name: string, importers: string[], hasTest: boolean, lineCount = 100): ModuleNode {
  return { name, runtimeImporters: importers, hasTest, lineCount };
}

describe('auditModuleWiring (pure core)', () => {
  it('classifies a module with runtime importers as wired', () => {
    const audit = auditModuleWiring([node('task-store', ['task-worker', 'index'], true)]);
    expect(audit.wiredModules).toBe(1);
    expect(audit.orphanModules).toBe(0);
    expect(audit.all[0].status).toBe('wired');
  });

  it('flags a tested-but-unwired module as orphan-tested', () => {
    const audit = auditModuleWiring([node('agent-reflection', [], true, 363)]);
    expect(audit.orphanModules).toBe(1);
    expect(audit.orphans[0].status).toBe('orphan-tested');
    expect(audit.orphans[0].rationale).toMatch(/does not run/);
    expect(audit.deadWeightLines).toBe(363);
  });

  it('flags an untested unwired module as orphan-untested', () => {
    const audit = auditModuleWiring([node('lonely', [], false, 40)]);
    expect(audit.orphans[0].status).toBe('orphan-untested');
    expect(audit.orphans[0].rationale).toMatch(/dead weight/);
  });

  it('treats entrypoints as expected-no-importers, not orphans', () => {
    const audit = auditModuleWiring([
      node('index', [], false, 500),
      node('server', [], false, 800),
    ]);
    expect(audit.orphanModules).toBe(0);
    expect(audit.entrypointModules).toBe(2);
    expect(audit.deadWeightLines).toBe(0);
  });

  it('honors a custom entryPoints list', () => {
    const audit = auditModuleWiring([node('my-root', [], false, 10)], {
      entryPoints: ['my-root'],
    });
    expect(audit.all[0].status).toBe('entrypoint');
    expect(audit.orphanModules).toBe(0);
  });

  it('sorts orphans by line count descending (biggest dead weight first)', () => {
    const audit = auditModuleWiring([
      node('small', [], true, 20),
      node('huge', [], true, 400),
      node('medium', [], false, 120),
    ]);
    expect(audit.orphans.map((o) => o.name)).toEqual(['huge', 'medium', 'small']);
    expect(audit.deadWeightLines).toBe(540);
  });

  it('does not count a module importing itself as wiring', () => {
    // runtimeImporters never includes self by construction, but verify the
    // count drives status correctly with zero importers.
    const audit = auditModuleWiring([node('solo', [], true, 50)]);
    expect(audit.orphans[0].importerCount).toBe(0);
  });
});

describe('renderWiringHeadline', () => {
  it('reports clean when no orphans', () => {
    const audit = auditModuleWiring([node('a', ['b'], true)]);
    expect(renderWiringHeadline(audit)).toMatch(/clean/);
  });

  it('names the top orphans and the tested-but-unwired count', () => {
    const audit = auditModuleWiring([
      node('orphan-a', [], true, 300),
      node('orphan-b', [], false, 100),
    ]);
    const line = renderWiringHeadline(audit);
    expect(line).toMatch(/orphan-a/);
    expect(line).toMatch(/1 of them tested-but-unwired/);
  });
});

describe('checkWiringRatchet (pure ratchet gate)', () => {
  const baseline = { orphanModules: 10, deadWeightLines: 1000 };

  it('passes when live counts are at the baseline', () => {
    const audit = auditModuleWiring(
      Array.from({ length: 10 }, (_, i) => node(`o${i}`, [], true, 100)),
    );
    const r = checkWiringRatchet(audit, baseline);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/at baseline/);
  });

  it('fails and explains when orphan count regresses above baseline', () => {
    const audit = auditModuleWiring(
      Array.from({ length: 11 }, (_, i) => node(`o${i}`, [], true, 50)),
    );
    const r = checkWiringRatchet(audit, baseline);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/REGRESSION/);
    expect(r.message).toMatch(/rose to 11/);
    // Names the offending modules so the failure is actionable, not just a number.
    expect(r.message).toMatch(/o0|o1/);
  });

  it('fails when only dead-weight lines regress, even if module count holds', () => {
    const audit = auditModuleWiring([node('big', [], true, 5000)]);
    const r = checkWiringRatchet(audit, baseline);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/dead-weight lines rose to 5000/);
  });

  it('passes on a reduction and invites lowering the baseline to lock it in', () => {
    const audit = auditModuleWiring([node('lonely', [], true, 200)]);
    const r = checkWiringRatchet(audit, baseline);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/IMPROVED/);
    expect(r.message).toMatch(/Lower WIRING_BASELINE/);
    // Suggests the exact new numbers to commit.
    expect(r.message).toMatch(/orphanModules: 1/);
    expect(r.message).toMatch(/deadWeightLines: 200/);
  });
});

describe('scanSrcDir + buildWiringDigest (filesystem)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-audit-'));
    fs.mkdirSync(path.join(dir, '__tests__'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it('detects an orphan module that nothing imports', () => {
    write('used.ts', 'export const x = 1;\n');
    write('consumer.ts', "import { x } from './used';\nexport const y = x;\n");
    write('orphan.ts', 'export const z = 3;\n');

    const digest = buildWiringDigest(dir);
    const byName = Object.fromEntries(digest.all.map((m) => [m.name, m.status]));
    expect(byName['used']).toBe('wired');
    expect(byName['orphan']).toMatch(/orphan/);
    expect(digest.orphans.some((o) => o.name === 'orphan')).toBe(true);
    expect(digest.orphans.some((o) => o.name === 'used')).toBe(false);
  });

  it('treats __tests__ imports as non-runtime and marks hasTest', () => {
    write('feature.ts', 'export const f = () => 42;\n');
    // ONLY a test imports feature => still an orphan, but tested.
    write('__tests__/feature.test.ts', "import { f } from '../feature';\nf();\n");

    const digest = buildWiringDigest(dir);
    const feature = digest.all.find((m) => m.name === 'feature')!;
    expect(feature.status).toBe('orphan-tested');
    expect(feature.hasTest).toBe(true);
    expect(feature.importerCount).toBe(0);
  });

  it('matches suffixed test files (name-foo.test.ts) to the base module', () => {
    write('core-thing.ts', 'export const c = 1;\n');
    write('user.ts', "import { c } from './core-thing';\nexport const u = c;\n");
    write('__tests__/core-thing-access.test.ts', "import { c } from '../core-thing';\nc;\n");

    const node2 = scanSrcDir(dir).find((m) => m.name === 'core-thing')!;
    expect(node2.hasTest).toBe(true);
    expect(node2.runtimeImporters).toContain('user');
  });

  it('counts require() imports as wiring too', () => {
    write('lib.ts', 'export const l = 1;\n');
    write('cjs-consumer.ts', "const { l } = require('./lib');\nmodule.exports = l;\n");

    const digest = buildWiringDigest(dir);
    expect(digest.all.find((m) => m.name === 'lib')!.status).toBe('wired');
  });
});
