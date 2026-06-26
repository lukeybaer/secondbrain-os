// windows-scheduled-tasks-launcher.test.ts
//
// Regression guard for the 2026-04-27 to 2026-05-02 silent-no-op meta-bug.
//
// What happened: commit abb84f2 ("hide node.exe console with VBScript launcher")
// rewrote 15 SecondBrain-* Windows Task Scheduler tasks to invoke wscript.exe
// with `silent-node-launcher.vbs` as their first argument. For 11 of the 15
// tasks the original script-to-run argument was preserved after the launcher.
// For 4 tasks (DailyBackup, HealthSelfHeal, PreBriefingDiagnostic, DailyBriefing)
// the script argument was dropped, so the launcher invoked node.exe with no
// script. Node ran a 0-byte program, exited 0, and Windows Task Scheduler
// recorded LastTaskResult=0 every day. Result: 12 days of dead backups, dead
// self-heal, dead pre-briefing diagnostic. Self-heal could not even surface
// the failure because self-heal itself was one of the broken tasks.
//
// This test enforces two invariants on the launcher script itself:
//
//   1. The .vbs MUST refuse to run when called with zero arguments
//      (so a task like the 4 broken ones surfaces as a non-zero exit
//      instead of silently logging success).
//
//   2. The .vbs MUST handle .bat and .cmd extensions through cmd.exe,
//      not node.exe. The 4 broken tasks all wrap .bat scripts; the
//      original launcher only knew how to invoke node.exe.
//
// We test the launcher script by static analysis (parsing the .vbs source)
// rather than executing wscript. CI runs on Linux where wscript does not
// exist, and the asserts here are about the script contract, not the
// Windows runtime. Source: feedback_scheduled_tasks_must_use_silent_launcher.md.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const LAUNCHER = path.join(REPO_ROOT, 'scripts', 'silent-node-launcher.vbs');
const REGISTER = path.join(REPO_ROOT, 'scripts', 'register-scheduled-tasks.ps1');

describe('silent-node-launcher.vbs (Windows scheduled-task launcher contract)', () => {
  const src = fs.readFileSync(LAUNCHER, 'utf-8');

  it('refuses to run with no script argument (prevents silent no-op meta-bug)', () => {
    // The launcher must guard `WScript.Arguments.Count < 1` and call WScript.Quit
    // with a non-zero exit code. If this guard is missing, the 2026-04-27 bug
    // returns: tasks fire, log success, do nothing.
    expect(src).toMatch(/WScript\.Arguments\.Count\s*<\s*1/);
    // The Quit must be non-zero. Anything 1-255 is fine; 0 would defeat the guard.
    const quitMatch = src.match(/WScript\.Quit\s+(\d+)/);
    expect(quitMatch, 'launcher must include `WScript.Quit <code>` after the no-arg guard').not.toBeNull();
    const exitCode = parseInt(quitMatch![1], 10);
    expect(exitCode, 'no-arg guard must surface as non-zero exit so Task Scheduler reports failure').toBeGreaterThan(0);
  });

  it('dispatches .bat and .cmd through cmd.exe, not node.exe', () => {
    // The 4 tasks broken in 2026-04-27 all wrap .bat files. Sending a .bat to
    // node.exe is a silent no-op (node tries to parse JS and dies), so the
    // launcher must branch on extension.
    expect(src).toMatch(/\.bat/);
    expect(src).toMatch(/\.cmd/);
    expect(src).toMatch(/cmd\.exe\s+\/c/i);
  });

  it('runs hidden (window style 0) so node never flashes a console at ExampleCo', () => {
    // The original commit existed because GmailAmyScan flashed a console every
    // 5 min. Hidden mode is non-negotiable. sh.Run(cmd, 0, ...).
    expect(src).toMatch(/sh\.Run\s*[\s\S]*?,\s*0\s*,/);
  });

  it('sets a stable scheduled-task runtime environment before launch', () => {
    // Auto-regen now runs directly as JS through node.exe, without the .bat
    // PATH shim that produced a cmd.exe child process.
    expect(src).toContain('Set env = sh.Environment("PROCESS")');
    expect(src).toContain('env("PYTHON_EXE") = "C:\\Python314\\python.exe"');
    expect(src).toContain('env("PY_LAUNCHER") = "C:\\Windows\\py.exe"');
    expect(src).toContain('Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe');
  });

  it('waits for the wrapped command and propagates its exit code', () => {
    // sh.Run(..., wait=True) returns the wrapped command exit code. The
    // ORIGINAL launcher used wait=False, which discarded the exit code and
    // hid every wrapped failure as Task Scheduler success. Same class of bug.
    expect(src).toMatch(/sh\.Run\s*\([\s\S]*?,\s*True\s*\)/);
    expect(src).toMatch(/WScript\.Quit\s+exitCode/);
  });
});

describe('register-scheduled-tasks.ps1 (all task actions stay hidden)', () => {
  const src = fs.readFileSync(REGISTER, 'utf-8');

  it('registers skill and bat tasks through the silent launcher, not raw node/cmd/bat actions', () => {
    expect(src).toContain('$launcher = "$root\\scripts\\silent-node-launcher.vbs"');
    expect(src).toContain('wscript.exe `"$launcher`" `"$runner`" `"$SkillName`"');
    expect(src).toContain('wscript.exe `"$launcher`" `"$BatPath`"');
    expect(src).not.toMatch(/\$taskRun\s*=\s*"`"\$node/);
    expect(src).not.toMatch(/\/tr\s+"`"\$BatPath/);
    expect(src).not.toMatch(/\/tr\s+`"\$BatPath/);
  });

  it('keeps the every-minute LinkedIn sender behind the silent launcher contract', () => {
    expect(src).toContain("Bat-Minute-Task 'SecondBrain-LinkedInOutboundSend'");
    expect(src).toContain('linkedin-outbound-send.bat');
    expect(src).toContain('/sc MINUTE');
    expect(src).toContain('/tr $taskRun /sc MINUTE');
  });

  it('keeps the hourly Claude token refresher behind the silent launcher contract', () => {
    expect(src).toContain("Bat-Minute-Task 'SecondBrain-ClaudeTokenRefresh'");
    expect(src).toContain('claude-token-refresh.bat');
  });
});
