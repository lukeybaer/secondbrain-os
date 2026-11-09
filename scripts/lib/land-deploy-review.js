'use strict';
//
// land-deploy-review.js -- the land-time deploy-review pre-check.
//
// The EC2 deploy gate (scripts/claude-hooks/two-bot-gate.mjs) unlocks only on
// an `ec2-deploy` peer-review receipt whose sourceSha is the commit being
// deployed, or an ancestor with only non-runtime files changed since (the
// caller supplies that ancestry through changedFilesSince). That
// receipt is stamped by scripts/codex-peer-review.js only when the artifact
// equals the branch's diff against origin/master, so once a branch is landed
// (HEAD == origin/master, empty diff) it can never be produced and the deploy
// needs an audited override. Two sessions hit that on 2026-10-27 (overrides at
// 01:33Z and 01:36Z): the review came after the land.
//
// This module answers, at land time, "will this landed sha be deployable
// without an override?" and says what to run when it will not. Pure: land.js
// supplies the files, the sha, the receipts, the branch state and the clock.
// Warn-only. The land gate never blocks on it, and the two-bot gate (verdict,
// findings, severity scoping) stays the authority at deploy time.

const { parseFindings, parseVerdict } = require('./codex-verdict.js');

// Mirror of NON_RUNTIME_PREFIXES in scripts/claude-hooks/two-bot-gate.mjs, an
// ES module land.js cannot require synchronously. The test asserts parity.
const NON_RUNTIME_PREFIXES = Object.freeze(['memory/', 'dev-plans/', 'docs/']);
const DEPLOY_GATE_ID = 'ec2-deploy';
// Same freshness window the gate applies (DEFAULT_MAX_AGE_MS there).
const DEFAULT_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SHA_RE = /^[0-9a-f]{40}$/i;
// Verdicts that can unlock the deploy gate. Whether changes-required actually
// unlocks depends on the findings' severity, which the gate decides.
const UNLOCKING_VERDICTS = new Set(['approve', 'changes-required']);

function runtimeFiles(files) {
  return (Array.isArray(files) ? files : [])
    .map((file) => String(file || '').replace(/\\/g, '/').trim())
    .filter((file) => file && !NON_RUNTIME_PREFIXES.some((prefix) => file.startsWith(prefix)));
}

// A degraded (Codex-unreachable) receipt counts only when it names the failure
// it stands in for, exactly as the gate requires.
function degradedReceiptOk(receipt) {
  const flagged = receipt.degraded === true || receipt.reviewer === 'claude-self-pass';
  if (!flagged) return true;
  return (
    receipt.degraded === true &&
    receipt.reviewer === 'claude-self-pass' &&
    Boolean(String(receipt.codexFailure || '').trim())
  );
}

/**
 * @param {object[]} receipts
 * @param {string}   sha                         the commit that will land
 * @param {object}   [options]
 * @param {string}   [options.gate]
 * @param {number}   [options.nowMs]
 * @param {number}   [options.maxAgeMs]
 * @param {(reviewedSha: string, currentSha: string) => string[]|null} [options.changedFilesSince]
 *   files changed from a reviewed ancestor to sha, or null when it is not an
 *   ancestor. Mirrors changedFilesSinceReview in two-bot-gate.mjs: a receipt on
 *   an ancestor binds only when every file changed since is non-runtime.
 *   Without the callback only an exact sha match binds.
 */
function bindingDeployReceipts(receipts, sha, options = {}) {
  const gate = String(options.gate || DEPLOY_GATE_ID).toLowerCase();
  const changedFilesSince =
    typeof options.changedFilesSince === 'function' ? options.changedFilesSince : null;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const want = String(sha || '').trim().toLowerCase();
  if (!SHA_RE.test(want)) return [];
  return (Array.isArray(receipts) ? receipts : []).filter((receipt) => {
    if (!receipt || typeof receipt !== 'object') return false;
    if (String(receipt.gate || '').trim().toLowerCase() !== gate) return false;
    const reviewed = String(receipt.sourceSha || '').trim().toLowerCase();
    if (!SHA_RE.test(reviewed)) return false;
    if (reviewed !== want) {
      if (!changedFilesSince) return false;
      const since = changedFilesSince(reviewed, want);
      if (!Array.isArray(since) || since.length === 0 || runtimeFiles(since).length) return false;
    }
    const ts = Date.parse(receipt.ts || '');
    if (!Number.isFinite(ts) || nowMs - ts > maxAgeMs || ts - nowMs > CLOCK_SKEW_MS) return false;
    if (!degradedReceiptOk(receipt)) return false;
    return UNLOCKING_VERDICTS.has(parseVerdict(receipt.review));
  });
}

function shortSha(sha) {
  return String(sha || '').trim().slice(0, 9) || '(unknown sha)';
}

// Critical or high findings in a receipt's review text: the gate blocks on
// each unless the reviewer tagged it [pre-existing] on a file the diff did not
// change. Reported here as information, never judged.
function blockingFindingCount(review) {
  const parsed = parseFindings(review);
  if (parsed.status !== 'ok') return 0;
  return parsed.findings.filter((finding) => /^(critical|high)$/.test(finding.severity)).length;
}

