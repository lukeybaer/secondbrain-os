'use strict';
// Broad-kill guard (ship-jam S-6, owner decision): a session stops only
// processes inside its own process tree. The rule was broken Oct 27, Nov 15
// and Nov 16; memory/feedback_never_sweep_processes_by_pattern.md.
//
// Two shapes reach other sessions' processes, and both are blocked:
// 1. A kill by name or pattern: `Stop-Process -Name node`, `pkill -f vitest`,
//    `taskkill /IM node.exe`, or a kill-everything form. Nov 15:
//    `Stop-Process -Name node` ended other sessions' land checks and servers.
// 2. A stop by PID whose PIDs were chosen by matching: a process list filtered
//    on command line, name, path or start time feeding Stop-Process -Id, kill,
//    taskkill /PID, .Kill() or Terminate. Nov 16: a cleanup picked every
//    `vitest` or `land.js --check` process started in the last 40 minutes and
//    stopped about 110 processes belonging to other sessions.
// A PID is safe only by lineage: one the session started, or a child found by
// ParentProcessId. Shape 2 is judged on the whole command, so a pattern listing
// next to a computed stop blocks even when it is only a "left running" check;
// such a listing runs as its own command. A stop of typed PIDs, a liveness
// probe (kill -0) and a listing alone never block. Quoted text (a commit
// message) is not a command, except the script of a nested `powershell
// -Command`, `bash -c`, `cmd /c` or `trap`: it is judged on its own, and its
// stops count for the outer command too, since xargs or a loop feeds them.

const POLICY_MARKER = '[broad-kill-guard]';

function statements(command) {
  return String(command || '')
    .split(/&&|\|\||[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function stagesOf(statement) {
  return statement.split('|').map((s) => s.trim()).filter(Boolean);
}

function words(stage) {
  return stage.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').replace(/^&\s*/, '').split(/\s+/).filter(Boolean);
}

function base(word) {
  return String(word || '').replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
}

// The command with every quoted string replaced by a placeholder.
function unquoted(text) {
  return String(text || '').replace(/"(?:\\.|`.|[^"\\`])*"|'[^'\n]*'/g, ' Q ');
}

// Bodies of scriptblocks and subexpressions: `{ Stop-Process -Name $_ }`.
function fragments(text) {
  return text.split(/\$\(|[{}()]/).map((s) => s.trim()).filter(Boolean);
}

// The script handed to a nested shell (powershell -Command "...", bash -c '...',
// cmd /c "..."), to a trap, or to ssh as its remote command (EC2 runs Amy's
// services and other sessions' jobs too).
const NESTED = /\b(?:powershell|pwsh|bash|sh|cmd)(?:\.exe)?\b[^\n"']*?\s(?:-(?:Command|c)|\/[ck])\s+("|')((?:\\.|(?!\1)[\s\S])*)\1/gi;
const TRAP = /\btrap\s+("|')((?:\\.|(?!\1)[\s\S])*)\1/g;
const SSH = /\bssh\b[^\n"'|;&]*?\s("|')((?:\\.|(?!\1)[\s\S])*)\1/g;

function nestedScripts(text) {
  const t = String(text || '');
  return [...t.matchAll(NESTED), ...t.matchAll(TRAP), ...t.matchAll(SSH)].map((m) => m[2].replace(/\\(["'\\$`])/g, '$1'));
}

const PS_STOP = new Set(['stop-process', 'spps']);
const PS_GET = new Set(['get-process', 'gps']);

function hasFlag(argv, re) {
  return argv.some((a) => re.test(a));
}

