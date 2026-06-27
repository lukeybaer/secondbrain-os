'use strict';

/**
 * Live-scheduler popup guard.
 *
 * Every recurring SecondBrain Windows scheduled task MUST run through
 * wscript.exe + silent-node-launcher.vbs (window style 0 = hidden). A task
 * whose Execute is a .bat / cmd.exe / node.exe / python.exe / powershell.exe
 * directly can pop a console window to the foreground on every firing and steal
 * ExampleCo's screen.
 *
 * The static test (scripts/__tests__/scheduled-tasks-silent-launcher.test.js)
 * guards the registration SOURCE. It passes when register-scheduled-tasks.ps1
 * is correct -- which it was. The failure this guard catches is LIVE-scheduler
 * drift: a task registered before the launcher rule (or by an ad-hoc path)
 * still holds a visible Execute, and the registration script was never re-run
 * to overwrite it. A source-only test cannot see that.
 *
 * Origin (2026-06-15): SecondBrain-GraphitiRealtimeMaintenance had drifted to
 * run graphiti-realtime-maintenance.bat directly every 15 minutes, popping a
 * node.exe console constantly in front of ExampleCo's Claude Code window.
 * ProviderCanaries (daily) and an OvernightLlmHeal orphan had the same defect.
 *
 * This module: a PURE classifier (CI-testable, no scheduler needed) plus a
 * live audit + surgical auto-repair that health-self-heal runs nightly and the
 * verify:scheduled-tasks-silent npm script runs on demand.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const LAUNCHER = path.join(REPO, 'scripts', 'silent-node-launcher.vbs');
const LAUNCHER_NAME = 'silent-node-launcher.vbs';

/**
 * Pure classifier. Returns null when the task is silent-safe, else a problem
 * object. Encodes the CATEGORY (anything that pops a window or silently
 * no-ops), never the literal task name from the incident.
 *
 *  - 'visible-exec'      : node/cmd/bat/python directly -> pops a console; the
 *                          node launcher can re-point it (script in Exec or Args).
 *  - 'visible-powershell': powershell/pwsh directly -> can still create a
 *                          visible console in an interactive desktop session;
 *                          re-point .ps1 scripts through the launcher.
 *  - 'no-launcher'       : wscript.exe but the launcher is not in the arguments.
 *  - 'bare-launcher'     : launcher present but no script after it -> silent no-op.
 *
 * Silent-safe form (return null): wscript/cscript + launcher + script. Handles
 * quoted AND unquoted launcher paths, so it does not share the false-positive
 * bug in the old `\.vbs"\s+\S` audit regex (which assumed the launcher path was
 * always quoted).
 */
function classifyTask(exec, args) {
  const e = String(exec || '')
    .trim()
    .toLowerCase();
  const a = String(args || '');

  // PowerShell's own hidden flag was not enough in ExampleCo's interactive desktop:
  // a blue PowerShell host still appeared. All PowerShell must be launched via
  // wscript + silent-node-launcher.vbs, which now dispatches .ps1 files.
  if (e === 'powershell.exe' || e === 'pwsh.exe' || /[\\/](powershell|pwsh)(\.exe)?$/.test(e)) {
    return {
      problem: 'visible-powershell',
      detail: `Execute is "${exec}" directly -- PowerShell must route through wscript + silent launcher`,
    };
  }

  const isWscript =
    e === 'wscript.exe' ||
    e === 'wscript' ||
    e === 'cscript.exe' ||
    e === 'cscript' ||
    /[\\/](wscript|cscript)(\.exe)?$/.test(e);
  if (!isWscript) {
    return {
      problem: 'visible-exec',
      detail: `Execute is "${exec}", not wscript.exe -- pops a console window on every firing`,
    };
  }
  const idx = a.toLowerCase().indexOf(LAUNCHER_NAME);
  if (idx === -1) {
    return {
      problem: 'no-launcher',
      detail: 'wscript.exe invoked without silent-node-launcher.vbs',
    };
  }
  // Is there a real script token after the launcher reference? Strip a single
  // trailing quote left over from the launcher path, then look for non-space.
  const after = a
    .slice(idx + LAUNCHER_NAME.length)
    .replace(/^["']/, '')
    .trim();
  if (!after) {
    return {
      problem: 'bare-launcher',
      detail: 'launcher invoked with no script argument -- task silently no-ops',
    };
  }
  return null;
}

function powershell(psCommand, timeoutMs = 60000) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
}

/**
 * Query live Windows Task Scheduler for every SecondBrain task.
 *
 * The filter must NOT assume the `SecondBrain-` hyphen prefix: the
 * `SecondBrain Session Sweep` task (a SPACE, not a hyphen) popped a node.exe
 * window every 10 minutes precisely because the first version of this guard
 * matched only `SecondBrain-*`. So match `SecondBrain*` (covers space and
 * hyphen) OR any task whose action references the secondbrain repo, which
 * catches a SecondBrain job registered under any name.
 */
function listLiveTasks() {
  if (process.platform !== 'win32') return { available: false, tasks: [], error: 'not win32' };
  const ps =
    'Get-ScheduledTask | Where-Object { ' +
    "$_.TaskName -like 'SecondBrain*' -or " +
    "$_.Actions.Execute -match 'secondbrain' -or " +
    "$_.Actions.Arguments -match 'secondbrain' } | " +
    'ForEach-Object { [pscustomobject]@{ Name=$_.TaskName; Exec=$_.Actions[0].Execute; ' +
    'Args=$_.Actions[0].Arguments } } | ConvertTo-Json -Compress';
  const r = powershell(ps);
  if (r.status !== 0) {
    return {
      available: false,
      tasks: [],
      error: (r.stderr || r.error?.message || 'powershell failed').slice(0, 300),
    };
  }
  let parsed = [];
  try {
    const j = JSON.parse(r.stdout || '[]');
    parsed = Array.isArray(j) ? j : [j];
  } catch {
    return { available: false, tasks: [], error: 'could not parse Get-ScheduledTask JSON' };
  }
  return { available: true, tasks: parsed };
}

/** Audit live state. Returns the list of drifted tasks (empty = clean). */
function auditLiveTasks() {
  const { available, tasks, error } = listLiveTasks();
  if (!available) return { available: false, drift: [], error };
  const drift = [];
  for (const t of tasks) {
    const c = classifyTask(t.Exec, t.Args);
    if (c) drift.push({ name: t.Name, exec: t.Exec, args: t.Args, ...c });
  }
  return { available: true, drift };
}

/** Split a Windows arguments string into tokens, honoring double quotes. */
function tokenizeArgs(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || '')))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/**
 * Find the real script to hand the launcher, looking across BOTH Execute and
 * Arguments. A drifted task can carry the script in either place:
 *   - Execute = "...graphiti.bat", Args = ""          -> script is the Execute
 *   - Execute = "node.exe", Args = '"...sweep.mjs"'   -> script is in the Args
 * Returns { script, rest } or null when no script-looking token is present.
 */
