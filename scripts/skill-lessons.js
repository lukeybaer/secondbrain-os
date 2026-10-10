#!/usr/bin/env node
// skill-lessons.js
//
// LESSONS.md self-refining loop for scheduled-task skills.
// Pattern from https://x.com/exm7777/status/2052131046645510583 (Machina, 2026-05-06).
//
// Each scheduled-task skill keeps a LESSONS.md alongside its SKILL.md.
// Pre-run, the skill reads the last N entries to bias behavior.
// Post-run, the skill appends a 2-line entry: input pattern + outcome.
//
// Storage: secondbrain/scheduled-tasks/<skillName>/LESSONS.md
// Format: each entry is 4 lines (header date, input, outcome, blank separator).

const fs = require('fs');
const path = require('path');

const REPO = process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');
const SKILLS_DIR = path.join(REPO, 'scheduled-tasks');

function lessonsPath(skillName) {
  return path.join(SKILLS_DIR, skillName, 'LESSONS.md');
}

function ensureLessonsFile(skillName) {
  const dir = path.join(SKILLS_DIR, skillName);
  if (!fs.existsSync(dir)) {
    throw new Error(`Skill directory does not exist: ${dir}`);
  }
  const file = lessonsPath(skillName);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# ${skillName} LESSONS\n\nSelf-refining loop. Each entry: date, input pattern, outcome.\nPre-run, the skill reads the last 10 entries. Post-run, it appends a fresh one.\n\n`);
  }
  return file;
}

function appendLesson(skillName, { input, outcome }) {
  if (!input || !outcome) {
    throw new Error('appendLesson requires both input and outcome');
  }
  const file = ensureLessonsFile(skillName);
  const date = new Date().toISOString();
  const entry = `## ${date}\n- input: ${input.replace(/\r?\n/g, ' ')}\n- outcome: ${outcome.replace(/\r?\n/g, ' ')}\n\n`;
  fs.appendFileSync(file, entry);
  return { file, date };
}

function readRecentLessons(skillName, n = 10) {
  const file = lessonsPath(skillName);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const blocks = text.split(/\n## /).slice(1);
  const entries = blocks.map(block => {
    const lines = ('## ' + block).split('\n');
    const date = (lines[0] || '').replace(/^## /, '').trim();
    const input = (lines[1] || '').replace(/^- input:\s*/, '').trim();
    const outcome = (lines[2] || '').replace(/^- outcome:\s*/, '').trim();
    return { date, input, outcome };
  });
  return entries.slice(-n);
}

function lessonsAsContext(skillName, n = 10) {
  const entries = readRecentLessons(skillName, n);
  if (!entries.length) return '';
  return [
    `# Lessons from the last ${entries.length} runs of ${skillName}`,
    ...entries.map(e => `- ${e.date}: ${e.input} -> ${e.outcome}`),
    '',
    'Apply these lessons. Repeat what worked. Avoid what failed.',
  ].join('\n');
}

module.exports = {
  appendLesson,
  readRecentLessons,
  lessonsAsContext,
  ensureLessonsFile,
  lessonsPath,
};