// Shape 1, one pipeline stage. source: the first Get-Process stage earlier in the same pipeline.
function stageReason(argv, source, wholeCommand) {
  const cmd = base(argv[0]);
  const rest = argv.slice(1);
  if (cmd === 'pkill' || cmd === 'killall') return `${cmd} kills by name`;
  if (cmd === 'taskkill' && hasFlag(rest, /^[/-](im|fi)$/i)) return 'taskkill /IM or /FI kills by name or filter';
  if (cmd === 'kill' && rest.some((a) => a === '-1' || a === '0') && !hasFlag(rest, /^-(l|L)$/)) return 'kill -1 / kill 0 kills every process it can reach';
  if (cmd === 'wmic' && /\bprocess\b/i.test(argv.join(' ')) && /\b(delete|terminate)\b/i.test(argv.join(' '))) return 'wmic process delete kills by query';
  if ((cmd === 'invoke-cimmethod' || cmd === 'remove-ciminstance') && /win32_process/i.test(wholeCommand)
      && (cmd === 'remove-ciminstance' || /terminate/i.test(argv.join(' ')))) return 'a Win32_Process query terminate kills by query';
  if (PS_STOP.has(cmd) || (cmd === 'kill' && hasFlag(rest, /^-(name|processname)$/i))) {
    if (hasFlag(rest, /^-(name|processname|n)$/i)) return 'Stop-Process -Name kills every process with that name';
    const byId = hasFlag(rest, /^-id$/i) || rest.some((a) => /^\d+$/.test(a) || /^\$/.test(a));
    if (!byId && source && !hasFlag(source.slice(1), /^-id$/i)) {
      return 'a Get-Process list piped into Stop-Process kills every match';
    }
  }
  return null;
}

function directReason(u, raw) {
  for (const piece of [u, ...fragments(u)]) {
    for (const statement of statements(piece)) {
      let source = null;
      for (const stage of stagesOf(statement)) {
        const argv = words(stage);
        if (!argv.length) continue;
        const reason = stageReason(argv, source, raw);
        if (reason) return reason;
        if (!source && PS_GET.has(base(argv[0]))) source = argv;
      }
    }
  }
  return null;
}

