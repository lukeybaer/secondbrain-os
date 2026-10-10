'use strict';

// The briefing's blockers drill-down.
//
// Why this exists: the briefing's blockers list and the overnight report's red
// list used to be two different lists with different wording, so ExampleCo could not
// cross-reference them. This page renders the same work units the report
// renders, carrying the same stable ids from scripts/lib/briefing-blocker-ids.js,
// so "repropose RED-2" means the same thing on both surfaces.
//
// Copy rules come from memory/feedback_ExampleCo_communication_standard.md. The two
// that shape this file:
//   Section 6, every blocker shows three parts: what is broken including the
//   root cause, how to fix it, and impact, complexity and risk.
//   Section 6 again, an unknown root cause is stated as unknown with a
//   predicted size and what would resolve it. It is never filled with
//   plausible text.

const { assignBlockerIds, blockerItemKey } = require('./briefing-blocker-ids.js');

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

// Evidence sources that carry a real diagnosis. redRepairUnits in
// scripts/overnight-watch-report.js stamps reportReadySource with one of these
// when a controller receipt, a watcher observation, or a card lifecycle event
// was available. Anything else means the strings on the item are a
// late-assembly restatement of the symptom, not a researched root cause.
const RESEARCHED_EVIDENCE_SOURCES = new Set([
  'controller-receipt',
  'watcher-observation',
  'card-lifecycle-event',
]);

function hasResearchedEvidence(item = {}) {
  if (RESEARCHED_EVIDENCE_SOURCES.has(text(item.reportReadySource))) return true;
  if (item.reportReadyEvidence === true) return true;
  return false;
}

// Is there a real root cause for this blocker, or do we only know the symptom?
// Returning the honest answer is the whole job here. Anything that reads like a
// root cause but is really a restatement gets reported as unknown.
function rootCauseState(item = {}) {
  const reflection = item.standingReflection || {};
  const candidate = text(reflection.rootCause || item.rootCause);
  const researched = hasResearchedEvidence(item);
  const id = text(item.id) || text(item.title) || 'this blocker';

  if (researched && candidate) {
    return {
      known: true,
      text: candidate,
      predictedSize: text(item.impactComplexityRisk) || '',
      whatWouldResolve: '',
    };
  }

  // Unknown. Say so, give a predicted size when one was actually produced, and
  // name the evidence that would settle it. Never guess the cause.
  const predictedSize =
    text(item.predictedSize) ||
    text(item.predictedImpact) ||
    'Predicted size: not yet estimated, because the cause is still unknown.';
  return {
    known: false,
    text: `The root cause is not yet known. Amy recorded the symptom for ${id} but no run produced a diagnosis for it.`,
    predictedSize: predictedSize.toLowerCase().startsWith('predicted size')
      ? predictedSize
      : `Predicted size: ${predictedSize}`,
    whatWouldResolve: `What would resolve it: a controller receipt or a watcher observation for ${id} that carries its own diagnosis. Until one exists, the cause stays unknown rather than guessed.`,
  };
}

// The three mandatory parts. Every one is always populated, because a blank
// slot on this page would be the same failure as inventing text for it.
function blockerThreeParts(item = {}) {
  const reflection = item.standingReflection || {};
  const cause = rootCauseState(item);
  const id = text(item.id) || text(item.title) || 'this blocker';

  const symptom =
    text(item.whyRed) ||
    text(reflection.diagnosis) ||
    `${id} was still red when the night ended, and its owning evidence did not say more than that.`;

  const whatIsBroken = cause.known
    ? `${symptom} Root cause: ${cause.text}`
    : `${symptom} ${cause.text}`;

  const proposedFix = text(item.makeGreen) || text(reflection.nextFix);
  const howToFix = cause.known
    ? proposedFix ||
      `No fix has been proposed for ${id} yet. The next step is to read its owning producer evidence and propose one.`
    : `${cause.whatWouldResolve} Diagnosis comes first, so there is no proposed fix for ${id} yet.${
        proposedFix ? ` The last recorded next step was: ${proposedFix}` : ''
      }`;

  const impactComplexityRisk = cause.known
    ? text(item.impactComplexityRisk) ||
      `Impact, complexity and risk are not yet estimated for ${id}. The root cause is known, so the estimate is the next thing to produce.`
    : `${cause.predictedSize} Complexity and risk cannot be honest numbers until the cause is found.`;

  return { whatIsBroken, howToFix, impactComplexityRisk, rootCauseKnown: cause.known };
}

