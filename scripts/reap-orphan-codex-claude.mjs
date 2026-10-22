#!/usr/bin/env node
// reap-orphan-codex-claude.mjs
//
// 2026-06-10 incident (feedback_codex_orphan_leak_thrashes_briefing.md): leaked
// codex/claude grandchild process trees (spawned `cmd.exe /c codex|claude ...`
// whose cmd.exe parent was killed without tree-kill) accumulated to 259 codex +
// 30 claude deadlocked-on-stdin processes that thrashed the box, so Bedrock's
// first call timed out and the briefing shipped 4h late.
//
// heal-executor.js now tree-kills at the source, but this reaper is the belt to
// that suspenders: it sweeps any dead-parent codex/claude WORKER orphans that
// still leak (crashes, OOM-killed parents, other spawn sites). Run it BEFORE
// every briefing build (wired into the pre-briefing chain) so a quiet-looking
// box is actually clean before Bedrock is asked to summarize.
//
// SAFETY: only kills processes whose PARENT IS DEAD (ParentProcessId not in the
// live pid set). Interactive Claude Code sessions have a LIVE parent (the
// harness/terminal), so they are never touched. It also excludes its own pid
// and ancestor chain. Windows-only reaping (the leak is the cmd.exe grandchild
// pattern); on other platforms it is a no-op.
//
// Flags: --dry-run (report only, kill nothing).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry-run');
const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const LOG = path.join(REPO, 'data', 'agent', 'orphan-reaper.log');

function logLine(obj) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
  } catch {
    /* logging is best-effort */
  }
}

// Must MATCH: the leaked-worker command-line signatures, i.e. the codex/claude
// CLI invocations the heal-executor + news repair spawn as `cmd.exe /c codex
// exec ...` / `cmd.exe /c claude ...`, plus the briefing spawners themselves.
const REAP_RE =
  /(\bcodex\b[^|]*\bexec\b|codex\.js|cmd\.exe[^|]*\bcodex\b|cmd\.exe[^|]*\bclaude\b|claude\.cmd|refresh-news-only|heal-executor|content-heal)/i;
// Must NOT match: the Codex/Claude DESKTOP apps, crashpad/renderer children,
// long-running watcher daemons, and the EC2/server processes. These can also be
// dead-parent (launcher exited) yet must never be reaped.
const EXCLUDE_RE =
  /WindowsApps|Codex\.exe|Claude\.exe|crashpad|--type=|electron|gmail-amy-scan|otter-ingest|dispatch-processor|youtube-auth|--watch|spine-session|server\.js|claude-proxy/i;

function getProcs() {
  // PowerShell: emit PID|PPID|CommandLine for node/codex/claude. CommandLine
  // pipes/newlines are squashed to spaces so the delimiter stays clean.
  const ps =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|codex|claude' } | " +
    "ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, ($_.CommandLine -replace '[\\r\\n|]',' ') }";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error('powershell enumerate failed: ' + (r.stderr || '').slice(0, 200));
  return (r.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [pid, ppid, ...rest] = l.split('|');
      return { pid: Number(pid), ppid: Number(ppid), cmd: rest.join('|') };
    })
    .filter((p) => Number.isFinite(p.pid));
}

function alivePidSet() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Process | Select-Object -ExpandProperty Id'], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const set = new Set();
  (r.stdout || '').split(/\r?\n/).forEach((l) => {
    const n = Number(l.trim());
    if (Number.isFinite(n)) set.add(n);
  });
  return set;
}

function treeKill(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
}

function main() {
  if (process.platform !== 'win32') {
    console.log('[reaper] non-Windows: no-op');
    return;
  }
  const me = process.pid;
  let procs, alive;
  try {
    procs = getProcs();
    alive = alivePidSet();
  } catch (e) {
    console.error('[reaper] enumerate failed:', e.message);
    logLine({ event: 'enumerate-failed', error: e.message });
    process.exit(1);
  }
  const selfChain = new Set([me]);
  // walk up our own ancestry so we never reap ourselves or our launcher
  let cur = me;
  for (let i = 0; i < 12; i++) {
    const p = procs.find((x) => x.pid === cur);
    if (!p) break;
    selfChain.add(p.ppid);
    cur = p.ppid;
  }

  const orphans = procs.filter(
    (p) =>
      !alive.has(p.ppid) && // PARENT IS DEAD
      !selfChain.has(p.pid) && // not us / our ancestry
      REAP_RE.test(p.cmd || '') && // matches a leaked codex/claude CLI worker
      !EXCLUDE_RE.test(p.cmd || ''), // and is NOT a desktop app / watcher daemon
  );

  console.log(`[reaper] ${procs.length} node/codex/claude procs, ${orphans.length} dead-parent worker orphans${DRY ? ' (dry-run)' : ''}`);
  let killed = 0;
  for (const o of orphans) {
    const tag = `pid=${o.pid} ppid=${o.ppid}(dead) ${(o.cmd || '').slice(0, 90)}`;
    if (DRY) {
      console.log('  would reap: ' + tag);
      continue;
    }
    try {
      treeKill(o.pid);
      killed++;
      console.log('  reaped: ' + tag);
    } catch (e) {
      console.warn('  reap failed: ' + tag + ' -> ' + e.message);
    }
  }
  logLine({ event: DRY ? 'dry-run' : 'reap', total: procs.length, orphans: orphans.length, killed });
  if (!DRY) console.log(`[reaper] reaped ${killed} orphan(s)`);
}

// Pure classifier, exported for tests: would this command line be reaped IF its
// parent were dead? (The dead-parent check is environmental and tested live.)
export function shouldReap(cmd) {
  const c = String(cmd || '');
  return REAP_RE.test(c) && !EXCLUDE_RE.test(c);
}
export { REAP_RE, EXCLUDE_RE };

// Only sweep when run directly, not when imported by a test.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('reap-orphan-codex-claude.mjs')) {
  main();
}
