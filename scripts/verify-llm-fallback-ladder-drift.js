#!/usr/bin/env node
/**
 * Drift-lint for the LLM Fallback Ladder core component.
 *
 * Keeps dev-plans/core/llm-fallback-ladder.md equal to the code: every
 * load-bearing file the doc names must still exist, and the design
 * invariants the doc asserts (subscription rungs before paid floors, the
 * failure guard fronting every rung, the charged API gate, honest
 * proxy /health) must still hold. If the code moves and the doc does not,
 * this fails loud so the doc gets fixed instead of rotting into fiction.
 *
 * Scoped per review: the rung order, the failure-detection guard, the charged
 * API gate contract (Codex-down proof on every charged floor; per ExampleCo's
 * 2026-07-11 dispatch the OpenAI floor runs under standing authorization with
 * hard caps while anthropic/bedrock keep per-call approval), and the proxy
 * health honesty -- NOT every rung's HTTP implementation detail.
 *
 * No dev-plans/core/llm-fallback-ladder.LESSONS.md exists yet (the doc's own
 * section 5 says so). This lint therefore checks the doc only for now: it
 * fails if a LESSONS file is missing ONLY once the doc claims one exists, so
 * this lint self-updates the day that file is created and the doc is edited
 * to point at it.
 *
 * Zero deps (fs/path only) so it works in a fresh worktree.
 *   node scripts/verify-llm-fallback-ladder-drift.js
 * Exit 0 = in sync, 1 = drift. Importable as { checkDrift } for tests.
 */

const fs = require('fs');
const path = require('path');

const DOC = 'dev-plans/core/llm-fallback-ladder.md';
const LESSONS = 'dev-plans/core/llm-fallback-ladder.LESSONS.md';
// The doc's own "no LESSONS file yet" admission (section 5). While this
// sentence is present, a missing LESSONS file is expected, not drift.
const DOC_SAYS_NO_LESSONS_YET = /no per-component lessons file exists yet/i;

// Load-bearing files the doc names in "6. Key files". Each must exist
// (these are git-tracked source, not runtime artifacts).
const KEY_FILES = [
  'scripts/lib/ask-ai.js',
  'scripts/lib/cli-output-guard.js',
  'claude-proxy.js',
  'scripts/lib/proxy-stream-outcome.js',
  'memory/project_amy_universal_codex_fallback.md',
  'scripts/__tests__/ask-ai-ladder.test.js',
  'scripts/__tests__/cli-output-guard.test.js',
];

// Runtime artifacts: present on a live box / after real calls, not guaranteed
// in a fresh worktree -> warn, never fail.
const RUNTIME_FILES = [
  ['data/agent/ask-ai-rungs.jsonl', 'per-attempt ladder log, appended at call time'],
  [
    'data/agent/openai-api-spend.json',
    'hard-cap OpenAI floor ledger (month + night buckets), written on paid-rung spend',
  ],
];

// [file, token, why] -- the token must be present (an invariant the doc relies on).
const MUST_CONTAIN = [
  [
    'scripts/lib/ask-ai.js',
    'function defaultRungOrder',
    'the rung order is a named function the doc points readers at, not an inline literal',
  ],
  [
    'scripts/lib/ask-ai.js',
    "return ['codex', 'claude-proxy', 'claude-cli', 'openai-api']",
    'policy is fixed: subscription rungs (codex, claude-proxy, claude-cli) before the paid floor (openai-api)',
  ],
  [
    'scripts/lib/ask-ai.js',
    "return ['codex', 'claude-cli', 'claude-proxy', 'openai-api']",
    'W5 stage 3 (2026-07-12): on EC2 the local CLI runs BEFORE the tunnel proxy so the laptop SSH tunnel is not load-bearing there; paid floor still last',
  ],
  [
    'scripts/lib/ask-ai.js',
    'function isEc2Host',
    'the EC2 rung order is host-detected (SB_LLM_HOST_PROFILE override, else linux + pushed OAuth token), never hand-copied per call site',
  ],
  [
    'scripts/lib/ask-ai.js',
    'function resolveRungOrder',
    'the one place per-call rung overrides meet the host-aware default (Codex 2026-07-12 finding 7)',
  ],
  [
    'scripts/lib/ask-ai.js',
    'function chargedLlmApiGate',
    'charged API answer generation is gated before any paid floor runs',
  ],
  [
    'scripts/lib/ask-ai.js',
    'allowChargedLlmApi',
    'per-call ExampleCo approval still fronts the anthropic-api and bedrock floors (the OpenAI floor runs under standing authorization with hard caps)',
  ],
  [
    'scripts/lib/ask-ai.js',
    'class BrainUnreachable',
    'the ladder only throws when every rung has failed, never mid-descent',
  ],
  [
    'scripts/lib/ask-ai.js',
    'isCliFailureOutput',
    'every rung answer is screened by the shared failure guard before being trusted',
  ],
  [
    'scripts/lib/ask-ai.js',
    'buildClaudeCliEnv',
    'the claude-cli rung strips paid API keys so the Max OAuth token always wins',
  ],
  [
    'scripts/lib/cli-output-guard.js',
    'function isCliFailureOutput',
    'auth/quota sentinel detection lives in one shared place all rungs can front with',
  ],
  [
    'claude-proxy.js',
    "'claude-sonnet-4-6'",
    'the proxy rung is pinned to the Max-plan model the doc names',
  ],
  [
    'claude-proxy.js',
    "url === '/health'",
    'the proxy serves the honest token-expiry-based /health route the doc says stops EC2 routing to paid OpenAI when auth is fine',
  ],
  [
    'scripts/lib/proxy-stream-outcome.js',
    'function decideStreamOutcome',
    'a dead proxy stream must fail loud, not resolve as a clean empty 200',
  ],
];

