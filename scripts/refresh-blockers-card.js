#!/usr/bin/env node
/**
 * refresh-blockers-card.js
 *
 * Surgical refresh of just the BLOCKERS card in today's briefing markdown.
 * Use this after self-heal lands a fix so the briefing card reflects the
 * new state without re-running the full briefing pipeline (which is slow
 * and would rewrite clean cards).
 *
 * Logic (conservative, targeted at the test-blocker case):
 *   1. Read the briefing markdown for the given date (default: today CT).
 *   2. Identify the BLOCKERS segment using the canonical separator
 *      "\n\n---\n\n" and the "BLOCKERS - briefing quality gates:" header.
 *   3. Re-run probeTests against the freshly generated
 *      data/agent/vitest-probe-output.json. If tests are now green and the
 *      ONLY blocker in the current card was a tests/system-health-tests
 *      one, replace the section with the empty "No hard blockers" form.
 *   4. If tests is still red, splice in the latest detail; keep the rest
 *      of the BLOCKERS section unchanged.
 *
 * Anything beyond tests-blocker resolution stays the responsibility of a
 * full briefing refresh; this script only clears or refreshes the test
 * blocker so we don't have to redo the clean cards.
 *
 * Usage:
 *   node scripts/refresh-blockers-card.js [--date 2026-06-01] [--write]
 *
 * Without --write it prints the new BLOCKERS section to stdout (dry run).
 */

const fs = require('fs');
const path = require('path');
const { probeTests, syncBriefingMarkdownToEc2Dashboard } = require('./manual-briefing-v3');

const REPO = path.resolve(__dirname, '..');
const SEPARATOR = '\n\n---\n\n';
const HEADER = 'BLOCKERS - briefing quality gates:';
const CLEAN_SECTION = [
  HEADER,
  '',
  'No hard blockers need ExampleCo. Amy still validates every card before publishing.',
].join('\n');

function todayCt() {
  // CT date as YYYY-MM-DD
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(now);
}

function parseArgs(argv) {
  const out = { date: todayCt(), write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = argv[++i];
    else if (a === '--write') out.write = true;
  }
  return out;
}

function findBlockersSegment(text) {
  const segments = text.split(SEPARATOR);
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].trimStart().startsWith(HEADER)) {
      return { index: i, segments };
    }
  }
  return { index: -1, segments };
}

function isTestsOnlyBlocker(segmentText) {
  // The card contains numbered items "N. <title>". Pull out the titles.
  const titles = [];
  const re = /^\d+\.\s+(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(segmentText)) !== null) {
    titles.push(m[1].trim());
  }
  if (titles.length === 0) return false;
  return titles.every((t) => /tests?(\s|$|\b)|system health (is )?not green:\s*tests/i.test(t));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const briefingPath = path.join(REPO, 'data', 'briefings', `briefing-${opts.date}.md`);
  if (!fs.existsSync(briefingPath)) {
    console.error(`[refresh-blockers] briefing not found at ${briefingPath}`);
    process.exit(2);
  }
  const before = fs.readFileSync(briefingPath, 'utf8');
  const { index, segments } = findBlockersSegment(before);
  if (index < 0) {
    console.error(`[refresh-blockers] BLOCKERS section header not found in ${briefingPath}; aborting (no surgical splice point).`);
    process.exit(3);
  }
  const oldSection = segments[index];

  let testsProbe;
  try { testsProbe = probeTests(); }
  catch (e) {
    console.error('[refresh-blockers] probeTests threw:', e.message);
    process.exit(4);
  }
  const testsGreen = testsProbe && testsProbe.status === 'green';
  const testsOnly = isTestsOnlyBlocker(oldSection);

  console.error(`[refresh-blockers] tests probe: status=${testsProbe.status} detail=${(testsProbe.detail || '').slice(0, 160)}`);
  console.error(`[refresh-blockers] current section is tests-only blocker: ${testsOnly}`);

  let newSection;
  if (testsGreen && testsOnly) {
    newSection = CLEAN_SECTION;
    console.error('[refresh-blockers] tests are green AND the only blocker was tests; clearing card.');
  } else if (testsGreen && !testsOnly) {
    // Remove just the tests blocker, keep others. Renumber.
    const lines = oldSection.split('\n');
    const out = [];
    let skipItem = false;
    let renumberOffset = 0;
    const numberRe = /^(\d+)\.\s+(.+)$/;
    let currentNumber = 0;
    for (const line of lines) {
      const m = line.match(numberRe);
      if (m) {
        const title = m[2];
        if (/^tests\b|system health (is )?not green:\s*tests/i.test(title)) {
          skipItem = true; // skip this whole item
          renumberOffset++;
          continue;
        } else {
          skipItem = false;
          currentNumber = parseInt(m[1], 10) - renumberOffset;
          out.push(`${currentNumber}. ${title}`);
          continue;
        }
      }
      if (!skipItem) out.push(line);
    }
    newSection = out.join('\n');
    // If after removal no items remain, collapse to clean section.
    if (!/^\d+\.\s+/m.test(newSection)) newSection = CLEAN_SECTION;
    console.error('[refresh-blockers] tests green; removed tests blocker from card.');
  } else {
    console.error('[refresh-blockers] tests still red; not clearing. Updating evidence line.');
    // Update the Evidence line of any tests blocker with the latest probe
    // detail so the card reflects current truth even when still red.
    newSection = oldSection.replace(
      /^(\s+Evidence:\s*).*$/m,
      (_m, prefix) => `${prefix}${(testsProbe.detail || 'tests red, no detail available').slice(0, 220)}`,
    );
  }

  if (newSection === oldSection) {
    console.error('[refresh-blockers] section unchanged; nothing to write.');
    if (!opts.write) {
      console.log(newSection);
    }
    return;
  }

  segments[index] = newSection;
  const after = segments.join(SEPARATOR);

  if (!opts.write) {
    console.log(newSection);
    console.error('[refresh-blockers] DRY RUN. Pass --write to overwrite briefing.');
    return;
  }

  fs.writeFileSync(briefingPath, after, 'utf8');
  console.error(`[refresh-blockers] wrote ${after.length} chars to ${briefingPath}`);
  // Push refreshed markdown to the EC2 dashboard so ExampleCo sees the cleared
  // blocker in the live web view without waiting for the next briefing run.
  try {
    syncBriefingMarkdownToEc2Dashboard(opts.date, briefingPath, 'blockers-card refresh');
  } catch (e) {
    console.error('[refresh-blockers] EC2 publish failed:', e.message);
  }
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('[refresh-blockers] fatal:', e.stack || e.message);
    process.exit(1);
  }
}

module.exports = { findBlockersSegment, isTestsOnlyBlocker, CLEAN_SECTION, SEPARATOR, HEADER };
