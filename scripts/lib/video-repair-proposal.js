// video-repair-proposal.js
//
// One shared answer to "a video BUILD failed, so what does the pipeline owe
// ExampleCo now?"
//
// 2026-08-24 ExampleCo: "fix the video, why isn't it regenerating based on the
// feedback." The Lex Fridman clip vtc-be1913704036 sat for two days after its
// build failed. The reason nothing regenerated it was structural, not a bug in
// any one retry loop:
//
//   scripts/build-viral-clip.js recordBuildFailure() writes
//   status='build_failed' and repair_required=true onto the manifest row, and
//   until this module NOTHING in the repo read either field. auto-regen
//   selects only video_needs_regen / thumbnail_needs_regen (see
//   lib/video-delete-state.js isRegenCandidate), so a build failure produced a
//   receipt that no consumer was subscribed to. A write-only marker is not an
//   owner, and an unowned row waits forever.
//
// This module is the missing consumer, and it is deliberately a PROPOSER.
// dev-plans/core/video-generation.md invariant 6 says nothing builds or ships
// unattended, so recovery from a failed build cannot be an automatic rebuild.
// What the pipeline owes ExampleCo is therefore an explicit, actionable decision:
// the honest blocker that stopped the build, plus the exact existing command
// that would retry it, surfaced on the card instead of an indefinite stuck
// state. Invariant 3 (unify, never stack a parallel generation) is why the
// proposed command is the EXISTING build entry point and why the claim runs
// inside the existing scheduled auto-regen owner rather than in a new job.
// Invariant 7 (ExampleCo deletion is terminal by video identity) is why every entry
// point below consults the tombstone predicate FIRST.

const fs = require('fs');
const path = require('path');
const { isTerminallyExcludedFromStuckScan } = require('./video-delete-state.js');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');

const REPAIR_STATUS = 'build_failed';

// The machine-readable marker the card banner carries so the live render-QC can
// grade the proposal without depending on tile styling, matching the
// STUCK BEYOND GRACE / STALE: / MISSING: contract used by the other cards.
const REPAIR_PROPOSAL_MARKER = 'REPAIR PROPOSAL';

// What we say when the builder recorded only a process exit code. This is the
// exact string the two-day-stuck row carried: it names the wrapper's exit
// status and not one word about why YouTube refused, which is why the row was
// undiagnosable from the manifest alone.
const UNDIAGNOSED_BLOCKER = 'build failed without recording a cause';

function isExitCodeOnly(reason) {
  // "python3 exited 1", "source video download failed: python3 exited 1".
  return /(?:^|:\s*)\S+ exited -?\d+\s*$/.test(String(reason || '').trim());
}

/**
 * Does this row carry an unconsumed build-failure marker?
 *
 * Terminal deletion wins over everything: a tombstoned id is never repairable,
 * never proposed, and never resurrected by a later manifest rebuild.
 */
function isRepairRequired(video) {
  if (!video || typeof video !== 'object') return false;
  if (isTerminallyExcludedFromStuckScan(video)) return false;
  return video.repair_required === true || String(video.status || '') === REPAIR_STATUS;
}

/**
 * The honest blocker, in ExampleCo's words not the shell's. Falls back to a plain
 * statement that the cause was not recorded rather than dressing an exit code
 * up as a diagnosis.
 */
// 2026-08-24. yt-dlp's bot-check message is the SYMPTOM, and it reads like
// "just sign in and retry", which is the one thing that cannot work here. But
// Codex 2026-08-24 [high] was right that the 17 failed attempts do NOT isolate
// the credential as the sole cause: every one of them ran with the broken jar
// or with no jar, and downloadRange's own comment says EC2 datacenter IPs are
// blocked regardless. So do not hardcode a cause. Read the CURRENT credential
// and report only what that evidence supports.
const BOT_CHECK_SIGNATURE = /sign in to confirm you.{0,3}re not a bot/i;
// Kept short on purpose: the card face summarizes to roughly 120 characters,
// and the long-form evidence belongs in the health probe steps.
const BOT_CHECK_CAUSE_BAD_JAR =
  'EC2 cookie jar is logged out (no LOGIN_INFO). Retrying cannot fix it; needs a cookies.txt re-export.';
