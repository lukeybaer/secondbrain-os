'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  isTerminalOvernightRun,
  readLatestValidOvernightRun,
} = require('./briefing-run-window.js');

const POLICY_MARKER = '[watcher-command-guard]';
const BLOCKED_CONTROL_TOOLS = /^(?:Task|Agent|CronCreate|CronDelete|RemoteTrigger|Skill|EnterWorktree|ExitWorktree)$/i;
const SHELL_TOOLS = /^(?:Bash|shell|exec|unified_exec|code_mode_exec)$/i;

function normalizePath(value) {
  let out = String(value || '')
    .replace(/\\/g, '/')
    .trim();
  const msys = out.match(/^\/([a-zA-Z])\/(.*)$/);
  if (msys) out = `${msys[1]}:/${msys[2]}`;
  if (/^[a-zA-Z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1);
  return out.replace(/\/+$/, '');
}

function canonicalPath(value) {
  const absolute = path.resolve(normalizePath(value));
  let cursor = absolute;
  const missing = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  let resolved = cursor;
  try {
    resolved = fs.realpathSync.native(cursor);
  } catch {
    resolved = path.resolve(cursor);
  }
  return normalizePath(path.join(resolved, ...missing));
}

function isSameOrInside(candidate, root) {
  const c = canonicalPath(candidate).toLowerCase();
  const r = canonicalPath(root).toLowerCase();
  return Boolean(c && r && (c === r || c.startsWith(`${r}/`)));
}

function isProtectedSessionControlPath(candidate, root) {
  if (!candidate || !root || !isSameOrInside(candidate, root)) return false;
  const normalizedCandidate = canonicalPath(candidate).toLowerCase();
  const normalizedRoot = canonicalPath(root).toLowerCase();
  const relative = normalizedCandidate.slice(normalizedRoot.length).replace(/^\/+/, '');
  const first = relative.split('/')[0];
  return new Set(['.git', '.codex', '.claude', '.mcp.json', 'agents.md', 'claude.md']).has(first);
}

function shellSegments(command) {
  return String(command || '')
    .split(/(?:&&|\|\||[|;&\r\n`]|\$\()/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function reportClauses(command) {
  return shellSegments(command).filter((clause) =>
    /(?:scripts[\\/])?overnight-watch-report\.js\b/i.test(clause),
  );
}

function safeReportControlCall(clause) {
  return /(?:^|\s)--(?:status|freeze-red-roster|observation-kind)(?:\s|$)/i.test(clause);
}

function terminalOvernightRun(env, nowMs, readTerminalRun = readLatestValidOvernightRun) {
  const dataDir = String(env.SB_WATCHER_DATA_DIR || '').trim();
  const date = String(env.BRIEFING_DATE || '').slice(0, 10);
  if (!dataDir || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  // Ask for the newest eligible run, then require THAT run to be terminal.
  // Asking the shared reader for `requireTerminal:true` can skip a newer
  // running retry and return an older same-date terminal receipt.
  const latest = readTerminalRun({ dataDir, date, requireTerminal: false, nowMs });
  if (!latest) return null;
  return isTerminalOvernightRun(latest, nowMs) ? latest : null;
}

function reportSynthesisBlocked(
  command,
  env = {},
  nowMs = Date.now(),
  readTerminalRun = readLatestValidOvernightRun,
) {
  const unsafe = reportClauses(command).find((clause) => !safeReportControlCall(clause));
  if (!unsafe) return '';
  const notBeforeMs = Number(env.SB_WATCHER_REPORT_NOT_BEFORE_MS || 0);
  if (!Number.isFinite(notBeforeMs) || notBeforeMs <= 0) {
    return 'final report synthesis is fail-closed until the launcher supplies the 05:00 CT reconciliation boundary';
  }
  if (nowMs < notBeforeMs) {
    return 'final report synthesis is blocked during the repair window; inspect status or record an observation instead';
  }
  return '';
}

function regexEscape(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeCliCommandReason(command, env = {}) {
  const helper = normalizePath(env.SB_WATCHER_SAFE_CLI || '');
  if (!helper) return 'watcher shell access is fail-closed until the safe helper is pinned';
  const quotedHelper = `"${helper}"`;
  const prefix = `/usr/bin/node ${quotedHelper} `;
  const allowed = new RegExp(
    `^${regexEscape(prefix)}(?:` +
      `snapshot|git-status|git-diff|` +
      `sleep (?:[1-9]|[1-5][0-9]|60)|` +
      `submit-observation \\.watcher-requests/[A-Za-z0-9._-]+\\.json` +
      `)$`,
  );
  return allowed.test(String(command || '').trim())
    ? ''
    : 'the watcher shell is restricted to one exact watcher-safe-cli operation';
}

function broadHostDiagnosticReason(command) {
  const cmd = String(command || '');
  if (/\bps\s+(?:aux|axu?|axo\b|-[a-z]*[ae][a-z]*f?)\b/i.test(cmd)) {
    return 'broad process-table enumeration is blocked; inspect an exact known PID with ps -p';
  }
  if (/\b(?:top|htop)\b/i.test(cmd) || /\bGet-Process\b(?![^\r\n|;]*-Name)/i.test(cmd)) {
    return 'whole-host process enumeration is blocked; inspect an exact process identity';
  }
  if (
    /\bfind\s+(?:["']?(?:\/|\/opt|\/tmp|\/home|~|\$HOME)(?:["']?\s|["']?$))/i.test(cmd) ||
    /\bls\s+-[a-z]*r[a-z]*\s/i.test(cmd) ||
    /\brg\s+--files\s+(?:\/|\/opt|\/tmp|\/home)\b/i.test(cmd) ||
    /\bGet-ChildItem\b[^\r\n|;]*\b-Recurse\b/i.test(cmd)
  ) {
    return 'broad filesystem enumeration is blocked; use one exact dated evidence directory or file';
  }
  if (/\bdu\b[^\r\n|;]*(?:\s\/\s|\s\/opt(?:\s|$)|\s\/tmp(?:\s|$)|\s\/home(?:\s|$))/i.test(cmd)) {
    return 'broad disk enumeration is blocked; inspect one exact known path';
  }
  if (/\bsed\s+-n\s+["']?1,(?:[1-9]\d{3,}|\$)p["']?/i.test(cmd)) {
    return 'unbounded file dumping is blocked; request a narrow line range or exact pattern';
  }
  return '';
}

function persistentWorkReason(command, toolInput = {}) {
  const cmd = String(command || '');
  if (toolInput.run_in_background === true) {
    return 'the watcher may not detach background work; run a bounded foreground command';
  }
  if (
    /(?:^|[;&]\s*)nohup\b/i.test(cmd) ||
    /\bsleep\s+/i.test(cmd) ||
    /(?:^|\s)watch\s+/i.test(cmd) ||
    /\btail\b[^\r\n|;]*(?:\s-f\b|--follow\b)/i.test(cmd) ||
    /watch-watcher-interventions\.js\b[^\r\n|;]*--follow\b/i.test(cmd) ||
    cmd.replace(/&&/g, '').includes('&')
  ) {
    return 'persistent or detached follower commands are blocked; use bounded status reads and exact log tails';
  }
  return '';
}

const SAFE_SOURCE_INSPECTION =
  /^(?:cat|head|tail|stat|wc|ls|rg|grep|jq|Get-Content|Select-String|Test-Path)(?:\s|$)|^sed\s+-n(?:\s|$)|^git\s+(?:diff|show|status|log)(?:\s|$)/i;

function unsafeProtectedMention(command, pattern) {
  return shellSegments(command).find((segment) => {
    if (!pattern.test(segment)) return false;
    pattern.lastIndex = 0;
    if (/\$\(|`|\beval\b|\b(?:bash|sh|zsh)\s+-[lc]*c\b/i.test(segment)) return true;
    return !SAFE_SOURCE_INSPECTION.test(segment);
  });
}

function coordinatorOwnershipReason(
  command,
  env = {},
  nowMs = Date.now(),
  readTerminalRun = readLatestValidOvernightRun,
) {
  const cmd = String(command || '');
  if (unsafeProtectedMention(cmd, /(?:scripts[\\/])?card-controller\.js\b/i)) {
    return 'the automated watcher may not launch another card controller while the canonical controller owns the night';
  }
  if (
    unsafeProtectedMention(
      cmd,
      /(?:scripts[\\/])?verify-(?:briefing|dashboard)-cards-live\.js\b/i,
    ) ||
    /\bnpm\s+run\s+verify:(?:briefing|dashboard)-cards\b/i.test(cmd)
  ) {
    return 'the automated watcher may not launch whole-board live QC; read the canonical controller artifact';
  }
  if (
    unsafeProtectedMention(
      cmd,
      /(?:scripts[\\/])?(?:cloud-morning-briefing|overnight-briefing-orchestrator)\.js\b/i,
    )
  ) {
    return 'the automated watcher may not launch a second briefing producer or orchestrator';
  }
  if (
    unsafeProtectedMention(
      cmd,
      /(?:scripts[\\/])?(?:deploy-ec2-server|ec2-sync-build-path)\.sh\b/i,
    ) &&
    !terminalOvernightRun(env, nowMs, readTerminalRun)
  ) {
    return 'the automated watcher may not swap the production runtime while the canonical overnight controller is nonterminal';
  }
  return '';
}

function hasShellWriteEffect(command) {
  const cmd = String(command || '');
  return (
    /(?:^|[;&|]\s*)(?:rm|rmdir|mv|cp|touch|mkdir|install|tee|truncate|chmod|chown|sed\s+-i|perl\s+-i|python\d*\b|node\b)/i.test(
      cmd,
    ) || /(^|[^>])>{1,2}(?!>)/.test(cmd)
  );
}

function absolutePathCandidates(command) {
  const out = [];
  const rx = /(?:^|[\s'"=>(])([A-Za-z]:[\\/][^\s'";|]+|\/(?!\/)[^\s'";|]+)/g;
  for (const match of String(command || '').matchAll(rx)) {
    out.push(String(match[1] || '').replace(/[),]+$/, ''));
  }
  return out;
}

