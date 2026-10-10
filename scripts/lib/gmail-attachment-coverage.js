'use strict';

// Coverage metric for the Gmail attachment indexing backlog loop.
//
// Shape is deliberately borrowed from the Signal history loop's
// `amy.signal.history-attachment-coverage.v1` artifact (see
// data/signal/history/runs/*/attachment-coverage.json). Signal solved the same
// problem first: a long backlog of attachments where a single blended success
// rate lies in both directions. It undercounts by charging the parser for files
// that legitimately carry no text (rendering artifacts, contextual images), and
// it overcounts by treating recoverable work as finished merely because it was
// classified.
//
// The rules that make this honest:
//   - The denominator is text-bearing payloads only.
//   - Classified-but-unexecuted retries are pending work, never coverage.
//   - An undrained backlog can never render green.
//   - An empty denominator yields null, never a fabricated 100%.

const SCHEMA = 'amy.gmail.attachment-index-coverage.v1';

// A payload is text-bearing when the pipeline expects to get characters out of
// it. Everything else is inspected and legitimately silent.
const SEARCHABLE = new Set(['searchable_document', 'searchable_structured_event']);
const RETRY_PENDING = new Set([
  'retry_ocr_or_alternate_parser',
  'retry_or_owner_unlock',
  // Surfaced first by the full 3,129-message corpus on 2026-08-16; the 660-message
  // stage-1 slice never produced one. XFA is a LiveCycle dynamic-form PDF whose
  // content lives in an XML payload pypdf does not read, so it is recoverable
  // work like any other retry, not a failure.
  'retry_xfa_or_alternate_parser',
]);
// A quarantined payload is a security hold, not a parse outcome. It must never
// count as covered (no text was extracted) and never as failed (nothing broke).
const QUARANTINED = new Set(['quarantine_untrusted_template']);

// Correctly skipped, and therefore NOT defects.
//
// ExampleCo, 2026-08-16: "you can skip the password required ones, that's correctly
// skipped." He is right, and the earlier design was wrong to hold the row red
// for them. The rule this encodes: green means THE LOOP DID EVERYTHING IT CAN
// DO. A file that needs a password Amy does not have, or that is genuinely
// corrupt, is a named and counted skip, not a failure to fix. Reporting it as a
// defect forever trains the eye to ignore the colour, which is worse than
// having no colour at all.
//
// What still goes red is anything the loop SHOULD have handled and did not:
// a repairable extraction error, an unclassified disposition, or a retry that
// was labelled but never actually attempted.
const OWNER_ACTION = new Set(['blocked_owner_unlock']);
const UNRECOVERABLE = new Set(['unrecoverable_no_text', 'unrecoverable_corrupt']);
const INSPECTED_NO_TEXT = new Set([
  'drop_rendering_artifact',
  'context_only_image',
  'preserve_contextual_image',
  'preserve_unparsed',
  // Emitted by the incremental stage for a payload it inspected that yielded no
  // usable text. Same meaning as the batch names above; the incremental path
  // simply does not run the full classifier. Added after the guard correctly
  // went red on 605 rows carrying it, which is the vocabulary drift this set
  // exists to catch.
  'inspected_no_text',
]);

