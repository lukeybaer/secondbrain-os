/**
 * 2026-05-26 ExampleCo: migration safety. The new planner + executor land
 * behind a USE_PLANNER_PIPELINE env flag. The OLD path stays default
 * for at least one week. During the migration week, the legacy path
 * MUST consume the niche YAML via niche-to-legacy-spec.js so daily
 * generation does not drift from the craft contract.
 *
 * Per Codex review issue #4. Source-pinned tests on auto-regen-rejected-videos.js.
 *
 * Plan ref: ~/.claude/plans/distributed-questing-wilkinson.md (Category 10)
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..');
const AUTO_REGEN = path.join(REPO, 'scripts', 'auto-regen-rejected-videos.js');
const SRC = fs.readFileSync(AUTO_REGEN, 'utf8');

describe('auto-regen migration wiring', () => {
  it('reads the USE_PLANNER_PIPELINE env flag', () => {
    expect(SRC).toMatch(/USE_PLANNER_PIPELINE/);
  });

  it('USE_PLANNER_PIPELINE default is OFF (legacy path runs when unset)', () => {
    // When env is unset/0, the planner branch must NOT be entered.
    // We pin a literal default check that defaults to falsy.
    expect(SRC).toMatch(/USE_PLANNER_PIPELINE[\s\S]{0,80}===\s*['"]1['"]|process\.env\.USE_PLANNER_PIPELINE\s*===\s*['"]1['"]/);
  });

  it('imports the niche loader for the legacy adapter path', () => {
    expect(SRC).toMatch(/require.*niche-loader/);
  });

  it('imports the niche-to-legacy adapter (stampNicheOntoSpec)', () => {
    expect(SRC).toMatch(/stampNicheOntoSpec/);
    expect(SRC).toMatch(/require.*niche-to-legacy-spec/);
  });

  it('imports the planner CLI invocation for the new path', () => {
    expect(SRC).toMatch(/plan-video-build-cli\.js|plan-video-build-cli/);
  });

  it('imports build-from-plan.py for the new path', () => {
    expect(SRC).toMatch(/build-from-plan\.py/);
  });

  it('the legacy spawnSync of ec2-build-from-queue.py still wires (backwards compat)', () => {
    expect(SRC).toMatch(/spawnSync\(['"]python3['"][\s\S]{0,200}ec2-build-from-queue\.py/);
  });

  it('niche YAML missing should NOT crash the legacy adapter (warn-and-continue)', () => {
    // The adapter is best-effort during migration; missing YAML logs a
    // warning but the build keeps going. This is the only place silent
    // continuation is allowed (and it is loud-on-stderr, not silent).
    expect(SRC).toMatch(/niche.*missing|niche.*not.*found|NICHE_NOT_FOUND/i);
  });
});

describe('the planner+executor branch is structurally separable', () => {
  it('the planner branch writes plan.json before invoking build-from-plan.py', () => {
    // Plan path passed to build-from-plan.py --plan
    expect(SRC).toMatch(/--plan\b/);
  });

  it('the planner branch records plan_path on the manifest entry', () => {
    expect(SRC).toMatch(/plan_path/);
  });
});
