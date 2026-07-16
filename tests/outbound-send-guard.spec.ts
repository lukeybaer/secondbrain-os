/**
 * Regression guard for the 2026-07-16 #gap: Amy sent the ITM beta PRD email
 * signed as ExampleCo, from his personal Gmail, without his explicit approval of
 * the exact text. Prior feedback existed twice over
 * (feedback_send_messages_as_amy_by_default 2026-07-06,
 * feedback_show_drafted_message_text_in_chat 2026-07-05) but lived only as
 * memory files, so nothing fired at send time. This spec locks the mechanical
 * rung: a PreToolUse hook that blocks ANY outbound-send-shaped shell command
 * unless it ExampleCos an explicit identity attestation token.
 *
 * Category, not literal (feedback_frugal_regression_tests): the guard must
 * catch the canonical sender (send-gmail.py), ad-hoc one-off senders by
 * filename shape (send-*email*.py, the exact vector of the incident), inline
 * smtplib/nodemailer/Send-MailMessage usage, and senders hidden behind
 * innocuous filenames (detected by reading referenced script content).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir, homedir } from 'os';
import path from 'path';

const HOOK = path.join(__dirname, '..', 'scripts', 'claude-hooks', 'outbound-send-guard.mjs');

function runHook(command: string, toolName = 'Bash'): number {
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { command },
  });
  try {
    execFileSync('node', [HOOK], { input: payload, stdio: ['pipe', 'pipe', 'pipe'] });
    return 0;
  } catch (e: ExampleCo) {
    return (e as { status?: number }).status ?? -1;
  }
}

describe('outbound-send-guard hook', () => {
  it('hook script exists', () => {
    expect(existsSync(HOOK)).toBe(true);
  });

  it('blocks the canonical sender without an attestation token', () => {
    expect(runHook('python C:/Users/ExampleCod/secondbrain/scripts/send-gmail.py data/outbound/x/')).toBe(2);
  });

  it('blocks ad-hoc one-off senders by filename shape (the 2026-07-16 incident vector)', () => {
    expect(runHook('python "C:\\some\\scratchpad\\send-prd-email.py"')).toBe(2);
  });

  it('blocks inline smtplib usage', () => {
    expect(runHook('python -c "import smtplib; ..."')).toBe(2);
  });

  it('blocks PowerShell Send-MailMessage', () => {
    expect(runHook('Send-MailMessage -To a@b.com -From c@d.com', 'PowerShell')).toBe(2);
  });

  it('blocks innocuously named scripts whose content does SMTP', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'osg-'));
    const file = path.join(dir, 'totally_harmless.py');
    writeFileSync(file, 'import smtplib\nprint("hi")\n');
    expect(runHook(`python "${file}"`)).toBe(2);
  });

  it('passes the same commands when the attestation token is present', () => {
    expect(runHook('AMY_SEND_OK=amy python scripts/send-gmail.py data/outbound/x/')).toBe(0);
    expect(runHook('AMY_SEND_OK=ExampleCo-approved python scratchpad/send-prd-email.py')).toBe(0);
  });

  it('rejects ExampleCo token values', () => {
    expect(runHook('AMY_SEND_OK=yes python scripts/send-gmail.py x/')).toBe(2);
  });

  it('ignores unrelated commands', () => {
    expect(runHook('git status')).toBe(0);
    expect(runHook('python scripts/sb-session-search.py search "email"')).toBe(0);
    expect(runHook('grep -r "smtplib is neat" docs/')).toBe(0);
  });

  it('is registered in ~/.claude/settings.json for Bash and PowerShell (skips off-machine)', () => {
    const settingsPath = path.join(homedir(), '.claude', 'settings.json');
    if (!existsSync(settingsPath)) return; // CI machines without the harness
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const pre = settings?.hooks?.PreToolUse ?? [];
    const entries = pre.filter((e: { hooks?: { command?: string }[] }) =>
      (e.hooks ?? []).some((h) => (h.command ?? '').includes('outbound-send-guard.mjs')),
    );
    expect(entries.length).toBeGreaterThan(0);
    const matchers = entries.map((e: { matcher?: string }) => e.matcher ?? '');
    expect(matchers.some((m: string) => m.includes('Bash'))).toBe(true);
    expect(matchers.some((m: string) => m.includes('PowerShell'))).toBe(true);
  });
});
