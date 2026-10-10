'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const LEGACY_RUNNER = /(?:^|[\s/])(?:ec2-self-heal-run\.sh|ec2-morning-report-prep-run\.sh|briefing-delivery-watchdog\.js|night-supervisor\.js|ec2-card-controller-run\.sh|ec2-morning-briefing-run\.sh|ec2-overnight-watcher-run\.sh)(?=\s|$)/;
const IMMUTABLE_RELEASE = /^\/opt\/secondbrain-releases\/[0-9a-f]{7,64}$/;

function conflictingProcesses(rows) {
  return rows.filter((row) => /^(?:node|bash|sh)$/.test(row.command) && LEGACY_RUNNER.test(row.args));
}

function legacySchedules(text) {
  return String(text)
    .split('\n')
    .filter((line) => line.trim() && !/^\s*#/.test(line) && LEGACY_RUNNER.test(line));
}

function parseProcessRows(text) {
  return String(text)
    .split('\n')
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      return match
        ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3], args: match[4] }]
        : [];
    });
}

function readCurrentService() {
  try {
    const output = execFileSync(
      'systemctl',
      ['show', 'amy-night-run.service', '--property=MainPID', '--property=ActiveState', '--property=ControlGroup'],
      { encoding: 'utf8' },
    );
    const property = (name) => output.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() || '';
    return {
      mainPid: Number(property('MainPID')),
      activeState: property('ActiveState'),
      controlGroup: property('ControlGroup'),
    };
  } catch {
    return null;
  }
}

function defaultReadCgroup(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
  } catch {
    return '';
  }
}

function defaultReadCwd(pid) {
  try {
    return fs.realpathSync(`/proc/${pid}/cwd`);
  } catch {
    return '';
  }
}

function cgroupContains(cgroupText, controlGroup) {
  const expected = String(controlGroup || '').replace(/^\/+|\/+$/g, '');
  if (!expected) return false;
  return String(cgroupText || '')
    .split('\n')
    .some((line) => {
      const member = line.split(':').at(-1).replace(/^\/+|\/+$/g, '');
      return member === expected || member.startsWith(`${expected}/`);
    });
}

function isDescendantOf(pid, ancestorPid, rows) {
  const byPid = new Map(rows.map((row) => [Number(row.pid), row]));
  const seen = new Set();
  let current = byPid.get(Number(pid));
  while (current && !seen.has(current.pid)) {
    if (current.pid === Number(ancestorPid)) return true;
    seen.add(current.pid);
    current = byPid.get(Number(current.ppid));
  }
  return false;
}

// A deploy may change /opt/secondbrain while the night owner correctly keeps
// running from its already-pinned immutable release. Exempt only children we
// can prove belong to that active service; AMY_NIGHT_OWNER in an environment is
// deliberately not evidence because any independent legacy process can spoof it.
function isCurrentOwnerChild(row, rows, service, { readCgroup, readCwd, isImmutableRelease } = {}) {
  if (!service || service.activeState !== 'active' || !Number.isInteger(service.mainPid) || service.mainPid <= 0) {
    return false;
  }
  const getCgroup = readCgroup || defaultReadCgroup;
  const getCwd = readCwd || defaultReadCwd;
  const immutable = isImmutableRelease || ((candidate) => IMMUTABLE_RELEASE.test(String(candidate || '')));
  const serviceMain = rows.find((candidate) => Number(candidate.pid) === service.mainPid);
  if (!serviceMain || !/(?:^|[\s/])amy-night-run\.js(?:\s|$)/.test(String(serviceMain.args || ''))) {
    return false;
  }
  const pinnedRelease = getCwd(service.mainPid);
  if (!immutable(pinnedRelease) || !isDescendantOf(row.pid, service.mainPid, rows)) return false;
  if (!cgroupContains(getCgroup(service.mainPid), service.controlGroup)) return false;
  if (!cgroupContains(getCgroup(row.pid), service.controlGroup)) return false;
  return getCwd(row.pid) === pinnedRelease;
}

function activeLegacyProcesses({ processRows, service, readCgroup, readCwd, isImmutableRelease } = {}) {
  let rows = processRows;
  if (!rows) {
    try {
      rows = parseProcessRows(execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' }));
    } catch (error) {
      throw new Error(`night-owner active process inspection failed: ${error?.message || error}`);
    }
  }
  const currentService = service === undefined ? readCurrentService() : service;
  return conflictingProcesses(rows).filter(
    (row) => !isCurrentOwnerChild(row, rows, currentService, { readCgroup, readCwd, isImmutableRelease }),
  );
}

if (require.main === module) {
  const conflicts = process.argv.includes('--active')
    ? activeLegacyProcesses()
    : legacySchedules(fs.readFileSync(0, 'utf8'));
  if (conflicts.length) {
    console.error(JSON.stringify({ reason: 'legacy-night-owner-remains', conflicts }));
    process.exitCode = 1;
  }
}

module.exports = {
  activeLegacyProcesses,
  cgroupContains,
  conflictingProcesses,
  isCurrentOwnerChild,
  isDescendantOf,
  legacySchedules,
  parseProcessRows,
};