function buildCoverage({
  rows = [],
  messagesIndexed = 0,
  messagesEligible = 0,
  failureRows = 0,
  failureBuckets = null,
  manifest = null,
  generatedAt = null,
} = {}) {
  const statusCounts = {};
  let searchableTextPayloads = 0;
  let retryPendingPayloads = 0;
  let inspectedNoTextPayloads = 0;
  let quarantinedPayloads = 0;
  let ownerActionPayloads = 0;
  let unrecoverablePayloads = 0;
  let unclassifiedPayloads = 0;
  let searchableTextCharacters = 0;
  let physicalFiles = 0;

  for (const row of rows) {
    const disposition = String(row.disposition || 'unclassified');
    statusCounts[disposition] = (statusCounts[disposition] || 0) + 1;
    physicalFiles += Number(row.occurrence_count || 1);

    if (SEARCHABLE.has(disposition)) {
      searchableTextPayloads += 1;
      searchableTextCharacters += Number(row.extracted_characters || 0);
    } else if (RETRY_PENDING.has(disposition)) {
      retryPendingPayloads += 1;
    } else if (OWNER_ACTION.has(disposition)) {
      ownerActionPayloads += 1;
    } else if (UNRECOVERABLE.has(disposition)) {
      unrecoverablePayloads += 1;
    } else if (QUARANTINED.has(disposition)) {
      quarantinedPayloads += 1;
    } else if (INSPECTED_NO_TEXT.has(disposition)) {
      inspectedNoTextPayloads += 1;
    } else {
      // An unrecognised disposition is not quietly folded into "inspected".
      // A new pipeline disposition must be classified deliberately, or the
      // metric would drift into overstating coverage the day it is added.
      unclassifiedPayloads += 1;
    }
  }

  const uniquePayloads = rows.length;
  // Denominator is work the loop can actually complete. Password-locked and
  // corrupt payloads are excluded, not counted as coverage Amy failed to get.
  const supportedPayloads = searchableTextPayloads + retryPendingPayloads;
  const coveredPayloads = searchableTextPayloads;
  // Only REPAIRABLE failures are defects. Password-locked and corrupt files are
  // correctly skipped and counted separately, never as things to go fix.
  const buckets = failureBuckets || {
    repairable: Number(failureRows || 0),
    ownerAction: 0,
    unrecoverable: 0,
  };
  const failedPayloads = Number(buckets.repairable || 0);
  const skippedOwnerAction = ownerActionPayloads + Number(buckets.ownerAction || 0);
  const skippedUnrecoverable = unrecoverablePayloads + Number(buckets.unrecoverable || 0);
  const backlogRemaining = Math.max(
    0,
    Number(messagesEligible || 0) - Number(messagesIndexed || 0),
  );

  // Null, not 1. Nothing text-bearing means there is no rate to report, and a
  // fabricated 100% would read as a completion claim.
  const coverageRate = supportedPayloads > 0 ? coveredPayloads / supportedPayloads : null;

  let status = 'green';
  let statusReason = 'every text-bearing payload extracted, backlog drained, no failures';
  if (failedPayloads > 0) {
    status = 'red';
    statusReason = `${failedPayloads} payload(s) failed extraction and need repair`;
  } else if (unclassifiedPayloads > 0) {
    status = 'red';
    statusReason = `${unclassifiedPayloads} payload(s) carry an unclassified disposition`;
  } else if (retryPendingPayloads > 0) {
    status = 'yellow';
    statusReason = `${retryPendingPayloads} payload(s) classified for retry (OCR, alternate parser, or owner unlock) but the recovery stage has not run`;
  } else if (backlogRemaining > 0) {
    status = 'yellow';
    statusReason = `${backlogRemaining} eligible message(s) remain in the indexing backlog`;
  } else {
    const skips = [];
    if (skippedOwnerAction) skips.push(`${skippedOwnerAction} need an owner password`);
    if (skippedUnrecoverable) skips.push(`${skippedUnrecoverable} unreadable`);
    if (quarantinedPayloads) skips.push(`${quarantinedPayloads} quarantined`);
    statusReason = skips.length
      ? `everything indexable is indexed; skipped ${skips.join(', ')}`
      : 'every text-bearing payload extracted, backlog drained, no failures';
  }

  return {
    schema: SCHEMA,
    status,
    statusReason,
    generated_at: generatedAt || new Date().toISOString(),
    manifest,
    messagesIndexed: Number(messagesIndexed || 0),
    messagesEligible: Number(messagesEligible || 0),
    backlogRemaining,
    physicalFiles,
    uniquePayloads,
    deduplicatedPhysicalFiles: Math.max(0, physicalFiles - uniquePayloads),
    supportedPayloads,
    coveredPayloads,
    coverageRate,
    searchableTextPayloads,
    inspectedNoTextPayloads,
    quarantinedPayloads,
    skippedOwnerAction,
    skippedUnrecoverable,
    retryPendingPayloads,
    unclassifiedPayloads,
    failedPayloads,
    statusCounts,
    searchableTextCharacters,
  };
}

module.exports = {
  buildCoverage,
  SCHEMA,
  SEARCHABLE,
  RETRY_PENDING,
  INSPECTED_NO_TEXT,
  QUARANTINED,
};