// Shape 2 needs a stop whose targets are computed in this command: a variable,
// a subexpression, pipeline input (xargs, ForEach-Object), a loop token or an
// object method. Typed PIDs were chosen before the command ran, so a stop of
// typed PIDs followed by a check listing passes. Judged without quoted text,
// so a commit message is not a stop.
const STOP_WORD = /\b(?:Stop-Process|spps|taskkill)\b|(?<=^|[\s|;&({]|\$\()kill(?=[\s)]|$)/gi;
const STOP_TEST = new RegExp(STOP_WORD.source, 'i');
const OBJECT_STOP = /\.(?:Kill|Terminate)\s*\(|\b(?:Remove-CimInstance|Remove-WmiObject)\b|\bwmic\b[^|;\n]*\b(?:delete|terminate)\b/i;

function computedStop(u, raw, nested, depth = 0) {
  if (OBJECT_STOP.test(u)) return true;
  if (/\b(?:Invoke-CimMethod|Invoke-WmiMethod)\b/i.test(u) && /\bTerminate\b/i.test(raw)) return true;
  if (depth < 3 && nested.some((s) => computedStop(unquoted(s), s, nestedScripts(s), depth + 1))) return true;
  for (const statement of u.split(/&&|\|\||[;\n]/)) {
    for (const m of statement.matchAll(STOP_WORD)) {
      const rest = statement.slice(m.index);
      if (/^kill\s+-[0lL]\b/.test(rest)) continue; // a liveness probe or the signal list
      if (statement.slice(0, m.index).includes('|')) return true;
      if (/\$(?!(?:false|true|null)\b|!)|%%?\w|`|\{\}/i.test(rest)) return true; // {} is an xargs slot
    }
  }
  return false;
}

const CMD_START = '(?:^|[|;&({\\n]|\\$\\()\\s*';
// Selections that choose processes by name or text on their own.
const SELECTORS = [
  [/\b(?:Get-Process|gps)\b(?:\s+-(?:Name|ProcessName)\b|\s+(?!-)[^\s|;)}]+)/i, 'Get-Process <name>'],
  [/GetProcessesByName\s*\(/i, 'GetProcessesByName'],
  [/\b(?:pgrep|pidof)\b/i, 'pgrep or pidof'],
  [new RegExp(`${CMD_START}ps\\b[^;\\n]*?\\|\\s*(?:grep|egrep|fgrep|rg|awk|sed|findstr|Select-String|sls)\\b`, 'i'), 'ps filtered by text'],
  [new RegExp(`${CMD_START}ps\\b[^|;\\n]*\\s-C\\s`), 'ps -C <name>'],
  [/\btasklist\b[^;\n]*?(?:\s\/FI\b|\|\s*(?:findstr|find|grep|Select-String|sls)\b)/i, 'a tasklist filter'],
];
// A process list plus a filter on one of these attributes chooses by pattern.
const PROCESS_SOURCE = new RegExp(`\\b(?:Get-Process|gps|Get-CimInstance|gcim|Get-WmiObject|gwmi|wmic)\\b|\\bWin32_Process\\b|Diagnostics\\.Process\\]::GetProcesses|${CMD_START}ps\\b`, 'i');
const ATTR = '(?:CommandLine|ProcessName|ExecutablePath|Path|Name|MainWindowTitle|StartTime|CreationDate|Caption|Description|Product|Company)';
const OP = '(?:-[ci]?(?:not)?(?:match|like|contains|in)|-[ci]?(?:eq|ne|gt|ge|lt|le))\\b';
const FILTERS = [
  new RegExp(`\\$[\\w:]+\\.${ATTR}\\b\\s*(?:${OP}|\\.(?:Contains|StartsWith|EndsWith|IndexOf|Equals)\\s*\\()`, 'i'),
  new RegExp(`(?:\\bWhere-Object|\\bwhere|\\?)\\s+(?:-Property\\s+)?${ATTR}\\s+${OP}`, 'i'),
  new RegExp(`(?:-Filter|-Query|\\bwhere)\\b[^|;\\n]*?\\b${ATTR}\\s*(?:=|<>|!=|<|>|\\blike\\b)`, 'i'),
];

function selectedReason(u, raw, nested) {
  if (!computedStop(u, raw, nested)) return null;
  for (const [re, what] of SELECTORS) {
    if (re.test(raw)) return `the stop targets come from ${what}, a name or pattern match`;
  }
  if (PROCESS_SOURCE.test(raw) && FILTERS.some((re) => re.test(raw))) {
    return 'the stop targets were chosen by command line, name, path or start time';
  }
  return null;
}

/** @returns {{decision:'allow'|'block', reason:string}} */
function evaluateKill(command, depth = 0) {
  const raw = String(command || '');
  const u = unquoted(raw);
  const nested = nestedScripts(raw);
  const reason = directReason(u, raw) || selectedReason(u, raw, nested);
  if (reason) return { decision: 'block', reason };
  if (depth < 3) {
    for (const inner of nested) {
      const verdict = evaluateKill(inner, depth + 1);
      if (verdict.decision === 'block') return verdict;
    }
  }
  return { decision: 'allow', reason: '' };
}

function blockMessage(reason) {
  return [
    `${POLICY_MARKER} BLOCKED: ${reason}, so it also reaches other sessions' processes.`,
    'Stop only your own process tree, by PID lineage:',
    '  1. Start from a PID your session launched (Start-Process -PassThru, $!, your background task\'s shell PID).',
    '  2. Find its children: Get-CimInstance Win32_Process -Filter "ParentProcessId=<pid>", repeated for each child.',
    '  3. Stop exactly those: Stop-Process -Id <pid> (PowerShell), kill <pid> (Bash), taskkill /PID <pid> /T /F.',
    'Never pick targets by command line, name, path or start time. The whole command is judged, so run any',
    'pattern listing, even a "left running" check, as its own command.',
    'If another session\'s process looks stuck, tell that session or the owner.',
  ].join('\n');
}

module.exports = { POLICY_MARKER, evaluateKill, blockMessage };
