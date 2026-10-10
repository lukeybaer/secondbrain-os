'use strict';

// Pure transform for the 13:10-16:40 CT daytime scheduled-skill fleet cron row
// (ExampleCo 2026-09-14). secondbrain-nightly-enhancement, video-quality-research,
// and weekly-warmth-audit moved off the overnight box: at midnight they burned
// roughly 2.6M Codex tokens combined and pushed Codex over its usage limit
// before the briefing news card ran. The now-deleted daily-otter-sweep skill
// burned another 4M Claude tokens failing outright because it looked for PC
// paths while running on EC2. See scripts/lib/cloud-scheduled-fleet.js for the
// task window split this row admits against.
//
// This module is deliberately side-effect free (no fs, no process, no
// crontab access) so the bash installer (install-ec2-daytime-scheduled-fleet-cron.sh)
// can shell out to node for the transform, validate the result, and only then
// touch the live crontab. Mirrors the house style of scripts/lib/night-owner-cron.js.

const MARKER = '# secondbrain daytime scheduled-skill fleet (ExampleCo 2026-09-14)';
const OWNED_TZ_LINE = 'CRON_TZ=America/Chicago';
const ROW_PATTERN = /run-cloud-scheduled-tasks[.]js\s+--window\s+daytime(?:\s|$)/;

/**
 * Build the daytime fleet cron row. Defaults are the production EC2 values;
 * overrides exist only for tests, never for the real installer.
 */
function defaultDaytimeFleetRow({
  root = '/opt/secondbrain',
  dataDir = '/opt/secondbrain/data',
  logDir = '/opt/secondbrain/logs',
  nodeBin = '/usr/bin/node',
  concurrency = 1,
} = {}) {
  return (
    `10,40 13-16 * * * cd ${root} && mkdir -p ${logDir} && ` +
    `SECONDBRAIN_DATA_DIR=${dataDir} AMY_CLOUD_SCHEDULED_CONCURRENCY=${concurrency} nice -n 10 ${nodeBin} ` +
    `scripts/run-cloud-scheduled-tasks.js --window daytime --trigger cloud-daytime ` +
    `>> ${logDir}/cloud-scheduled-fleet-daytime.log 2>&1`
  );
}

function isMarkerLine(line) {
  return line === MARKER;
}

function isDaytimeRowLine(line) {
  return !/^\s*#/.test(line) && ROW_PATTERN.test(line);
}

/**
 * Every line index this installer owns. The block it ever writes is always
 * contiguous (marker, then an optional CRON_TZ line it added itself, then the
 * row), so strip and the "only our block changed" proof agree on exactly what
 * "daytime" means. A stray row not immediately following a marker (hand
 * edited, or left over from a differently-shaped prior install) is still
 * claimed so re-running never accumulates a second row.
 * @param {string[]} lines
 * @returns {Set<number>}
 */
function ownedLineIndexes(lines) {
  const owned = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (isMarkerLine(lines[i])) {
      owned.add(i);
      let next = i + 1;
      if (next < lines.length && lines[next] === OWNED_TZ_LINE) {
        owned.add(next);
        next += 1;
      }
      if (next < lines.length && isDaytimeRowLine(lines[next])) owned.add(next);
    } else if (isDaytimeRowLine(lines[i]) && !owned.has(i)) {
      owned.add(i);
    }
  }
  return owned;
}

function splitLines(cron) {
  return String(cron || '').replace(/\r\n/g, '\n').split('\n');
}

function stripDaytimeBlock(cron) {
  const lines = splitLines(cron);
  const owned = ownedLineIndexes(lines);
  return lines.filter((_, i) => !owned.has(i));
}

/** Effective CRON_TZ after the last (non-comment) assignment in `lines`. */
function lastCronTz(lines) {
  let tz = '';
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    const assignment = /^\s*CRON_TZ\s*=\s*(.*)$/.exec(line);
    if (assignment) tz = assignment[1].trim();
  }
  return tz;
}

/**
 * Remove any prior daytime block and append a fresh one. Idempotent: running
 * this twice on its own output yields exactly one daytime row.
 * @param {string} cron current crontab text
 * @param {object} [rowOpts] forwarded to defaultDaytimeFleetRow (tests only)
 * @returns {string} new crontab text, always ending with exactly one newline
 */
function installDaytimeFleetRow(cron, rowOpts = {}) {
  const kept = stripDaytimeBlock(cron);
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  const needsTz = lastCronTz(kept) !== 'America/Chicago';
  const row = defaultDaytimeFleetRow(rowOpts);
  const block = [MARKER, ...(needsTz ? [OWNED_TZ_LINE] : []), row];
  return [...kept, ...block, ''].join('\n');
}

/**
 * Require exactly one daytime fleet row, effective America/Chicago.
 * @param {string} cron
 * @returns {true}
 */
function assertDaytimeFleetRow(cron) {
  const lines = splitLines(cron);
  const rows = [];
  let tz = '';
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    const assignment = /^\s*CRON_TZ\s*=\s*(.*)$/.exec(line);
    if (assignment) {
      tz = assignment[1].trim();
      continue;
    }
    if (ROW_PATTERN.test(line)) rows.push({ line, tz });
  }
  if (rows.length !== 1) {
    throw new Error(`expected exactly one daytime scheduled fleet cron row; found ${rows.length}`);
  }
  if (rows[0].tz !== 'America/Chicago') {
    throw new Error(
      `daytime scheduled fleet effective timezone is ${rows[0].tz || 'host-default'}, not America/Chicago`,
    );
  }
  return true;
}

/**
 * Prove every line outside the daytime block is preserved, in order, between
 * `before` and `after`. Does not care whether a CRON_TZ line was added or
 * already present -- only that nothing else moved or changed.
 * @param {string} before
 * @param {string} after
 * @returns {true}
 */
function assertOnlyDaytimeBlockChanged(before, after) {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const beforeRest = beforeLines.filter((_, i) => !ownedLineIndexes(beforeLines).has(i));
  const afterRest = afterLines.filter((_, i) => !ownedLineIndexes(afterLines).has(i));
  const mismatch =
    beforeRest.length !== afterRest.length || beforeRest.some((line, i) => line !== afterRest[i]);
  if (mismatch) {
    throw new Error('daytime fleet cron install changed a line outside its own block');
  }
  return true;
}

module.exports = {
  MARKER,
  OWNED_TZ_LINE,
  ROW_PATTERN,
  assertDaytimeFleetRow,
  assertOnlyDaytimeBlockChanged,
  defaultDaytimeFleetRow,
  installDaytimeFleetRow,
  stripDaytimeBlock,
};
