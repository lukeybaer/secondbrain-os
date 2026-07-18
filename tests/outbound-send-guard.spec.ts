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

  /**
   * 2026-07-18 gap: ExampleCo said "email it to her". Amy drafted the mail signed
   * "Love, ExampleCo" by default, which tripped the exact-text-approval rule and
   * converted an execute instruction into a request for permission. Root cause
   * was the identity default, so the identity default is what gets enforced.
   *
   * Category, not literal: any sign-off shape that reads as ExampleCo alone, in any
   * payload the command references, under an AMY_SEND_OK=amy claim.
   */
  describe('identity verification under AMY_SEND_OK=amy', () => {
    function payloadDir(body: string): string {
      const dir = mkdtempSync(path.join(tmpdir(), 'osg-body-'));
      writeFileSync(
        path.join(dir, 'msg.json'),
        JSON.stringify({ to: 'a@b.com', subject: 'S', body }),
      );
      return dir;
    }

    const ExampleCo_SIGNOFFS = [
      'Hi there,\n\nSome content.\n\nLove,\nExampleCo\n',
      'Hi there,\n\nSome content.\n\nThanks,\nExampleCo\n',
      'Hi there,\n\nSome content.\n\n- ExampleCo\n',
      'Hi there,\n\nSome content.\n\nExampleCo\n',
      'Hi there,\n\nSome content.\n\nBest,\nExampleCo\n',
    ];

    it.each(ExampleCo_SIGNOFFS)('blocks a ExampleCo-signed body claiming Amy identity: %j', (body) => {
      const dir = payloadDir(body);
      expect(runHook(`AMY_SEND_OK=amy python scripts/send-gmail.py "${dir}"`)).toBe(2);
    });

    it('allows the same body when ExampleCo actually approved the exact text', () => {
      const dir = payloadDir(ExampleCo_SIGNOFFS[0]);
      expect(runHook(`AMY_SEND_OK=ExampleCo-approved python scripts/send-gmail.py "${dir}"`)).toBe(0);
    });

    it('allows genuine Amy sign-offs', () => {
      for (const body of [
        'Hi,\n\nContent.\n\nAmy\n(ExampleCo ExampleCo\'s assistant)\n',
        'Hi,\n\nContent.\n\nThanks,\nExampleCo (via Amy)\n',
      ]) {
        expect(runHook(`AMY_SEND_OK=amy python scripts/send-gmail.py "${payloadDir(body)}"`)).toBe(0);
      }
    });

    it('does not mistake a mid-body mention of ExampleCo for a signature', () => {
      const body = 'Hi,\n\nExampleCo asked me to send this over.\nExampleCo is travelling this week.\n\nAmy\n';
      expect(runHook(`AMY_SEND_OK=amy python scripts/send-gmail.py "${payloadDir(body)}"`)).toBe(0);
    });

    it('catches a ExampleCo-signed body passed inline via --body', () => {
      expect(
        runHook('AMY_SEND_OK=amy python scripts/send-gmail.py --to a@b.com --subject S --body "Hey,\n\nStuff.\n\nLove,\nExampleCo\n"'),
      ).toBe(2);
    });
  });

  /**
   * This box is PowerShell-primary. The original token regex only matched the
   * bash prefix form, so the real send on 2026-07-18 ExampleCod a PowerShell
   * attestation the guard could not see.
   */
  it('recognises the PowerShell attestation form', () => {
    expect(
      runHook("$env:AMY_SEND_OK = 'amy'; python scripts/send-gmail.py data/outbound/x/", 'PowerShell'),
    ).toBe(0);
    expect(
      runHook('$env:AMY_SEND_OK = "ExampleCo-approved"; python scripts/send-gmail.py x/', 'PowerShell'),
    ).toBe(0);
    expect(
      runHook("$env:AMY_SEND_OK = 'maybe'; python scripts/send-gmail.py x/", 'PowerShell'),
    ).toBe(2);
  });

  it('ignores unrelated commands', () => {
    expect(runHook('git status')).toBe(0);
    expect(runHook('python scripts/sb-session-search.py search "email"')).toBe(0);
    expect(runHook('grep -r "smtplib is neat" docs/')).toBe(0);
  });

  it('read-only views of sender code are allowed, but piping into an interpreter is not', () => {
    expect(runHook('cat scripts/send-gmail.py')).toBe(0);
    expect(runHook('git log --oneline -- scripts/send-gmail.py')).toBe(0);
    expect(runHook('cat sender.txt | python - "import smtplib"')).toBe(2);
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
