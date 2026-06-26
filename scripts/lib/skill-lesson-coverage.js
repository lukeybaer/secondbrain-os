'use strict';

// Skill lesson-logging coverage (one of the two checks locked 2026-06-15 in
// dev-plans/managing-complex-scope-2026-06-14.html). ExampleCo's ask: a health check
// that every skill use logs a lesson where appropriate.
//
// The mechanical, certain signal: a scheduled-tasks/<name>/ directory that has a
// SKILL.md (so it IS a skill) but no LESSONS.md, or a LESSONS.md with zero appended
// entries (so it is not actually accumulating learning). skill-runner-hooks.js
// auto-creates and appends LESSONS.md on a scheduled run, so a missing or empty
// LESSONS.md means the skill has never logged. This audit surfaces those so the
// briefing System Health row (the wiring step) can alarm on regressions.
//
// Pure auditSkillLessons() takes injected skill descriptors so it is unit-testable
// without the filesystem; readSkillCoverage() is the real-dir reader.

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCHEDULED_TASKS_DIR = path.join(REPO_ROOT, 'scheduled-tasks');

// Count appended lesson entries ("## <ISO-date>" headers) and the last one's date.
function parseLessonsBody(body) {
  const headers = body.match(/^## .+$/gm) || [];
  const dates = (body.match(/^## (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/gm) || []).map((h) =>
    h.replace(/^## /, ''),
  );
  return {
    entryCount: headers.length,
    lastEntryIso: dates.length ? dates[dates.length - 1] : null,
  };
}

// Read every scheduled-tasks/<name>/ that has a SKILL.md, returning its lesson state.
function readSkillCoverage(dir = SCHEDULED_TASKS_DIR) {
  const out = [];
  let names = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const base = path.join(dir, name);
    const hasSkillMd = fs.existsSync(path.join(base, 'SKILL.md'));
    if (!hasSkillMd) continue;
    const lessonsPath = path.join(base, 'LESSONS.md');
    const hasLessons = fs.existsSync(lessonsPath);
    let entryCount = 0;
    let lastEntryIso = null;
    if (hasLessons) {
      ({ entryCount, lastEntryIso } = parseLessonsBody(fs.readFileSync(lessonsPath, 'utf8')));
    }
    out.push({ name, hasSkillMd: true, hasLessons, entryCount, lastEntryIso });
  }
  return out;
}

// Pure audit: classify which skills are not logging lessons.
function auditSkillLessons(skills) {
  const total = skills.length;
  const missingLessons = skills.filter((s) => !s.hasLessons).map((s) => s.name);
  const emptyLessons = skills.filter((s) => s.hasLessons && s.entryCount === 0).map((s) => s.name);
  const logging = skills.filter((s) => s.hasLessons && s.entryCount > 0).map((s) => s.name);
  return {
    total,
    loggingCount: logging.length,
    missingLessons,
    emptyLessons,
    // a skill is "not logging" if it has no LESSONS file or an empty one
    notLogging: [...missingLessons, ...emptyLessons].sort(),
  };
}

function auditLive() {
  return auditSkillLessons(readSkillCoverage());
}

module.exports = { parseLessonsBody, readSkillCoverage, auditSkillLessons, auditLive };
