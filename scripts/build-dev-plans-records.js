#!/usr/bin/env node
'use strict';
//
// build-dev-plans-records.js -- the records wing of dev-plans.
//
// Every dev-plans/*.html is a permanent record (plan, incident report, audit,
// tombstone). Records never command: authority lives in dev-plans/core/*.md.
// Each record ExampleCos machine-readable meta stamps in its <head>:
//
//   <meta name="sb-status"        content="PROPOSED|IMPLEMENTED|SUPERSEDED|ABANDONED|HISTORICAL">
//   <meta name="sb-governed-by"   content="dev-plans/core/<file>.md">   (the core doc owning the subject today)
//   <meta name="sb-superseded-by" content="dev-plans/<file>.html">      (required when SUPERSEDED)
//   <meta name="sb-date"          content="YYYY-MM-DD">                 (only when the filename has no date)
//
// This script reads those stamps from every record and emits dev-plans/records.json
// so agents can answer "what became of plan X, and who owns the subject now"
// without opening 450KB HTML files. Run: npm run build:dev-plans-records.
// Sync is enforced by scripts/__tests__/dev-plans-index.test.js (regenerating
// must produce no diff).

const fs = require('fs');
const path = require('path');

const DEV_PLANS_DIR = path.resolve(__dirname, '..', 'dev-plans');
const OUT_PATH = path.join(DEV_PLANS_DIR, 'records.json');
const VALID_STATUSES = ['PROPOSED', 'IMPLEMENTED', 'SUPERSEDED', 'ABANDONED', 'HISTORICAL'];

function metaContent(html, name) {
  // Tolerates attribute spacing, single/double quotes, and self-closing tags
  // (the repo formatter rewrites <meta ...> as <meta ... />).
  const re = new RegExp(`<meta\\s+name=["']${name}["']\\s+content=["']([^"']*)["']`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

function titleOf(html) {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  return m ? m[1].trim() : null;
}

function dateOf(file, html) {
  const explicit = metaContent(html, 'sb-date');
  if (explicit) return explicit;
  const m = file.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function buildRecords(dir = DEV_PLANS_DIR) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.html'))
    .sort();
  return files.map((file) => {
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    return {
      file,
      status: metaContent(html, 'sb-status'),
      governedBy: metaContent(html, 'sb-governed-by'),
      supersededBy: metaContent(html, 'sb-superseded-by'),
      date: dateOf(file, html),
      title: titleOf(html),
    };
  });
}

function serializeRecords(records) {
  return JSON.stringify(records, null, 2) + '\n';
}

function main() {
  const records = buildRecords();
  const invalid = records.filter((r) => !VALID_STATUSES.includes(r.status));
  if (invalid.length > 0) {
    console.error(
      `[build-dev-plans-records] records with missing/invalid sb-status: ${invalid
        .map((r) => `${r.file} (${r.status})`)
        .join(', ')}`,
    );
    process.exitCode = 1;
  }
  fs.writeFileSync(OUT_PATH, serializeRecords(records));
  console.log(
    `[build-dev-plans-records] wrote ${records.length} records to ${path.relative(process.cwd(), OUT_PATH)}`,
  );
}

module.exports = {
  DEV_PLANS_DIR,
  OUT_PATH,
  VALID_STATUSES,
  buildRecords,
  serializeRecords,
  metaContent,
};

if (require.main === module) main();
