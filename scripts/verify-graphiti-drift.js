#!/usr/bin/env node
/**
 * Drift-lint for the Graphiti core component.
 *
 * Keeps dev-plans/core/graphiti.md equal to the code: every load-bearing entry
 * point the doc names must still exist, and the design invariants the doc
 * asserts (single MCP client, spool-on-failure durability, distinct source ids
 * per prompt action, voice-safe scope on recall) must still hold. If the code
 * moves and the doc does not, this fails loud so the doc gets fixed instead of
 * rotting into fiction.
 *
 * Scoped per review: the client/cascade/spool/recall entry points and the
 * invariants they encode -- NOT every Graphiti MCP tool call or Neo4j schema
 * detail.
 *
 * Zero deps (fs/path only) so it works in a fresh worktree.
 *   node scripts/verify-graphiti-drift.js
 * Exit 0 = in sync, 1 = drift. Importable as { checkDrift } for tests.
 */

const fs = require('fs');
const path = require('path');

const DOC = 'dev-plans/core/graphiti.md';
const LESSONS = 'dev-plans/core/graphiti.LESSONS.md';

// Load-bearing entry points the doc names. Each must exist (these are git-tracked).
const KEY_FILES = [
  'src/main/graphiti-client.ts',
  'src/main/index.ts',
  'src/main/memory-index.ts',
  'src/main/graphiti-retry-queue.ts',
  'src/main/agent-memory.ts',
  'scripts/lib/graphiti-source-scanner.js',
  'scripts/lib/graphiti-mcp.js',
  'scripts/lib/graphiti-tunnel.js',
  'scripts/fire-graphiti-episode.mjs',
  'scripts/graphiti-cli.mjs',
  'scripts/recurate-all.ts',
  'scripts/whatsapp-ingest-standalone.js',
  'scripts/lib/voice-cloud-runtime.js',
  'scripts/graphiti-live-health.js',
  'scripts/lib/graphiti-brain-advisor.js',
  'scripts/lib/graphiti-advisor-health.js',
  'scripts/lib/deploy-graphiti-indexed.sh',
  'scripts/graphiti-brain-advisor.js',
  'scripts/claude-hooks/graphiti-advisor-start.mjs',
  'scripts/claude-hooks/graphiti-advisor-context.mjs',
  'scripts/claude-hooks/graphiti-advisor-stop.mjs',
  'skills/memory/graphiti-consult-for-prompts/SKILL.md',
  'skills/memory/graphiti-consult-for-prompts/LEARNINGS.md',
  'scripts/__tests__/graphiti-brain-advisor.test.js',
  'scripts/__tests__/graphiti-advisor-health.test.js',
  'scripts/__tests__/graphiti-advisor-contract-wiring.test.js',
  'docker-compose.graphiti.yml',
  'infra/graphiti/Dockerfile',
  'infra/graphiti/main_secondbrain.py',
  'ec2-server.js',
  'src/main/__tests__/amy-e2e-e5-graphiti-retry-queue.test.ts',
  'scripts/__tests__/voice-cloud-runtime.test.js',
];