const REGISTERS = [
  {
    kind: 'red',
    heading: 'Cards still red',
    blurb:
      'Briefing cards and health measurements that ended the night red. Same ids as the overnight report.',
  },
  {
    kind: 'watcher',
    heading: 'Watcher interventions',
    blurb:
      'Where the overnight watcher had to step in, and whether the cause was fixed so it does not recur.',
  },
  {
    kind: 'strategic',
    heading: 'Strategic fixes',
    blurb: 'Changes that remove a whole class of failure rather than one instance.',
  },
  {
    kind: 'token',
    heading: 'Token reduction',
    blurb: 'The largest token costs and what would cut them. Top five only.',
  },
];

function renderBlocker(item) {
  const parts = blockerThreeParts(item);
  const title = escapeHtml(text(item.title) || text(item.id) || 'Untitled blocker');
  const workUnitId = escapeHtml(text(item.id) || text(blockerItemKey(item)));
  const causeClass = parts.rootCauseKnown ? 'root-cause-known' : 'root-cause-unknown';
  return `<article class="blocker-item ${causeClass}" data-blocker-id="${escapeHtml(item.stableId)}" data-work-unit-id="${workUnitId}" data-item="${escapeHtml(item.stableId)}">
<header class="blocker-head"><span class="blocker-id">${escapeHtml(item.stableId)}</span><h3 class="blocker-title">${title}</h3><code class="blocker-unit">${workUnitId}</code></header>
<section class="blocker-part blocker-part-what"><h4>What is broken</h4><p class="blocker-part-body">${escapeHtml(parts.whatIsBroken)}</p></section>
<section class="blocker-part blocker-part-fix"><h4>How to fix it</h4><p class="blocker-part-body">${escapeHtml(parts.howToFix)}</p></section>
<section class="blocker-part blocker-part-impact"><h4>Impact, complexity and risk</h4><p class="blocker-part-body">${escapeHtml(parts.impactComplexityRisk)}</p></section>
</article>`;
}

function renderRegister(register, items) {
  if (!items.length) return '';
  return `<section class="blocker-register blocker-register-${register.kind}">
<h2>${escapeHtml(register.heading)}</h2>
<p class="blocker-register-blurb">${escapeHtml(register.blurb)}</p>
${items.map((item) => renderBlocker(item)).join('\n')}
</section>`;
}

// Render the whole drill-down. Pass the same ordered lists the overnight report
// was given and the ids will match it item for item.
function renderBlockersDrilldown({
  date,
  red = [],
  watcher = [],
  strategic = [],
  token = [],
} = {}) {
  const assigned = assignBlockerIds({ red, watcher, strategic, token });
  const total = REGISTERS.reduce((sum, register) => sum + assigned[register.kind].length, 0);
  const asOf = escapeHtml(String(date || '').slice(0, 10) || 'unknown');

  if (!total) {
    return `<div class="blockers-drilldown" data-as-of="${asOf}">
<p class="blockers-empty">No blockers for ${asOf}. Every card and health measurement finished green, and the watcher recorded no intervention.</p>
</div>`;
  }

  const body = REGISTERS.map((register) => renderRegister(register, assigned[register.kind]))
    .filter(Boolean)
    .join('\n');

  return `<div class="blockers-drilldown" data-as-of="${asOf}">
<p class="blockers-lede">${total} open blocker${total === 1 ? '' : 's'} for ${asOf}. Every id below is the same id the overnight report uses, so you can reply by number.</p>
${body}
</div>`;
}

module.exports = {
  RESEARCHED_EVIDENCE_SOURCES,
  hasResearchedEvidence,
  rootCauseState,
  blockerThreeParts,
  renderBlocker,
  renderBlockersDrilldown,
};
