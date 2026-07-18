/**
 * Regression guard for the 2026-07-18 wallpaper #gap.
 *
 * ExampleCo said "make her a desktop background and email it to her". Amy built the
 * artifact, then drafted the mail signed as ExampleCo and STOPPED to ask permission
 * to send. ExampleCo's correction: "I said send it, I didn't say draft it."
 *
 * independence-guard.sh already existed and was registered, but none of its
 * patterns matched the phrasings actually used ("Say 'send it' and it goes",
 * "I need you to okay the exact words first", "tell me what to change"), so it
 * stayed silent through the whole turn.
 *
 * Category, not literal (feedback_frugal_regression_tests): the guard must fire
 * on RE-ASKING for permission an instruction already ExampleCoed, in whatever
 * phrasing, not on the specific sentence from this incident.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const HOOK = path.join(__dirname, '..', 'scripts', 'claude-hooks', 'independence-guard.sh');

const BASH_CANDIDATES = [
  'C:/PROGRA~1/Git/bin/bash.exe',
  'C:/Program Files/Git/bin/bash.exe',
  'C:/Users/ExampleCod/Desktop/ExampleCo/Dev/Git/usr/bin/bash.exe',
  '/bin/bash',
];
const BASH = BASH_CANDIDATES.find((p) => existsSync(p));

/** Returns true when the guard flagged the text as permission-asking drift. */
function flags(text: string): boolean {
  const out = execFileSync(BASH as string, [HOOK], {
    input: JSON.stringify({ assistant_text: text }),
    encoding: 'utf8',
  });
  return out.includes('systemMessage');
}

describe.skipIf(!BASH)('independence-guard permission-asking detection', () => {
  it('hook script exists', () => {
    expect(existsSync(HOOK)).toBe(true);
  });

  // The exact shapes from the 2026-07-18 incident turn.
  const WALLPAPER_GAP_PHRASINGS = [
    'Say "send it" and it goes, or tell me what to change.',
    'This goes to her from your account, so I need you to okay the exact words first.',
    'The draft, for your approval.',
    'Tell me what to change in the image or the words and I will rework it first.',
    'Confirm and I\'ll send it.',
    'Waiting for your go-ahead before it ships.',
    'Shall I send it now?',
  ];

  it.each(WALLPAPER_GAP_PHRASINGS)('flags re-asked permission: %j', (text) => {
    expect(flags(text)).toBe(true);
  });

  // Pre-existing coverage must not regress.
  const LEGACY_PHRASINGS = [
    'Want me to start on the next one?',
    'Would you like me to continue?',
    'Say the word and I will kick it off.',
    'That one is your call.',
    'This needs your sign-off.',
  ];

  it.each(LEGACY_PHRASINGS)('still flags the original drift family: %j', (text) => {
    expect(flags(text)).toBe(true);
  });

  // Reporting completed work is not permission-asking.
  const CLEAN_REPORTS = [
    'Sent. She has it, confirmed on the SENT message with the attachment.',
    'I fixed the guard, registered it, and the suite is green.',
    'The wallpaper is saved to Pictures and the email went out as Amy.',
    'Two tests were failing, so I rewrote the token regex and both pass now.',
  ];

  it.each(CLEAN_REPORTS)('stays silent on plain completion reports: %j', (text) => {
    expect(flags(text)).toBe(false);
  });
});
