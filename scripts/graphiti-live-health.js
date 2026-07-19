#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execSync } = require('child_process');
const { health: httpHealth } = require('./lib/graphiti-mcp');

const ROOT =
  process.env.SECONDBRAIN_ROOT ||
  (fs.existsSync('/opt/secondbrain') ? '/opt/secondbrain' : path.resolve(__dirname, '..'));
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'secondbrain_neo4j_pass';
const NEO4J_HTTP_URL = process.env.NEO4J_HTTP_URL || 'http://127.0.0.1:7474/db/neo4j/tx/commit';

function run(cmd, timeout = 15000) {
  return String(
    execSync(cmd, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }),
  ).trim();
}

function cypher(query) {
  const q = query.replace(/'/g, "'\\''");
  return run(
    `docker exec secondbrain-neo4j cypher-shell -u neo4j -p ${NEO4J_PASSWORD} --format plain '${q}'`,
    20000,
  );
}

function firstInt(text) {
  return parseInt((String(text || '').match(/\d+/) || ['0'])[0], 10);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function cypherShellStats() {
  const nodes = firstInt(cypher('MATCH (n) RETURN count(n) AS nodes;'));
  const episodes = firstInt(cypher('MATCH (n:Episodic) RETURN count(n) AS episodes;'));
  const entities = firstInt(cypher('MATCH (n:Entity) RETURN count(n) AS entities;'));
  const latestRaw = cypher(
    'MATCH (n:Episodic) WHERE n.created_at IS NOT NULL RETURN toString(max(n.created_at)) AS latest;',
  );
  const iso = (latestRaw.match(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/,
  ) || [null])[0];
  const indexRaw = cypher(
    "SHOW INDEXES YIELD name, state WHERE name = 'edge_fact_embedding_vector' RETURN state;",
  );
  const vectorIndexState = (indexRaw.match(/\b(?:ONLINE|POPULATING|FAILED)\b/) || [null])[0];
  return { nodes, episodes, entities, iso, vectorIndexState };
}

function parseNeo4jScalarResponse(json) {
  if (json && Array.isArray(json.errors) && json.errors.length) {
    throw new Error(json.errors.map((e) => e.message || e.code || JSON.stringify(e)).join('; '));
  }
  const row =
    json &&
    json.results &&
    json.results[0] &&
    json.results[0].data &&
    json.results[0].data[0] &&
    json.results[0].data[0].row;
  const value = Array.isArray(row) ? row[0] : null;
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error('Neo4j HTTP response did not contain a number');
  return num;
}

function parseNeo4jLatestResponse(json) {
  if (json && Array.isArray(json.errors) && json.errors.length) {
    throw new Error(json.errors.map((e) => e.message || e.code || JSON.stringify(e)).join('; '));
  }
  const row =
    json &&
    json.results &&
    json.results[0] &&
    json.results[0].data &&
    json.results[0].data[0] &&
    json.results[0].data[0].row;
  const value = Array.isArray(row) ? row[0] : null;
  return value == null ? null : String(value);
}

function neo4jHttpQuery(statement, opts = {}) {
  const url = new URL(opts.url || NEO4J_HTTP_URL);
  const payload = JSON.stringify({ statements: [{ statement }] });
  const auth = Buffer.from(`neo4j:${opts.password || NEO4J_PASSWORD}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 7474,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk.toString()));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Neo4j HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw || '{}'));
          } catch (e) {
            reject(new Error(`Neo4j HTTP JSON parse failed: ${e.message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs || 15000, () => {
      req.destroy(new Error('Neo4j HTTP timeout'));
    });
    req.write(payload);
    req.end();
  });
}

async function neo4jHttpStats(opts = {}) {
  const query = (statement) => neo4jHttpQuery(statement, opts);
  const [nodes, episodes, entities, latest, vectorIndexState] = await Promise.all([
    query('MATCH (n) RETURN count(n) AS nodes').then(parseNeo4jScalarResponse),
    query('MATCH (n:Episodic) RETURN count(n) AS episodes').then(parseNeo4jScalarResponse),
    query('MATCH (n:Entity) RETURN count(n) AS entities').then(parseNeo4jScalarResponse),
    query(
      'MATCH (n:Episodic) WHERE n.created_at IS NOT NULL RETURN toString(max(n.created_at)) AS latest',
    ).then(parseNeo4jLatestResponse),
    query(
      "SHOW INDEXES YIELD name, state WHERE name = 'edge_fact_embedding_vector' RETURN state",
    ).then(parseNeo4jLatestResponse),
  ]);
  return { nodes, episodes, entities, iso: latest, vectorIndexState };
}

async function collectGraphitiStats(opts = {}) {
  const httpStatsFn = opts.httpStatsFn || neo4jHttpStats;
  const shellStatsFn = opts.shellStatsFn || cypherShellStats;
  try {
    return { stats: await httpStatsFn(opts), source: 'neo4j-http', error: null };
  } catch (httpError) {
    try {
      return { stats: shellStatsFn(), source: 'cypher-shell', error: null };
    } catch (shellError) {
      return {
        stats: null,
        source: null,
        error: `Neo4j HTTP failed: ${String(httpError.message || httpError).slice(
          0,
          120,
        )}; cypher-shell failed: ${String(shellError.message || shellError).slice(0, 120)}`,
      };
    }
  }
}

async function main() {
  const health = await httpHealth();
  let stats = null;
  const statsResult = await collectGraphitiStats();
  stats = statsResult.stats;
  const lifetime = readJson(
    path.join(ROOT, 'data', 'agent', 'graphiti-lifetime-coverage-health-latest.json'),
  );
  const nodes = stats ? stats.nodes : null;
  const episodes = stats ? stats.episodes : null;
  const entities = stats ? stats.entities : null;
  const vectorIndexState = stats ? stats.vectorIndexState : null;
  const iso = stats
    ? stats.iso
    : lifetime && lifetime.chronological_replay
      ? lifetime.chronological_replay.last_reference_time
      : null;
  const latestMs = iso ? Date.parse(iso) : NaN;
  const ageHours = Number.isFinite(latestMs) ? Math.round((Date.now() - latestMs) / 3600000) : null;
  const hasDataProof = (nodes > 0 && episodes > 0) || (lifetime && lifetime.status === 'green');
  const status =
    health.status === 'healthy' &&
    hasDataProof &&
    vectorIndexState === 'ONLINE' &&
    (ageHours == null || ageHours <= 36)
      ? 'healthy'
      : 'red';
  const entry = {
    ts: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    node_count: nodes,
    episode_count: episodes,
    entity_count: entities,
    edge_vector_index_state: vectorIndexState,
    last_episode_at: Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null,
    last_episode_age_hours: ageHours,
    status,
    source: 'graphiti-live-health',
    notes: stats
      ? `HTTP: ${health.service || 'graphiti-mcp'} ${health.status || '?'}. Neo4j: live via ${statsResult.source}. Edge vector index: ${vectorIndexState || 'missing'}.`
      : `HTTP: ${health.service || 'graphiti-mcp'} ${health.status || '?'}. Neo4j stats unavailable; using lifetime receipt proof. ${statsResult.error || ''}`.trim(),
  };
  const out = path.join(ROOT, 'data', 'agent', 'graphiti-health.jsonl');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.appendFileSync(out, JSON.stringify(entry) + '\n');
  console.log(JSON.stringify(entry, null, 2));
  process.exit(status === 'healthy' ? 0 : 1);
}

module.exports = {
  collectGraphitiStats,
  cypherShellStats,
  firstInt,
  neo4jHttpQuery,
  neo4jHttpStats,
  parseNeo4jLatestResponse,
  parseNeo4jScalarResponse,
};

if (require.main === module) {
  main().catch((e) => {
    const entry = {
      ts: new Date().toISOString(),
      date: new Date().toISOString().slice(0, 10),
      status: 'red',
      source: 'graphiti-live-health',
      notes: `probe failed: ${String(e.message || e).slice(0, 300)}`,
    };
    const out = path.join(ROOT, 'data', 'agent', 'graphiti-health.jsonl');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.appendFileSync(out, JSON.stringify(entry) + '\n');
    console.error(JSON.stringify(entry, null, 2));
    process.exit(1);
  });
}
