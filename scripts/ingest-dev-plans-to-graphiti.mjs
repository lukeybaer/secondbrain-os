#!/usr/bin/env node
// ingest-dev-plans-to-graphiti.mjs
//
// ExampleCo 2026-06-13: on a phone call Amy said she "couldn't find" the git-hygiene
// dev plan she had written hours earlier. The voice query_knowledge tool reaches
// Graphiti, Otter transcripts, contacts, and memory -- but NOT dev-plans/. This
// ingests every dev plan registered in dev-plans/INDEX.md into Graphiti (the
// semantic brain query_knowledge already consults) as a title-forward episode,
// so Amy can retrieve a plan by name on a call.
//
// Why Graphiti and not an S3 / EC2-disk fast-path: EC2's /opt/secondbrain is an
// rsync deploy with no dev-plans/ and no sync; its IAM role cannot read the
// sessions S3 bucket; ec2-server.js (where query_knowledge lives) is a contended
// 18k-line file. Graphiti is the one store query_knowledge already reads on the
// box, so this needs no ec2-server.js change, no IAM ExampleCo, and no whole-file
// deploy.
//
// Re-runnable: episodes use a stable name `dev-plan:<file>` so re-ingest updates
// rather than duplicating. Graceful: a down Graphiti is non-fatal per the
// graphiti-cli philosophy; exits non-zero only if there were plans and EVERY
// ingest failed (so a scheduled run surfaces a real outage loudly).
//
// Usage: node scripts/ingest-dev-plans-to-graphiti.mjs [--dry]

import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEV_PLANS_DIR = path.resolve(here, '..', 'dev-plans');
const INDEX_PATH = path.join(DEV_PLANS_DIR, 'INDEX.md');
const CLI = path.join(here, 'graphiti-cli.mjs');

/**
 * Parse dev-plans/INDEX.md markdown table rows into plan records.
 * Skips the preamble prose, the header row, and the |---| separator by
 * requiring a YYYY-MM-DD first cell.
 */
export function parseDevPlansIndex(md) {
  const out = [];
  for (const line of String(md).split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // Drop the empty leading/trailing cells produced by the bounding pipes.
    const cols = cells.slice(1, -1);
    if (cols.length < 4) continue;
    const [date, planCell, status, covers] = cols;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // skips header + separator
    const m =
      planCell.match(/\(([^)]+\.html)\)/i) || planCell.match(/([^\s|[\]()]+\.html)/i);
    if (!m) continue;
    out.push({ date, file: path.basename(m[1]), status, covers });
  }
  return out;
}

/** Derive a human, voice-garble-tolerant title from a plan filename. */
export function humanTitleFromFile(file) {
  return String(file)
    .replace(/\.html$/i, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

/** Build the Graphiti episode (stable dedupe name, title-forward body). */
export function buildDevPlanEpisode(plan) {
  const title = humanTitleFromFile(plan.file);
  const body =
    `Dev plan titled "${title}" (dated ${plan.date}, status: ${plan.status}). ` +
    `Stored at dev-plans/${plan.file}. Covers: ${plan.covers}`;
  return {
    name: `dev-plan:${plan.file}`,
    body,
    source: 'dev-plan',
    time: `${plan.date}T12:00:00Z`,
  };
}

/**
 * The Graphiti add succeeded iff graphiti-cli printed "ok" to stdout. On
 * Windows + Node 24 the CLI can still abort during process exit with a libuv
 * `UV_HANDLE_CLOSING` assertion (see graphiti-cli.mjs cleanExit note), which
 * yields a nonzero exit status even though add_memory already committed the
 * episode server-side. So trust the "ok" marker, not the exit code -- otherwise
 * a successful ingest is misreported as a failure (observed 2026-06-13).
 */
export function ingestSucceeded(stdout) {
  return /(^|\n)ok\b/.test(stdout || '');
}

function ingest(ep) {
  const r = spawnSync(
    process.execPath,
    [CLI, 'add', '--name', ep.name, '--body', ep.body, '--source', ep.source, '--time', ep.time],
    { encoding: 'utf8', timeout: 45_000 },
  );
  return { ok: ingestSucceeded(r.stdout), stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

async function main() {
  const dry = process.argv.includes('--dry');
  const md = readFileSync(INDEX_PATH, 'utf8');
  const plans = parseDevPlansIndex(md);

  // Safety net: a *.html with no INDEX row is invisible to this ingest.
  // dev-plans-index.test.js enforces the index, but surface a gap loudly here too.
  const onDisk = readdirSync(DEV_PLANS_DIR).filter((f) => f.toLowerCase().endsWith('.html'));
  const indexed = new Set(plans.map((p) => p.file));
  const missing = onDisk.filter((f) => !indexed.has(f));
  if (missing.length) {
    console.warn(`[ingest-dev-plans] WARN not in INDEX.md (will not be ingested): ${missing.join(', ')}`);
  }

  let ok = 0;
  let fail = 0;
  for (const plan of plans) {
    const ep = buildDevPlanEpisode(plan);
    if (dry) {
      console.log(`[dry] ${ep.name}\n      ${ep.body.slice(0, 140)}...`);
      continue;
    }
    const r = ingest(ep);
    if (r.ok) {
      ok++;
      console.log(`[ingest-dev-plans] ok   ${ep.name}`);
    } else {
      fail++;
      console.error(`[ingest-dev-plans] FAIL ${ep.name}: ${r.stderr || r.stdout || 'no output'}`);
    }
  }
  console.log(`[ingest-dev-plans] done: ${ok} ingested, ${fail} failed, ${plans.length} total${dry ? ' (dry run)' : ''}`);

  if (!dry && plans.length > 0 && ok === 0) {
    console.error('[ingest-dev-plans] all ingests failed -- Graphiti unreachable?');
    process.exit(1);
  }
}

// Run main only when invoked directly, never when imported by the test.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
