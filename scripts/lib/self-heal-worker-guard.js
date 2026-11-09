'use strict';

function normalizePath(p) {
  if (!p) return '';
  let out = String(p).replace(/\\/g, '/').trim();
  const msys = out.match(/^\/([a-zA-Z])\/(.*)$/);
  if (msys) out = `${msys[1]}:/${msys[2]}`;
  if (/^[a-zA-Z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1);
  return out.replace(/\/+$/, '');
}

function commandText(command) {
  return String(command || '').replace(/\\/g, '/');
}

function msysForm(p) {
  const n = normalizePath(p);
  const m = n.match(/^([a-z]):\/(.*)$/i);
  return m ? `/${m[1].toLowerCase()}/${m[2]}` : n;
}

function splitRoots(raw) {
  return String(raw || '')
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function protectedRootsFromEnv(env = {}) {
  return [
    env.SB_SELF_HEAL_COORDINATOR_ROOT,
    ...splitRoots(env.SB_SELF_HEAL_PROTECTED_ROOTS),
  ].filter(Boolean);
}

function mentionsPath(command, root) {
  const cmd = commandText(command).toLowerCase();
  const n = normalizePath(root).toLowerCase();
  if (!cmd || !n) return false;
  const variants = new Set([n, msysForm(n).toLowerCase()]);
  for (const v of variants) {
    if (v && cmd.includes(v)) return true;
  }
  return false;
}

function mentionsProtectedRoot(command, roots = []) {
  return roots.some((root) => mentionsPath(command, root));
}

function isSameOrInside(candidate, root) {
  const c = normalizePath(candidate).toLowerCase();
  const r = normalizePath(root).toLowerCase();
  if (!c || !r) return false;
  if (c === r) return true;
  return c.startsWith(`${r}/`);
}

function pathIsAllowedWorkerWrite(filePath, env = {}) {
  const workerRoot = env.SB_SELF_HEAL_WORKER_ROOT;
  const roots = protectedRootsFromEnv(env);
  if (!filePath) return false;
  if (roots.some((root) => isSameOrInside(filePath, root))) return false;
  if (!workerRoot) return false;
  return isSameOrInside(filePath, workerRoot);
}

function hasShellWriteEffect(command) {
  const cmd = String(command || '');
  return (
    /(?:^|[;&|]\s*)(?:rm|rmdir|del|mv|move|cp|copy|touch|mkdir|install|tee|truncate|chmod|chown|sed\s+-i|perl\s+-i|python\b|node\b)/i.test(
      cmd,
    ) ||
    /(?:^|\s)(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item)\b/i.test(
      cmd,
    ) ||
    /(^|[^>])>{1,2}(?!>)/.test(cmd)
  );
}

function mentionsParentTraversal(command) {
  return /(?:^|[\s'"=])\.\.(?:[\\/]|$)/.test(String(command || ''));
}

function absolutePathCandidates(command) {
  const out = [];
  const rx = /(?:^|[\s'"=>(])([A-Za-z]:[\\/][^\s'";|]+|\/(?!\/)[^\s'";|]+)/g;
  for (const match of String(command || '').matchAll(rx)) {
    out.push(String(match[1] || '').replace(/[),]+$/, ''));
  }
  return out;
}

function invokesRawCodexCli(command) {
  // A healer may use the routed repo wrapper (`node scripts/codex-run.js`),
  // but never the raw Codex binary. Blocking the standalone executable token
  // also covers explicit Astra pins and env-prefixed/path-qualified launches.
  return /(?:^|[\s;&|=/\\"])(?:codex|codex\.exe|codex\.cmd)(?=["'\s;&|]|$)/i.test(
    String(command || ''),
  );
}

function mutatesBriefingCeilingMarker(command) {
  const cmd = String(command || '');
  const marker = 'SECONDBRAIN_BRIEFING_CODEX_CEILING';
  return (
    new RegExp(`\\bunset\\s+${marker}\\b`, 'i').test(cmd) ||
    new RegExp(`\\benv\\b[^\\n;&|]*?(?:-u\\s+${marker}\\b|${marker}\\s*=)`, 'i').test(cmd) ||
    new RegExp(`(?:^|[\\s;&|])(?:export\\s+)?${marker}\\s*=`, 'i').test(cmd) ||
    new RegExp(`\\$env:${marker}\\s*=`, 'i').test(cmd) ||
    new RegExp(`\\bset\\s+["']?${marker}\\s*=`, 'i').test(cmd) ||
    new RegExp(`\\bRemove-Item\\s+(?:-LiteralPath\\s+)?Env:${marker}\\b`, 'i').test(cmd)
  );
}

const PROTECTED_BOUNDARY_MARKERS = Object.freeze([
  'SECONDBRAIN_BRIEFING_CODEX_CEILING',
  'SB_SELF_HEAL_WORKER_ROOT',
  'SB_SELF_HEAL_COORDINATOR_ROOT',
  'SB_SELF_HEAL_PROTECTED_ROOTS',
  'SB_SELF_HEAL_GUARD_ROOT',
  'SB_SELF_HEAL_GUARD_BUNDLE_SHA256',
  'SB_SELF_HEAL_ROUTED_CODEX_WRAPPER',
]);

function mutatesSelfHealBoundaryMarker(command) {
  const cmd = String(command || '');
  return PROTECTED_BOUNDARY_MARKERS.some((marker) => (
    new RegExp(`\\bunset\\s+${marker}\\b`, 'i').test(cmd) ||
    new RegExp(`\\benv\\b[^\\n;&|]*?(?:-u\\s+${marker}\\b|${marker}\\s*=)`, 'i').test(cmd) ||
    new RegExp(`(?:^|[\\s;&|])(?:export\\s+)?${marker}\\s*=`, 'i').test(cmd) ||
    new RegExp(`\\$env:${marker}\\s*=`, 'i').test(cmd) ||
    new RegExp(`\\bset\\s+["']?${marker}\\s*=`, 'i').test(cmd) ||
    new RegExp(`\\bRemove-Item\\s+(?:-LiteralPath\\s+)?Env:${marker}\\b`, 'i').test(cmd)
  ));
}

function opensIndirectProcessLaunchSurface(command) {
  const cmd = String(command || '');
  return (
    /\bnode(?:\.exe)?\s+(?:--eval|-e|--print|-p)\b/i.test(cmd) ||
    /\b(?:python|python3|py)(?:\.exe)?\s+-c\b/i.test(cmd) ||
    /\b(?:bash|sh)(?:\.exe)?\s+-c\b/i.test(cmd) ||
    /\bpowershell(?:\.exe)?\s+(?:-Command|-EncodedCommand)\b/i.test(cmd) ||
    /\bchild_process\b|\bspawnSync\b|\bexecFileSync\b/i.test(cmd)
  );
}

function launchesUntrustedNodeScript(command) {
  const cmd = String(command || '');
  if (!/\bnode(?:\.exe)?\s+/i.test(cmd)) return false;
  if (/\bnode(?:\.exe)?\s+--check\b/i.test(cmd)) return false;
  if (/\bnode(?:\.exe)?\s+(?:\.\/)?scripts[\\/]codex-run\.js\b/i.test(cmd)) return false;
  if (/\bnode(?:\.exe)?\s+(?:\.\/)?node_modules[\\/]vitest[\\/]vitest\.mjs\b/i.test(cmd)) return false;
  return /\bnode(?:\.exe)?\s+(?:"[^"]+"|'[^']+'|\S+)\.(?:c?js|mjs)\b/i.test(cmd);
}

function codexWrapperPathFromCommand(command) {
  const match = /\bnode(?:\.exe)?\s+(?:"([^"]*codex-run\.js)"|'([^']*codex-run\.js)'|(\S*codex-run\.js))/i.exec(
    String(command || ''),
  );
  return match ? match[1] || match[2] || match[3] || '' : '';
}

function invokesTrustedCodexWrapper(command, env = {}) {
  if (/[;&|><\r\n]/.test(String(command || ''))) return false;
  const invoked = codexWrapperPathFromCommand(command);
  const trusted = env.SB_SELF_HEAL_ROUTED_CODEX_WRAPPER;
  return Boolean(invoked && trusted && normalizePath(invoked) === normalizePath(trusted));
}

// Splits a command on unquoted `&&` and `|` into segments. Returns null when an
// unquoted shell control character remains (`;`, `||`, redirects, backticks,
// `$` expansion, newlines) or a double-quoted string could expand. Quoted text
// is data: a `|` inside a quoted regex is not a pipe (2026-09-27: the guard
// rejected `rg "a|b"` and blocked every self-heal worker's source inspection).
function splitAuditedSegments(cmd) {
  const segments = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) {
      if (quote === '"' && (ch === '`' || ch === '$' || ch === '\\')) return null;
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '&' && cmd[i + 1] === '&') {
      segments.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    if (ch === '|') {
      if (cmd[i + 1] === '|') return null;
      segments.push(current.trim());
      current = '';
      continue;
    }
    if (/[;&><`$\r\n]/.test(ch)) return null;
    current += ch;
  }
  if (quote) return null;
  segments.push(current.trim());
  return segments.every(Boolean) ? segments : null;
}

// Whitespace-split argv with quotes removed; quoting was already validated.
function segmentArgv(segment) {
  return (String(segment).match(/"[^"]*"|'[^']*'|[^\s]+/g) || []).map((token) =>
    /^(["']).*\1$/.test(token) ? token.slice(1, -1) : token,
  );
}

// Git read commands, minus every option that writes a file or runs a program:
// --output/-o style writes, and -O pagers attached or bundled (-O<cmd>, -iO).
function isAuditedGitRead(argv) {
  let index = 1;
  if (argv[index] === '-C') index += 2;
  if (!/^(?:status|diff|show|log|rev-parse|ls-files|grep)$/i.test(argv[index] || '')) return false;
  return argv.slice(index + 1).every(
    (arg) =>
      !/^--(?:output|open-files-in-pager|ext-diff|textconv)(?:=|$)/i.test(arg) &&
      !/^-[A-Za-z]*O/.test(arg),
  );
}

// Print-only sed: exactly `-n`, one numeric address with `p`, then input
// paths. Any other option in any position (-i, --in-place, -e, -f, -s, -z)
// or script (w, e, s///) is refused.
function isAuditedSedRead(argv) {
  if (argv[1] !== '-n' || !/^\d+(?:,\d+)?p$/.test(argv[2] || '')) return false;
  const paths = argv.slice(3);
  return paths.length > 0 && paths.every((arg) => arg && !arg.startsWith('-'));
}

function isAuditedReadSegment(segment) {
  const argv = segmentArgv(segment);
  const program = String(argv[0] || '');
  if (/^git$/i.test(program)) return isAuditedGitRead(argv);
  if (program === 'sed') return isAuditedSedRead(argv);
  // Syntax check of exactly one source file; no Node option (e.g. --require)
  // may preload or execute code.
  if (/^node(?:\.exe)?$/i.test(program)) {
    return argv.length === 3 && argv[1] === '--check' && !String(argv[2]).startsWith('-');
  }
  return /^(?:rg|grep|jq|tail|head|stat|ls|dir|pwd|where|which|wc|Get-Content|Get-ChildItem|Select-String)(?:\.exe)?$/i.test(program);
}

function isAuditedWorkerCommand(command, opts = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (/(?:^|\s)(?:--pre(?:-glob)?|--ext-diff|--textconv|-exec(?:dir)?|-ok|--open-files-in-pager)(?:\s|=|$)/i.test(cmd)) {
    return false;
  }
  if (opts.trustedCodexWrapper === true) {
    if (/[;&|><`$\r\n]/.test(cmd)) return false;
    if (!/\s--operation-file(?:\s|=)/i.test(cmd)) return true;
  }
  const segments = splitAuditedSegments(cmd);
  return Boolean(segments && segments.every(isAuditedReadSegment));
}

function invokesComputedExecutable(command) {
  const cmd = String(command || '');
  return (
    /(?:^|[;&|]\s*)["']?\$[A-Za-z_][A-Za-z0-9_]*["']?\s+(?:exec\b|-m\b|--model\b)/i.test(cmd) ||
    /&\s*(?:\$[A-Za-z_][A-Za-z0-9_]*|\([^\r\n]*[+'"][^\r\n]*\))\s+/i.test(cmd) ||
    /["']co["']\s*\+\s*["']dex["']/i.test(cmd)
  );
}

function isWorkerForbiddenCommand(command, roots = [], opts = {}) {
  const cmd = String(command || '');
  if (!cmd.trim()) return '';
  if (invokesRawCodexCli(cmd)) {
    return 'self-heal workers may not launch the raw Codex CLI; use the routed coordinator boundary so the briefing model ceiling is mechanically enforced and receipted';
  }
  if (mutatesSelfHealBoundaryMarker(cmd)) {
    return 'self-heal workers may not remove or override protected model-routing or guard boundary markers';
  }
  if (opensIndirectProcessLaunchSurface(cmd)) {
    return 'self-heal workers may not use inline or indirect process launchers; use an audited repo command or the routed Codex wrapper';
  }
  if (invokesComputedExecutable(cmd)) {
    return 'self-heal workers may not invoke computed executables; use a literal audited command or the routed Codex wrapper';
  }
  if (/\bgit\s+worktree\b/i.test(cmd)) {
    return 'self-heal workers may not mutate git worktree registrations';
  }
  if (/\bgit\b[\s\S]*\bpush\b/i.test(cmd)) {
    return 'self-heal workers may not push; the coordinator lands commits';
  }
  if (/\bgit\b[\s\S]*\bcommit\b/i.test(cmd)) {
    return 'self-heal workers may not commit; the coordinator owns git landing';
  }
  if (
    /(?:scripts[\\/])?(?:land\.js|deploy-ec2-server\.sh|ec2-sync-build-path\.sh|refresh-card\.js|card-controller\.js|verify-dashboard-cards-live\.js|cloud-morning-briefing\.js)/i.test(
      cmd,
    )
  ) {
    return 'self-heal workers repair the cause only; the coordinator owns commit, land, deploy, refresh, QC, and publish';
  }
  if (launchesUntrustedNodeScript(cmd) && opts.trustedCodexWrapper !== true) {
    return 'self-heal workers may not execute worker-authored Node launchers; use tests, node --check, or the routed Codex wrapper';
  }
  if (/\bgit\b[^\n]*\bbranch\b[^\n]*(\s-D\b|\s--delete\s+--force\b)/i.test(cmd)) {
    return 'self-heal workers may not force-delete branches';
  }
  if (
    mentionsProtectedRoot(cmd, roots) &&
    (/\bgit\b[^\n]*\b(clean|reset|checkout|stash)\b/i.test(cmd) ||
      /\b(rm|rmdir|del)\b[^\n]*(\s-rf\b|\s-fr\b|\/s\b|\/q\b)/i.test(cmd) ||
      /(^|\s)Remove-Item\b[^\n]*(-Recurse|-Force)/i.test(cmd))
  ) {
    return 'command attempts destructive cleanup against a protected self-heal root';
  }
  if (!isAuditedWorkerCommand(cmd, opts)) {
    return 'self-heal worker command is not on the audited allowlist; worker-authored scripts, package runners, and indirect executables must be verified by the coordinator';
  }
  return '';
}

function evaluateSelfHealWorkerCommand({ command, env = {} } = {}) {
  const roots = protectedRootsFromEnv(env);
  const workerRoot = env.SB_SELF_HEAL_WORKER_ROOT;
  const wrapperPath = codexWrapperPathFromCommand(command);
  const trustedCodexWrapper = invokesTrustedCodexWrapper(command, env);
  if (!workerRoot) {
    return {
      blocked: true,
      reason: 'self-heal Bash is fail-closed until the coordinator supplies the worker checkout root',
    };
  }
  if (mutatesSelfHealBoundaryMarker(command)) {
    return {
      blocked: true,
      reason: 'self-heal workers may not remove or override protected model-routing or guard boundary markers',
    };
  }
  if (wrapperPath && !trustedCodexWrapper) {
    return {
      blocked: true,
      reason: 'self-heal workers may only launch Codex through the protected coordinator wrapper',
    };
  }
  if (trustedCodexWrapper && /\s--operation-file(?:\s|=)/i.test(String(command || ''))) {
    return {
      blocked: true,
      reason: 'self-heal workers may not use operation-file mode through the routed Codex wrapper',
    };
  }
  if (mentionsProtectedRoot(command, roots) && hasShellWriteEffect(command) && !trustedCodexWrapper) {
    return {
      blocked: true,
      reason: 'self-heal workers may not write to coordinator-owned or protected roots from Bash',
    };
  }
  if (hasShellWriteEffect(command) && mentionsParentTraversal(command)) {
    return {
      blocked: true,
      reason: 'self-heal Bash writes may not traverse outside the worker checkout',
    };
  }
  if (hasShellWriteEffect(command)) {
    const outside = absolutePathCandidates(command).filter(
      (candidate) =>
        !isSameOrInside(candidate, workerRoot) &&
        !(trustedCodexWrapper && normalizePath(candidate) === normalizePath(env.SB_SELF_HEAL_ROUTED_CODEX_WRAPPER)) &&
        !/^\/(?:usr\/bin|usr\/local\/bin|bin)\//i.test(normalizePath(candidate)),
    );
    if (outside.length) {
      return {
        blocked: true,
        reason: `self-heal Bash writes may only target the worker checkout; outside path: ${outside[0]}`,
      };
    }
  }
  const reason = isWorkerForbiddenCommand(command, roots, { trustedCodexWrapper });
  return reason ? { blocked: true, reason } : { blocked: false, reason: 'allowed' };
}

// Self-heal workers MUST fix the defect inline. Spawning a background sub-agent
// (Task/Agent) or backgrounding a Bash command detaches the work from the worker
// session: the executor then sees a task_started / backgroundTaskId, cannot
// track the detached work to completion inside the budget, and escalates the
// heal as an executor-fault. That is the observed 0-cleared / "claude started a
// nested background task inside a self-heal worker" failure. The worker prompt
// already forbids this; this is the mechanical hook enforcement of that rule so a
// fixable defect actually clears instead of faulting.
function isWorkerBackgroundSpawn(name, toolInput = {}) {
  if (/^(Task|Agent)$/i.test(name)) {
    return 'self-heal workers must fix the defect inline; spawning a background Task or sub-agent detaches the fix from this worker and forces an executor-fault escalation (the 0-cleared failure). Do the edit and affected-test run in this session.';
  }
  if ((!name || /^Bash$/i.test(name)) && toolInput && toolInput.run_in_background === true) {
    return 'self-heal workers must run commands in the foreground; backgrounding detaches work the executor cannot track to completion within the heal budget. Run it inline.';
  }
  return '';
}

function evaluateSelfHealWorkerTool({ toolName, toolInput = {}, env = {} } = {}) {
  const name = String(toolName || '');
  const backgroundReason = isWorkerBackgroundSpawn(name, toolInput);
  if (backgroundReason) {
    return { blocked: true, reason: backgroundReason };
  }
  if (!name || /^(Bash|shell_command|exec_command|unified_exec)$/i.test(name)) {
    return evaluateSelfHealWorkerCommand({ command: toolInput.command || '', env });
  }
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(name)) {
    const filePath = toolInput.file_path || toolInput.notebook_path || '';
    if (!pathIsAllowedWorkerWrite(filePath, env)) {
      return {
        blocked: true,
        reason: 'self-heal workers may only edit files inside their worker checkout',
      };
    }
  }
  if (/^(Read|Grep|Glob|Write|Edit|MultiEdit|NotebookEdit|apply_patch|view_image|web)$/i.test(name)) {
    return { blocked: false, reason: 'allowed' };
  }
  return {
    blocked: true,
    reason: `self-heal worker guard does not recognize tool ${name || '<empty>'}; fail closed`,
  };
}

module.exports = {
  evaluateSelfHealWorkerTool,
  evaluateSelfHealWorkerCommand,
  isWorkerBackgroundSpawn,
  isWorkerForbiddenCommand,
  invokesRawCodexCli,
  mutatesBriefingCeilingMarker,
  mutatesSelfHealBoundaryMarker,
  opensIndirectProcessLaunchSurface,
  launchesUntrustedNodeScript,
  codexWrapperPathFromCommand,
  invokesTrustedCodexWrapper,
  isAuditedWorkerCommand,
  invokesComputedExecutable,
  pathIsAllowedWorkerWrite,
  mentionsPath,
  mentionsProtectedRoot,
  normalizePath,
  protectedRootsFromEnv,
  absolutePathCandidates,
};
