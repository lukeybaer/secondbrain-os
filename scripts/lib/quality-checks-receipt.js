'use strict';
// quality-checks-receipt.js
//
// Owner decision: the test, regression, Gravity and parity checks left the
// dawn board when they became land and deploy gates (five cuts Q6), but "I still
// want to see the latest results on the board too." This module is the whole
// contract for that row, "Latest quality checks", without re-running anything
// at dawn:
//
//   WRITE  scripts/land.js (apply mode) records one entry per suite that the land
//          actually ran into agent/quality-checks-latest.json: the scoped
//          tests, each System Health test category it ran, and the Gravity
//          change gate. Entries merge by suite, so a suite keeps its own
//          latest run when a later land does not touch it.
//   SHIP   scripts/deploy-ec2-server.sh copies that file to
//          /opt/secondbrain/data/agent/ next to the land-gate receipt.
//   DEPLOY the post-deploy parity proof already writes
//          agent/deploy-parity-latest.json on EC2 (verify-deploy-parity.js);
//          it is read here as the "Deploy parity" suite.
//   READ   qualityChecksVerdict() grades the row. Pure read, no producer.
//
// Colors: green when the latest run of every suite passed; red when the latest
// run of any suite failed; yellow when no suite has run in 7 days (or none ever
// has). A category the recent lands never touched is not stale on its own: the
// row goes yellow only when the NEWEST run of any suite is older than 7 days.
// tests-other (over 1,000 files) is not run by land, so it has no entry; the
// row says which suites it knows rather than implying more.

const fs = require('node:fs');
const path = require('node:path');

const QUALITY_CHECKS_SCHEMA = 'quality-checks-latest@1';
const QUALITY_CHECKS_BASENAME = 'quality-checks-latest.json';
const DEPLOY_PARITY_BASENAME = 'deploy-parity-latest.json';
const STALE_MS = 7 * 24 * 3600 * 1000;
const ROW_LABEL = 'Latest quality checks';

const SUITE_LABELS = Object.freeze({
  'land-scoped': 'Land scoped tests',
  gravity: 'Gravity gate',
  'deploy-parity': 'Post-deploy parity',
});

function suiteLabel(key) {
  if (SUITE_LABELS[key]) return SUITE_LABELS[key];
  if (String(key).startsWith('category-')) return `Tests ${String(key).slice('category-'.length)}`;
  return String(key);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function validEntry(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    (entry.status === 'green' || entry.status === 'red') &&
    Number.isFinite(Date.parse(entry.ranAt))
  );
}

function cleanEntry(raw, { commit, source, ranAt }) {
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
  const passed = num(raw.passed);
  const failed = num(raw.failed);
  return {
    status: raw.status === 'green' ? 'green' : 'red',
    passed,
    failed,
    total: num(raw.total) || passed + failed,
    unit: String(raw.unit || 'files').slice(0, 20),
    note: String(raw.note || '').slice(0, 200),
    ranAt,
    commit: String(raw.commit || commit || '').slice(0, 40),
    source: String(raw.source || source || 'land').slice(0, 20),
  };
}

// Counts from a vitest JSON report (testResults[] has one row per test file).
function summarizeVitestReport(report) {
  const results = Array.isArray(report && report.testResults) ? report.testResults : [];
  if (!results.length) return null;
  const failed = results.filter((r) => r && r.status === 'failed').length;
  return { total: results.length, failed, passed: results.length - failed };
}

function readSuites(file) {
  const json = readJson(file);
  if (!json || json.schema !== QUALITY_CHECKS_SCHEMA || !json.suites || typeof json.suites !== 'object') return {};
  const out = {};
  for (const [key, entry] of Object.entries(json.suites)) {
    if (validEntry(entry)) out[key] = entry;
  }
  return out;
}

