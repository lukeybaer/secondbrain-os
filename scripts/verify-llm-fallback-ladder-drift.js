#!/usr/bin/env node
/**
 * Drift-lint for the LLM Fallback Ladder core component.
 *
 * Keeps dev-plans/core/llm-fallback-ladder.md equal to the code: every
 * load-bearing file the doc names must still exist, and the design
 * invariants the doc asserts (subscription-first rung order, the failure guard
 * fronting every rung, the narrow briefing switch, honest
 * proxy /health) must still hold. If the code moves and the doc does not,
 * this fails loud so the doc gets fixed instead of rotting into fiction.
 *
 * Scoped per review: the rung order, the failure-detection guard, ExampleCo's
 * 2026-08-05 default-off charged boundary and briefing exception, and proxy
 * health honesty -- NOT every rung's HTTP implementation detail.
 *
 * LESSONS bookkeeping is guarded too. While the doc says no component
 * lessons file exists, a missing file is acceptable. Once the doc points to
 * the lessons file, that file must exist; if the file exists, the doc may not
 * keep claiming it is absent.
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
  'config/model-routing.json',
  'scripts/configure-model-routing.js',
  'scripts/lib/model-routing-config.js',
  'scripts/__tests__/configure-model-routing.test.js',
  'scripts/lib/ask-ai.js',
  'scripts/lib/briefing-api-fallback-switch.js',
  'scripts/briefing-api-fallback-switch.js',
  'scripts/agentic-healer-driver.js',
  'scripts/lib/briefing-model-context.js',
  'scripts/lib/cli-output-guard.js',
  'claude-proxy.js',
  'scripts/lib/claude-max-health-state.js',
  'scripts/lib/proxy-stream-outcome.js',
  'memory/project_amy_universal_codex_fallback.md',
  'scripts/lib/brain-switch.js',
  'scripts/brain-switch.js',
  'scripts/__tests__/brain-switch.test.js',
  'scripts/__tests__/ask-ai-ladder.test.js',
  'scripts/__tests__/briefing-api-fallback-switch.test.js',
  'scripts/__tests__/cli-output-guard.test.js',
  'scripts/__tests__/owner-video-model-route.test.js',
];

// Runtime artifacts: present on a live box / after real calls, not guaranteed
// in a fresh worktree -> warn, never fail.
const RUNTIME_FILES = [
  ['data/agent/ask-ai-rungs.jsonl', 'per-attempt ladder log, appended at call time'],
  [
    'data/agent/openai-api-spend.json',
    'historical and explicit-workload spend attribution; never fallback authority',
  ],
  [
    'data/agent/brain-switch.json',
    'durable default-brain switch state; absent means the source default (claude) leads',
  ],
];

// [file, token, why] -- the token must be present (an invariant the doc relies on).
const MUST_CONTAIN = [
  [
    'scripts/lib/model-routing-config.js',
    'function resolvedTier',
    'one policy resolver applies enabled-model fallback to every routed tier',
  ],
  [
    'scripts/lib/model-router.js',
    "const OWNER_VIDEO_CLAUDE_ROUTE = Object.freeze({ model: 'claude-opus-5-5', effort: 'medium' });",
    'owner-triggered video work has the documented Claude route',
  ],
  [
    'scripts/lib/model-router.js',
    "const OWNER_VIDEO_CODEX_ROUTE = Object.freeze({ model: 'gpt-5.6-sol', effort: 'medium' });",
    'owner-triggered video work has the documented Codex route',
  ],
  [
    'scripts/configure-model-routing.js',
    "argv.includes('--all')",
    'one operator command can update desktop and EC2 routing policy',
  ],
  [
    'scripts/lib/ask-ai.js',
    'function defaultRungOrder',
    'the rung order is a named function the doc points readers at, not an inline literal',
  ],
  [
    'scripts/lib/ask-ai.js',
    'const HOST_BRAIN_RUNGS',
    'which rungs each brain owns per host is a named table (ec2/desktop), not a hand-copied literal per call site (ExampleCo 2026-08-08 cloud-only ownership: EC2 never gets claude-proxy)',
  ],
  [
    'scripts/lib/ask-ai.js',
    'const [leading, trailing] = brainOrder({ env });',
    'defaultRungOrder() asks the durable brain switch who leads instead of hardcoding Codex or Claude first',
  ],
  [
    'scripts/lib/ask-ai.js',
    'recordBrainFailure(brain, detail, switchOpts)',
    'a rung failure feeds the durable brain switch so quota/auth exhaustion demotes that brain for every lane, not just this call',
  ],
  [
    'scripts/lib/ask-ai.js',
    'recordBrainSuccess(brain, switchOpts)',
    'a rung success clears the brain switch demotion immediately instead of waiting out the cooldown',
  ],
  [
    'scripts/lib/brain-switch.js',
    "const DEFAULT_PREFERRED = 'claude'",
    'ExampleCo 2026-09-03: Claude leads by source default; changing it is an owner decision',
  ],
  [
    'scripts/lib/brain-switch.js',
    'classifyLaneFailure',
    'one shared quota/auth/transient classifier with the voice lane, so out of tokens means the same strings everywhere',
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
    'charged-api-disabled:owner-policy',
    'every non-briefing charged answer-generation rung is denied before its function runs',
  ],
  [
    'scripts/lib/briefing-api-fallback-switch.js',
    "const SCOPE = 'overnight-briefing'",
    'the only paid exception is scoped to overnight briefing',
  ],
  [
    'scripts/briefing-api-fallback-switch.js',
    'Fargate is intentionally never opened by this switch',
    'the paid briefing switch can never reopen the model-worker role',
  ],
  [
    'scripts/agentic-healer-driver.js',
    'function resolveSubscriptionExecutionLane',
    'stale Fargate healer configuration is coerced to local subscription execution',
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
    'the proxy serves the honest persisted-live-proof /health route',
  ],
  [
    'claude-proxy.js',
    'classifyClaudeHealth',
    'the proxy requires recent live proof instead of promoting token expiry directly to green',
  ],
  [
    'scripts/lib/proxy-stream-outcome.js',
    'function decideStreamOutcome',
    'a dead proxy stream must fail loud, not resolve as a clean empty 200',
  ],
  [
    'scripts/lib/model-routing-config.js',
    'const OVERNIGHT_CEILING',
    'the owner overnight ceiling (Opus 5.5 medium, Sol medium; ExampleCo 2026-09-24) lives in code, so no policy file can raise it',
  ],
  [
    'config/model-routing.json',
    '"profiles"',
    'the overnight profile tiers live in config and may only tune downward under the code ceiling',
  ],
  [
    'scripts/overnight-watch-report.js',
    'ownerReportLock',
    'the final strategic report is locked to exactly the overnight ceiling on both rungs (ExampleCo 2026-09-24)',
  ],
];

// [file, token, why] -- the token must be ABSENT (a design boundary the doc
// or a hard-won lesson locks in). No documented removed-for-a-reason pattern
// exists yet for this component (no LESSONS file), so this stays empty
// rather than inventing a ban with no incident behind it.
const MUST_NOT_CONTAIN = [
  [
    'scripts/lib/ask-ai.js',
    "return ['codex', 'claude-proxy', 'claude-cli', 'openai-api']",
    'the desktop default may not regain a charged fallback rung',
  ],
  [
    'scripts/lib/ask-ai.js',
    "return ['codex', 'claude-cli', 'openai-api']",
    'the EC2 default may not regain a charged fallback rung',
  ],
  [
    'scripts/lib/ask-ai.js',
    "return ['codex', 'claude-cli', 'claude-proxy']",
    'the EC2 default may not regain the laptop SSH-tunnel proxy in any position (ExampleCo 2026-08-08 cloud-only ownership); ranking it last is still a cloud dependency on the PC',
  ],
  [
    'scripts/lib/ask-ai.js',
    "return ['codex', 'claude-cli']",
    'a hardcoded Codex-first EC2 literal may not return; who leads is the durable brain switch, not a call-site copy (ExampleCo 2026-09-03)',
  ],
  [
    'scripts/lib/ask-ai.js',
    "return ['codex', 'claude-proxy', 'claude-cli']",
    'a hardcoded Codex-first desktop literal may not return; who leads is the durable brain switch, not a call-site copy (ExampleCo 2026-09-03)',
  ],
  [
    'scripts/lib/ask-ai.js',
    "'-p',",
    'the Claude CLI rung may not go back to passing the prompt as an argv flag; Linux E2BIG and cmd.exe 8191-char ceilings silently dropped large prompts (ExampleCo 2026-09-03 fix: stdin plus --print)',
  ],
  [
    'scripts/viral-tech-clip-proposals.js',
    "'--model', 'claude-sonnet-5'",
    'a direct Claude pin may not bypass the enabled switch and the overnight ceiling again; the disabled claude-sonnet-5 ran every night until 2026-09-24',
  ],
];

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

  if (doc && !/unauthorized\/off|defaults? (?:unauthorized\/)?off|default-off/i.test(doc)) {
    failures.push('doc no longer states that the paid briefing switch defaults off');
  }
  if (doc && !/Graphiti.*Whisper.*canar/i.test(doc)) {
    failures.push('doc no longer separates disabled explicit API workloads from fallback');
  }

  if (doc && !/auth-voice-paid-fallback[\s\S]*voice-call-stack\.md/i.test(doc)) {
    failures.push(
      'doc no longer delegates the separate voice paid fallback to voice-call-stack.md',
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
