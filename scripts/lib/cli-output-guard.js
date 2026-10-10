// Guard helpers for `claude -p` (Claude CLI) invocations used by ec2-server.js
// (Telegram replies) and scripts/process-dispatches.js (dispatch act-now).
//
// Why this exists: when the Claude CLI is not authenticated it prints
// "Not logged in · Please run /login" to STDOUT and exits 0. Callers that
// only check `out.trim()` truthiness or `exitCode === 0` therefore mistake
// that error string for a real answer. ec2-server.js forwarded it straight
// to ExampleCo on Telegram as Amy's reply; process-dispatches.js logged it as a
// successful dispatch act. Both bugs share this root cause.
//
// Extracted to its own module so the detection + env construction can be
// unit-tested without booting ec2-server.js.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Sentinels the Claude CLI prints on auth / quota failure, AND raw upstream
// API error strings (HTTP 4xx, Anthropic error types) that must never reach
// Telegram. Matched against the first 500 chars of stdout or stderr so a
// long, legitimate answer that merely mentions one of these phrases deep in
// the body is not misflagged.
const RAW_PROVIDER_FAILURE_PATTERNS = [
  // A provider wrapper may return only the bare status.  This exact full-body
  // shape is an error; embedded numeric prose such as "404 records" remains
  // valid because the anchors require the whole payload to be the status.
  /^(?:HTTP(?:\/\d(?:\.\d)?)?\s*)?404(?:\s+Not Found)?$/i,
  // Raw HTTP error strings from provider APIs and CLI wrappers. Providers and
  // wrappers disagree on whether the word "HTTP" is present, so cover both
  // the protocol-shaped variants and status/error-labelled forms.
  /\bhttps?[\s\/:_-]*[45]\d\d\b/i,
  /\brequest\s+failed\s+with\s+(?:status|response)(?:\s+status)?(?:\s+code)?\s*[:=\/_-]?\s*[45]\d\d\b/i,
  /\b(?:upstream|provider|api|model|endpoint)\s+(?:status|response)(?:\s+status)?(?:\s+code)?\s*[:=\/_-]?\s*[45]\d\d\b/i,
  /\b(?:upstream|provider|api|model|endpoint)?\s*error\s*[:=\/_-]?\s*[45]\d\d\b/i,
  /["']?status["']?\s*:\s*[45]\d\d\b[\s\S]{0,120}["']?(?:error|message|request[_ -]?id)["']?\s*:/i,
  /\b404\b.{0,120}\b(?:not[\s_-]*found|model|endpoint|request[_ -]?id|provider|api)\b/i,
  /\b404 Not Found\b/i,
  /not_found_error/i,
  /overloaded_error/i,
  /invalid_request_error/i,
  /api_error:/i,
  /api error:\s*401/i,
  /Bad Request:\s*message is too long/i,
  /telegram_error/i,
];

const CLI_FAILURE_PATTERNS = [
  // Auth / quota failures (Claude CLI)
  /not logged in/i,
  /please run\s*\/login/i,
  /invalid api key/i,
  /authentication[\s_]?error/i,
  /oauth token (?:has )?expired/i,
  /credit balance is too low/i,
  /out of extra usage/i,
  /usage limit reached/i,
  /rate limit exceeded/i,
  ...RAW_PROVIDER_FAILURE_PATTERNS,
  // Codex CLI / OpenAI API sentinels (2026-06-11 ladder plan -- the guard now
  // fronts EVERY rung of ask-ai.js, not just the Claude CLI)
  /run\s+`?codex login`?/i,
  /\b401 unauthorized\b/i,
  /exceeded your current quota/i,
  /insufficient_quota/i,
  /incorrect api key provided/i,
  /billing_hard_limit_reached/i,
  // ExampleCo, 2026-08-17: "the repair model should fall back to claude subscription
  // when codex sub is down." It could not, because the Codex CLI's real
  // out-of-credits line matched nothing above. Codex says "You've hit your usage
  // limit"; the existing entry is Claude's wording, "usage limit reached". An
  // unmatched quota error is treated as a valid ANSWER, which is precisely what
  // ladder invariant 8 forbids, so nothing descended to the Claude rung.
  //
  // Measured that day: askAI stopped at the Codex rung, and the briefing's
  // agentic card healer counted a dead Codex worker as a genuine repair attempt,
  // burning one of each card's eight hard repair cycles until the ceiling was
  // reached with no card ever handed to Claude. Mid-day healing was impossible
  // for every red card while Codex was out.
  //
  // Worded as the category, not the one sentence: hitting or exceeding a usage
  // allowance, being asked to buy credits, and being out of credits.
  /\bhit\s+(?:your|the)\s+usage\s+limit\b/i,
  /\busage\s+limit\s+(?:reached|exceeded|hit)\b/i,
  /\bpurchase\s+more\s+credits\b/i,
  /\bout\s+of\s+credits\b/i,
];

// True when CLI output is an auth/quota failure rather than a real answer.
function isCliFailureOutput(text) {
  if (!text || typeof text !== 'string') return false;
  // 1000-char window (was 500): Codex review found auth errors can sit past
  // 500 chars when a CLI prints a preamble before failing. Still bounded so a
  // long legitimate answer mentioning quota/login deep in the body passes.
  const head = text.trim().slice(0, 1000);
  if (!head) return false;
  return CLI_FAILURE_PATTERNS.some((re) => re.test(head));
}

// Final egress classification is intentionally different from CLI-result
// classification. CLI callers inspect only the first 1,000 characters to avoid
// rejecting a long legitimate answer that discusses an error late in the body.
// Telegram egress must scan the whole payload because wrappers can prepend long
// diagnostics before appending the actual provider failure.
function isRawProviderError(text) {
  if (!text || typeof text !== 'string') return false;
  const payload = text.trim().slice(0, 65536);
  if (!payload) return false;
  return RAW_PROVIDER_FAILURE_PATTERNS.some((re) => re.test(payload));
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
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.AGENTIC_CODEX_API_KEY;
  delete env.GROQ_API_KEY;
  delete env.OPENAI_ORGANIZATION;
  delete env.OPENAI_PROJECT;
  env.CLAUDECODE = '';
  const token = readOauthToken(tokenPath);
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

// Build a child-process env for subscription-authenticated `codex` calls.
// Codex supports both subscription login and metered API credentials. Removing
// every API credential selector here prevents a stale/future key from silently
// changing an intended subscription call into a paid token call.
function buildCodexCliEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.AGENTIC_CODEX_API_KEY;
  delete env.GROQ_API_KEY;
  delete env.OPENAI_ORGANIZATION;
  delete env.OPENAI_PROJECT;
  env.CLAUDECODE = '';
  return env;
}

module.exports = {
  isCliFailureOutput,
  isRawProviderError,
  buildClaudeCliEnv,
  buildCodexCliEnv,
  readOauthToken,
  CLI_FAILURE_PATTERNS,
  RAW_PROVIDER_FAILURE_PATTERNS,
  DEFAULT_TOKEN_PATH,
};
