'use strict';

// Central Time face formatting for ExampleCo-facing surfaces.
//
// Rule (memory/feedback_times_in_ct_never_utc.md): every timestamp ExampleCo sees
// renders in Central Time with an explicit CT label, never raw UTC/ISO-Z.
// Machine timestamps stay ISO internally (markdown "Generated:" lines,
// artifacts, logs consumed by code); this helper converts them at the render
// face only. Born 2026-07-19 after the briefing hero showed
// "2026-07-19T10:12:52.053Z" raw in the greeting block.

const CT_TIME_ZONE = 'America/Chicago';

// An ISO-8601 timestamp with an explicit UTC/offset suffix, e.g.
// 2026-07-19T10:12:52.053Z, 2026-07-19T10:12:52Z, 2026-07-19T10:12+00:00.
// Only zoned timestamps are rewritten; bare dates (2026-07-19) and already
// humanized labels pass through untouched.
const ISO_ZONED_TIMESTAMP_RE =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g;

// "Jul 19, 5:12 AM CT" for any parseable instant; '' when unparseable.
function ctTimeLabel(value) {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : Date.parse(String(value == null ? '' : value).trim());
  if (!Number.isFinite(ms)) return '';
  return (
    new Date(ms).toLocaleString('en-US', {
      timeZone: CT_TIME_ZONE,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }) + ' CT'
  );
}

// Rewrite every embedded ISO-zoned timestamp in a ExampleCo-facing string to its
// CT-labeled equivalent. All other text passes through byte-for-byte, so it
// is safe to run over strings that are already humanized.
function ctFaceTime(raw) {
  return String(raw == null ? '' : raw).replace(
    ISO_ZONED_TIMESTAMP_RE,
    (match) => ctTimeLabel(match) || match,
  );
}

// Rewrite ISO-zoned timestamps ONLY in the visible text of a rendered HTML
// document. The exemption is structural and exact: anything inside a tag
// (attributes, including data-*) and the contents of <script>/<style> elements
// are machine-facing by contract and pass through byte-for-byte; every text
// node converts. This is the mechanical page-level guarantee behind
// memory/feedback_times_in_ct_never_utc.md for the briefing dashboard: a new
// render site added tomorrow is CT-converted without anyone remembering to
// wrap it. Idempotent (converted text contains no ISO-zoned match).
const HTML_MACHINE_SEGMENT_RE =
  /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<[^>]*>/gi;

function ctFaceHtmlVisibleText(html) {
  const raw = String(html == null ? '' : html);
  let out = '';
  let last = 0;
  HTML_MACHINE_SEGMENT_RE.lastIndex = 0;
  let m;
  while ((m = HTML_MACHINE_SEGMENT_RE.exec(raw))) {
    out += ctFaceTime(raw.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  out += ctFaceTime(raw.slice(last));
  return out;
}

module.exports = {
  CT_TIME_ZONE,
  ISO_ZONED_TIMESTAMP_RE,
  ctTimeLabel,
  ctFaceTime,
  ctFaceHtmlVisibleText,
};