function deriveLaunch(exec, args) {
  const strip = (s) => String(s || '').replace(/^["']|["']$/g, '');
  const all = [strip(exec), ...tokenizeArgs(args)];
  // Only the script types silent-node-launcher.vbs can dispatch: .bat/.cmd via
  // cmd.exe, .js/.mjs via node.exe, and .ps1 via powershell.exe hidden behind
  // wscript. NOT .py -- the launcher would feed it to node and break the task.
  const scriptRe = /\.(bat|cmd|js|mjs|ps1)$/i;
  const idx = all.findIndex((t) => scriptRe.test(t));
  if (idx === -1) return null;
  return { script: all[idx], rest: all.slice(idx + 1) };
}

/** Re-point a drifted task through the silent launcher, preserving triggers. */
function repairTask(name, exec, args) {
  const derived = deriveLaunch(exec, args);
  if (!derived) return false;
  const tail = derived.rest.map((t) => ` "${t}"`).join('');
  const argVal = `'"${LAUNCHER}" "${derived.script}"${tail}'`;
  const ps =
    `$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${argVal} ` +
    `-WorkingDirectory '${REPO}'; Set-ScheduledTask -TaskName '${name}' -Action $a | Out-Null`;
  const r = powershell(ps);
  return r.status === 0;
}

/**
 * Self-heal entry point (called by health-self-heal). Audits live state and
 * re-points any task whose visible Execute IS the script to wrap. A
 * bare/no-launcher task cannot have its missing script auto-derived, so it is
 * surfaced as a blocker pointing at register-scheduled-tasks.ps1.
 */
function healScheduledTaskPopups() {
  const { available, drift, error } = auditLiveTasks();
  if (!available) {
    return {
      healed: true,
      action: 'scheduled-task popup audit skipped',
      note: error || 'not win32',
    };
  }
  if (drift.length === 0) {
    return {
      healed: true,
      action: 'all SecondBrain scheduled tasks route through the silent launcher',
      repaired: [],
    };
  }
  const repaired = [];
  const blockers = [];
  for (const d of drift) {
    if (d.problem === 'visible-exec') {
      // Derive the real script from Execute OR Args, then wrap it through the
      // launcher (handles both "...sweep.mjs in Args" and "...task.bat as Exec").
      if (repairTask(d.name, d.exec, d.args)) repaired.push(d.name);
      else blockers.push(`${d.name}: could not derive script to re-point`);
    } else if (d.problem === 'visible-powershell') {
      if (repairTask(d.name, d.exec, d.args)) repaired.push(d.name);
      else blockers.push(`${d.name}: ${d.detail}; could not derive .ps1 script to re-point`);
    } else {
      blockers.push(`${d.name}: ${d.detail} (re-register through silent-node-launcher.vbs)`);
    }
  }
  const out = {
    healed: blockers.length === 0,
    action: `re-pointed ${repaired.length} popup task(s) through the silent launcher`,
    repaired,
  };
  if (blockers.length) {
    out.blocker = 'Scheduled tasks still pop a console window: ' + blockers.join('; ');
  }
  return out;
}

module.exports = {
  classifyTask,
  tokenizeArgs,
  deriveLaunch,
  listLiveTasks,
  auditLiveTasks,
  repairTask,
  healScheduledTaskPopups,
};

// CLI: `node scripts/lib/scheduled-task-popup-guard.js`        -> audit, exit 1 on drift
//      `node scripts/lib/scheduled-task-popup-guard.js --fix`  -> audit + repair
if (require.main === module) {
  const fix = process.argv.includes('--fix');
  if (fix) {
    const res = healScheduledTaskPopups();
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.healed ? 0 : 1);
  }
  const { available, drift, error } = auditLiveTasks();
  if (!available) {
    console.log('scheduled-task popup guard: skipped (' + (error || 'not Windows') + ')');
    process.exit(0); // off-Windows / CI: skip, never fail the suite
  }
  if (drift.length === 0) {
    console.log('OK: all SecondBrain scheduled tasks route through wscript + silent launcher');
    process.exit(0);
  }
  console.error('DRIFT: ' + drift.length + ' SecondBrain task(s) will pop a console window:');
  for (const d of drift) console.error('  ' + d.name + ' [' + d.problem + '] ' + d.detail);
  console.error('Fix: node scripts/lib/scheduled-task-popup-guard.js --fix');
  process.exit(1);
}
