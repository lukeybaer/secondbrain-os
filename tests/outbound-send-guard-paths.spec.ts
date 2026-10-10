/**
 * Top-15 item 2 (2026-10): the outbound send guard covers every path that can
 * reach a person, not only the shell. Category, not literal: Gmail connector
 * sends, browser send actions on mail/messaging pages, and shell commands,
 * with ExampleCo.com refused on all of them; drafts and read-only commands
 * (including a grep that names the guard file, the 2026-10-03 false positive)
 * pass.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const HOOK = path.join(__dirname, '..', 'scripts', 'claude-hooks', 'outbound-send-guard.mjs');
const tmp = mkdtempSync(path.join(tmpdir(), 'osg-paths-'));
const env = {
  ...process.env,
  OUTBOUND_SEND_GUARD_LOG: path.join(tmp, 'guard.log'),
  OUTBOUND_SEND_RECEIPT_DIR: path.join(tmp, 'receipts'),
  OUTBOUND_SEND_GUARD_STATE: path.join(tmp, 'browser.json'),
};
const GMAIL = 'mcp__95753925-88dd-49be-9966-ac7f02537550__';
const SIG = '\n\nAmy\nExecutive Assistant to PRIVATE_NAME\n';

function run(tool_name: string, tool_input: Record<string, unknown>): number {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input }),
    env,
    encoding: 'utf8',
  });
  return r.status ?? -1;
}
const shell = (command: string) => run('Bash', { command });

function writeReceipt(payload: Record<string, unknown>, identity = 'amy'): number {
  const file = path.join(tmp, `payload-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(payload));
  return spawnSync('node', [HOOK, '--receipt', '--payload', file, '--identity', identity], { env }).status ?? -1;
}

describe('ExampleCo.com is refused on every path', () => {
  it('shell', () => {
    expect(shell('AMY_SEND_OK=amy python scripts/send-gmail.py --to someone.fake@ExampleCo.com --subject S --body "Hi' + SIG + '"')).toBe(2);
  });
  it('gmail connector (send_message, reply, forward)', () => {
    for (const t of ['send_message', 'reply', 'forward']) {
      expect(run(GMAIL + t, { to: ['someone.fake@ExampleCo.com'], subject: 'S', body: 'Hi' + SIG, messageId: 'm1' })).toBe(2);
    }
  });
  it('a receipt for an ExampleCo recipient cannot even be written', () => {
    expect(writeReceipt({ to: ['someone.fake@ExampleCo.com'], subject: 'S', body: 'Hi' + SIG })).toBe(2);
  });
  it('browser: typing an ExampleCo address on a mail page, with or without a send click', () => {
    expect(run('mcp__claude-in-chrome__computer', { action: 'type', text: 'someone.fake@ExampleCo.com', action_summary: 'Types the Gmail recipient' })).toBe(2);
    expect(
      run('mcp__Claude_Browser__browser_batch', {
        actions: [
          { name: 'computer', input: { action: 'type', text: 'someone.fake@ExampleCo.com', action_summary: 'Types the Gmail recipient' } },
          { name: 'computer', input: { action: 'left_click', action_summary: 'AMY_SEND_OK=amy Sends the Gmail message' } },
        ],
      }),
    ).toBe(2);
  });
  it('browser: an ExampleCo address is refused even when the page and summary give no messaging signal', () => {
    expect(run('mcp__claude-in-chrome__form_input', { ref: 'ref_1', value: 'someone.fake@ExampleCo.com', action_summary: 'Fills the field' })).toBe(2);
  });
});

describe('gmail connector', () => {
  const msg = { to: ['friend@example.com'], subject: 'Hello', body: 'Hi there.' + SIG };

  it('allows drafts without a receipt', () => {
    expect(run(GMAIL + 'create_draft', msg)).toBe(0);
    expect(run(GMAIL + 'update_draft', msg)).toBe(0);
  });
  it('does not touch the session messenger from another server', () => {
    expect(run('mcp__ccd_session_mgmt__send_message', { message: 'x' })).toBe(0);
  });
  it('blocks a send with no show-draft-first receipt', () => {
    expect(run(GMAIL + 'send_message', msg)).toBe(2);
  });
  it('allows the send once, after a receipt, and only for the exact message', () => {
    expect(writeReceipt(msg)).toBe(0);
    expect(run(GMAIL + 'send_message', { ...msg, body: 'Different.' + SIG })).toBe(2);
    expect(run(GMAIL + 'send_message', msg)).toBe(0);
    expect(run(GMAIL + 'send_message', msg)).toBe(2); // single use
  });
  it('blocks reply or forward with no explicit recipient', () => {
    expect(run(GMAIL + 'reply', { messageId: 'm1', body: 'Hi' + SIG })).toBe(2);
  });
  it('refuses a receipt when the body is signed as ExampleCo under the Amy claim', () => {
    expect(writeReceipt({ ...msg, body: 'Hi,\n\nLove,\nExampleCo\n' })).toBe(2);
  });
});

describe('browser actions', () => {
  beforeEach(() => {
    writeFileSync(env.OUTBOUND_SEND_GUARD_STATE, '{}');
  });
  const nav = (url: string) => run('mcp__claude-in-chrome__navigate', { url });

  it('lets reading and navigation through on a mail page', () => {
    expect(nav('https://mail.google.com/mail/u/0/#inbox')).toBe(0);
    expect(run('mcp__claude-in-chrome__computer', { action: 'left_click', action_summary: 'Opens the Filters menu' })).toBe(0);
    expect(run('mcp__claude-in-chrome__computer', { action: 'screenshot' })).toBe(0);
  });
  it('blocks a send click or Ctrl+Enter on mail and LinkedIn without the token', () => {
    expect(nav('https://mail.google.com/mail/u/0/#inbox')).toBe(0);
    expect(run('mcp__claude-in-chrome__computer', { action: 'left_click', action_summary: 'Sends the drafted reply' })).toBe(2);
    expect(run('mcp__Claude_Browser__computer', { action: 'key', text: 'ctrl+Return', action_summary: 'Submits' })).toBe(2);
    expect(nav('https://www.linkedin.com/messaging/')).toBe(0);
    expect(run('mcp__claude-in-chrome__computer', { action: 'key', text: 'Enter', action_summary: 'Presses Enter' })).toBe(2);
  });
  it('allows the same send with the token in action_summary', () => {
    expect(nav('https://mail.google.com/mail/u/0/#inbox')).toBe(0);
    expect(run('mcp__claude-in-chrome__computer', { action: 'left_click', action_summary: 'AMY_SEND_OK=amy Sends the drafted reply' })).toBe(0);
  });
  it('ignores send-looking clicks on unrelated sites', () => {
    expect(nav('https://example.com/form')).toBe(0);
    expect(run('mcp__claude-in-chrome__computer', { action: 'left_click', action_summary: 'Submits the search form' })).toBe(0);
  });
});

describe('shell parsing', () => {
  it('a read-only grep that mentions the guard file passes, even after cd', () => {
    expect(shell(`cd ${path.dirname(HOOK)} && grep -n "ExampleCo" outbound-send-guard.mjs`)).toBe(0);
    expect(shell(`grep -rn "send" "${HOOK}" | head -5`)).toBe(0);
    expect(shell(`cat "${HOOK}"`)).toBe(0);
  });
  it('a send chained after a read-only segment is still caught', () => {
    expect(shell('cd scripts && python send-gmail.py data/outbound/x/')).toBe(2);
    expect(shell(`cat "${HOOK}" | python -`)).toBe(2);
  });
  it('command substitution inside a read-only segment is not exempt', () => {
    expect(shell('echo $(python send-prd-email.py)')).toBe(2);
  });
  it('registered in the manifest for the Gmail and browser tool names', () => {
    const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', 'scripts', 'claude-hooks', 'hook-boundary-manifest.json'), 'utf8'));
    const matchers: string[] = [];
    JSON.stringify(manifest, (_k, v) => {
      if (v && typeof v === 'object' && typeof v.matcher === 'string' && JSON.stringify(v).includes('outbound-send-guard')) matchers.push(v.matcher);
      return v;
    });
    const hit = (name: string) => matchers.some((m) => new RegExp(m).test(name));
    expect(hit(GMAIL + 'send_message')).toBe(true);
    expect(hit(GMAIL + 'forward')).toBe(true);
    expect(hit(GMAIL + 'create_draft')).toBe(false);
    expect(hit('mcp__ccd_session_mgmt__send_message')).toBe(false);
    expect(hit('mcp__claude-in-chrome__computer')).toBe(true);
    expect(hit('mcp__Claude_Browser__browser_batch')).toBe(true);
  });
});
