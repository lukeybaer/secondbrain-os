'use strict';

// Shared by the live dashboard QC and the targeted refresh splice. A numeric
// card face needs a date/as-of proof somewhere in that card body so the metric
// reads as current evidence, not floating copy.
const FACE_HAS_NUMBER = /(?:\$\s?\d|\d+\s?%|\b\d+\b)/;
const DATE_TOKEN =
  /(?:\b\d{4}-\d{2}-\d{2}\b|\bas of\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b)/i;

function numericFaceNeedsDateStamp({ face, body } = {}) {
  return FACE_HAS_NUMBER.test(String(face || '')) && !DATE_TOKEN.test(String(body || ''));
}

module.exports = {
  FACE_HAS_NUMBER,
  DATE_TOKEN,
  numericFaceNeedsDateStamp,
};
