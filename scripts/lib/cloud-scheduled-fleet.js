'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
const DEFAULT_DATA_DIR =
  process.env.SECONDBRAIN_DATA_DIR ||
  (process.platform === 'linux'
    ? '/opt/secondbrain/data'
    : path.join(
        process.env.APPDATA || path.join(require('node:os').homedir(), 'AppData', 'Roaming'),
        'secondbrain',
        'data',
      ));

// Mirrors the Skill-Task fan-out in scripts/register-scheduled-tasks.ps1.
// Bat/script jobs stay owned by their dedicated runners; this fleet owns the
// scheduled SKILL.md work so PC-off nights still leave receipts.
const DEFAULT_CLOUD_SCHEDULED_SKILLS = Object.freeze([
  { skill: 'secondbrain-nightly-enhancement', cadence: 'daily', preBriefingRequired: true },
  { skill: 'daily-birthday-check', cadence: 'daily', preBriefingRequired: true },
  { skill: 'daily-gmail-scan', cadence: 'daily', preBriefingRequired: true },
  { skill: 'daily-otter-sweep', cadence: 'daily', preBriefingRequired: true },
  { skill: 'daily-linkedin-scan', cadence: 'daily', preBriefingRequired: true },
  {
    skill: 'kingdom-equipping-ideas',
    cadence: 'daily',
    preBriefingRequired: true,
    script: 'scripts/kingdom-equipping-ideas.js',
    args: ['--date', '$DATE', '--data-dir', '$DATA_DIR'],
  },
  {
    skill: 'communication-coaching-card',
    cadence: 'daily',
    preBriefingRequired: true,
    script: 'scripts/comm-coaching-card.js',
    args: ['--date', '$DATE'],
  },
  // Shorts proposals reinstated as their OWN job (ExampleCo wave 3a, 2026-07-12).
  // They previously rode the video-quality loops; retiring those (ExampleCo's D2
  // decision covered only the research/tools loops) silently took the daily
  // 10-proposal producer with them. The producer rides subscription LLM rungs
  // only (claude CLI, codex fallback -- no charged spend) and writes
  // data/agent/shorts-proposals/<date>.json, the artifact the TODAY'S 10
  // SHORTS PROPOSALS card reads (10-item card contract unchanged).
  {
    skill: 'morning-shorts-proposals',
    cadence: 'daily',
    preBriefingRequired: true,
    script: 'scripts/morning-shorts-proposals.js',
    args: ['--date', '$DATE'],
    timeoutMs: 18 * 60 * 1000,
  },
  {
    skill: 'amy-research-skill',
    cadence: 'daily',
    preBriefingRequired: true,
    disabled: process.env.AMY_ENABLE_AUTONOMOUS_RESEARCH !== '1',
    disabledReason:
      'proposal-only unless ExampleCo explicitly enables autonomous research with AMY_ENABLE_AUTONOMOUS_RESEARCH=1',
  },
  { skill: 'weekly-warmth-audit', cadence: 'weekly', dayOfWeek: 'MON', preBriefingRequired: true },
  {
    skill: 'weekly-backup-health-check',
    cadence: 'weekly',
    dayOfWeek: 'FRI',
    preBriefingRequired: true,
  },
]);

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function appendJsonl(file, row) {
  ensureDir(file);
  fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
}

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ctDateFromMs(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function dayOfWeekForDate(date) {
  const d = new Date(`${date}T12:00:00Z`);
  return DAY_NAMES[d.getUTCDay()];
}

function expectedSkillsForDate(tasks = DEFAULT_CLOUD_SCHEDULED_SKILLS, date, opts = {}) {
  const day = dayOfWeekForDate(date);
  return (tasks || [])
    .filter((task) => task && task.skill && task.disabled !== true)
    .filter((task) => {
      if (opts.preBriefingRequiredOnly && task.preBriefingRequired === false) return false;
      const cadence = String(task.cadence || 'daily').toLowerCase();
      if (cadence === 'daily') return true;
      if (cadence === 'weekly') return String(task.dayOfWeek || '').toUpperCase() === day;
      return false;
    });
}

function rowScheduleDate(row) {
  if (row && row.scheduleDate) return String(row.scheduleDate).slice(0, 10);
  const ms = Date.parse(row && row.ts);
  if (!Number.isFinite(ms)) return null;
  return ctDateFromMs(ms);
}

function latestOutcomesForDate(rows, date) {
  const latest = new Map();
  for (const row of rows || []) {
    if (!row || !row.skill) continue;
    if (rowScheduleDate(row) !== date) continue;
    const prev = latest.get(row.skill);
    if (!prev || Date.parse(row.ts || 0) > Date.parse(prev.ts || 0)) latest.set(row.skill, row);
  }
  return latest;
}

function missingDueSkills(expectedTasks, rows, date) {
  const latest = latestOutcomesForDate(rows, date);
  return (expectedTasks || []).filter((task) => {
    const row = latest.get(task.skill);
    return !(row && row.ok === true);
  });
}

function classifyScheduledFleet({ tasks = DEFAULT_CLOUD_SCHEDULED_SKILLS, rows = [], date } = {}) {
  const expected = expectedSkillsForDate(tasks, date);
  const latest = latestOutcomesForDate(rows, date);
  const failed = [];
  const missing = [];
  const codexExampleCod = [];

  for (const task of expected) {
    const row = latest.get(task.skill);
    if (!row) {
      missing.push(task.skill);
    } else if (row.ok !== true) {
      failed.push(task.skill);
    } else if (row.rung === 'codex') {
      codexExampleCod.push(task.skill);
    }
  }

  return {
    ok: missing.length === 0 && failed.length === 0,
    expected: expected.map((task) => task.skill),
    missing,
    failed,
    codexExampleCod,
    status: missing.length || failed.length ? 'red' : codexExampleCod.length ? 'yellow' : 'green',
    detail:
      missing.length || failed.length
        ? [
            missing.length ? `${missing.length} scheduled task receipt(s) missing` : '',
            failed.length ? `${failed.length} scheduled task(s) failed` : '',
          ]
            .filter(Boolean)
            .join('; ')
        : codexExampleCod.length
          ? `${codexExampleCod.length} scheduled task(s) completed on the Codex fallback rung`
          : `${expected.length} scheduled task receipt(s) complete`,
  };
}

function defaultRunSkill(
  task,
  { dataDir = DEFAULT_DATA_DIR, date, trigger = 'cloud-scheduled-fleet' } = {},
) {
  if (task && task.script) {
    const scriptPath = path.isAbsolute(task.script) ? task.script : path.join(REPO, task.script);
    const args = (task.args || []).map((arg) =>
      String(arg)
        .replace(/\$DATE/g, date || '')
        .replace(/\$DATA_DIR/g, dataDir || ''),
    );
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
      cwd: REPO,
      encoding: 'utf8',
      // Per-task timeoutMs beats the fleet default: the shorts producer's X
      // scrape + subscription LLM judging legitimately needs more than 10 min
      // (its source contract already budgets 18).
      timeout:
        Number(task.timeoutMs) ||
        Number(process.env.AMY_CLOUD_DIRECT_TASK_TIMEOUT_MS || 10 * 60 * 1000),
      env: {
        ...process.env,
        SECONDBRAIN_DATA_DIR: dataDir,
        AMY_SCHEDULE_DATE: date,
        AMY_SCHEDULE_TRIGGER: trigger,
      },
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      ok: result.status === 0,
      rung: 'direct',
      exitCode: result.status,
      raw: [result.stdout, result.stderr].filter(Boolean).join('\n').slice(-2000),
    };
  }
  const result = spawnSync(
    process.execPath,
    [path.join(REPO, 'scripts', 'run-scheduled-skill.js'), task.skill],
    {
      cwd: REPO,
      encoding: 'utf8',
      timeout: Number(process.env.AMY_CLOUD_SCHEDULED_SKILL_TIMEOUT_MS || 45 * 60 * 1000),
      env: {
        ...process.env,
        SECONDBRAIN_DATA_DIR: dataDir,
        AMY_SCHEDULE_DATE: date,
        AMY_SCHEDULE_TRIGGER: trigger,
      },
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    },
  );
  return {
    ok: result.status === 0,
    rung: /SUCCESS \(via codex\)/i.test(result.stdout || '')
      ? 'codex'
      : /SUCCESS \(via claude\)/i.test(result.stdout || '')
        ? 'claude'
        : 'none',
    exitCode: result.status,
    raw: [result.stdout, result.stderr].filter(Boolean).join('\n').slice(-2000),
  };
}

