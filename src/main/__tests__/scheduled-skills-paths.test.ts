// scheduled-skills-paths.test.ts
//
// Regression guard: every SKILL.md file under scheduled-tasks/ must reference
// tracked repo paths (secondbrain/... or C:\Users\luked\secondbrain\...)
// rather than AppData paths. The hardlink migration in commit 5 made
// AppData paths work via hardlinks but new skill authors should not
// adopt the legacy paths — write to the tracked path directly.
//
// Additionally: each do-the-work skill (the three registered nightly
// cron tasks) must contain the word COMMIT so it actually ships code
// rather than writing a report. Phase 11 of plans/dazzling-rolling-moler.md.
//
// Commit 13 of 18 in the plan.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCHEDULED_DIR = path.join(REPO_ROOT, 'scheduled-tasks');

function listSkillFiles(): string[] {
  return fs
    .readdirSync(SCHEDULED_DIR)
    .map((task) => path.join(SCHEDULED_DIR, task, 'SKILL.md'))
    .filter((p) => fs.existsSync(p));
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
        /%APPDATA%[^\n]*nightly-enhancements\.jsonl/i,
        /%APPDATA%[^\n]*video-quality-rubric\.json/i,
        /%APPDATA%[^\n]*video-quality-tools/i,
      ];
      const bad = FORBIDDEN_APPDATA_PATTERNS.filter((re) => re.test(content));
      // Allow if the body explicitly calls out the hardlink/junction.
      const annotated = /hardlink|junction/i.test(content);
      if (bad.length > 0 && !annotated) {
        throw new Error(
          `${name}: references repo data files via %APPDATA% paths without hardlink/junction note. Use C:\\Users\\luked\\secondbrain\\... instead or explicitly note the hardlink.`,
        );
      }
    });
  }

  for (const taskName of [
    'secondbrain-nightly-enhancement',
    'video-quality-research',
    'video-quality-tools',
  ]) {
    it(`${taskName}: is a "do the work" skill, not a report`, () => {
      const p = path.join(SCHEDULED_DIR, taskName, 'SKILL.md');
      expect(fs.existsSync(p)).toBe(true);
      const content = fs.readFileSync(p, 'utf-8');
      expect(content.toLowerCase()).toMatch(/commit/);
      expect(content.toLowerCase()).toMatch(/implement|build|ship|enhance/);
    });
  }

  for (const taskName of [
    'secondbrain-nightly-enhancement',
    'video-quality-research',
    'video-quality-tools',
  ]) {
    it(`${taskName}: writes log to the tracked repo path, not AppData`, () => {
      const p = path.join(SCHEDULED_DIR, taskName, 'SKILL.md');
      const content = fs.readFileSync(p, 'utf-8');
      expect(content).toMatch(
        /secondbrain\\data\\agent\\nightly-enhancements\.jsonl|secondbrain\/data\/agent\/nightly-enhancements\.jsonl/,
      );
    });
  }
});
