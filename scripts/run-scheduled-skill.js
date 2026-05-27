#!/usr/bin/env node
/**
 * run-scheduled-skill.js
 *
 * Generic runner for scheduled-tasks SKILL.md prompts.
 * Reads the SKILL.md, strips frontmatter, and runs it via Claude CLI (-p flag).
 * Used by Windows Task Scheduler entries for overnight improvement jobs.
 *
 * Usage: node scripts/run-scheduled-skill.js <skill-name>
 *   <skill-name> is the directory name under scheduled-tasks/
 *
 * Example:
 *   node scripts/run-scheduled-skill.js secondbrain-nightly-enhancement
 *   node scripts/run-scheduled-skill.js video-quality-research
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const hooks = require('./skill-runner-hooks');

const skillName = process.argv[2];
if (!skillName) {
  console.error('Usage: node run-scheduled-skill.js <skill-name>');
  process.exit(1);
}

const SECONDBRAIN_ROOT = path.resolve(__dirname, '..');
const skillFile = path.join(SECONDBRAIN_ROOT, 'scheduled-tasks', skillName, 'SKILL.md');

if (!fs.existsSync(skillFile)) {
  console.error(`SKILL.md not found: ${skillFile}`);
  process.exit(1);
}

const rawContent = fs.readFileSync(skillFile, 'utf8');

// Strip YAML frontmatter (--- ... ---)
const basePrompt = rawContent.replace(/^---[\s\S]*?---\s*\n/, '').trim();

// Phase 5 harness-evolution wiring: inject prior LESSONS.md entries into the
// prompt so the skill biases toward what worked and away from what failed.
const prompt = hooks.buildPromptWithLessons(skillName, basePrompt);
const lessonInputDescriptor = `scheduled run ${new Date().toISOString()}`;

// Log file: per-skill, in the same backups dir other scripts use
const logDir = path.join(os.homedir(), 'AppData', 'Roaming', 'secondbrain', 'backups');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `${skillName}.log`);

const timestamp = new Date().toISOString();
const separator = `\n============================\n${timestamp}  ${skillName}\n============================\n`;
fs.appendFileSync(logFile, separator);
console.log(separator.trim());

const CLAUDE_CLI_JS = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'npm',
  'node_modules',
  '@anthropic-ai',
  'claude-code',
  'cli.js',
);

if (!fs.existsSync(CLAUDE_CLI_JS)) {
  const msg = `Claude CLI not found: ${CLAUDE_CLI_JS}`;
  fs.appendFileSync(logFile, `ERROR: ${msg}\n`);
  console.error(msg);
  process.exit(1);
}

// Unset CLAUDECODE so the nested-session guard doesn't fire
const env = { ...process.env };
delete env.CLAUDECODE;

const result = spawnSync(
  process.execPath,
  [CLAUDE_CLI_JS, '-p', prompt],
  {
    env,
    cwd: SECONDBRAIN_ROOT,
    maxBuffer: 50 * 1024 * 1024,
    timeout: 30 * 60 * 1000, // 30-min hard cap
    encoding: 'utf8',
  },
);

const output = [result.stdout, result.stderr].filter(Boolean).join('');
fs.appendFileSync(logFile, output + '\n');
process.stdout.write(output);

if (result.error) {
  const errMsg = `Spawn error: ${result.error.message}`;
  fs.appendFileSync(logFile, `ERROR: ${errMsg}\n`);
  console.error(errMsg);
  try {
    hooks.recordSkillOutcome(skillName, { input: lessonInputDescriptor, exitCode: -1, output: errMsg });
  } catch (e) {
    fs.appendFileSync(logFile, `LESSONS append failed: ${e.message}\n`);
  }
  process.exit(1);
}

if (result.status !== 0) {
  const msg = `Skill exited with code ${result.status}`;
  fs.appendFileSync(logFile, `FAILED: ${msg}\n`);
  console.error(msg);
  try {
    hooks.recordSkillOutcome(skillName, { input: lessonInputDescriptor, exitCode: result.status, output });
  } catch (e) {
    fs.appendFileSync(logFile, `LESSONS append failed: ${e.message}\n`);
  }
  process.exit(result.status || 1);
}

try {
  hooks.recordSkillOutcome(skillName, { input: lessonInputDescriptor, exitCode: 0, output });
} catch (e) {
  fs.appendFileSync(logFile, `LESSONS append failed: ${e.message}\n`);
}

const done = `SUCCESS: ${skillName} completed at ${new Date().toISOString()}\n`;
fs.appendFileSync(logFile, done);
console.log(done);
