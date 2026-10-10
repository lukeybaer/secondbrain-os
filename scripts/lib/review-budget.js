'use strict';

/**
 * review-budget.js
 *
 * Two-pass adversarial review budget (ExampleCo, 2026-09-27). Authority:
 * memory/feedback_when_to_call_codex.md "Review budget".
 *
 * Measured failure: `linkedin-content-pipe-plain-virality` ran 26 broad Codex
 * reviews in a row (gates `-r2` through `-r26`), each a fresh full rescan that
 * found something new, so the change never shipped and the loop burned tokens
 * all day. Nothing in either launcher remembered that the change had already
 * been reviewed.
 *
 * Every change gets one review chain. The chain allows exactly:
 *   1. one broad initial review,
 *   2. one delta-only closure review (`--follow-up-of <initial id> --focus ...`),
 *   3. at most one exception pass, only after closure, only with recorded
 *      evidence (`--exception "<evidence>"`) that the closure fix introduced a
 *      new concrete production, security, data-loss or reputation blocker.
 * A rerun whose reviewed bytes are identical to the chain's latest receipt is
 * a metadata-only rebind: it copies the prior verdict onto the new commit and
 * never calls a model.
 *
 * Both launchers (codex-peer-review.js, claude-peer-review.js) call
 * planReviewPass() BEFORE building a prompt, so a refused pass costs nothing.
 */

const fs = require('fs');
const path = require('path');
const { sharedCheckoutRoots } = require('./shared-checkout-root.js');

// Gates that name a real irreversible action (scripts/claude-hooks/two-bot-gate.mjs
// GATED_ACTIONS plus the plan gate). These are shared by every change, so the
// chain key for them is scoped further by diff base or artifact path.
const SHARED_GATE_IDS = new Set(['ec2-deploy', 'instance-resize', 'public-mirror', 'plan']);

// Round-counter suffixes are how the 26-round loop dodged every "already
// reviewed" check: each round was a brand-new gate name.
const ROUND_SUFFIX = /(?:^|[-_.:/ ])(?:r|rd|round|pass|retry|attempt|take|iter|iteration)[-_]?\d+$/i;

// Chains older than this no longer bind. Loops happen within hours; a
// derived key such as an artifact path may legitimately be reused weeks later.
const CHAIN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const MIN_EXCEPTION_EVIDENCE_CHARS = 40;

class ReviewBudgetError extends Error {
  constructor(message) {
    super(`[review-budget] ${message}`);
    this.name = 'ReviewBudgetError';
  }
}

function assertNoRoundSuffix(label, value) {
  if (value && ROUND_SUFFIX.test(String(value).trim())) {
    throw new ReviewBudgetError(
      `${label} "${value}" carries a round counter. One change gets one review chain: ` +
        'reuse the original name with --follow-up-of <initial receipt id> --focus <finding IDs> for the closure pass.',
    );
  }
}

/**
 * The chain a review belongs to. Explicit --change-id wins; a custom gate
 * label is itself the change id; a shared action gate (ec2-deploy, plan) is
 * scoped by the diff merge-base (stable across fix commits on one branch) or
 * the artifact path; an ungated review is keyed by its artifact path.
 */
function deriveChainKey({ changeId, gate, diffBase, artifactRel }) {
  assertNoRoundSuffix('--change-id', changeId);
  assertNoRoundSuffix('--gate', gate);
  if (changeId) return `change:${String(changeId).trim().toLowerCase()}`;
  const g = gate ? String(gate).trim().toLowerCase() : '';
  if (g && !SHARED_GATE_IDS.has(g)) return `change:${g}`;
  if (g && diffBase) return `gate:${g}@${diffBase}`;
  if (g) return `gate:${g}@${artifactRel}`;
  return `artifact:${artifactRel}`;
}

function readRows(files) {
  const rows = [];
  const seen = new Set();
  for (const f of files || []) {
    if (!f) continue;
    const abs = path.resolve(f);
    if (seen.has(abs.toLowerCase())) continue;
    seen.add(abs.toLowerCase());
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip a torn line */
      }
    }
  }
  return rows;
}