const BOT_CHECK_CAUSE_UNKNOWN_CREDENTIAL =
  'YouTube refused the download as a bot; the credential could not be checked, so the cause is unconfirmed.';
const BOT_CHECK_CAUSE_UNPROVEN =
  'YouTube refused the download as a bot even though the cookie jar looks signed in. Cause not yet isolated.';

// Codex 2026-08-24 v2 [high]: do NOT map every failing verdict to "logged out".
// A missing file, a staging failure, or a probe that could not run are all
// different problems, and only the actually-unauthenticated one warrants
// telling ExampleCo to re-export. Anything else is reported as unconfirmed.
function botCheckCause(opts = {}) {
  let verdict = null;
  try {
    const grade =
      opts.gradeCookieJar || require('./yt-dlp-cookie-jar.js').gradeCookieJar;
    verdict = grade(opts.jarPath);
  } catch {
    verdict = null;
  }
  if (!verdict) return BOT_CHECK_CAUSE_UNKNOWN_CREDENTIAL;
  if (verdict.ok) return BOT_CHECK_CAUSE_UNPROVEN;
  if (verdict.code === 'COOKIES_NOT_AUTHENTICATED') return BOT_CHECK_CAUSE_BAD_JAR;
  // COOKIES_MISSING, STAGE_FAILED, PROBE_INFRA_FAILED, COOKIES_PRESENT_UNVERIFIED
  return BOT_CHECK_CAUSE_UNKNOWN_CREDENTIAL;
}

function repairBlockerReason(video, opts = {}) {
  const raw = String((video && video.build_error) || '').trim();
  if (!raw) return UNDIAGNOSED_BLOCKER;
  if (BOT_CHECK_SIGNATURE.test(raw)) return botCheckCause(opts);
  if (isExitCodeOnly(raw)) return `${raw} (no cause recorded)`;
  return raw;
}

/**
 * The EXISTING build entry point, never a new one. The proposal file date is
 * recorded on the row by recordBuildFailure; without it the command cannot be
 * exact, so we say so instead of guessing a date that would fail.
 */
// Codex 2026-08-24 [high]: rows written before proposal_date existed carry no
// date, and a command containing a `<proposal date>` placeholder is not
// actionable work, it is a second write-only marker. Resolve the id against the
// proposal ledger instead, and fail CLOSED on zero or ambiguous matches so the
// card says "cannot be named" rather than blessing a command that will throw
// "proposal id not in file".
function resolveProposalDateForId(id, opts = {}) {
  const wanted = String(id || '').trim();
  if (!wanted) return '';
  const dir = opts.dir || path.join(REPO, 'data', 'agent', 'viral-tech-clips');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return '';
  }
  const hits = [];
  for (const file of files.sort()) {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    const list = Array.isArray(state && state.proposals) ? state.proposals : [];
    const row = list.find((r) => r && r.id === wanted);
    if (row) hits.push({ date: file.slice(0, 10), row });
  }
  if (!hits.length) return '';
  if (hits.length === 1) return hits[0].date;
  // The same clip id recurs across days' proposal files. The one that recorded
  // the build attempt is the only one that can reproduce the failure.
  const attempted = hits.filter(
    (h) => h.row.build_attempts || String(h.row.status || '') === 'build_failed',
  );
  return attempted.length === 1 ? attempted[0].date : '';
}

const UNRESOLVED_COMMAND = 'no runnable rebuild command: the source proposal could not be identified';