// [file, token, why] -- the token must be ABSENT (a design boundary the doc
// or a hard-won lesson locks in). No documented removed-for-a-reason pattern
// exists yet for this component (no LESSONS file), so this stays empty
// rather than inventing a ban with no incident behind it.
const MUST_NOT_CONTAIN = [];

// Files removed for a documented reason that must stay deleted. No such
// removal is documented for this component yet, so this stays empty.
const MUST_NOT_EXIST = [];

function checkDrift(repoRoot) {
  const failures = [];
  const warnings = [];
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    } catch {
      return null;
    }
  };

  const doc = read(DOC);
  if (doc === null) failures.push(`missing core doc: ${DOC}`);

  // LESSONS is optional today: the doc itself says none exists yet. Only
  // once the doc drops that admission (i.e. claims a LESSONS file exists)
  // does a missing LESSONS file become drift.
  const lessons = read(LESSONS);
  if (lessons === null) {
    if (doc && !DOC_SAYS_NO_LESSONS_YET.test(doc)) {
      failures.push(
        `doc no longer admits ${LESSONS} is missing, but the file still does not exist`,
      );
    }
  } else if (lessons !== null && doc && DOC_SAYS_NO_LESSONS_YET.test(doc)) {
    failures.push(
      `${LESSONS} now exists but the doc still says no per-component LESSONS file exists yet -- update section 5`,
    );
  }

  for (const rel of KEY_FILES) {
    if (read(rel) === null) failures.push(`missing load-bearing file: ${rel}`);
  }
  for (const [rel, note] of RUNTIME_FILES) {
    if (read(rel) === null)
      warnings.push(`runtime artifact absent (ok in a fresh worktree): ${rel} -- ${note}`);
  }
  for (const [rel, token, why] of MUST_CONTAIN) {
    const src = read(rel);
    if (src === null) failures.push(`cannot check invariant, file missing: ${rel}`);
    else if (!src.includes(token))
      failures.push(`invariant lost in ${rel}: expected "${token}" (${why})`);
  }
  for (const [rel, token, why] of MUST_NOT_CONTAIN) {
    const src = read(rel);
    if (src === null) failures.push(`cannot check invariant, file missing: ${rel}`);
    else if (src.includes(token))
      failures.push(
        `invariant broken in ${rel}: found "${token}" (${why}) -- update the doc if intentional`,
      );
  }
  for (const rel of MUST_NOT_EXIST) {
    if (read(rel) !== null) failures.push(`file should stay deleted but exists: ${rel}`);
  }

  // The doc must still state the Codex-down plus ExampleCo-approval policy for charged floors.
  if (doc && !/Codex has already failed|Codex-down proof|Codex is down too/i.test(doc)) {
    failures.push('doc no longer states charged API floors require Codex-down proof');
  }
  if (doc && !/ExampleCo explicitly approved|ExampleCo approval|approved charged extra usage/i.test(doc)) {
    failures.push(
      'doc no longer states charged API floors require ExampleCo approval (per-call contract for anthropic/bedrock)',
    );
  }

  // The doc must still state the core requirement: subscription rungs first.
  if (doc && !/subscription rungs (?:are tried )?first|subscription rungs first/i.test(doc)) {
    failures.push('doc no longer states the hard requirement that subscription rungs run first');
  }

  return { failures, warnings };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const { failures, warnings } = checkDrift(repoRoot);
  warnings.forEach((w) => console.warn(`WARN  ${w}`));
  if (failures.length) {
    console.error(
      `\nDRIFT: llm-fallback-ladder doc is out of sync with code (${failures.length}):`,
    );
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error('\nFix the code or update dev-plans/core/llm-fallback-ladder.md, then re-run.');
    process.exit(1);
  }
  console.log('OK: llm-fallback-ladder doc is in sync with the code.');
}

if (require.main === module) main();

module.exports = {
  checkDrift,
  KEY_FILES,
  RUNTIME_FILES,
  MUST_CONTAIN,
  MUST_NOT_CONTAIN,
  MUST_NOT_EXIST,
};
