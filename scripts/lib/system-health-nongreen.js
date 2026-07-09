'use strict';

// ONE shared source of truth for "which SYSTEM HEALTH rows are non-green".
// The publish validator (validate-briefing-quality.js) and the cloud briefing
// generator (cloud-morning-briefing.js) BOTH parse the SYSTEM HEALTH body for
// the same set of non-green subsystem names: the dashboard counts them, and the
// validator makes sure Blockers does not duplicate them. Defining the parser once
// here keeps the two from drifting.

// Parse the SYSTEM HEALTH section for every non-green subsystem row.
// A non-green row starts with the cross/X glyph or a question glyph, then the
// subsystem name. Returns the de-duped list of bare subsystem names.
function nonGreenSubsystems(systemHealthBody) {
  const out = [];
  const text = String(systemHealthBody || '');
  const lines = text.split(/\r?\n/);
  const fileChurnWatchOnly =
    /\bFileChurn\b/i.test(text) && /watch alert,\s*not a failure/i.test(text);
  // The cloud build cannot run the test suite (tests run on the desktop and in
  // CI), so the cloud SYSTEM HEALTH card ExampleCos a "?" Tests row that is
  // INFORMATIONAL, not a failing subsystem. Treat a Tests row that explicitly
  // declares it is not evaluated on the cloud build (or runs on the desktop/CI)
  // as informational, NOT a non-green subsystem requiring a health-failure count. This
  // mirrors the FileChurn watch-only carve-out above. Category, not literal
  // trigger: any subsystem row that states on its own line that it is not
  // evaluated/measured on this build is informational. ExampleCo 2026-06-20 #gap.
  const isInformationalNotEvaluatedRow = (line) =>
    /\b(Tests|Automated regression suite)\b/i.test(line) &&
    /(not evaluated on the cloud build|run on the desktop and in ci|no current runtime proof|not (?:run|evaluated|measured) (?:live |on )|informational, not a failure)/i.test(
      line,
    );
  for (const line of lines) {
    // The "Probe detail (proof of health)" funnel is a DRILL-DOWN, not the
    // subsystem roster. Its lines (e.g. "<glyph> Otter speaker enrichment
    // probe:") look like roster rows but name the probe, not a subsystem. Once
    // we reach that block, stop scanning: a "... probe:" line was being parsed
    // as a PHANTOM subsystem ("Otter speaker enrichment probe") and inflated the
    // health count (ExampleCo 2026-06-29 green-tomorrow WAVE 1).
    // The block is always appended AFTER the roster + Attention block, so a hard
    // break is safe and never drops a real subsystem.
    if (/^\s*Probe detail \(proof of health\)\s*$/.test(line)) break;
    // A non-green row starts with the cross/X glyph or a question glyph, then
    // the subsystem name. Match both the "name: detail" and bare "name" forms
    // (the Attention block lists bare names).
    const m = line.match(/^\s*([✗?])\s+([A-Za-z][\w:\s+&/().#-]*?)\s*(?::\s+.+)?$/);
    if (m) {
      if (isInformationalNotEvaluatedRow(line)) continue;
      const name = m[2].trim().replace(/:$/, '');
      if (fileChurnWatchOnly && /^FileChurn(?: probe)?$/i.test(name)) continue;
      if (isInformationalNotEvaluatedRow(line)) continue;
      out.push(name);
    }
  }
  // De-dupe: the same subsystem appears once in the roster and again in the
  // Attention block.
  return Array.from(new Set(out));
}

// Parse the SYSTEM HEALTH section for EVERY subsystem row PRESENT in the roster,
// regardless of glyph (green checkmark, cross, or question). Used by the REVERSE
// health<->blockers consistency check: a blocker that names a subsystem the
// SYSTEM HEALTH card shows GREEN or OMITS entirely is a contradiction (ExampleCo
// 2026-07-01: BLOCKERS named "Scheduled tasks health" non-green while SYSTEM
// HEALTH showed only a green Graphiti row because the rest of the roster
// vanished). Same probe-detail cutoff + informational-Tests carve-out as
// nonGreenSubsystems so the two parsers cannot drift. Returns de-duped bare
// subsystem names.
function presentSubsystems(systemHealthBody) {
  const out = [];
  const text = String(systemHealthBody || '');
  const lines = text.split(/\r?\n/);
  const isInformationalNotEvaluatedRow = (line) =>
    /\b(Tests|Automated regression suite)\b/i.test(line) &&
    /(not evaluated on the cloud build|run on the desktop and in ci|no current runtime proof|not (?:run|evaluated|measured) (?:live |on )|informational, not a failure)/i.test(
      line,
    );
  for (const line of lines) {
    if (/^\s*Probe detail \(proof of health\)\s*$/.test(line)) break;
    // Any glyph (green checkmark, cross, question) then the subsystem name, in
    // both the "name: detail" and bare-name (Attention block) forms.
    const m = line.match(/^\s*([✓✗?])\s+([A-Za-z][\w:\s+&/().#-]*?)\s*(?::\s+.+)?$/);
    if (m) {
      if (isInformationalNotEvaluatedRow(line)) continue;
      const name = m[2].trim().replace(/:$/, '');
      out.push(name);
    }
  }
  return Array.from(new Set(out));
}

module.exports = { nonGreenSubsystems, presentSubsystems };
