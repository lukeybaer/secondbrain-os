#!/usr/bin/env node
'use strict';

// Deterministic desktop bridge for the attended watcher-of-the-watcher.
// A one-minute Windows task reads one bounded EC2 outbox and launches no model
// on unchanged state. Only a new, proven terminal escalation resumes the same
// registered Codex task. EC2 remains the sole controller/watcher/publisher.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { dateKeyInCt, nextDateKey } = require('./lib/briefing-run-window.js');
const { codexExecPins, decideSpawnModel } = require('./lib/model-router.js');

const TASK_NAME = 'SecondBrain-AttendedBriefingWatcherBridge';
const DEFAULT_EC2_TARGET = 'ec2-user@ExampleCo';
const DEFAULT_CLOUD_OUTBOX = '/opt/secondbrain/data/agent/attended-watcher-escalations.jsonl';
const ROOT = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'secondbrain');
const CONFIG_PATH = path.join(ROOT, 'attended-watcher-bridge.json');
const STATE_PATH = path.join(ROOT, 'attended-watcher-bridge-state.json');
const RECEIPT_PATH = path.join(ROOT, 'attended-watcher-bridge-receipts.jsonl');
const LOCK_PATH = path.join(ROOT, 'attended-watcher-bridge.lock');
const INSTALLED_RUNTIME_ROOT = path.join(ROOT, 'attended-watcher-runtime');
const INSTALLED_SCRIPT_PATH = path.join(
  INSTALLED_RUNTIME_ROOT,
  'attended-briefing-watcher-bridge.js',
);
const INSTALLED_LAUNCHER_PATH = path.join(INSTALLED_RUNTIME_ROOT, 'poll-attended-watcher.cmd');
const INSTALLED_SILENT_LAUNCHER_PATH = path.join(
  INSTALLED_RUNTIME_ROOT,
  'silent-node-launcher.vbs',
);

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
}

