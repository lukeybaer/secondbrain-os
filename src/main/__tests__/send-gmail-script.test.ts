// send-gmail-script.test.ts
//
// Smoke test for scripts/send-gmail.py. Catches regressions where a
// PII scrub or similar refactor leaves the script in a non-runnable
// state (hardcoded placeholder sender, un-expanded shell syntax in
// a Python string literal, missing threading support, etc).
//
// Root cause this test prevents: 2026-04-11 PII scrub (commit 2f94cce)
// replaced SENDER_ADDRESS with "owner@example.com" and set
// APP_PASSWORD_FILE to Path(r"${USERPROFILE:-~}/.secrets/gmail_app_password.txt"),
// a literal Python string that Python does not shell-expand. The script
// silently became unrunnable. No test caught it because no test ran the
// script. Discovered manually on 2026-04-15 when Amy tried to send an
// email and had to fall back to the Gmail API. This test runs the script
// in a smoke-test mode that imports it and validates config paths + the
// threading header support, so any future scrub that breaks runnability
// fails the test before the commit leaves the machine.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'send-gmail.py');

// Python one-liner that imports the script, dumps config, builds a
// test message with threading headers, and prints the results as JSON.
// Runs with a fake sender in env so it works even on a machine with
// no ~/.secrets/gmail_sender.txt.
const PROBE = `
import sys, os, json, importlib.util
os.environ['GMAIL_SENDER'] = 'probe@example.com'
os.environ['GMAIL_APP_PASSWORD'] = 'x' * 16
spec = importlib.util.spec_from_file_location('send_gmail', r'${SCRIPT.replace(/\\/g, '\\\\')}')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
payload = {
    'to': 'test@example.com',
    'subject': 'test',
    'body': 'hello',
    'in_reply_to': '<abc@example.com>',
    'references': '<abc@example.com>',
    'reply_to': 'reply@example.com',
}
msg = mod.build_message(payload, mod.load_sender())
result = {
    'secrets_dir': str(mod.SECRETS_DIR),
    'app_password_file': str(mod.APP_PASSWORD_FILE),
    'sender_file': str(mod.SENDER_FILE),
    'sender_loaded': mod.load_sender(),
    'password_length': len(mod.load_app_password()),
    'smtp_host': mod.SMTP_HOST,
    'smtp_port': mod.SMTP_PORT,
    'msg_from': str(msg['From']),
    'msg_to': str(msg['To']),
    'msg_subject': str(msg['Subject']),
    'msg_in_reply_to': str(msg['In-Reply-To']),
    'msg_references': str(msg['References']),
    'msg_reply_to': str(msg['Reply-To']),
}
print(json.dumps(result))
`;

function runProbe(): Record<string, ExampleCo> {
  const out = execFileSync('python', ['-c', PROBE], {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim());
}

describe('send-gmail.py script integrity', () => {
  it('imports without crashing', () => {
    // If this throws, the script is broken at import time (syntax error,
    // bad Path literal, missing dependency, etc).
    expect(() => runProbe()).not.toThrow();
  });

  it('resolves config paths to absolute filesystem paths (no un-expanded shell syntax)', () => {
    const probe = runProbe();
    // Catches the 2026-04-11 regression where APP_PASSWORD_FILE was
    // Path(r"${USERPROFILE:-~}/.secrets/gmail_app_password.txt") -- a
    // literal string Python does not shell-expand. Here we assert the
    // resolved path contains no ${} template syntax and is absolute.
    for (const key of ['secrets_dir', 'app_password_file', 'sender_file']) {
      const p = probe[key] as string;
      expect(p).toBeTruthy();
      expect(p).not.toContain('${');
      expect(p).not.toContain('~');
      expect(path.isAbsolute(p)).toBe(true);
    }
  });

  it('loads sender from env var without hardcoded PII', () => {
    const probe = runProbe();
    // Catches the 2026-04-11 regression where SENDER_ADDRESS was
    // hardcoded to a placeholder "owner@example.com" that would fail
    // at SMTP login. Here we pass a fake sender via env and verify
    // the script honors it rather than falling back to a placeholder.
    expect(probe.sender_loaded).toBe('probe@example.com');
  });

  it('builds messages with threading headers (In-Reply-To + References)', () => {
    const probe = runProbe();
    // Catches the original gap: the script only supported flat sends,
    // no thread-reply support, which broke for any reply flow and
    // forced Amy to fall back to the Gmail API.
    expect(probe.msg_in_reply_to).toBe('<abc@example.com>');
    expect(probe.msg_references).toBe('<abc@example.com>');
    expect(probe.msg_reply_to).toBe('reply@example.com');
    expect(probe.msg_from).toBe('probe@example.com');
  });

  it('uses standard Gmail SMTP endpoint', () => {
    const probe = runProbe();
    expect(probe.smtp_host).toBe('smtp.gmail.com');
    expect(probe.smtp_port).toBe(587);
  });
});
