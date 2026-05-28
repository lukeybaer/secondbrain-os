// Guard helpers for `claude -p` (Claude CLI) invocations used by ec2-server.js
// (Telegram replies) and scripts/process-dispatches.js (dispatch act-now).
//
// Why this exists: when the Claude CLI is not authenticated it prints
// "Not logged in · Please run /login" to STDOUT and exits 0. Callers that
// only check `out.trim()` truthiness or `exitCode === 0` therefore mistake
// that error string for a real answer. ec2-server.js forwarded it straight
// to Luke on Telegram as Amy's reply; process-dispatches.js logged it as a
// successful dispatch act. Both bugs share this root cause.
//
// Extracted to its own module so the detection + env construction can be
// unit-tested without booting ec2-server.js.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Sentinels the Claude CLI prints on auth / quota failure. Matched against
// the first 500 chars of stdout or stderr so a long, legitimate answer that
// merely mentions one of these phrases deep in the body is not misflagged.
const CLI_FAILURE_PATTERNS = [
  /not logged in/i,
  /please run\s*\/login/i,
  /invalid api key/i,
  /authentication[\s_]?error/i,
  /oauth token (?:has )?expired/i,
  /credit balance is too low/i,
  /usage limit reached/i,
  /rate limit exceeded/i,
];

// True when CLI output is an auth/quota failure rather than a real answer.
function isCliFailureOutput(text) {
  if (!text || typeof text !== 'string') return false;
  const head = text.trim().slice(0, 500);
  if (!head) return false;
  return CLI_FAILURE_PATTERNS.some((re) => re.test(head));
}

// Path the Windows token-refresher pushes the Max-plan OAuth access token to.
// Kept in the home dir, outside any git repo, so the token is never committed.
const DEFAULT_TOKEN_PATH = path.join(os.homedir(), '.claude-oauth-token');

// Read the pushed OAuth access token, or null when the file is missing/empty.
function readOauthToken(tokenPath = DEFAULT_TOKEN_PATH) {
  try {
    const t = fs.readFileSync(tokenPath, 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

// Build a child-process env for Max-plan `claude -p` invocations:
//  - inject CLAUDE_CODE_OAUTH_TOKEN from the pushed token file when present
//  - strip ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN so a stray paid-API key
//    can never take precedence over the Max-plan OAuth token
//  - clear CLAUDECODE so a nested `claude` call does not inherit the parent
//    Claude Code session marker
function buildClaudeCliEnv(baseEnv = process.env, tokenPath = DEFAULT_TOKEN_PATH) {
  const env = { ...baseEnv };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDECODE = '';
  const token = readOauthToken(tokenPath);
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

module.exports = {
  isCliFailureOutput,
  buildClaudeCliEnv,
  readOauthToken,
  CLI_FAILURE_PATTERNS,
  DEFAULT_TOKEN_PATH,
};
