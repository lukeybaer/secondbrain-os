'use strict';

// Deploy-source freshness gate (2026-07-05). The EC2 deploy-drift heal scp's
// the LOCAL working ec2-server.js over the live server. On 2026-07-04/05 a
// stale shared checkout (91 commits behind master, old news-reader design)
// "healed" prod BACK to a broken build every morning at ~5:05am CT, reverting
// the landed fix. A self-heal may only deploy content PROVEN to match
// origin/master; anything unproven defers loudly to a human. Fail closed:
// a fetch/read error means freshness is unproven, so the heal must refuse.

function normalizeSource(text) {
  return String(text || '').replace(/\r/g, '');
}

function assessDeploySourceFreshness({
  localContent = '',
  originContent = '',
  fetchError = '',
  showError = '',
  readError = '',
} = {}) {
  if (fetchError) {
    return { fresh: false, reason: 'git fetch failed: ' + String(fetchError).slice(0, 120) };
  }
  if (showError) {
    return {
      fresh: false,
      reason: 'origin/master:ec2-server.js unreadable: ' + String(showError).slice(0, 120),
    };
  }
  if (readError) {
    return {
      fresh: false,
      reason: 'local ec2-server.js unreadable: ' + String(readError).slice(0, 120),
    };
  }
  if (!normalizeSource(localContent)) {
    return { fresh: false, reason: 'local ec2-server.js is empty' };
  }
  if (normalizeSource(localContent) !== normalizeSource(originContent)) {
    return {
      fresh: false,
      reason:
        'local ec2-server.js does not match origin/master (stale or dirty checkout); refusing to deploy',
    };
  }
  return { fresh: true, reason: '' };
}

// ---------------------------------------------------------------------------
// COMMIT-LEVEL PROVENANCE GATE (2026-07-19)
// ---------------------------------------------------------------------------
// assessDeploySourceFreshness above compares ONE file's content. The EC2 deploy
// ships a whole tree at a commit sha, so it needs a commit-level answer: is the
// sha we are about to make live the code we agreed to ship?
//
// Every pre-existing deploy gate is an INTEGRITY check (does the tree parse,
// require, import-smoke, answer /health). None of them is a PROVENANCE check.
// A tree can be perfectly healthy and still be the wrong code. On 2026-07-19 a
// deploy shipped sha 59d92950, which was BEHIND master, and it passed every
// integrity gate; the only thing that caught it was a human reading the receipt
// afterward, long after the atomic swap was already live.
//
// Relation values come from relationFromAncestry() in lib/ec2-deploy-receipts.js
// so both the gate and the receipt speak one vocabulary:
//   equal    -> the sha IS origin/master. The only clean deploy.
//   behind   -> stale source. This is the 59d92950 class. REFUSE.
//   ahead    -> unlanded code that never passed the land gate. REFUSE.
//   diverged -> forked history, provenance unknowable. REFUSE.
// Anything else (including a missing relation) is unproven, so it fails closed.
//
// Override: SB_DEPLOY_ALLOW_STALE_SOURCE=1 is the documented, attended
// emergency escape. It does not silence anything. The refusal reason is still
// computed and reported, the caller prints a loud warning, and the override is
// recorded so an overridden deploy is auditable after the fact.
const PROVENANCE_REFUSALS = {
  behind: {
    code: 'stale-source',
    reason:
      'the sha being deployed is BEHIND origin/master: this ships stale code and would silently revert landed work',
  },
  ahead: {
    code: 'unlanded-source',
    reason:
      'the sha being deployed is AHEAD of origin/master: this ships code that never passed the land gate',
  },
  diverged: {
    code: 'diverged-source',
    reason:
      'the sha being deployed has DIVERGED from origin/master: provenance cannot be established',
  },
};

/**
 * Pure fail-closed provenance decision for an EC2 deploy.
 * @param {{relation?:string, headSha?:string, originMasterSha?:string,
 *          fetchError?:string, resolveError?:string, overrideRequested?:boolean}} args
 * @returns {{ok:boolean, overridden:boolean, code:string, reason:string,
 *            headSha:string|null, originMasterSha:string|null, relation:string}}
 */
function assessDeployProvenance({
  relation = '',
  headSha = '',
  originMasterSha = '',
  fetchError = '',
  resolveError = '',
  overrideRequested = false,
} = {}) {
  const base = {
    headSha: headSha || null,
    originMasterSha: originMasterSha || null,
    relation: relation || 'ExampleCo',
  };
  const refuse = (code, reason) => {
    if (overrideRequested) {
      return { ...base, ok: true, overridden: true, code, reason };
    }
    return { ...base, ok: false, overridden: false, code, reason };
  };

  if (fetchError) {
    return refuse(
      'fetch-failed',
      'could not fetch origin, so the deployed sha cannot be compared to origin/master: ' +
        String(fetchError).slice(0, 200),
    );
  }
  if (resolveError) {
    return refuse(
      'unresolvable',
      'could not resolve HEAD or origin/master: ' + String(resolveError).slice(0, 200),
    );
  }
  if (!headSha || !originMasterSha) {
    return refuse('unresolvable', 'HEAD or origin/master sha is missing, provenance is unproven');
  }
  if (relation === 'equal') {
    return { ...base, ok: true, overridden: false, code: 'equal', reason: '' };
  }
  const named = PROVENANCE_REFUSALS[relation];
  if (named) return refuse(named.code, named.reason);
  return refuse(
    'ExampleCo-relation',
    'the relation of the deployed sha to origin/master is ExampleCo (' +
      String(relation) +
      '), so provenance is unproven',
  );
}

module.exports = { assessDeploySourceFreshness, assessDeployProvenance, normalizeSource };