function isSafeBoundedReadControl(segment) {
  return /(?:scripts[\\/])?watch-watcher-interventions\.js\b[^|;&\r\n]*--once\b/i.test(
    String(segment || ''),
  );
}

function withoutNullDeviceRedirections(command) {
  // A read-only diagnostic commonly suppresses an expected missing-file error.
  // Do not mistake that shell plumbing for a mutation of every absolute path
  // mentioned by the command. Other redirections remain write effects.
  return String(command || '').replace(/(?:^|\s)\d*(?:>>?|<)\s*(?:\/dev\/null|NUL)(?=\s|$)/gi, ' ');
}

function shellWriteBoundaryReason(command, env = {}) {
  const cmd = String(command || '');
  const root = env.SB_WATCHER_SESSION_ROOT;
  for (const segment of shellSegments(cmd)) {
    const effectiveSegment = withoutNullDeviceRedirections(segment);
    if (!hasShellWriteEffect(effectiveSegment)) continue;
    // Report timing/ownership is checked immediately before this boundary.
    // The report CLI and the bounded intervention-feed reader are the only
    // intentional canonical-data writers/readers exposed to the model.
    if (reportClauses(segment).length || isSafeBoundedReadControl(segment)) continue;
    if (/(?:^|[\s'"=])\.\.(?:[\\/]|$)/.test(effectiveSegment)) {
      return 'shell writes may not traverse outside the isolated watcher worktree';
    }
    if (!root) return 'watcher shell writes are fail-closed until the isolated worktree is pinned';
    const outside = absolutePathCandidates(effectiveSegment).find(
      (candidate) =>
        !isSameOrInside(candidate, root) &&
        !/^\/(?:usr\/bin|usr\/local\/bin|bin)\//i.test(normalizePath(candidate)),
    );
    if (outside) {
      return `watcher shell writes may only target the isolated worktree; outside path: ${outside}`;
    }
  }
  return '';
}

function evaluateWatcherCommand({
  command,
  toolInput = {},
  env = {},
  nowMs = Date.now(),
  readTerminalRun = readLatestValidOvernightRun,
} = {}) {
  const cmd = String(command || '');
  if (!cmd.trim()) return { blocked: false, reason: 'allowed' };
  const reason =
    persistentWorkReason(cmd, toolInput) ||
    coordinatorOwnershipReason(cmd, env, nowMs, readTerminalRun) ||
    reportSynthesisBlocked(cmd, env, nowMs, readTerminalRun) ||
    broadHostDiagnosticReason(cmd) ||
    shellWriteBoundaryReason(cmd, env);
  return reason ? { blocked: true, reason } : { blocked: false, reason: 'allowed' };
}

function evaluateWatcherTool({
  toolName,
  toolInput = {},
  env = {},
  nowMs = Date.now(),
  readTerminalRun = readLatestValidOvernightRun,
} = {}) {
  const name = String(toolName || '');
  if (BLOCKED_CONTROL_TOOLS.test(name)) {
    return {
      blocked: true,
      reason: 'the watcher may not delegate, schedule, trigger, or change its execution boundary',
    };
  }
  if (!name || SHELL_TOOLS.test(name)) {
    const reason = safeCliCommandReason(toolInput.command || '', env);
    return reason ? { blocked: true, reason } : { blocked: false, reason: 'allowed' };
  }
  if (/^apply_patch$/i.test(name)) {
    return { blocked: true, reason: 'apply_patch is unavailable to the automated watcher' };
  }
  if (/^(?:Write|Edit|MultiEdit|NotebookEdit)$/i.test(name)) {
    const target = toolInput.file_path || toolInput.notebook_path || '';
    const runtimeRoot = env.SB_WATCHER_RUNTIME_HOME || '';
    if (
      !target ||
      !env.SB_WATCHER_SESSION_ROOT ||
      !isSameOrInside(target, env.SB_WATCHER_SESSION_ROOT) ||
      isProtectedSessionControlPath(target, env.SB_WATCHER_SESSION_ROOT) ||
      (runtimeRoot && isSameOrInside(target, runtimeRoot))
    ) {
      return {
        blocked: true,
        reason: 'watcher edits are restricted to the isolated nightly worktree',
      };
    }
  }
  if (/^(?:Read|Grep|Glob)$/i.test(name)) {
    const target = toolInput.file_path || toolInput.path || '';
    if (/^Read$/i.test(name) && !target) {
      return { blocked: true, reason: 'watcher reads require one explicit source or worktree path' };
    }
    if (
      /^Glob$/i.test(name) &&
      !target &&
      (String(toolInput.pattern || '').startsWith('/') ||
        /^[A-Za-z]:/.test(String(toolInput.pattern || '')) ||
        String(toolInput.pattern || '')
          .replace(/\\/g, '/')
          .split('/')
          .includes('..'))
    ) {
      return { blocked: true, reason: 'watcher glob patterns may not escape the worktree' };
    }
    if (target) {
      const allowedRoots = [
        env.SB_WATCHER_SESSION_ROOT,
        env.SB_WATCHER_GUARD_SOURCE_ROOT,
      ].filter(Boolean);
      const runtimeRoot = env.SB_WATCHER_RUNTIME_HOME || '';
      if (
        !allowedRoots.some((root) => isSameOrInside(target, root)) ||
        (runtimeRoot && isSameOrInside(target, runtimeRoot))
      ) {
        return { blocked: true, reason: 'watcher reads are restricted to pinned source and worktree roots' };
      }
    }
    return { blocked: false, reason: 'allowed' };
  }
  if (/^(?:Write|Edit|MultiEdit|NotebookEdit)$/i.test(name)) {
    return { blocked: false, reason: 'allowed' };
  }
  return { blocked: true, reason: 'the watcher tool surface is fail-closed' };
}

module.exports = {
  POLICY_MARKER,
  absolutePathCandidates,
  broadHostDiagnosticReason,
  canonicalPath,
  coordinatorOwnershipReason,
  evaluateWatcherCommand,
  evaluateWatcherTool,
  isSameOrInside,
  isProtectedSessionControlPath,
  persistentWorkReason,
  reportSynthesisBlocked,
  safeCliCommandReason,
  safeReportControlCall,
  shellSegments,
  shellWriteBoundaryReason,
  terminalOvernightRun,
  withoutNullDeviceRedirections,
};
