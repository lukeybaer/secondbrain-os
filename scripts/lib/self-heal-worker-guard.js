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
  if (!workerRoot) return true;
  return isSameOrInside(filePath, workerRoot);
}

function isWorkerForbiddenCommand(command, roots = []) {
  const cmd = String(command || '');
  if (!cmd.trim()) return '';
  if (/\bgit\s+worktree\b/i.test(cmd)) {
    return 'self-heal workers may not mutate git worktree registrations';
  }
  if (/\bgit\b[\s\S]*\bpush\b/i.test(cmd)) {
    return 'self-heal workers may not push; the coordinator lands commits';
  }
  if (/\bgit\b[\s\S]*\bcommit\b/i.test(cmd)) {
    return 'self-heal workers may not commit; the coordinator owns git landing';
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
  return '';
}

function evaluateSelfHealWorkerCommand({ command, env = {} } = {}) {
  const roots = protectedRootsFromEnv(env);
  const reason = isWorkerForbiddenCommand(command, roots);
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
  if (!name || name === 'Bash') {
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
  return { blocked: false, reason: 'allowed' };
}

module.exports = {
  evaluateSelfHealWorkerTool,
  evaluateSelfHealWorkerCommand,
  isWorkerBackgroundSpawn,
  isWorkerForbiddenCommand,
  pathIsAllowedWorkerWrite,
  mentionsPath,
  mentionsProtectedRoot,
  normalizePath,
  protectedRootsFromEnv,
};
