// scheduled-skills-paths.test.ts
//
// Regression guard: every SKILL.md file under scheduled-tasks/ must reference
// canonical source paths for source/config artifacts. Runtime logs may live in
// AppData or ignored repo-local runtime paths and should be cloud-archived with
// receipts when they become durable records.
//
// Additionally: active do-the-work skills must actually SHIP their code rather
// than writing a report. The shipping contract is now "LAND via the gate"
// (node scripts/land.js --apply) instead of a raw git commit, because mutating
// work happens in an isolated worktree and lands through the gate, never a
// direct shared-checkout commit. Retired saturated tasks must stay explicit
// no-ops and remain absent from the schedulers that used to launch them.
// The active assertion accepts either "land" or "commit" as the ship verb.
// Phase 11 of plans/dazzling-rolling-moler.md.
//
// Commit 13 of 18 in the plan.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCHEDULED_DIR = path.join(REPO_ROOT, 'scheduled-tasks');
const ACTIVE_DO_WORK_TASKS = ['secondbrain-nightly-enhancement'];
const RETIRED_NOOP_TASKS = ['video-quality-research', 'video-quality-tools'];

function listSkillFiles(): string[] {
  return fs
    .readdirSync(SCHEDULED_DIR)
    .map((task) => path.join(SCHEDULED_DIR, task, 'SKILL.md'))
    .filter((p) => fs.existsSync(p));
}

function skillContent(taskName: string): string {
  const p = path.join(SCHEDULED_DIR, taskName, 'SKILL.md');
  expect(fs.existsSync(p)).toBe(true);
  return fs.readFileSync(p, 'utf-8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('scheduled-tasks SKILL.md hygiene', () => {
  const skills = listSkillFiles();

  it('at least 12 SKILL.md files are tracked', () => {
    expect(skills.length).toBeGreaterThanOrEqual(12);
  });

  for (const skillPath of listSkillFiles()) {
    const name = path.basename(path.dirname(skillPath));

    it(`${name}: SKILL.md does not reference %APPDATA% paths for REPO data`, () => {
      // Only flag AppData references to files that should live in the repo.
      // Legitimate AppData-only files (backup.log, config.json, session caches)
      // are allowed because they are runtime state, not tracked content.
      const content = fs.readFileSync(skillPath, 'utf-8');
      const FORBIDDEN_APPDATA_PATTERNS = [
        /%APPDATA%[^\n]*video-quality-rubric\.json/i,
        /%APPDATA%[^\n]*video-quality-tools/i,
      ];
      const bad = FORBIDDEN_APPDATA_PATTERNS.filter((re) => re.test(content));
      // Allow if the body explicitly calls out the hardlink/junction.
      const annotated = /hardlink|junction/i.test(content);
      if (bad.length > 0 && !annotated) {
        throw new Error(
          `${name}: references repo data files via %APPDATA% paths without hardlink/junction note. Use C:\\Users\\USER\\secondbrain\\... instead or explicitly note the hardlink.`,
        );
      }
    });
  }

  for (const taskName of ACTIVE_DO_WORK_TASKS) {
    it(`${taskName}: is a "do the work" skill, not a report`, () => {
      const content = skillContent(taskName);
      // Ships code for real: either the landing-gate command (scripts/land.js)
      // or an explicit git commit. A bare word like "land"/"commitment" must NOT
      // satisfy this, so the matcher pins the actual ship action, not prose.
      expect(content.toLowerCase()).toMatch(/scripts\/land\.js|git commit/);
      expect(content.toLowerCase()).toMatch(/implement|build|ship|enhance/);
    });
  }

  for (const taskName of ACTIVE_DO_WORK_TASKS) {
    it(`${taskName}: names the nightly-enhancements runtime log`, () => {
      const content = skillContent(taskName);
      expect(content).toMatch(/nightly-enhancements\.jsonl/);
    });
  }

  for (const taskName of RETIRED_NOOP_TASKS) {
    it(`${taskName}: retired task stays an explicit no-op and is not scheduled`, () => {
      const content = skillContent(taskName).toLowerCase();
      expect(content).toMatch(/retired 2026-07-11/);
      expect(content).toMatch(/do not run this task/);
      expect(content).toMatch(/no-op/);
      expect(content).toMatch(/removed from `scripts\/lib\/cloud-scheduled-fleet\.js`/);
      expect(content).toMatch(/scripts\/register-scheduled-tasks\.ps1/);

      const cloudFleet = fs.readFileSync(
        path.join(REPO_ROOT, 'scripts', 'lib', 'cloud-scheduled-fleet.js'),
        'utf-8',
      );
      const windowsTasks = fs.readFileSync(
        path.join(REPO_ROOT, 'scripts', 'register-scheduled-tasks.ps1'),
        'utf-8',
      );
      const skillLiteral = escapeRegExp(taskName);
      expect(cloudFleet).not.toMatch(new RegExp(`\\bskill:\\s*['"]${skillLiteral}['"]`));
      expect(windowsTasks).not.toMatch(new RegExp(`Skill-Task[^\\r\\n]*['"]${skillLiteral}['"]`));
    });
  }
});