// [file, token, why] -- the token must be present (an invariant the doc relies on).
const MUST_CONTAIN = [
  [
    'src/main/graphiti-client.ts',
    'export async function addEpisode',
    'the one write entry point episodes cascade through (never hand-rolled add_memory)',
  ],
  [
    'src/main/graphiti-client.ts',
    'export async function searchKnowledge',
    'the one recall entry point Electron uses',
  ],
  [
    'src/main/graphiti-client.ts',
    'export async function buildKnowledgeContext',
    'the recall formatter agent-memory.ts allocates context budget to',
  ],
  [
    'src/main/graphiti-client.ts',
    'export async function ingestCallTranscript',
    'the second (and only other) sanctioned write path, alongside memory-index upsertMemory',
  ],
  [
    'src/main/memory-index.ts',
    'fireGraphitiCascade',
    'upsertMemory cascades an episode in the same transaction as the Tier 2 write',
  ],
  [
    'src/main/graphiti-client.ts',
    'ensureGraphitiTunnel',
    'Electron Graphiti search and writes repair a missing local SSH tunnel before declaring the graph unavailable',
  ],
  [
    'src/main/index.ts',
    'isGraphitiAvailable',
    'Electron boot primes the same Graphiti client self-heal path used by normal memory operations',
  ],
  [
    'scripts/lib/graphiti-tunnel.js',
    'sb-key.pem',
    'standalone Graphiti callers can recover a missing local SSH tunnel with the deployed key',
  ],
  [
    'scripts/fire-graphiti-episode.mjs',
    'ensureGraphitiTunnel',
    'the #learn manual episode writer repairs its required local tunnel before declaring Graphiti unreachable',
  ],
  [
    'scripts/fire-graphiti-episode.mjs',
    'cleanExit',
    'the #learn writer avoids force-closing Node so Windows does not assert while detached SSH handles close',
  ],
  [
    'scripts/recurate-all.ts',
    'ensureGraphitiTunnel',
    'the standalone conversation re-curator repairs a missing local Graphiti tunnel before ingesting',
  ],
  [
    'scripts/whatsapp-ingest-standalone.js',
    'ensureGraphitiTunnel',
    'the standalone WhatsApp importer repairs a missing local Graphiti tunnel before ingesting',
  ],
  [
    'src/main/graphiti-retry-queue.ts',
    'graphiti-spool.jsonl',
    'the durability layer: enqueue-on-failure spool, not a silent drop',
  ],
  [
    'src/main/agent-memory.ts',
    'buildKnowledgeContext',
    'agent-memory recall consumer wires the Graphiti client, not a second ranking layer',
  ],
  [
    'scripts/lib/graphiti-source-scanner.js',
    'itemRef',
    'repeated briefing-action prompts get distinct source ids by itemRef+kind+timestamp instead of collapsing',
  ],
  [
    'scripts/lib/voice-cloud-runtime.js',
    'graphiti_return_order',
    'live voice recall preserves Graphiti-returned fact order rather than re-sorting it',
  ],
  [
    'scripts/lib/voice-cloud-runtime.js',
    "'owner-ea'",
    'a live voice no-match states its Graphiti scope instead of treating one empty query as global truth',
  ],
  [
    'scripts/lib/graphiti-mcp.js',
    'search_memory_facts',
    'the shared EC2-safe client calls the same MCP search tool as the Electron client',
  ],
  [
    'infra/graphiti/main_secondbrain.py',
    'db.index.vector.queryRelationships',
    "large owner graphs use Neo4j's relationship-vector index instead of a full cosine scan per prompt",
  ],
  [
    'infra/graphiti/main_secondbrain.py',
    'return []',
    'an index still populating defers semantic candidates instead of falling back to an abandoned full-graph scan',
  ],
  [
    'infra/graphiti/Dockerfile',
    'zepai/knowledge-graph-mcp@sha256:',
    'the repo-owned search overlay keeps its upstream Graphiti base immutable and auditable',
  ],
  [
    'scripts/graphiti-live-health.js',
    'edge_vector_index_state',
    'Graphiti service health proves the indexed prompt-time recall primitive is online',
  ],
  [
    'docker-compose.graphiti.yml',
    'main_secondbrain.py',
    'the live MCP container starts the indexed search wrapper',
  ],
  [
    'scripts/lib/deploy-graphiti-indexed.sh',
    'docker compose version',
    'the remote deploy accepts a host with the Docker Compose plugin',
  ],
  [
    'scripts/lib/deploy-graphiti-indexed.sh',
    'docker-compose',
    'the remote deploy accepts a host with standalone docker-compose',
  ],
  [
    'scripts/lib/deploy-graphiti-indexed.sh',
    "node <<'NODE'",
    'the owner-graph prewarm survives the SSH boundary without nested node -e quoting',
  ],
  [
    'scripts/lib/deploy-graphiti-indexed.sh',
    'restore_prior_image',
    'a failed indexed container acceptance restores the exact prior image',
  ],
  [
    'ec2-server.js',
    'function searchGraphiti',
    'EC2 voice code has its own direct local search path and does not need the SSH tunnel',
  ],
  [
    'scripts/lib/graphiti-brain-advisor.js',
    'searchFacts(built.query',
    'the shared advisor starts the sanctioned Graphiti search before returning control to ordinary work',
  ],
  [
    'scripts/lib/graphiti-brain-advisor.js',
    'private_detail_redacted',
    'every retrieved fact receives the permanent privacy-aware disposition fields',
  ],
  [
    'scripts/lib/graphiti-brain-advisor.js',
    'Impacted by ${used.length}/${facts.length} recalled facts',
    'official Graphiti impact uses the concise verdict-first binary-use metric',
  ],
  [
    'scripts/lib/graphiti-advisor-health.js',
    'false_impact_claims',
    'health exposes attempts to count negated adjustments as influence',
  ],
  [
    'scripts/graphiti-brain-advisor.js',
    'startDetached',
    'short-lived hooks and synchronous runners can start recall without blocking ordinary work',
  ],
  [
    'scripts/lib/channel-health-monitor.js',
    "name: 'graphiti-advisor'",
    'the five-minute monitor writes and reports advisor health as a distinct channel',
  ],
  [
    'claude-config/settings.json',
    'graphiti-advisor-stop.mjs',
    'Claude mechanically enforces start, context, answer ordering, and disposition receipts',
  ],
];

