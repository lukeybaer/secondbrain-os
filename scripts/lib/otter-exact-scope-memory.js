'use strict';

const v8 = require('node:v8');
const vm = require('node:vm');

function normalizedOtidSet(otids = []) {
  return new Set(
    (Array.isArray(otids) ? otids : [otids])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  );
}

function compactLedgerForExactOtids(ledger, otids = []) {
  if (!ledger || typeof ledger !== 'object') return ledger;
  const scope = normalizedOtidSet(otids);
  if (!scope.size) return ledger;
  const calls = (ledger.calls || []).filter((row) => scope.has(String(row?.otid || '')));
  const healerTargets = (ledger.healer_targets || []).filter((row) =>
    scope.has(String(row?.otid || '')),
  );
  const breaches = (ledger.breaches_last_24h || []).filter((row) =>
    scope.has(String(row?.otid || '')),
  );
  if (
    calls.length === (ledger.calls || []).length &&
    healerTargets.length === (ledger.healer_targets || []).length &&
    breaches.length === (ledger.breaches_last_24h || []).length
  ) {
    return ledger;
  }
  return {
    ...ledger,
    calls,
    healer_targets: healerTargets,
    breaches_last_24h: breaches,
  };
}

function compactJobsForExactOtids(report, otids = []) {
  if (!report || typeof report !== 'object') return report;
  const scope = normalizedOtidSet(otids);
  if (!scope.size) return report;
  const jobs = (report.jobs || []).filter((row) => scope.has(String(row?.otid || '')));
  if (jobs.length === (report.jobs || []).length) return report;
  return {
    ...report,
    jobs,
  };
}

function forceGarbageCollection() {
  try {
    if (typeof global.gc === 'function') {
      global.gc();
      return true;
    }
    v8.setFlagsFromString('--expose_gc');
    const collect = vm.runInNewContext('gc');
    if (typeof collect !== 'function') return false;
    collect();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  compactJobsForExactOtids,
  compactLedgerForExactOtids,
  forceGarbageCollection,
  normalizedOtidSet,
};
