'use strict';

// scripts/lib/briefing-cards/card-format.js
//
// W6 generator merge, shared formatting leaves. These helpers were moved
// VERBATIM out of scripts/cloud-morning-briefing.js so per-card builders in
// scripts/lib/briefing-cards/ can be consumed by BOTH generators
// (cloud-morning-briefing.js and manual-briefing-v3.js) without either one
// depending on the other, following the landed big-decisions-card.js pattern.
// cloud-morning-briefing.js re-imports these (its output is byte-identical);
// manual-briefing-v3.js reaches them only through the shared card modules.
//
// Scrub semantics stay owned by scripts/lib/executive-surface-policy.js
// (scrubExecutiveText / containsRawOperationalLeak): this module only ExampleCos
// the thin composition wrappers the card builders call.

const fs = require('node:fs');
const path = require('node:path');
const {
  containsRawOperationalLeak,
  scrubExecutiveText,
} = require('../executive-surface-policy.js');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function cleanExecutiveFragment(value, { max = 180 } = {}) {
  const raw = String(value || '')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw || containsRawOperationalLeak(raw)) return '';
  const clean = scrubExecutiveText(raw)
    .replace(/\s+/g, ' ')
    .replace(/\binternal service detail\b/gi, '')
    .trim();
  if (!clean || containsRawOperationalLeak(clean)) return '';
  return clean
    .slice(0, max)
    .replace(/\s+[.,;:!?]*$/g, '')
    .trim();
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<a\b[\s\S]*$/gi, ' ')
    .replace(/<[^>\n]*(?:>|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function cleanPublicUrl(value, { allowGoogleNews = false } = {}) {
  const raw = cleanExecutiveFragment(decodeHtmlEntities(value), { max: 260 });
  if (!raw) return '';
  if (!allowGoogleNews && /news\.google\.com\/rss\/articles/i.test(raw)) return '';
  return raw;
}

function sourceLabelFromUrl(value) {
  const url = cleanPublicUrl(value, { allowGoogleNews: true });
  if (!url) return '';
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    return cleanExecutiveFragment(host, { max: 70 });
  } catch {
    return '';
  }
}

function findLatestDatedFile(dataDir, { prefix, ext = 'json', date }) {
  const dir = path.join(dataDir, 'agent');
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const re = new RegExp(
    `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{4}-\\d{2}-\\d{2})\\.${ext}$`,
  );
  const rows = files
    .map((file) => {
      const m = file.match(re);
      if (!m) return null;
      if (date && m[1] > date) return null;
      return { date: m[1], file: path.join(dir, file) };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
  return rows.length ? rows[rows.length - 1] : null;
}

function formatWholeNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
}

function formatMoney(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '$0';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

function parseIsoDay(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function formatShortDate(dateIso) {
  const date = parseIsoDay(dateIso);
  if (!date) return cleanExecutiveFragment(dateIso, { max: 40 }) || 'ExampleCo date';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function daysBetween(a, b) {
  const start = a instanceof Date ? a.getTime() : parseIsoDay(a)?.getTime();
  const end = b instanceof Date ? b.getTime() : parseIsoDay(b)?.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86400000);
}

// The exact "TITLE:\n\nBODY" shape both generators publish per card.
function legacySection(title, body) {
  return `${String(title || '').trim()}:\n\n${String(body || '').trim()}`;
}

module.exports = {
  readJson,
  cleanExecutiveFragment,
  stripHtml,
  decodeHtmlEntities,
  cleanPublicUrl,
  sourceLabelFromUrl,
  findLatestDatedFile,
  formatWholeNumber,
  formatMoney,
  parseIsoDay,
  formatShortDate,
  daysBetween,
  legacySection,
};
