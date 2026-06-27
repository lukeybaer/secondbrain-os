#!/usr/bin/env node
/**
 * briefing-clean-contract.js
 *
 * ONE source of truth for the briefing one-Amy / clean contract, imported by
 * BOTH the renderers (manual-briefing-v3.js, refresh-briefing-generated-sections.js)
 * and the validator (validate-briefing-quality.js) so they can never drift
 * (Codex review #3: separate self-talk patterns in two files is a drift bug).
 *
 * The principle ExampleCo states repeatedly: Amy FIXES defects, she does not narrate
 * what she would do or say "Amy owns" it. A card is EITHER green (Amy fixed it,
 * no narration) OR it shows a precise Need from ExampleCo (a real credential/decision)
 * OR a factual Status of what is genuinely down. Never self-talk.
 */

// Phrases that are Amy talking to herself / narrating, banned ANYWHERE in the
// briefing (System Health attention drilldown, BLOCKERS, every card). These are
// the exact strings ExampleCo has flagged on the live dashboard plus their siblings.
const SELF_NARRATION_BAN = [
  /\bAmy owns\b/i,
  /\bAmy must\b/i,
  /\bAmy will\b/i,
  /\bAmy is fixing this now\b/i,
  /\bwhy I could ?n.?t fix it\b/i,
  /\bcould not fix it\b/i,
  /\bcouldn['’]t fix it\b/i,
  /\bAmy-owned repair\b/i,
  /\bowning card worker\b/i,
  /\bcard owner\b/i,
  /\bRoute this defect\b/i,
  /\bRelentless iteration\b/i,
  /\bRepair now\b/i,
  /\bPlan \+ ETA\b/i,
  /\bwhat I tried\b/i,
  /^\s*next action:/im,
  /^\s*Owner:\s*Amy\b/im,
  /\bmid-self-heal\b/i,
  /\bheal loop\b/i,
  /\bI could not self-heal\b/i,
];

// A real ExampleCo action exists only when the need names one of these. Otherwise
// the card is Amy-fixable and must be REPAIRED, never shown as a Need.
const REAL_ExampleCo_ACTION_RE =
  /\b(log ?in|sign[- ]?in|re-?auth(?:oriz\w*)?|authoriz\w*|credential|password|2fa|mfa|captcha|approve|approval|decide|decision\b|consent|sign\b|signature|interview|in[- ]?person|wire transfer|notar)\b/i;

// Returns the list of banned phrases found in a block of briefing text, with
// the matched phrase, so the validator can report exactly what leaked and the
// renderers can self-check before writing.
function findSelfNarration(text) {
  const s = String(text || '');
  const hits = [];
  for (const re of SELF_NARRATION_BAN) {
    const m = s.match(re);
    if (m) hits.push(m[0].trim());
  }
  return hits;
}

// True when a need string names a genuine ExampleCo action (and is not a self-talk
// "Nothing, Amy owns ..." fallback).
function isRealExampleCoAction(need) {
  const n = String(need || '').trim();
  if (!n) return false;
  if (/^(nothing|none)\b/i.test(n)) return false;
  if (findSelfNarration(n).length > 0) return false;
  return REAL_ExampleCo_ACTION_RE.test(n);
}

// Scrub residual Amy-verb self-narration out of an otherwise-factual sentence,
// so a status line that says "X is down. Amy owns restarting it." becomes
// "X is down." Renderers run their Status text through this as a backstop.
function scrubSelfNarration(text) {
  let s = String(text || '');
  // Drop whole sentences that are pure self-narration.
  s = s.replace(/\b(Amy (owns|must|will)|I could ?n.?t fix|why I could)[^.]*\.?/gi, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

// Lines whose trimmed content STARTS with one of these labels are Amy talking
// to herself about what she would do next. Dropped wholesale at write time so
// no card narrates its own repair plan. (A card states facts + a real ExampleCo ask
// only; "the next overnight run must ..." is self-talk.)
const SELF_INSTRUCTION_LINE_RE =
  /^\s*(?:Next action|What I tried|Plan \+ ETA|Plan and ETA|Relentless iteration verdict|Why I could ?n.?t fix it|Why I couldn['’]t fix it|Amy-owned repair|Repair now|Owner:\s*Amy|Requirement|Risk if not fixed|Current wall)\b\s*:?/i;

// Amy-verb clauses scrubbed from within an otherwise-factual line. Includes
// "Amy-owned <X>" self-labels (e.g. "Amy-owned failure: ...", "Amy-owned
// repair: ...") which are Amy narrating ownership of its own work.
const AMY_VERB_CLAUSE_RE =
  /\b(Amy (?:owns|must|will|reran|is fixing|fixes|checks|adds|keeps)|Amy-owned\b|I could ?n.?t fix|why I could)\b[^.]*\.?/gi;

/**
 * Durable write-time backstop: scrub an entire briefing markdown of Amy
 * self-narration so a card that leaks self-talk can never reach the dashboard,
 * regardless of which generator produced it. Drops self-instruction LINES and
 * scrubs Amy-verb CLAUSES from the rest. The ban targets are Amy-status text and
 * never appear in legit news/content, so this is safe over the whole file. The
 * validator bans the same phrases, so render and gate stay in lockstep.
 */
function scrubBriefingMarkdown(md) {
  const out = [];
  for (const rawLine of String(md || '').split('\n')) {
    if (SELF_INSTRUCTION_LINE_RE.test(rawLine)) continue; // drop the whole line
    let line = rawLine.replace(AMY_VERB_CLAUSE_RE, '');
    line = line.replace(/\bAmy is fixing this now\.?/gi, '');
    // Drop a "Need:" / "Need from ExampleCo:" line that, after scrubbing, names no
    // real ExampleCo action (empty, or just "Nothing"/"None" boilerplate). A card
    // that needs nothing from ExampleCo shows no Need line at all.
    if (/^\s*Need(?:\s+from\s+ExampleCo)?:\s*(?:nothing|none)?[\s,.]*$/i.test(line)) continue;
    line = line.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/g, '');
    out.push(line);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Honesty ladder + output-QC (ExampleCo 2026-06-19, feedback_qc_at_output_level.md)
//
// A blocked card's status is GENERATED from the heal artifact and sits on the
// most specific honesty rung the evidence supports, never hand-written self-talk:
//   L1 = a specific owner/ExampleCo action (a real wall only ExampleCo can clear)
//   L2 = broken for a known, identifiable reason self-heal could not fix
//   L3 = broken, do not know why, but know WHERE (the failing component)
//   L4 = broken, self-heal failed, do not even know what part, no logs; here is
//        exactly what we do know
//
// QC asserts the OUTPUT (honest + on the right rung). Exhaustion (defect vs
// blocked) is decided upstream by scripts/self-heal/verdict.js; these functions
// are the honesty half: a card-QC failure drives the heal loop, it is not a scrub.
// ---------------------------------------------------------------------------

const LADDER_RUNGS = ['L1', 'L2', 'L3', 'L4'];

// An action only the OWNER (ExampleCo) can perform: a physical/owner-machine op, or an
// auth/decision. This is broader than REAL_ExampleCo_ACTION_RE (which is auth-only and
// stays as-is for the legacy renderers) because a real wall can be "launch X on the
// owner machine", not only a login.
const OWNER_ACTION_RE =
  /\b(owner machine|your (?:pc|machine|laptop|desktop)|log ?in|sign[- ]?in|re-?auth(?:oriz\w*)?|authoriz\w*|credential|password|2fa|mfa|captcha|approve|approval|decide|decision|consent|signature|interview|in[- ]?person|wire transfer|notar|plug in|physically|restart (?:your|the) (?:pc|machine|laptop))\b/i;

// A field that issues an instruction to Amy/herself (a script path, an internal-host
// op, an imperative repair verb) rather than stating a fact or an owner action. Used
// as a QC ASSERTION that drives the heal loop, never a scrub. The owner-machine case
// (e.g. "launch start-claude-proxy.vbs on the owner machine") is an owner action, not
// self-direction, so it is exempted when the field is an L1 owner action.
const SELF_DIRECTED_RE =
  /(\b[\w./-]*\.(?:js|cjs|mjs|sh|ps1|bat|cmd|py)\b)|(\b(?:re-?probe|backfill|drain|rerun|re-run|restart the (?:probe|worker|service)|migrate|git (?:add|commit|push)|pm2|crontab)\b)|(\bon (?:the )?(?:EC2|server|box)\b)/i;

function isOwnerAction(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (findSelfNarration(t).length > 0) return false;
  return OWNER_ACTION_RE.test(t) || isRealExampleCoAction(t);
}

function isSelfDirectedField(text) {
  return SELF_DIRECTED_RE.test(String(text || ''));
}

function isRepairEvidenceNeed(text) {
  return /^Repair evidence(?: missing)?:/i.test(String(text || '').trim());
}

// Classify the honesty rung from a normalized heal record for an EXHAUSTED-but-red
// subsystem. healRecord: { target, detail, healed, action, note, blocker }.
function classifyHonestyRung(healRecord) {
  const r = healRecord || {};
  const note = String(r.note || '').trim();
  if (note && isOwnerAction(note)) return 'L1';
  const reason = String(r.blocker || r.detail || '').trim();
  // A specific reason (a real sentence about WHY) -> L2.
  if (reason && reason.split(/\s+/).length >= 4) return 'L2';
  // We know the component (target) but not the why -> L3.
  if (r.target) return 'L3';
  // No reason, no component, no logs -> L4 (the most honest admission).
  return 'L4';
}

// Build the honest hard-block card output from a heal record. Only for a card that
// is genuinely red AND self-heal is exhausted (verdict.js decides blocked vs defect);
// fields are sourced ONLY from the artifact, never fabricated, normalizing a missing
// action/note into an honest statement rather than inventing one.
function buildBlockedCardOutput(healRecord) {
  const r = healRecord || {};
  const rung = classifyHonestyRung(r);
  // The heal artifact itself sometimes ExampleCos self-talk (e.g. a blocker that says
  // "Amy must keep this red"). Scrub the SOURCED factual text so the generated card
  // is honest by construction; cardOutputQc still asserts the final output is clean.
  const whatBroke =
    scrubSelfNarration(String(r.detail || r.blocker || '').trim()) ||
    `${r.target || 'subsystem'} is red`;
  const whatITried =
    scrubSelfNarration(String(r.action || '').trim()) ||
    'No repair attempt was recorded for this subsystem (the probe captured no heal action).';
  const note = String(r.note || '').trim();
  const reason = scrubSelfNarration(String(r.blocker || r.detail || '').trim());
  let status;
  let whatINeed;
  switch (rung) {
    case 'L1':
      status = whatBroke;
      whatINeed = note; // a specific owner/ExampleCo action
      break;
    case 'L2':
      status = `Broken for a known reason self-heal could not fix: ${reason}`;
      whatINeed =
        'Repair evidence: named source failure, changed tactic, and new live QC result are required before this card can clear.';
      break;
    case 'L3':
      status = `Broken in ${r.target || 'this subsystem'}; the cause is not yet identified.`;
      whatINeed =
        'Repair evidence: failing component is known but cause is missing; capture the next changed tactic and new live QC result.';
      break;
    case 'L4':
    default:
      status = `Broken and self-heal failed; what part broke is not yet known and no logs were captured. Known: ${whatBroke}.`;
      whatINeed =
        'Repair evidence missing: capture the failing card, attempted repair, and next live QC result before clearing.';
      break;
  }
  return { target: r.target || null, rung, whatBroke, whatITried, status, whatINeed };
}

// A guaranteed-minimal honest block that passes cardOutputQc BY CONSTRUCTION,
// regardless of input. Every field is a fixed, self-talk-free, owner-action-free
// honest admission, and the need names the missing repair evidence. This is the
// last-resort fallback so the honest hard-block can never itself fail QC (PR3b Q5):
// when the evidence-sourced block is malformed, an honest "we know it is red but the
// captured artifact was unusable" block is still strictly better than emitting a card
// that fails its own QC. cardId only labels WHERE, it is never interpolated into a
// free-text field that QC scans, so a hostile cardId cannot reintroduce self-talk.
function guaranteedHonestBlock(cardId) {
  // cardId is kept ONLY in the unscanned `target` label field. It is NEVER interpolated
  // into whatBroke / status / whatITried / whatINeed (the fields cardOutputQc scans), so
  // even a hostile or malformed cardId carrying banned self-talk tokens cannot make this
  // block fail its own QC. The fields below are fixed, self-talk-free honest admissions,
  // which is what makes this block QC-clean BY CONSTRUCTION (PR3b Q5, Codex fail-safe).
  return {
    target: cardId || null,
    rung: 'L4',
    whatBroke: 'This card is red.',
    whatITried:
      'Self-heal ran but the captured heal artifact was unusable, so no specific repair detail is available.',
    status: 'Broken and self-heal failed; the exact cause was not captured.',
    whatINeed:
      'Repair evidence missing: capture the failing card, attempted repair, and next live QC result before clearing.',
  };
}

// Build the honest hard-block and GUARANTEE it passes cardOutputQc (PR3b Q5). The
// evidence-sourced buildBlockedCardOutput can emit a block that itself fails QC when
// the heal record ExampleCos banned self-narration that scrubSelfNarration does not fully
// strip (e.g. "Card owner", "Route this defect", "Relentless iteration", "Repair now").
// This wrapper builds the normal block, QC-checks it, and on failure falls back to the
// guaranteed-minimal honest block. A well-formed record passes through unchanged.
function safeBuildBlockedCardOutput(healRecord) {
  const r = healRecord || {};
  const block = buildBlockedCardOutput(r);
  if (cardOutputQc(block).ok) return block;
  return guaranteedHonestBlock(r.target || (block && block.target) || null);
}

// Output-QC for a blocked card. Asserts HONESTY (not self-narration, not self-directed,
// four fields present) and the two-shape need (an owner/ExampleCo action OR the literal
// a repair-evidence line). A failure is a heal trigger (loop again), not a scrub.
// Returns { ok, failures: [...], rung }.
function cardOutputQc(cardOutput) {
  const c = cardOutput || {};
  const failures = [];
  for (const f of ['whatBroke', 'whatITried', 'status', 'whatINeed']) {
    if (!String(c[f] || '').trim()) failures.push(`missing ${f}`);
  }
  for (const [name, t] of [
    ['whatBroke', c.whatBroke],
    ['status', c.status],
    ['whatITried', c.whatITried],
    ['whatINeed', c.whatINeed],
  ]) {
    const hits = findSelfNarration(t);
    if (hits.length) failures.push(`self-narration in ${name}: ${hits.join(', ')}`);
  }
  // Self-direction (a script path / imperative repair instruction) is banned in the
  // CURRENT-STATE fields (whatBroke, status) because there it reads as "future-Amy do
  // X" self-talk. whatITried is EXEMPT: it is a factual PAST report of the repair
  // actions Amy already took (which legitimately name scripts/options it tried), not
  // an instruction; it keeps only the self-narration ban above. whatINeed is handled
  // below (an L1 owner action may name a script for ExampleCo to run).
  for (const [name, t] of [
    ['whatBroke', c.whatBroke],
    ['status', c.status],
  ]) {
    if (isSelfDirectedField(t)) failures.push(`self-directed ${name}`);
  }
  const needIsOwnerAction = c.rung === 'L1' && isOwnerAction(c.whatINeed);
  const needIsRepairEvidence = !needIsOwnerAction && isRepairEvidenceNeed(c.whatINeed);
  if (!needIsOwnerAction && !needIsRepairEvidence) {
    failures.push(
      'whatINeed must be an owner/ExampleCo action (L1) or a Repair evidence line',
    );
  }
  if (!needIsOwnerAction && !needIsRepairEvidence && isSelfDirectedField(c.whatINeed)) {
    failures.push('self-directed whatINeed (not an owner action)');
  }
  if (!LADDER_RUNGS.includes(c.rung)) failures.push(`invalid rung ${c.rung}`);
  return { ok: failures.length === 0, failures, rung: c.rung };
}

module.exports = {
  SELF_NARRATION_BAN,
  REAL_ExampleCo_ACTION_RE,
  SELF_INSTRUCTION_LINE_RE,
  findSelfNarration,
  isRealExampleCoAction,
  scrubSelfNarration,
  scrubBriefingMarkdown,
  // honesty ladder + output QC (PR2a)
  LADDER_RUNGS,
  OWNER_ACTION_RE,
  isOwnerAction,
  isSelfDirectedField,
  classifyHonestyRung,
  buildBlockedCardOutput,
  guaranteedHonestBlock,
  safeBuildBlockedCardOutput,
  cardOutputQc,
};