async function runDueScheduledTasks({
  dataDir = DEFAULT_DATA_DIR,
  date = ctDateFromMs(Date.now()),
  tasks = DEFAULT_CLOUD_SCHEDULED_SKILLS,
  runSkill = defaultRunSkill,
  trigger = 'cloud-scheduled-fleet',
  maxTasks = Infinity,
  now = () => new Date(),
} = {}) {
  const agentDir = path.join(dataDir, 'agent');
  const outcomesLedger = path.join(agentDir, 'scheduled-skill-outcomes.jsonl');
  const fleetLedger = path.join(agentDir, 'cloud-scheduled-fleet.jsonl');
  const rows = readJsonl(outcomesLedger);
  const expected = expectedSkillsForDate(tasks, date);
  const due = missingDueSkills(expected, rows, date).slice(0, maxTasks);
  const replayed = [];
  const skipped = expected.length - due.length;

  appendJsonl(fleetLedger, {
    ts: now().toISOString(),
    op: 'scan',
    date,
    expected: expected.map((task) => task.skill),
    due: due.map((task) => task.skill),
    skipped,
    trigger,
  });

  for (const task of due) {
    const startedAt = now().toISOString();
    let result;
    try {
      result = await runSkill(task, { dataDir, date, trigger });
    } catch (err) {
      result = { ok: false, rung: 'none', exitCode: 1, raw: err && err.message };
    }
    const row = {
      ts: now().toISOString(),
      scheduleDate: date,
      skill: task.skill,
      rung: result && result.rung ? result.rung : 'none',
      ok: !!(result && result.ok),
      exitCode:
        result && Number.isFinite(result.exitCode) ? result.exitCode : result && result.ok ? 0 : 1,
      source: 'cloud-scheduled-fleet',
      trigger,
      startedAt,
    };
    appendJsonl(outcomesLedger, row);
    appendJsonl(fleetLedger, row);
    replayed.push(row);
  }

  const after = readJsonl(outcomesLedger);
  const final = classifyScheduledFleet({ tasks, rows: after, date });
  return {
    ...final,
    date,
    replayed,
    expected: expected.map((task) => task.skill),
    skipped,
    ledger: outcomesLedger,
  };
}

module.exports = {
  DEFAULT_CLOUD_SCHEDULED_SKILLS,
  classifyScheduledFleet,
  ctDateFromMs,
  defaultRunSkill,
  expectedSkillsForDate,
  latestOutcomesForDate,
  missingDueSkills,
  readJsonl,
  runDueScheduledTasks,
};