// No pattern has been removed-for-a-documented-reason here yet: graphiti.LESSONS.md
// does not exist (per the doc's own LESSONS section, "create on the first lesson
// learned here"). Leaving these empty rather than inventing a ban with no lesson
// behind it -- a fabricated invariant creates false drift the moment someone
// legitimately touches the file it is pinned to.
const MUST_NOT_CONTAIN = [];
const MUST_NOT_EXIST = [];

function checkDrift(repoRoot) {
  const failures = [];
  const warnings = [];
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    } catch {
      return null;
    }
  };

  const doc = read(DOC);
  if (doc === null) failures.push(`missing core doc: ${DOC}`);

  const lessons = read(LESSONS);
  // graphiti.LESSONS.md does not exist yet as of this writing; the doc says so
  // explicitly. Only fail on its absence once the doc stops admitting that, i.e.
  // once the doc claims the LESSONS file exists.
  if (
    lessons === null &&
    doc &&
    /graphiti\.LESSONS\.md.*(has been created|now exists)/i.test(doc)
  ) {
    failures.push(`doc claims ${LESSONS} exists but it is missing`);
  }

  for (const rel of KEY_FILES) {
    if (read(rel) === null) failures.push(`missing load-bearing file: ${rel}`);
  }
  for (const rel of MUST_NOT_EXIST) {
    if (read(rel) !== null) failures.push(`file must stay deleted: ${rel}`);
  }
  for (const [rel, token, why] of MUST_CONTAIN) {
    const src = read(rel);
    if (src === null) failures.push(`cannot check invariant, file missing: ${rel}`);
    else if (!src.includes(token))
      failures.push(`invariant lost in ${rel}: expected "${token}" (${why})`);
  }
  for (const [rel, token, why] of MUST_NOT_CONTAIN) {
    const src = read(rel);
    if (src === null) failures.push(`cannot check invariant, file missing: ${rel}`);
    else if (src.includes(token))
      failures.push(
        `invariant broken in ${rel}: found "${token}" (${why}) -- update the doc if intentional`,
      );
  }

  // The doc must still name the single MCP endpoint and the durability fallback,
  // the two facts every extension rule in section 3 depends on.
  if (doc && !/127\.0\.0\.1:8000/.test(doc)) {
    failures.push('doc no longer states the single Graphiti MCP endpoint (http://127.0.0.1:8000)');
  }
  if (doc && !/graphiti-retry-queue\.ts/.test(doc)) {
    failures.push('doc no longer names graphiti-retry-queue.ts as the durability/spool layer');
  }
  if (doc && !/graphiti-tunnel\.js/.test(doc)) {
    failures.push(
      'doc no longer names scripts/lib/graphiti-tunnel.js as the local tunnel self-heal layer',
    );
  }
  if (doc && !/channel-health-monitor\.js/i.test(doc)) {
    failures.push(
      'doc no longer names the implemented advisor probe in scripts/lib/channel-health-monitor.js',
    );
  }

  return { failures, warnings };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const { failures, warnings } = checkDrift(repoRoot);
  warnings.forEach((w) => console.warn(`WARN  ${w}`));
  if (failures.length) {
    console.error(`\nDRIFT: graphiti doc is out of sync with code (${failures.length}):`);
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error('\nFix the code or update dev-plans/core/graphiti.md, then re-run.');
    process.exit(1);
  }
  console.log('OK: graphiti doc is in sync with the code.');
}

if (require.main === module) main();

module.exports = {
  checkDrift,
  KEY_FILES,
  MUST_CONTAIN,
  MUST_NOT_CONTAIN,
  MUST_NOT_EXIST,
};
