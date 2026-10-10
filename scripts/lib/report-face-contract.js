'use strict';

// The overnight report's visible face is a locked contract: four sections, in
// order, every time.
//
// 2026-08-17 (#gap from ExampleCo): the generated report renders all locked sections, because
// the headings are literals in the template. But when generation FAILS, a
// substitute gets hand-authored and delivered instead, and that substitute is
// bound by nothing. That is exactly what happened: the packet builder threw, a
// hand-written report went out, and the 24-hour token spend section simply was
// not in it. ExampleCo noticed; no mechanism did.
//
// So the contract cannot live only in the generator's template. It has to be a
// thing any candidate report can be checked against, including one a model
// wrote by hand at 5am. That is what this module is for.

const LOCKED_FACE_SECTIONS = Object.freeze([
  '24-hour token spend Pareto and causal controls',
  'Top five strategic fixes',
  'Cards still red and what it takes to fix them',
  'Watcher interventions and what it takes to fix them',
]);
const FORBIDDEN_FACE_SECTIONS = Object.freeze([
  'Executive summary',
  'Research method and limits',
]);

// A heading with nothing under it satisfies a grep and fails the owner, so a
// section counts as present only when it carries some rendered content before
// the next section starts.
const MIN_SECTION_CONTENT_CHARS = 40;

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Locate each locked section and measure what sits under it. Headings are
// matched on their text rather than an exact tag so a substitute report using
// h1/h2/h3 still passes; the contract is about the content reaching ExampleCo, not
// about markup.
function findSection(html, title) {
  const source = String(html || '');
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp('<h[1-6][^>]*>\\s*' + escaped + '\\s*</h[1-6]>', 'i');
  const match = heading.exec(source);
  if (!match) return { present: false, contentChars: 0, index: -1 };
  const after = source.slice(match.index + match[0].length);
  const nextHeading = /<h[1-6][^>]*>/i.exec(after);
  const body = nextHeading ? after.slice(0, nextHeading.index) : after;
  return { present: true, contentChars: stripTags(body).length, index: match.index };
}

// Returns { ok, missing, empty, outOfOrder, unexpected }. Never throws: a validator that dies on odd
// input is one more thing that can silently stop protecting the contract.
function validateReportFace(html) {
  const missing = [];
  const empty = [];
  const outOfOrder = [];
  const unexpected = [];
  let previousIndex = -1;
  for (const title of LOCKED_FACE_SECTIONS) {
    const section = findSection(html, title);
    if (!section.present) missing.push(title);
    else {
      if (section.contentChars < MIN_SECTION_CONTENT_CHARS) empty.push(title);
      if (section.index < previousIndex) outOfOrder.push(title);
      previousIndex = Math.max(previousIndex, section.index);
    }
  }
  for (const title of FORBIDDEN_FACE_SECTIONS) {
    if (findSection(html, title).present) unexpected.push(title);
  }
  return {
    ok:
      missing.length === 0 &&
      empty.length === 0 &&
      outOfOrder.length === 0 &&
      unexpected.length === 0,
    missing,
    empty,
    outOfOrder,
    unexpected,
  };
}

// One line a human or a gate can read.
function describeReportFace(result) {
  if (result.ok) return 'report face OK: all four locked sections present with content';
  const parts = [];
  if (result.missing.length) parts.push('missing: ' + result.missing.join('; '));
  if (result.empty.length) parts.push('present but empty: ' + result.empty.join('; '));
  if (result.outOfOrder.length) parts.push('out of order: ' + result.outOfOrder.join('; '));
  if (result.unexpected.length) parts.push('retired section present: ' + result.unexpected.join('; '));
  return 'report face INCOMPLETE, ' + parts.join(' | ');
}

module.exports = {
  FORBIDDEN_FACE_SECTIONS,
  LOCKED_FACE_SECTIONS,
  MIN_SECTION_CONTENT_CHARS,
  validateReportFace,
  describeReportFace,
};