function copyFileAtomic(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.tmp`;
  fs.copyFileSync(source, temp);
  fs.renameSync(temp, destination);
}

function writeTextAtomic(destination, body) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temp, body, 'utf8');
  fs.renameSync(temp, destination);
}

function windowsLauncherText({ nodePath = process.execPath, scriptPath = INSTALLED_SCRIPT_PATH } = {}) {
  return `@echo off\r\n"${nodePath}" "${scriptPath}" --poll\r\n`;
}

function windowsTaskCommand({
  silentLauncherPath = INSTALLED_SILENT_LAUNCHER_PATH,
  launcherPath = INSTALLED_LAUNCHER_PATH,
} = {}) {
  return `wscript.exe "${silentLauncherPath}" "${launcherPath}"`;
}

function taskXmlConfirmsSilentLauncher(xml) {
  const text = String(xml || '');
  const command = /<Command>([^<]+)<\/Command>/i.exec(text)?.[1]?.trim() || '';
  const args = /<Arguments>([^<]+)<\/Arguments>/i.exec(text)?.[1] || '';
  const launcherIndex = args.toLowerCase().indexOf('silent-node-launcher.vbs');
  const afterLauncher =
    launcherIndex < 0
      ? ''
      : args
          .slice(launcherIndex + 'silent-node-launcher.vbs'.length)
          .replace(/^(?:&quot;|["'])/i, '')
          .trim();
  return (
    /^(?:.*[\\/])?wscript(?:\.exe)?$/i.test(command) &&
    launcherIndex >= 0 &&
    afterLauncher.length > 0
  );
}

function installRuntimeBundle() {
  const sourceLib = path.join(__dirname, 'lib', 'briefing-run-window.js');
  const sourceSilentLauncher = path.join(__dirname, 'silent-node-launcher.vbs');
  const installedLib = path.join(INSTALLED_RUNTIME_ROOT, 'lib', 'briefing-run-window.js');
  if (!fs.existsSync(sourceLib)) {
    throw new Error(`required bridge runtime dependency is missing: ${sourceLib}`);
  }
  if (!fs.existsSync(sourceSilentLauncher)) {
    throw new Error(`required silent launcher is missing: ${sourceSilentLauncher}`);
  }
  copyFileAtomic(__filename, INSTALLED_SCRIPT_PATH);
  copyFileAtomic(sourceLib, installedLib);
  copyFileAtomic(sourceSilentLauncher, INSTALLED_SILENT_LAUNCHER_PATH);
  writeTextAtomic(INSTALLED_LAUNCHER_PATH, windowsLauncherText());
  return {
    installedScriptPath: INSTALLED_SCRIPT_PATH,
    installedLibPath: installedLib,
    installedLauncherPath: INSTALLED_LAUNCHER_PATH,
    installedSilentLauncherPath: INSTALLED_SILENT_LAUNCHER_PATH,
  };
}

function appendReceipt(row) {
  fs.mkdirSync(path.dirname(RECEIPT_PATH), { recursive: true });
  fs.appendFileSync(RECEIPT_PATH, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}

function ctClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { hour: Number(values.hour), minute: Number(values.minute) };
}

function currentBriefingDate(now = new Date()) {
  const date = dateKeyInCt(now.getTime());
  return ctClock(now).hour >= 12 ? nextDateKey(date) : date;
}

function withinAttendedWindow(now = new Date()) {
  const { hour, minute } = ctClock(now);
  const value = hour * 60 + minute;
  return value >= 22 * 60 + 35 || value <= 5 * 60 + 35;
}

function selectNewEscalations(rows, { date, seenEventIds = [] } = {}) {
  const seen = new Set(seenEventIds);
  return (rows || []).filter(
    (row) =>
      row &&
      row.schema === 'attended-watcher-escalation@1' &&
      row.date === date &&
      row.terminal === true &&
      row.requiresAttendedJudgment === true &&
      row.eventId &&
      !seen.has(row.eventId),
  );
}

function buildResumePrompt(row) {
  return [
    'Canonical EC2 emitted a proven attended-watcher escalation.',
    `Event: ${row.eventId}`,
    `Briefing date: ${row.date}`,
    `Failure class: ${row.class}`,
    `Cloud evidence: ${row.cloudEvidence || row.reason}`,
    '',
    'Resume the attended watcher-of-the-watcher role now. Follow scripts/BRIEFING_BABYSITTER_SKILL.md and dev-plans/core/briefing.md. EC2 remains the sole autonomous production owner. Inspect current canonical evidence and no-op if named work is progressing. Rescue only the failed cloud lane. Become sole temporary owner of one exact stage only after cooperative lease handoff or safe proven-dead reclaim; never start a concurrent owner. Do not impose a task, turn, or token budget that an ordinary Codex development task would not have. Keep the 5:00 AM CT repair-admission cutoff and 5:30 AM delivery deadline because they protect the briefing outcome, not because they limit the Codex task. Stay silent if later proof has already cleared this exact event.',
  ].join('\n');
}

function assertThreadId(threadId) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(threadId || ''))) {
    throw new Error('a valid Codex thread UUID is required');
  }
  return String(threadId);
}

function codexResumeArgs(threadId, env = process.env) {
  const safeThreadId = assertThreadId(threadId);
  const ceilingEnv = {
    ...env,
    SECONDBRAIN_BRIEFING_CODEX_CEILING: 'gpt-5.6-sol:medium',
  };
  const decision = decideSpawnModel(
    'attended-briefing-watcher-bridge',
    'codex',
    { taskType: 'repair-code', attended: true },
    { env: ceilingEnv },
  );
  if (!decision) throw new Error('attended watcher resume refused: no capped Codex decision');
  return [
    'exec',
    ...codexExecPins(decision),
    'resume',
    '--json',
    '--skip-git-repo-check',
    safeThreadId,
    '-',
  ];
}

function validateCodexResumeCli(spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl('codex', ['exec', 'resume', '--help'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    shell: process.platform === 'win32',
    input: '',
  });
  const help = String((result && result.stdout) || '');
  return Boolean(
    result &&
      result.status === 0 &&
      /Resume a previous session/i.test(help) &&
      /\[PROMPT\]/.test(help) &&
      /Prompt to send after resuming the session/i.test(help) &&
      /If `-` is used, read from stdin/i.test(help),
  );
}

function spawnAttendedResume({
  threadId,
  event,
  cwd,
  spawnSyncImpl = spawnSync,
  platform = process.platform,
  env = process.env,
} = {}) {
  const ceilingEnv = {
    ...env,
    SECONDBRAIN_BRIEFING_CODEX_CEILING: 'gpt-5.6-sol:medium',
  };
  return spawnSyncImpl('codex', codexResumeArgs(threadId, ceilingEnv), {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    input: buildResumePrompt(event),
    shell: platform === 'win32',
    env: ceilingEnv,
  });
}

function sshKey(env = process.env) {
  return [
    env.SB_EC2_SSH_KEY,
    env.EC2_SSH_KEY,
    path.join(os.homedir(), '.ssh', 'sb-key.pem'),
    path.join(os.homedir(), '.ssh', 'secondbrain-backend-key.pem'),
  ]
    .filter(Boolean)
    .find((file) => fs.existsSync(file));
}

function bridgeTargetIsValid(value) {
  return /^[a-z0-9._-]+@[a-z0-9.-]+$/i.test(String(value || ''));
}

function cloudOutboxIsValid(value) {
  return /^\/[a-z0-9._/-]+$/i.test(String(value || '')) && !String(value).includes('..');
}

function fetchCloudEscalations({
  env = process.env,
  spawnSyncImpl = spawnSync,
  ec2Target = DEFAULT_EC2_TARGET,
  cloudOutbox = DEFAULT_CLOUD_OUTBOX,
} = {}) {
  if (!bridgeTargetIsValid(ec2Target)) {
    return { ok: false, rows: [], reason: 'invalid-ec2-target' };
  }
  if (!cloudOutboxIsValid(cloudOutbox)) {
    return { ok: false, rows: [], reason: 'invalid-cloud-outbox' };
  }
  const key = sshKey(env);
  if (!key) return { ok: false, rows: [], reason: 'ec2-ssh-key-missing' };
  const result = spawnSyncImpl(
    'ssh',
    [
      '-i',
      key,
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      ec2Target,
      'tail',
      '-n',
      '200',
      cloudOutbox,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 512 * 1024 },
  );
  if (!result || result.status !== 0) {
    const stderr = String((result && result.stderr) || 'cloud outbox read failed').trim();
    if (/No such file/i.test(stderr)) return { ok: true, rows: [] };
    return { ok: false, rows: [], reason: stderr.slice(-300) };
  }
  const rows = String(result.stdout || '')
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
  return { ok: true, rows };
}

function register({
  threadId,
  cwd = process.cwd(),
  install = false,
  spawnSyncImpl = spawnSync,
  platform = process.platform,
  writeJsonAtomicImpl = writeJsonAtomic,
  validateCodexResumeCliImpl = validateCodexResumeCli,
  installRuntimeBundleImpl = installRuntimeBundle,
  ec2Target = process.env.SB_EC2_TARGET || DEFAULT_EC2_TARGET,
  cloudOutbox = process.env.SB_ATTENDED_WATCHER_OUTBOX || DEFAULT_CLOUD_OUTBOX,
} = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(threadId || ''))) {
    throw new Error('a valid Codex thread UUID is required');
  }
  if (!bridgeTargetIsValid(ec2Target)) throw new Error('a valid EC2 SSH target is required');
  if (!cloudOutboxIsValid(cloudOutbox)) throw new Error('a valid absolute cloud outbox is required');
  writeJsonAtomicImpl(CONFIG_PATH, {
    schema: 'attended-watcher-bridge-config@1',
    threadId,
    cwd: path.resolve(cwd),
    ec2Target,
    cloudOutbox,
    registeredAt: new Date().toISOString(),
    sameThreadOnly: true,
  });
  let runtimeBundle = null;
  if (install && platform === 'win32') {
    if (!validateCodexResumeCliImpl(spawnSyncImpl)) {
      throw new Error('installed Codex CLI does not expose exec resume');
    }
    runtimeBundle = installRuntimeBundleImpl();
    const command = windowsTaskCommand({
      silentLauncherPath: runtimeBundle.installedSilentLauncherPath,
      launcherPath: runtimeBundle.installedLauncherPath,
    });
    const task = spawnSyncImpl(
      'schtasks.exe',
      ['/Create', '/TN', TASK_NAME, '/SC', 'MINUTE', '/MO', '1', '/TR', command, '/F'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (!task || task.status !== 0) {
      throw new Error(
        `scheduled bridge install failed (exit ${task && task.status}): ${[
          task && task.stdout,
          task && task.stderr,
          task && task.error && task.error.message,
        ]
          .filter(Boolean)
          .join(' ')
          .trim()}`,
      );
    }
    const readback = spawnSyncImpl(
      'schtasks.exe',
      ['/Query', '/TN', TASK_NAME, '/XML'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (
      !readback ||
      readback.status !== 0 ||
      !taskXmlConfirmsSilentLauncher(readback.stdout)
    ) {
      throw new Error(
        `scheduled bridge readback did not prove wscript + silent launcher: ${[
          readback && readback.stdout,
          readback && readback.stderr,
          readback && readback.error && readback.error.message,
        ]
          .filter(Boolean)
          .join(' ')
          .trim()
          .slice(-600)}`,
      );
    }
  }
  return {
    configPath: CONFIG_PATH,
    taskName: install ? TASK_NAME : null,
    installedScriptPath: runtimeBundle?.installedScriptPath || null,
  };
}

function runPoll({ now = new Date(), fetch = fetchCloudEscalations, spawnSyncImpl = spawnSync } = {}) {
  if (!withinAttendedWindow(now)) return { skipped: true, reason: 'outside-attended-window' };
  const config = readJson(CONFIG_PATH, null);
  if (!config || !config.threadId) return { skipped: true, reason: 'no-registered-thread' };
  if (
    config.sameThreadOnly !== true ||
    !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(config.threadId))
  ) {
    return { skipped: true, reason: 'invalid-same-thread-registration' };
  }
  fs.mkdirSync(ROOT, { recursive: true });
  let lock;
  try {
    lock = fs.openSync(LOCK_PATH, 'wx');
  } catch {
    return { skipped: true, reason: 'bridge-already-running' };
  }
  try {
    const cloud = fetch({
      ec2Target: config.ec2Target || DEFAULT_EC2_TARGET,
      cloudOutbox: config.cloudOutbox || DEFAULT_CLOUD_OUTBOX,
    });
    if (!cloud.ok) {
      appendReceipt({ status: 'cloud-read-failed', reason: cloud.reason });
      return { ok: false, reason: cloud.reason };
    }
    const state = readJson(STATE_PATH, { seenEventIds: [] });
    const date = currentBriefingDate(now);
    const events = selectNewEscalations(cloud.rows, { date, seenEventIds: state.seenEventIds });
    if (!events.length) return { ok: true, resumed: 0 };
    const seen = new Set(state.seenEventIds || []);
    let resumed = 0;
    for (const event of events) {
      const result = spawnAttendedResume({
        threadId: config.threadId,
        event,
        cwd: config.cwd,
        spawnSyncImpl,
      });
      if (!result || result.status !== 0) {
        appendReceipt({
          status: 'resume-failed-will-retry',
          eventId: event.eventId,
          reason: String((result && result.stderr) || 'codex resume failed').slice(-600),
        });
        break;
      }
      seen.add(event.eventId);
      resumed += 1;
      appendReceipt({ status: 'resumed-same-thread', eventId: event.eventId, threadId: config.threadId });
    }
    writeJsonAtomic(STATE_PATH, { seenEventIds: [...seen].slice(-500), updatedAt: new Date().toISOString() });
    return { ok: true, resumed };
  } finally {
    try {
      fs.closeSync(lock);
      fs.unlinkSync(LOCK_PATH);
    } catch {
      // A later task pass can remove a stale lock only after operator inspection.
    }
  }
}

function argValue(flag, argv = process.argv.slice(2)) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : '';
}

if (require.main === module) {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes('--register-thread')) {
      const result = register({
        threadId: argValue('--register-thread', argv),
        cwd: argValue('--cwd', argv) || process.cwd(),
        install: argv.includes('--install'),
        ec2Target: argValue('--ec2-target', argv) || process.env.SB_EC2_TARGET || DEFAULT_EC2_TARGET,
        cloudOutbox:
          argValue('--cloud-outbox', argv) ||
          process.env.SB_ATTENDED_WATCHER_OUTBOX ||
          DEFAULT_CLOUD_OUTBOX,
      });
      process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
    } else if (argv.includes('--poll')) {
      process.stdout.write(JSON.stringify(runPoll()) + '\n');
    } else {
      throw new Error('use --register-thread UUID [--cwd PATH] [--install] or --poll');
    }
  } catch (error) {
    process.stderr.write(`[attended-watcher-bridge] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  TASK_NAME,
  CONFIG_PATH,
  STATE_PATH,
  INSTALLED_SCRIPT_PATH,
  INSTALLED_LAUNCHER_PATH,
  INSTALLED_SILENT_LAUNCHER_PATH,
  currentBriefingDate,
  withinAttendedWindow,
  selectNewEscalations,
  buildResumePrompt,
  codexResumeArgs,
  spawnAttendedResume,
  validateCodexResumeCli,
  bridgeTargetIsValid,
  cloudOutboxIsValid,
  fetchCloudEscalations,
  installRuntimeBundle,
  windowsLauncherText,
  windowsTaskCommand,
  taskXmlConfirmsSilentLauncher,
  register,
  runPoll,
};