function repairProposalCommand(video, opts = {}) {
  const id = String((video && video.id) || '').trim();
  if (!id) return '';
  const date =
    String((video && video.proposal_date) || '').trim() || resolveProposalDateForId(id, opts);
  if (!date) return UNRESOLVED_COMMAND;
  return `node scripts/build-viral-clip.js --id ${id} --date ${date}`;
}

/**
 * The owner-facing proposal for one failed build: what broke, how many times,
 * and the single command that acts on it.
 */
function describeRepairProposal(video, opts = {}) {
  if (!isRepairRequired(video)) return null;
  return {
    id: String((video && video.id) || ''),
    title: String((video && video.title) || (video && video.id) || 'untitled'),
    attempts: Math.max(0, Number(video && video.build_attempts) || 0),
    blocker: repairBlockerReason(video),
    command: repairProposalCommand(video, opts),
    proposedAt: String((video && video.repair_proposal && video.repair_proposal.proposed_at) || ''),
  };
}

/**
 * One line for the card banner. Prefixed with the machine-readable marker so
 * the live render-QC can grade it independently of how the tile is painted.
 */
function repairProposalSentence(proposal) {
  if (!proposal) return '';
  const attempts = proposal.attempts === 1 ? '1 attempt' : `${proposal.attempts} attempts`;
  return (
    `${REPAIR_PROPOSAL_MARKER}: "${proposal.title}" needs your approval to rebuild ` +
    `after ${attempts}. Blocker: ${proposal.blocker}. Run: ${proposal.command}`
  );
}

/**
 * Claim every unconsumed build-failure marker in the manifest, in place.
 *
 * Claiming is what turns the write-only marker into owned work. It records the
 * proposal on the row so the card can render it and so a second scheduler tick
 * does not re-propose the same thing. It NEVER sets video_needs_regen or
 * thumbnail_needs_regen, because those are the flags the auto-regen builder
 * acts on, and acting on them here would be exactly the unattended build that
 * invariant 6 forbids.
 *
 * Re-claims only when the row changed underneath us (a further build attempt,
 * or a different blocker), so a genuine new failure is never swallowed by an
 * old proposal.
 *
 * @returns {{proposals: object[], claimed: object[], changed: boolean}}
 */
function claimRepairProposals(manifest, { now = () => new Date() } = {}) {
  const videos = Array.isArray(manifest && manifest.videos) ? manifest.videos : [];
  const proposals = [];
  const claimed = [];
  let changed = false;
  for (const video of videos) {
    if (!isRepairRequired(video)) continue;
    const attempts = Math.max(0, Number(video.build_attempts) || 0);
    const blocker = repairBlockerReason(video);
    const prior = video.repair_proposal;
    const alreadyClaimed =
      prior &&
      typeof prior === 'object' &&
      prior.attempts === attempts &&
      prior.blocker === blocker;
    if (!alreadyClaimed) {
      video.repair_proposal = {
        proposed_at: now().toISOString(),
        attempts,
        blocker,
        command: repairProposalCommand(video),
        // Propose-only: this is the record that the marker was READ, not an
        // instruction to any builder. Nothing in the build path consumes it.
        awaiting_owner_approval: true,
      };
      changed = true;
      claimed.push(video);
    }
    proposals.push(describeRepairProposal(video));
  }
  return { proposals, claimed, changed };
}

module.exports = {
  BOT_CHECK_SIGNATURE,
  BOT_CHECK_CAUSE_BAD_JAR,
  BOT_CHECK_CAUSE_UNPROVEN,
  BOT_CHECK_CAUSE_UNKNOWN_CREDENTIAL,
  botCheckCause,
  REPAIR_STATUS,
  REPAIR_PROPOSAL_MARKER,
  UNDIAGNOSED_BLOCKER,
  UNRESOLVED_COMMAND,
  isRepairRequired,
  repairBlockerReason,
  repairProposalCommand,
  resolveProposalDateForId,
  describeRepairProposal,
  repairProposalSentence,
  claimRepairProposals,
};
