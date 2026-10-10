'use strict';

// Owner build directive for viral clip proposals (ExampleCo 2026-09-23).
//
// The dashboard "Build with feedback" button approves a proposal for build AND
// carries ExampleCo's typed note into the build as a REQUIRED directive. The
// directive is persisted on the proposal (`build_directive`), mirrored into
// `feedback` so the builder's existing directive parsers (hook:, closing:,
// music, full screen, do not say) still apply, and bound into the build
// receipt and the approval-queue row so whichever model or builder produces or
// revises the video sees it.

const BUILD_DIRECTIVE_MAX_CHARS = 1000;
const BUILD_WITH_FEEDBACK_MODE = 'build-with-feedback';

function cleanDirectiveText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, BUILD_DIRECTIVE_MAX_CHARS);
}

// Returns { mode, directive } for an approve request body. A build-with-
// feedback request without text is invalid (throws) so the button can never
// silently degrade into a plain approval.
function parseApproveRequest(body) {
  const mode = body && body.mode === BUILD_WITH_FEEDBACK_MODE ? BUILD_WITH_FEEDBACK_MODE : 'approve';
  const text = cleanDirectiveText(body && body.feedback);
  if (mode === BUILD_WITH_FEEDBACK_MODE && !text) {
    throw new Error('need feedback for build-with-feedback');
  }
  return { mode, text };
}

function applyBuildDirective(proposal, text, { at = new Date().toISOString(), source = 'briefing-dashboard' } = {}) {
  const clean = cleanDirectiveText(text);
  if (!proposal || !clean) return proposal;
  proposal.build_directive = {
    text: clean,
    required: true,
    source,
    at,
  };
  proposal.feedback = clean;
  proposal.feedback_at = at;
  return proposal;
}

// Builder side. Returns null when the proposal carries no owner directive.
function resolveBuildDirective(proposal) {
  const d = proposal && proposal.build_directive;
  if (!d || typeof d !== 'object') return null;
  const text = cleanDirectiveText(d.text);
  if (!text) return null;
  return {
    text,
    required: d.required !== false,
    source: String(d.source || 'briefing-dashboard'),
    at: d.at || null,
  };
}

// The receipt block written beside the final build. `machineAssertions` are
// the directive-fidelity assertions the builder could measure. Free text that
// no assertion covers is never reported as verified: it stays
// `owner-review-required` so the approval reviewer checks it by eye.
function buildDirectiveReceipt(directive, machineAssertions = []) {
  if (!directive) return null;
  const assertions = Array.isArray(machineAssertions) ? machineAssertions : [];
  const allPassed = assertions.length > 0 && assertions.every((a) => a && a.passed === true);
  return {
    text: directive.text,
    required: directive.required,
    source: directive.source,
    at: directive.at,
    carriedInto: ['proposal.build_directive', 'proposal.feedback', 'build metadata', 'approval queue row'],
    machineAssertionIds: assertions.map((a) => a && a.id).filter(Boolean),
    verification:
      assertions.length === 0
        ? 'owner-review-required'
        : allPassed
          ? 'machine-assertions-passed'
          : 'machine-assertions-failed',
  };
}

module.exports = {
  BUILD_DIRECTIVE_MAX_CHARS,
  BUILD_WITH_FEEDBACK_MODE,
  parseApproveRequest,
  applyBuildDirective,
  resolveBuildDirective,
  buildDirectiveReceipt,
};