// Merge newest-per-suite across every target, then write the merged file to
// each one. Never throws: a receipt failure must not fail a land.
function recordQualitySuites({ suites, commit = '', source = 'land', repoRoots = [], dataDirs = [], now = new Date() } = {}) {
  const incoming = suites && typeof suites === 'object' ? suites : {};
  const dirs = [
    ...repoRoots.filter(Boolean).map((r) => path.join(r, 'data', 'agent')),
    ...dataDirs.filter(Boolean).map((d) => path.join(d, 'agent')),
  ];
  const targets = [...new Set(dirs.map((d) => path.resolve(d)))];
  const merged = {};
  for (const dir of targets) {
    const existing = readSuites(path.join(dir, QUALITY_CHECKS_BASENAME));
    for (const [key, entry] of Object.entries(existing)) {
      if (!merged[key] || Date.parse(entry.ranAt) > Date.parse(merged[key].ranAt)) merged[key] = entry;
    }
  }
  const ranAt = now.toISOString();
  for (const [key, raw] of Object.entries(incoming)) {
    if (!raw || typeof raw !== 'object') continue;
    merged[key] = cleanEntry(raw, { commit, source, ranAt });
  }
  const body = JSON.stringify({ schema: QUALITY_CHECKS_SCHEMA, updatedAt: ranAt, suites: merged }, null, 2) + '\n';
  const written = [];
  for (const dir of targets) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, QUALITY_CHECKS_BASENAME);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);
      written.push(file);
    } catch {
      /* best effort */
    }
  }
  return written;
}

function parityEntry(dataDir) {
  const report = readJson(path.join(dataDir || '', 'agent', DEPLOY_PARITY_BASENAME));
  if (!report || !Number.isFinite(Date.parse(report.checkedAt))) return null;
  const drift = Array.isArray(report.drift) ? report.drift.length : 0;
  const ok = report.ok === true;
  return {
    status: ok ? 'green' : 'red',
    passed: ok ? 1 : 0,
    failed: ok ? 0 : Math.max(1, drift),
    total: ok ? 1 : Math.max(1, drift),
    unit: ok ? 'proof' : 'drifted files',
    note: '',
    ranAt: report.checkedAt,
    commit: String(report.releaseSha || '').slice(0, 40),
    source: 'deploy',
  };
}

function stamp(iso) {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function suiteText(key, e) {
  const label = suiteLabel(key);
  const sha = e.commit ? e.commit.slice(0, 9) : 'unknown commit';
  const counts =
    e.status === 'green'
      ? `${e.passed} of ${e.total} ${e.unit} passed`
      : `${e.failed} of ${e.total} ${e.unit} failed`;
  const note = e.note ? ` (${e.note})` : '';
  return `${label} ${e.status === 'green' ? 'passed' : 'FAILED'}: ${counts}${note}, ${e.source} ${stamp(e.ranAt)} at ${sha}`;
}

// The row's verdict. dataDir is the EC2 (or desktop) data folder.
function qualityChecksVerdict({ dataDir, nowMs = Date.now() } = {}) {
  const suites = readSuites(path.join(dataDir || '', 'agent', QUALITY_CHECKS_BASENAME));
  const parity = parityEntry(dataDir);
  if (parity) suites['deploy-parity'] = parity;
  const keys = Object.keys(suites).sort();
  if (!keys.length) {
    return {
      status: 'yellow',
      detail: 'no land or deploy quality run has been recorded here yet (the next land and deploy write one)',
      suites: [],
    };
  }
  const detail = keys.map((k) => suiteText(k, suites[k]));
  const list = keys.map((k) => ({ key: k, label: suiteLabel(k), ...suites[k] }));
  const failedKeys = keys.filter((k) => suites[k].status === 'red');
  if (failedKeys.length) {
    return {
      status: 'red',
      detail: `latest run failed in ${failedKeys.map(suiteLabel).join(', ')}. ${detail.join('; ')}`,
      suites: list,
    };
  }
  const newest = Math.max(...keys.map((k) => Date.parse(suites[k].ranAt)));
  if (nowMs - newest > STALE_MS) {
    const days = Math.floor((nowMs - newest) / (24 * 3600 * 1000));
    return {
      status: 'yellow',
      detail: `no land or deploy quality run in ${days} days; last was ${stamp(new Date(newest).toISOString())}. ${detail.join('; ')}`,
      suites: list,
    };
  }
  return {
    status: 'green',
    detail: `latest run passed in all ${keys.length} suites. ${detail.join('; ')}`,
    suites: list,
  };
}

function qualityChecksRow({ dataDir, nowMs } = {}) {
  const verdict = qualityChecksVerdict({ dataDir, nowMs });
  const glyph = verdict.status === 'green' ? '✓' : verdict.status === 'yellow' ? '⚠' : '✗';
  return { ...verdict, line: `${glyph} ${ROW_LABEL}: ${verdict.detail}.` };
}

module.exports = {
  DEPLOY_PARITY_BASENAME,
  QUALITY_CHECKS_BASENAME,
  QUALITY_CHECKS_SCHEMA,
  ROW_LABEL,
  STALE_MS,
  qualityChecksRow,
  qualityChecksVerdict,
  recordQualitySuites,
  summarizeVitestReport,
  suiteLabel,
};
