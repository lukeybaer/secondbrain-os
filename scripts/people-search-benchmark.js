#!/usr/bin/env node
process.env.NODE_NO_WARNINGS = process.env.NODE_NO_WARNINGS || '1';
process.on('warning', (warning) => {
  if (!/SQLite is an experimental feature/i.test(warning.message || '')) {
    console.warn(warning.stack || warning.message || warning);
  }
});

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { PATHS, loadJson, repoRel, writeJsonAtomic } = require('./lib/people-provenance-core');

const OUT_PATH = path.join(PATHS.peopleIndexRoot, 'search-benchmark-latest.json');

function parseArgs(argv) {
  const args = { write: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') args.write = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') usage(0);
    else throw new Error(`ExampleCo argument: ${arg}`);
  }
  return args;
}

function usage(exitCode = 0) {
  const text = [
    'Usage:',
    '  node scripts/people-search-benchmark.js [--write] [--json]',
  ].join('\n');
  (exitCode ? console.error : console.log)(text);
  process.exit(exitCode);
}

function openDb() {
  if (!fs.existsSync(PATHS.sqlite)) throw new Error(`missing ${repoRel(PATHS.sqlite)}; run node scripts/people-provenance-builder.js --write first`);
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function filteredWarning(warning, ...rest) {
    const message = typeof warning === 'string' ? warning : warning && warning.message;
    if (/SQLite is an experimental feature/i.test(message || '')) return;
    return originalEmitWarning.call(process, warning, ...rest);
  };
  const { DatabaseSync } = require('node:sqlite');
  process.emitWarning = originalEmitWarning;
  let lastError = null;
  for (let i = 0; i < 10; i += 1) {
    try {
      const db = new DatabaseSync(PATHS.sqlite, { readOnly: true });
      try { db.exec('PRAGMA busy_timeout = 5000;'); } catch { /* no-op */ }
      return db;
    } catch (error) {
      lastError = error;
      if (!/locked|busy/i.test(error.message || '')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  throw lastError;
}

function measure(name, thresholdMs, fn) {
  const started = performance.now();
  let result;
  let error = null;
  try {
    result = fn();
  } catch (e) {
    error = e.message || String(e);
  }
  const elapsed = performance.now() - started;
  return {
    name,
    threshold_ms: thresholdMs,
    elapsed_ms: Number(elapsed.toFixed(3)),
    status: error ? 'error' : elapsed <= thresholdMs ? 'pass' : 'slow',
    error,
    result_count: Array.isArray(result) ? result.length : result?.count ?? null,
    sample: Array.isArray(result) ? result.slice(0, 3) : result,
  };
}

function buildBenchmark(args = {}) {
  const generatedAt = new Date().toISOString();
  const aliases = loadJson(PATHS.aliases, {});
  const voiceKey = Object.keys(aliases).find((key) => key.startsWith('voice:')) || null;
  // 2026-05-24 PII fix: hardcoded contact firstnames in source leak into
  // the public-sync payload (caught by tests/pii-screen.spec.ts). Pick
  // benchmark sample identifiers from the live alias/index files instead.
  const exactAlias = Object.keys(aliases).find((key) => key.startsWith('email:'))
    || Object.keys(aliases)[0]
    || 'ExampleCo';
  const personIndex = loadJson(PATHS.personIndex, { people: {} });
  const firstPerson = Object.keys(personIndex.people || {})[0] || 'ExampleCo';
  const db = openDb();
  try {
    const queries = [
      measure('exact_identifier_lookup', 500, () => {
        const key = exactAlias.startsWith('email:') ? exactAlias.slice(6) : exactAlias;
        return db.prepare('SELECT person_id, identifier_kind, identifier_value, status FROM identifiers WHERE identifier_normalized = ? OR person_id = ? LIMIT 10').all(key, firstPerson);
      }),
      measure('exact_voice_cluster_lookup', 500, () => {
        if (!voiceKey) return [];
        const cluster = voiceKey.slice(6);
        return db.prepare('SELECT person_id, voice_cluster_id, status, conversation_count FROM voice_edges WHERE voice_cluster_id = ? LIMIT 10').all(cluster);
      }),
      measure('person_fts_lookup', 2000, () => db.prepare('SELECT p.person_id, p.display_name, p.identity_status FROM people_fts f JOIN people p ON p.person_id = f.person_id WHERE people_fts MATCH ? LIMIT 10').all(firstPerson)),
      measure('topic_person_evidence_lookup', 5000, () => db.prepare('SELECT person_id, text, source_type, source_ref FROM claims WHERE text LIKE ? LIMIT 10').all('%mortgage%')),
    ];
    const report = {
      schema: 'life_archive_people_search_benchmark.v1',
      generated_at: generatedAt,
      sqlite_path: repoRel(PATHS.sqlite),
      status: queries.every((q) => q.status === 'pass') ? 'GREEN' : 'YELLOW',
      queries,
      contract: {
        exact_identifier_lookup_ms: 500,
        exact_voice_cluster_lookup_ms: 500,
        person_date_source_query_ms: 2000,
        topic_person_evidence_query_ms: 5000,
      },
    };
    if (args.write) writeJsonAtomic(OUT_PATH, report);
    return report;
  } finally {
    db.close();
  }
}

function format(report) {
  return [
    `People search benchmark: ${report.status}`,
    ...report.queries.map((q) => `${q.name}: ${q.elapsed_ms} ms (${q.status})`),
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = buildBenchmark(args);
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${format(report)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}

module.exports = { buildBenchmark };
