'use strict';

/**
 * Canonical VERDICT-line parser shared by every consumer of a Codex
 * peer-review receipt: scripts/codex-peer-review.js (does a real verdict
 * exist at all), scripts/claude-hooks/two-bot-gate.mjs (does it say approve),
 * and scripts/verify-public-sync-approval.js (does it say approve).
 *
 * Codex adversarial review, 2026-08-24 (critical finding on the fix for this
 * very gate): the review prompt's own format-instruction line reads
 * `VERDICT: approve | changes-required | blocked`. A reviewer legitimately
 * quotes that line when discussing the contract (exactly what happened while
 * describing this fix). The OLD parser in two-bot-gate.mjs and
 * verify-public-sync-approval.js was `/^\s*VERDICT:\s*([a-z-]+)/im`, which
 * finds the FIRST line starting with "VERDICT:" anywhere in the text and
 * takes whatever word follows. Against the instruction line, that captures
 * "approve" -- so a review whose REAL conclusion, stated later in a proper
 * standalone line, was "changes-required" or "blocked" could be misread as
 * approve if the instruction line happened to appear earlier. That silently
 * defeats the entire gate: `changes-required` becomes `approve`.
 *
 * The fix: scan every line. A line counts as a REAL verdict line only when it
 * starts with "VERDICT:" and names EXACTLY ONE of the three known keywords
 * anywhere in the rest of that line (trailing punctuation or a short aside is
 * fine; a second keyword on the same line is the multi-choice instruction
 * shape, not a real answer, so that line is skipped instead of accepted).
 * Require exactly one DISTINCT real verdict across the whole text; disagreement
 * between multiple real lines is ambiguous and returns 'unknown' rather than
 * guessing, and agreement across as many as they is fine (they all just say
 * the same word again).
 */

const KNOWN_VERDICTS = ['approve', 'changes-required', 'blocked'];
const VERDICT_LINE_START_RE = /^[ \t]*VERDICT:[ \t]*/i;
const KNOWN_SEVERITIES = ['critical', 'high', 'medium', 'low'];
const FINDINGS_HEADING_RE = /^[ \t]*FINDINGS:[ \t]*$/i;
// Any line that starts with the word FINDINGS (with or without a colon, with
// trailing text) but is not the exact heading above. Such a line is an
// attempted heading and makes the section invalid rather than absent.
// No word boundary: FINDINGS_EXTRA:, FINDINGS2:, and FINDINGSS: are attempted
// headings too (Codex round 4, 2026-09-03). Unicode whitespace counts as
// indentation, so an NBSP-indented heading is still a heading (round 5).
const ATTEMPTED_FINDINGS_HEADING_RE = /^\s*FINDINGS/i;
const CLEAN_FINDINGS_HEADING_RE = /^\s*FINDINGS:\s*$/i;
// Every default-ignorable code point (zero-width joiners and spaces,
// variation selectors, U+034F, soft hyphen, ...) plus control characters is
// invisible. Lines are cleaned of these BEFORE heading detection, so
// "FIND<zero-width>INGS:" is still an attempted heading, and finding text
// made only of them is empty (Codex rounds 4 and 5, 2026-09-03).
const INVISIBLE_RE = /[\p{Default_Ignorable_Code_Point}\p{Cc}]/gu;
function cleanLine(line) {
  return String(line).replace(INVISIBLE_RE, '');
}
// A standalone label line ("OPEN QUESTIONS:", "TESTS/RISK:", a repeated
// "FINDINGS:", ...) that closes the findings body. Deliberately generic
// (letters/digits/spaces/slashes ending in a bare colon) rather than an
// enumerated list of the known headings, so a future section name still ends
// the body instead of being absorbed as findings prose.
const SECTION_HEADING_RE = /^[ \t]*[A-Za-z][A-Za-z0-9 /]*:[ \t]*$/;
const FINDING_BULLET_RE = /^-\s*\[(critical|high|medium|low)\][ \t]*(.*)$/i;
const NONE_BULLET_RE = /^-\s*none\b/i;

/** Every standalone, single-outcome VERDICT line in the text, lowercased. */
function realVerdictLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  const found = [];
  for (const line of lines) {
    const m = VERDICT_LINE_START_RE.exec(line);
    if (!m) continue;
    const rest = line.slice(m[0].length);
    const keywords = KNOWN_VERDICTS.filter((kw) => new RegExp(`\\b${kw}\\b`, 'i').test(rest));
    if (keywords.length === 1) found.push(keywords[0].toLowerCase());
  }
  return found;
}

/** true when the text contains at least one unambiguous real verdict line. */
function hasRealVerdict(text) {
  return realVerdictLines(text).length > 0;
}

/**
 * 'approve' | 'changes-required' | 'blocked' | 'unknown'.
 * 'unknown' covers: no real verdict line found, or multiple real verdict
 * lines that disagree with each other.
 */
function parseVerdict(text) {
  const lines = realVerdictLines(text);
  if (lines.length === 0) return 'unknown';
  const distinct = new Set(lines);
  if (distinct.size > 1) return 'unknown';
  return lines[0];
}