function idMatches(rowId, ref) {
  const a = String(rowId || '').trim().toLowerCase();
  const b = String(ref || '').trim().toLowerCase();
  if (!a || b.length < 8) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * Decide which pass this request is, or refuse it. Pure given the receipt rows.
 *
 * @returns {{ chainKey, pass: 'initial'|'closure'|'exception'|'rebind', rebindOf?: object }}
 */
function planReviewPass(
  { changeId, gate, diffBase, artifactRel, followUpOf, focus, exception, sourceDigest },
  { receiptFiles = [], rows: injectedRows, now = Date.now() } = {},
) {
  const chainKey = deriveChainKey({ changeId, gate, diffBase, artifactRel });
  const allRows = injectedRows || readRows(receiptFiles);
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const chain = allRows
    .filter((r) => r && r.reviewChain === chainKey && r.status !== 'unavailable')
    .filter((r) => {
      const t = Date.parse(r.ts || '');
      return !Number.isFinite(t) || nowMs - t <= CHAIN_WINDOW_MS;
    })
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));

  const initial = chain.find((r) => r.reviewPass === 'initial');
  const closure = chain.find((r) => r.reviewPass === 'closure');
  const excepted = chain.find((r) => r.reviewPass === 'exception');
  const latest = chain[chain.length - 1];
  const focusList = (focus || []).map((f) => String(f).trim()).filter(Boolean);

  // Metadata-only rebind: same reviewed bytes, new commit or message. Never a
  // new review, allowed in any state, costs no model call.
  if (!followUpOf && !exception && latest && sourceDigest && latest.reviewSourceDigest === sourceDigest) {
    return { chainKey, pass: 'rebind', rebindOf: latest };
  }

  if (exception) {
    const evidence = String(exception).trim();
    if (!closure) {
      throw new ReviewBudgetError(
        `--exception is only for a third pass after the closure review; chain ${chainKey} has no closure yet.`,
      );
    }
    if (excepted) {
      throw new ReviewBudgetError(
        `Chain ${chainKey} already used its one exception pass (receipt ${excepted.id}). The chain is terminal: ship, or log remaining concerns as backlog.`,
      );
    }
    if (!followUpOf || !idMatches(closure.id, followUpOf)) {
      throw new ReviewBudgetError(
        `An exception pass must name the closure receipt: --follow-up-of ${closure.id}.`,
      );
    }
    if (!focusList.length) {
      throw new ReviewBudgetError('An exception pass must name the one new blocker with --focus.');
    }
    if (evidence.length < MIN_EXCEPTION_EVIDENCE_CHARS) {
      throw new ReviewBudgetError(
        'An exception pass needs recorded evidence: the new behavior the closure fix introduced and the concrete production, security, data-loss or reputation risk it creates. "Another reviewer might find something" does not qualify.',
      );
    }
    return { chainKey, pass: 'exception' };
  }

  if (!followUpOf) {
    if (!initial) return { chainKey, pass: 'initial' };
    const next = closure
      ? `The chain is closed (closure receipt ${closure.id}). Ship the change; new concerns go to backlog. A third pass needs --exception "<evidence>" --follow-up-of ${closure.id} --focus <blocker>.`
      : `Run the one closure pass instead: --follow-up-of ${initial.id} --focus <finding IDs being fixed>.`;
    throw new ReviewBudgetError(
      `Chain ${chainKey} already had its broad review (receipt ${initial.id}); another broad review is refused. ${next}`,
    );
  }

  // Closure pass.
  let anchor = initial;
  if (!anchor) {
    // A chain started before this budget existed has an untagged initial
    // receipt. Adopt it by id so an in-flight change can still close once.
    anchor = allRows.find((r) => r && !r.reviewChain && idMatches(r.id, followUpOf));
    if (!anchor) {
      throw new ReviewBudgetError(
        `--follow-up-of ${followUpOf} does not match an initial review in chain ${chainKey}. Run the initial broad review first.`,
      );
    }
  }
  if (closure) {
    throw new ReviewBudgetError(
      `Chain ${chainKey} is closed (closure receipt ${closure.id}); no further review runs. Ship the change; new concerns go to backlog. A third pass needs --exception "<evidence>" --follow-up-of ${closure.id} --focus <blocker>.`,
    );
  }
  if (!idMatches(anchor.id, followUpOf)) {
    throw new ReviewBudgetError(
      `The closure pass must follow the chain's initial review: --follow-up-of ${anchor.id}.`,
    );
  }
  if (!focusList.length) {
    throw new ReviewBudgetError('The closure pass must list the exact finding IDs it verifies with --focus.');
  }
  return { chainKey, pass: 'closure' };
}

// Both launchers' receipt logs in every root that may hold them, so a chain
// cannot be escaped by switching reviewer direction or checkout.
function defaultReceiptFiles(repo, extra = []) {
  const roots = sharedCheckoutRoots({ extraRoots: [repo] });
  const files = [...extra];
  for (const r of roots) {
    files.push(path.join(r, 'data', 'agent', 'codex-peer-review-results.jsonl'));
    files.push(path.join(r, 'data', 'agent', 'claude-peer-review-results.jsonl'));
  }
  return files;
}

// Appended to the reviewer prompt for delta-only passes so the reviewer does
// not rescan the whole design.
const CLOSURE_PROMPT_RULES = [
  '- Review budget: this is the final (closure) pass for this change. Review ONLY the prior findings, the exact changed lines named under Focus, their focused test results, and any rejected finding with its evidence.',
  '- Do not rescan the full design, introduce new preferences, or reopen accepted decisions. A new issue counts only if the fix itself created a concrete production, security, data-loss or reputation blocker; say which changed line created it.',
  '- Everything else you notice is backlog, not a blocker. Approve when the named findings are resolved.',
];

// The owner files each finding as fix now, reject, or backlog; the reviewer
// only needs to know there is no later broad pass.
const INITIAL_PROMPT_RULES = [
  '- Review budget: this change gets one broad review (this one) and one delta-only closure pass. Report everything that matters now; later passes will not rescan. Say which findings block this release and which are backlog improvements.',
];

module.exports = {
  CHAIN_WINDOW_MS,
  CLOSURE_PROMPT_RULES,
  INITIAL_PROMPT_RULES,
  ROUND_SUFFIX,
  ReviewBudgetError,
  SHARED_GATE_IDS,
  defaultReceiptFiles,
  deriveChainKey,
  planReviewPass,
  readRows,
};
