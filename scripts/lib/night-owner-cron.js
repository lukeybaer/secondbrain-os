'use strict';
const LEGACY_OWNER = /ec2-self-heal-run[.]sh|ec2-morning-report-prep-run[.]sh|briefing-delivery-watchdog[.]js|night-supervisor[.]js|ec2-card-controller-run[.]sh|ec2-morning-briefing-run[.]sh|ec2-overnight-watcher-run[.]sh/;
function isLegacyOwner(line) { return !/^\s*#/.test(line) && LEGACY_OWNER.test(line); }
function stripLegacyOwners(cron) { return cron.split('\n').filter((line) => !isLegacyOwner(line)).join('\n').trimEnd() + '\n'; }
const FLEET_ROW = /run-cloud-scheduled-tasks[.]js\s+--trigger\s+cloud-cron(?:\s|$)/;
function inspectFleetCron(cron) {
  const rows = []; const environment = new Map();
  for (const [index, line] of cron.split('\n').entries()) {
    if (/^\s*#/.test(line)) continue;
    const assignment = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (assignment) { environment.set(assignment[1], assignment[2]); continue; }
    if (FLEET_ROW.test(line)) rows.push({ index, line, environment: new Map(environment) });
  }
  if (rows.length !== 1) throw new Error(`expected one scheduled fleet cron row; found ${rows.length}`);
  return { row: rows[0], finalEnvironment: environment };
}
function assertFleetCronTimezone(cron) {
  const { row } = inspectFleetCron(cron);
  if (row.environment.get('CRON_TZ') !== 'America/Chicago') throw new Error('scheduled fleet effective timezone is not America/Chicago');
  if (!/^\s*\*\/30\s+0-4\s+\*\s+\*\s+\*\s/.test(row.line)) throw new Error('scheduled fleet cadence differs from the approved half-hour overnight schedule');
  return true;
}
function repairFleetCronTimezone(cron) {
  const { row, finalEnvironment } = inspectFleetCron(cron);
  if (row.environment.get('CRON_TZ') === 'America/Chicago') { assertFleetCronTimezone(cron); return cron; }
  // Moving this one row must not inherit another job's later PATH, HOME, or
  // other environment. Cron cannot unset assignments, so refuse that case.
  for (const [key, value] of finalEnvironment) {
    if (key !== 'CRON_TZ' && row.environment.get(key) !== value) throw new Error(`cannot safely move scheduled fleet across changed ${key}`);
  }
  const kept = cron.split('\n').filter((_, index) => index !== row.index).join('\n').trimEnd();
  const result = `${kept}\n# Scheduled skill fleet uses Central Time independently of preceding jobs.\nCRON_TZ=America/Chicago\n${row.line}\n`;
  assertFleetCronTimezone(result);
  return result;
}
function restoreLegacyOwners(current, before) {
  const assignment = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;
  const currentKeys = new Set(current.split('\n').map(line => assignment.exec(line)?.[1]).filter(Boolean));
  let environment = [];
  const defaultEnvironment = [];
  const restored = [];
  for (const line of before.split('\n')) {
    if (assignment.test(line)) {
      const key = line.slice(0, line.indexOf('=')).trim();
      environment = environment.filter((entry) => entry.slice(0, entry.indexOf('=')).trim() !== key);
      environment.push(line);
      continue;
    }
    if (isLegacyOwner(line)) {
      // Cron has no "unset CRON_TZ" directive.  If this owner inherited the
      // daemon timezone while also carrying positional environment state, we
      // cannot append it after a changed current CRON_TZ/PATH without lying
      // about its effective schedule or environment.  Refuse the manual
      // merge; installer rollback restores the exact crontab instead.
      if (!environment.some((entry) => /^\s*CRON_TZ\s*=/.test(entry)) && environment.length) {
        throw new Error('cannot safely restore legacy owner environment without its original CRON_TZ');
      }
      const ownerKeys = new Set(environment.map(entry => assignment.exec(entry)[1]));
      if (environment.length && [...currentKeys].some(key => !ownerKeys.has(key))) {
        throw new Error('cannot safely unset a current cron environment variable for the restored owner');
      }
      if (environment.length) restored.push(...environment, line);
      else defaultEnvironment.push(line);
    }
  }
  // Preserve all unrelated jobs added after cutover, with their current zones.
  // Unset-zone jobs must precede all current CRON_TZ assignments. Appending
  // them would silently inherit the current file's last explicit zone.
  return (defaultEnvironment.length ? defaultEnvironment.join('\n') + '\n' : '') + stripLegacyOwners(current).trimEnd() + '\n# Restored prior briefing owners\n' + restored.join('\n') + '\n';
}
module.exports = {isLegacyOwner, stripLegacyOwners, restoreLegacyOwners, assertFleetCronTimezone, repairFleetCronTimezone};