/**
 * Parse the ONE "FINDINGS:" section of a review into structured
 * `{severity, text}` records, instead of trusting that a "FINDINGS:" heading
 * being present anywhere in the text means the findings are usable.
 *
 * Codex adversarial review, 2026-09-03 (high, plan-review receipt 7321a4a75add):
 * "the findings parser is under-specified. A present FINDINGS: heading
 * containing malformed bullets, an unknown severity, or multiple headings
 * could produce an empty severity list and incorrectly mean 'no highs.'"
 * Receipt validation before this only required `hasFindingsSection` (a bare
 * substring test), so a malformed body silently graded as zero findings,
 * which is indistinguishable from a genuinely clean review to a caller that
 * only checks "any critical/high present?".
 *
 * Codex adversarial review, 2026-09-03 (high, code review 5e1473893570): a
 * bare `null` return conflated two different situations -- a review that
 * never had a FINDINGS section at all (a legacy/free-form review; an
 * `approve` verdict may still be trusted) versus one whose section IS
 * present but malformed or duplicated (never safe to trust, for ANY
 * verdict). Every caller that treated `null` as "legacy, therefore valid"
 * was thereby also treating a self-contradictory or duplicated FINDINGS
 * section as valid. This now returns a discriminated result so a caller can
 * tell the two apart and only the genuinely-absent case gets any legacy
 * benefit of the doubt:
 *   - `{status: 'absent'}` -- no standalone "FINDINGS:" heading line at all.
 *   - `{status: 'invalid', reason}` -- a heading exists but the section
 *     cannot be trusted: more than one heading (ambiguous: which one is THE
 *     section?), or a non-blank body line that is neither a recognized
 *     `- [severity] ...` bullet nor a `- None...` bullet (unrecognized
 *     severity word, missing bracket, stray prose).
 *   - `{status: 'ok', findings}` -- exactly one heading, every body line
 *     recognized.
 *
 * A `- None...` bullet (case-insensitive; the exact shape this repo's real
 * "clean" receipts use, e.g. "- None. The exact `Infinity` invariant is
 * pinned at ...") contributes nothing and is not an error -- it is how a
 * real reviewer with zero findings fills the required bullet.
 *
 * The section body ends at the next standalone label line (SECTION_HEADING_RE:
 * "OPEN QUESTIONS:", "TESTS/RISK:", a repeated "FINDINGS:", or any future
 * section name shaped like it) or at the end of the text, whichever comes
 * first. Blank lines inside the body are skipped, not errors.
 *
 * @returns {{status:'absent'}|{status:'invalid',reason:string}|{status:'ok',findings:Array<{severity:string,text:string}>}}
 */
function parseFindings(reviewText) {
  const lines = String(reviewText || '').split(/\r?\n/);

  const headingIdx = [];
  const attemptedHeadings = [];
  lines.forEach((line, i) => {
    const clean = cleanLine(line);
    // Exact acceptance stays strict: a heading that only becomes exact after
    // invisible characters are removed is an attempted heading, not the real
    // one. Unicode whitespace indentation alone is still exact.
    const hadInvisible = clean !== line;
    if (FINDINGS_HEADING_RE.test(line) || (!hadInvisible && CLEAN_FINDINGS_HEADING_RE.test(clean)))
      headingIdx.push(i);
    else if (ATTEMPTED_FINDINGS_HEADING_RE.test(clean)) attemptedHeadings.push(i);
  });
  // Codex round 3 (2026-09-03): "FINDINGS: malformed" used to read as absent,
  // and absent is the legacy pass for approve. A line that is trying to be the
  // findings heading but is not exact is invalid, never absent.
  if (headingIdx.length === 0 && attemptedHeadings.length > 0) {
    return {
      status: 'invalid',
      reason: `malformed "FINDINGS:" heading line: ${JSON.stringify(lines[attemptedHeadings[0]])}`,
    };
  }
  if (headingIdx.length === 0) return { status: 'absent' };
  if (attemptedHeadings.length > 0) {
    return {
      status: 'invalid',
      reason: `malformed "FINDINGS" heading alongside the real one: ${JSON.stringify(lines[attemptedHeadings[0]])}`,
    };
  }
  if (headingIdx.length > 1) {
    return {
      status: 'invalid',
      reason: `${headingIdx.length} "FINDINGS:" headings found; exactly one is allowed`,
    };
  }

  let end = lines.length;
  for (let i = headingIdx[0] + 1; i < lines.length; i += 1) {
    if (SECTION_HEADING_RE.test(cleanLine(lines[i]))) {
      end = i;
      break;
    }
  }

  const findings = [];
  for (let i = headingIdx[0] + 1; i < end; i += 1) {
    const trimmed = cleanLine(lines[i]).trim();
    if (!trimmed) continue; // blank line inside the body: not an error
    const bullet = FINDING_BULLET_RE.exec(trimmed);
    if (bullet) {
      const text = bullet[2].replace(INVISIBLE_RE, '').trim();
      // Codex round 3 (2026-09-03): "- [medium]" with no text parsed as one
      // valid finding, so changes-required could unlock a gate without naming
      // any issue. A severity tag without visible finding text is invalid.
      if (!text) {
        return {
          status: 'invalid',
          reason: `finding bullet has a severity but no text: ${JSON.stringify(lines[i])}`,
        };
      }
      findings.push({ severity: bullet[1].toLowerCase(), text });
      continue;
    }
    if (NONE_BULLET_RE.test(trimmed)) continue; // "- None..." -> no finding, not an error
    return {
      status: 'invalid',
      reason: `unrecognized findings line, not a "- [severity] ..." or "- None" bullet: ${JSON.stringify(lines[i])}`,
    };
  }
  return { status: 'ok', findings };
}

module.exports = {
  KNOWN_VERDICTS,
  KNOWN_SEVERITIES,
  realVerdictLines,
  hasRealVerdict,
  parseVerdict,
  parseFindings,
};
