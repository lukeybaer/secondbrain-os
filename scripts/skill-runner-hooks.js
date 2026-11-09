#!/usr/bin/env node
// skill-runner-hooks.js
//
// Phase 5 of harness-evolution-loop. Hooks that wrap the universal scheduled-
// task dispatcher (run-scheduled-skill.js) so every scheduled SKILL.md run
// gets LESSONS.md context pre-run and a fresh lesson appended post-run.
// Extracted as a separate module so the integration logic is testable.

const lessons = require('./skill-lessons');

const LESSONS_HEADER = '\n\n---\n# Prior lessons from this skill (auto-injected)\n';
const LESSONS_FOOTER = '\n# End prior lessons\n---\n\n';

function buildPromptWithLessons(skillName, basePrompt, contextDepth) {
  const ctx = lessons.lessonsAsContext(skillName, contextDepth || 10);
  if (!ctx) return basePrompt;
  return `${basePrompt}${LESSONS_HEADER}${ctx}${LESSONS_FOOTER}`;
}

function deriveOutcome({ exitCode, output, maxOutputChars }) {
  const tail = (output || '')
    .split('\n')
    .filter(line => line.trim())
    .slice(-3)
    .join(' | ')
    .slice(0, maxOutputChars || 240);
  if (exitCode === 0) {
    return tail ? `OK: ${tail}` : 'OK';
  }
  return tail ? `FAILED (exit ${exitCode}): ${tail}` : `FAILED (exit ${exitCode})`;
}

function recordSkillOutcome(skillName, { input, exitCode, output, maxOutputChars }) {
  const outcome = deriveOutcome({ exitCode, output, maxOutputChars });
  lessons.appendLesson(skillName, { input: input || '(scheduled run)', outcome });
  return outcome;
}

module.exports = {
  buildPromptWithLessons,
  deriveOutcome,
  recordSkillOutcome,
  LESSONS_HEADER,
  LESSONS_FOOTER,
};