function verdictNote(receipt) {
  const verdict = parseVerdict(receipt.review);
  if (verdict !== 'changes-required') return `verdict ${verdict}`;
  const blocking = blockingFindingCount(receipt.review);
  return blocking
    ? `verdict changes-required with ${blocking} critical/high finding(s): the gate blocks on each unless it is tagged [pre-existing] on an unchanged file`
    : 'verdict changes-required, no critical or high findings';
}

const REVIEW_COMMANDS = [
  '  git diff --no-renames origin/master...HEAD > <artifact>',
  `  sh scripts/peer-review.sh --artifact-file <artifact> --gate ${DEPLOY_GATE_ID} --title "<change>"`,
];
const RULE_POINTER =
  'Rule: memory/feedback_when_to_call_codex.md, "the deploy review runs on the branch tip, before the land".';

/**
 * @param {object} input
 * @param {string[]} input.files        changed files of the land vs origin/master
 * @param {string}   input.sha          HEAD of the branch being landed
 * @param {object[]} input.receipts     peer-review receipt rows
 * @param {boolean}  input.upToDate     HEAD already descends from the fetched origin/master
 * @param {'check'|'apply'} input.mode  which land run this is
 * @param {number}   [input.nowMs]
 * @param {number}   [input.maxAgeMs]
 * @param {Function} [input.changedFilesSince]  see bindingDeployReceipts
 * @returns {{needed:boolean, bound:boolean, runtimeFiles:string[], receipts:object[], message:string}}
 *   bound is true only when a receipt binds the sha that will actually land.
 */
function deployReviewDecision(input = {}) {
  const runtime = runtimeFiles(input.files);
  const mode = input.mode === 'apply' ? 'apply' : 'check';
  if (!runtime.length) {
    return {
      needed: false,
      bound: false,
      runtimeFiles: [],
      receipts: [],
      message: 'deploy review: not needed (no runtime file changes).',
    };
  }
  const bound = bindingDeployReceipts(input.receipts, input.sha, {
    nowMs: input.nowMs,
    maxAgeMs: input.maxAgeMs,
    changedFilesSince: input.changedFilesSince,
  });
  const sha = shortSha(input.sha);
  const unbound =
    `WARNING: deploy review (not blocking): ${runtime.length} runtime file(s) change and ` +
    `no ${DEPLOY_GATE_ID} peer-review receipt binds ${sha}.`;
  // On --check behind master, --apply will rebase onto a tip nobody has
  // reviewed, whether or not a receipt binds the current HEAD (review F1).
  if (mode === 'check' && input.upToDate === false) {
    const lead = bound.length
      ? `WARNING: deploy review (not blocking): ${DEPLOY_GATE_ID} receipt ${bound[0].id || '(no id)'} binds ${sha}, ` +
        'but origin/master moved since this branch was based on it.'
      : unbound;
    const lines = [
      lead,
      `--apply will rebase, so ${sha} will not be the landed sha and no receipt binds the one that lands. ` +
        'Rebase first (git rebase origin/master), re-run --check, then review the new tip:',
      ...REVIEW_COMMANDS,
      'A rebased tip starts a new review chain (the chain is keyed by the merge base with origin/master), ' +
        'so this is a fresh gated review, not a rebind of the old receipt.',
      RULE_POINTER,
    ];
    return { needed: true, bound: false, runtimeFiles: runtime, receipts: bound, message: lines.join('\n') };
  }
  if (bound.length) {
    const reviewed = String(bound[0].sourceSha || '').trim().toLowerCase();
    const via =
      reviewed === String(input.sha || '').trim().toLowerCase()
        ? ''
        : ` through reviewed ancestor ${shortSha(reviewed)} (only non-runtime files changed since)`;
    return {
      needed: true,
      bound: true,
      runtimeFiles: runtime,
      receipts: bound,
      message:
        `deploy review: ${DEPLOY_GATE_ID} receipt ${bound[0].id || '(no id)'} binds ${sha}${via} ` +
        `(${verdictNote(bound[0])}); the two-bot gate decides at deploy time.`,
    };
  }
  const lines =
    mode === 'apply'
      ? [
          unbound,
          `The land continues. An EC2 deploy of ${sha} will need an audited peer-review override: ` +
            'a gated review cannot be stamped once the branch is landed, because its diff against origin/master is empty.',
          RULE_POINTER,
        ]
      : [
          unbound,
          `This is the moment to review: ${sha} is what --apply will push unless origin/master moves again. From this worktree:`,
          ...REVIEW_COMMANDS,
          '  node scripts/land.js --apply',
          RULE_POINTER,
        ];
  return { needed: true, bound: false, runtimeFiles: runtime, receipts: [], message: lines.join('\n') };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DEPLOY_GATE_ID,
  NON_RUNTIME_PREFIXES,
  bindingDeployReceipts,
  deployReviewDecision,
  runtimeFiles,
};
