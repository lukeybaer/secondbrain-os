#!/usr/bin/env node
/**
 * niche-loader.js
 *
 * 2026-05-26 ExampleCo #learn: per-channel niche YAML profiles replace the
 * hardcoded craft decisions (voice id, music map, caption style, tag
 * library) that lived in scripts/ec2-build-from-queue.py. Each channel
 * gets a niches/<ChannelName>.yaml. The loader is schema-strict: every
 * required field must be present (after an optional _defaults.yaml
 * overlay), ExampleCo top-level keys are rejected, numeric ranges are
 * validated. A missing or malformed YAML throws; the build never
 * falls back to legacy heuristics.
 *
 * Public API:
 *
 *   loadNiche(channel, opts?) -> niche
 *     - opts.nichesDir: directory to look in (default: <repo>/niches)
 *     - Throws NICHE_NOT_FOUND, NICHE_PARSE_ERROR, NICHE_MISSING_FIELD,
 *       NICHE_ExampleCo_KEY, NICHE_BAD_RANGE with a precise message.
 *
 *   REQUIRED_FIELDS: string[]
 *     - Dotted field paths that must be present on the merged niche.
 *
 * Contract is pinned by scripts/__tests__/niche-yaml.test.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULT_NICHES_DIR = path.resolve(__dirname, '..', '..', 'niches');

const REQUIRED_FIELDS = [
  'script.word_count',
  'script.tone',
  'script.hooks',
  'script.forbidden',
  'tags.count_range',
  'tags.cadence_s',
  'tags.derivation',
  'tags.forbidden',
  'stock.cadence_s',
  'stock.queries_per_minute',
  'stock.subjects',
  'voice.id',
  'voice.model',
  'voice.pace',
  'captions.style',
  'captions.emphasis_color',
  'captions.emphasis_rate',
  'music.mood',
  'music.duck_db',
  'music.track',
  'thumbnail.style',
  'thumbnail.focal_subject_required',
];

const ALLOWED_TOP_LEVEL = new Set([
  'script', 'tags', 'stock', 'voice', 'captions', 'music', 'thumbnail',
]);

// Field paths whose value is a [lo, hi] pair where 0 < lo <= hi.
const RANGE_FIELDS = [
  'script.word_count',
  'tags.count_range',
  'tags.cadence_s',
  'stock.cadence_s',
];

function getPath(obj, dotted) {
  const parts = dotted.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

// Case-insensitive lookup of a `<channel>.yaml` file in the directory.
// Returns the absolute path or null. Excludes `_defaults.yaml`.
function resolveChannelFile(nichesDir, channel) {
  if (!fs.existsSync(nichesDir)) return null;
  const target = channel.toLowerCase() + '.yaml';
  let found = null;
  for (const name of fs.readdirSync(nichesDir)) {
    if (name === '_defaults.yaml') continue;
    if (name.toLowerCase() === target) { found = name; break; }
  }
  return found ? path.join(nichesDir, found) : null;
}

function readYaml(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`NICHE_NOT_FOUND: ${filePath}: ${e.message}`);
  }
  try {
    return yaml.load(raw) || {};
  } catch (e) {
    throw new Error(`NICHE_PARSE_ERROR: ${filePath}: ${e.message}`);
  }
}

// Field-by-field overlay. Per-channel value wins. Arrays are replaced
// wholesale, never concatenated, so a channel can shrink a default list.
function overlay(base, top) {
  if (top === undefined) return base;
  if (base === undefined) return top;
  if (Array.isArray(base) || Array.isArray(top)) return top;
  if (typeof base !== 'object' || base === null || typeof top !== 'object' || top === null) {
    return top;
  }
  const out = { ...base };
  for (const k of Object.keys(top)) {
    out[k] = overlay(base[k], top[k]);
  }
  return out;
}

function validate(merged, channel) {
  // 1. PRIVATE_NAME top-level keys.
  for (const k of Object.keys(merged)) {
    if (!ALLOWED_TOP_LEVEL.has(k)) {
      throw new Error(`NICHE_ExampleCo_KEY: ${channel}: rogue top-level field "${k}" not in schema`);
    }
  }

  // 2. Required fields. Collect ALL holes, not just the first.
  const missing = [];
  for (const f of REQUIRED_FIELDS) {
    if (getPath(merged, f) === undefined) missing.push(f);
  }
  if (missing.length > 0) {
    throw new Error(`NICHE_MISSING_FIELD: ${channel}: missing required field(s): ${missing.join(', ')}`);
  }

  // 3. Range constraints.
  for (const f of RANGE_FIELDS) {
    const v = getPath(merged, f);
    if (!Array.isArray(v) || v.length !== 2) {
      throw new Error(`NICHE_BAD_RANGE: ${channel}: ${f} must be a [lo, hi] pair`);
    }
    const [lo, hi] = v;
    if (typeof lo !== 'number' || typeof hi !== 'number' || lo <= 0 || hi < lo) {
      throw new Error(`NICHE_BAD_RANGE: ${channel}: ${f} = [${lo}, ${hi}] must satisfy 0 < lo <= hi`);
    }
  }
}

function loadNiche(channel, opts = {}) {
  if (!channel || typeof channel !== 'string') {
    throw new Error('NICHE_NOT_FOUND: channel name is required');
  }
  const nichesDir = opts.nichesDir || DEFAULT_NICHES_DIR;
  const channelFile = resolveChannelFile(nichesDir, channel);
  if (!channelFile) {
    throw new Error(`NICHE_NOT_FOUND: no <${channel}>.yaml under ${nichesDir}`);
  }

  // _defaults is optional. If present, channel YAML overlays it field-by-field.
  const defaultsPath = path.join(nichesDir, '_defaults.yaml');
  const base = fs.existsSync(defaultsPath) ? readYaml(defaultsPath) : {};
  const top = readYaml(channelFile);
  const merged = overlay(base, top);

  validate(merged, channel);
  return merged;
}

module.exports = {
  loadNiche,
  REQUIRED_FIELDS,
  ALLOWED_TOP_LEVEL,
  RANGE_FIELDS,
  // exported for testing if needed:
  overlay,
};
