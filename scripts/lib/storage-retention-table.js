'use strict';

// The one storage table (config/storage-retention.json) and its loader.
// Every retention script and every archive/backup freshness threshold reads
// this file; nothing else holds a keep-count, an age, a prefix or a
// freshness window. Raw rows are copy-only: the loader refuses a table that
// asks to prune one.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TABLE_FILE = path.join(__dirname, '..', '..', 'config', 'storage-retention.json');
const CLASSES = ['raw', 'derived', 'release', 'log', 'state'];
const TOKEN_RE = /\$\{(DATA|DURABLE|SHARED|RELEASES|HOME)\}/g;

function validateRow(row, seen) {
  const where = `storage-retention row ${row && row.id}`;
  if (!row || typeof row.id !== 'string' || !row.id) throw new Error('storage-retention row without id');
  if (seen.has(row.id)) throw new Error(`${where}: duplicate id`);
  seen.add(row.id);
  if (typeof row.path !== 'string' || !row.path) throw new Error(`${where}: path required`);
  if (!CLASSES.includes(row.class)) throw new Error(`${where}: class must be one of ${CLASSES.join('|')}`);
  if (typeof row.prune !== 'boolean') throw new Error(`${where}: prune must be a boolean`);
  if (row.class === 'raw' && row.prune) throw new Error(`${where}: raw rows are copy-only and can never be pruned`);
  if (row.s3Prefix != null && (typeof row.s3Prefix !== 'string' || row.s3Prefix.startsWith('/'))) {
    throw new Error(`${where}: s3Prefix must be a relative key prefix or null`);
  }
  for (const key of ['freshnessHours', 'localKeepDays', 'keepNewest', 'pressureKeepNewest']) {
    if (row[key] != null && !(Number.isFinite(row[key]) && row[key] >= 0)) {
      throw new Error(`${where}: ${key} must be a non-negative number or null`);
    }
  }
  if (row.prune && !row.owner && row.keepNewest == null && row.localKeepDays == null) {
    throw new Error(`${where}: a prunable row needs keepNewest or localKeepDays (or an owner script)`);
  }
  if (row.match != null) new RegExp(row.match);
}

function loadTable({ file = TABLE_FILE } = {}) {
  const table = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (!Array.isArray(table.rows)) throw new Error('storage-retention table has no rows');
  const seen = new Set();
  for (const row of table.rows) validateRow(row, seen);
  return table;
}

let cached = null;
function table() {
  if (!cached) cached = loadTable();
  return cached;
}

function rows() {
  return table().rows;
}

function row(id) {
  const found = rows().find((r) => r.id === id);
  if (!found) throw new Error(`storage-retention: no row "${id}"`);
  return found;
}

function threshold(name) {
  const value = table().thresholds && table().thresholds[name];
  if (!Number.isFinite(value)) throw new Error(`storage-retention: no threshold "${name}"`);
  return value;
}

function s3Bucket() {
  return table().s3Bucket;
}

function freshnessHours(id) {
  const value = row(id).freshnessHours;
  if (!Number.isFinite(value)) throw new Error(`storage-retention: row "${id}" has no freshnessHours`);
  return value;
}

function roots(env = process.env) {
  const home = env.HOME || os.homedir();
  return {
    DATA: env.SECONDBRAIN_DATA_DIR || '/opt/secondbrain/data',
    DURABLE: '/opt/secondbrain-durable',
    SHARED: '/opt/secondbrain-shared',
    RELEASES: env.SB_RELEASES_ROOT || '/opt/secondbrain-releases',
    HOME: home,
  };
}

function resolvePath(rowOrPath, tokens = roots()) {
  const raw = typeof rowOrPath === 'string' ? rowOrPath : rowOrPath.path;
  return path.resolve(raw.replace(TOKEN_RE, (_m, name) => tokens[name]));
}

function globToRegExp(name) {
  const escaped = name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

module.exports = {
  CLASSES,
  TABLE_FILE,
  freshnessHours,
  globToRegExp,
  loadTable,
  resolvePath,
  roots,
  s3Bucket,
  row,
  rows,
  threshold,
};
