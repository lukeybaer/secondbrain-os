// linkedin-zero-capture.js
//
// 2026-10-08 heal: the Oct 7 cloud bulk scan visited all 89 contacts, captured
// 0 posts from every one, exited 0, and published an empty canonical intel
// pool as green. The messaging session check passed, so no auth wall was
// recorded, but the activity pages rendered nothing. A full scan where not a
// single contact yields a single post is not network silence; it is an
// unproven capture (gated activity pages or selector drift) and must fail
// closed instead of becoming the card's last good scan.

const ZERO_CAPTURE_EXIT_CODE = 3;
const MIN_CONTACTS_FOR_ZERO_CAPTURE = 10;

function classifyBulkCapture({ scanned = 0, errors = 0, postsCaptured = 0 } = {}) {
  const ok = Math.max(0, Number(scanned) - Number(errors));
  const zeroCapture = ok >= MIN_CONTACTS_FOR_ZERO_CAPTURE && Number(postsCaptured) === 0;
  return {
    zeroCapture,
    exitCode: zeroCapture ? ZERO_CAPTURE_EXIT_CODE : 0,
    detail: zeroCapture
      ? `LinkedIn bulk scan captured 0 posts from all ${ok} reachable contacts; activity pages returned no content (gated activity view or selector drift). Canonical intel not published.`
      : '',
  };
}

module.exports = {
  classifyBulkCapture,
  MIN_CONTACTS_FOR_ZERO_CAPTURE,
  ZERO_CAPTURE_EXIT_CODE,
};
