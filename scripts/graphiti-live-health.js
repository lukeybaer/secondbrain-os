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
const SUBSCRIPTION_SOCKET =
  process.env.GRAPHITI_SUBSCRIPTION_SOCKET ||
  '/opt/secondbrain-durable/graphiti/subscription.sock';
// The gateway runs one subscription job at a time, and its first rung (Codex)
// shells out through spawnSync, so while that rung runs the process cannot
// answer /health at all. The ceiling must cover the WHOLE ladder, not one rung:
// askAI tries Codex then Claude CLI sequentially at REQUEST_TIMEOUT_MS each, so
// a Codex timeout followed by a healthy Claude attempt legitimately runs past
// two rung budgets. Under this ceiling is live work; over it is genuinely stuck.
const GATEWAY_STUCK_MS = Number(process.env.GRAPHITI_GATEWAY_STUCK_MS || 300_000);

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkMcpHealth(opts = {}) {
  const httpHealthFn = opts.httpHealthFn || httpHealth;
  const attempts = Math.max(1, Number(opts.attempts) || 2);
  const delayMs = Math.max(0, Number(opts.delayMs) || 1000);
  let last = null;
  for (let i = 0; i < attempts; i++) {
    try {
      last = await httpHealthFn();
    } catch (e) {
      last = {
        status: 'error',
        service: 'graphiti-mcp',
        error: String(e.message || e).slice(0, 200),
      };
    }
    if (last && last.status === 'healthy') return last;
    if (i < attempts - 1 && delayMs > 0) await wait(delayMs);
  }
  return last || { status: 'error', service: 'graphiti-mcp', error: 'no health response' };
}

// 'busy' is a live gateway working a bounded subscription job, so it is NOT a
// live failure. 'not-deployed' is a tolerated absence. Anything else is red.
// Exported so the health verdict and its tests share one predicate instead of
// each restating the union and drifting apart.
function isSubscriptionOk(status) {
  return status === 'healthy' || status === 'not-deployed' || status === 'busy' || status === 'disabled-by-owner';
}

// The whole verdict for a gateway that did not answer, as one pure decision so
// the probe and its tests share it. ENOENT means the socket was never created,
// so the gateway is absent rather than broken. No connection means a socket file
// with nothing behind it, which is a real outage. A connection the kernel DID
// accept proves a live process owns the socket, so the only question left is
// whether its current job is inside the request ceiling: inside is 'busy' (live
// work), outside, or no job at all while staying mute, is genuinely stuck.
function classifyGatewayFailure(input = {}) {
  if (String(input.code || '') === 'ENOENT') return { status: 'not-deployed' };
  if (!input.connected) return { status: 'red' };
  // null/undefined means the heartbeat says no job is running, which must NOT
  // coerce to epoch 0 and read as a job that has been stuck since 1970.
  const raw = input.activeSinceMs;
  const activeSince = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  const stuckMs = Number(input.stuckMs || GATEWAY_STUCK_MS);
  const busyMs =
    Number.isFinite(activeSince) && activeSince > 0 ? Number(input.nowMs) - activeSince : null;
  if (busyMs != null && busyMs >= 0 && busyMs <= stuckMs) {
    return { status: 'busy', active_since_ms: activeSince, busy_ms: busyMs };
  }
  return {
    status: 'red',
    detail:
      busyMs == null ? 'no active job in heartbeat' : `job stuck ${busyMs}ms`,
  };
}

function checkSubscriptionGateway(opts = {}) {
  const socketPath = opts.socketPath || SUBSCRIPTION_SOCKET;
  const statusPath =
    opts.statusPath ||
    process.env.GRAPHITI_SUBSCRIPTION_STATUS ||
    path.join(path.dirname(socketPath), 'gateway-status.json');
  const readStatus = opts.readStatus || (() => readJson(statusPath));
  const nowMs = opts.now || Date.now;
  const stuckMs = Number(opts.stuckMs || GATEWAY_STUCK_MS);
  return new Promise((resolve) => {
    let connected = false;
    const req = http.request(
      {
        socketPath,
        path: '/health',
        method: 'GET',
        headers: { Host: 'graphiti-subscription' },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk.toString()));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw || '{}');
            resolve({
              ...parsed,
              status: res.statusCode === 200 && parsed.status === 'healthy' ? 'healthy' : 'red',
            });
          } catch {
            resolve({ status: 'red', error: 'subscription gateway returned invalid JSON' });
          }
        });
      },
    );
    req.on('socket', (socket) => {
      if (socket.connecting === false) connected = true;
      socket.once('connect', () => {
        connected = true;
      });
    });
    req.on('error', (error) => {
      // ENOENT means the socket file does not exist; the subscription gateway is
      // not deployed on this host rather than deployed-but-unhealthy. Treat
      // socket absence as 'not-deployed' so it does not block the overall healthy
      // status when the rest of the data plane is live. A gateway that IS deployed
      // but returns a non-healthy response still produces 'red'.
      const code = (error && error.code) || '';
      const heartbeat = code === 'ENOENT' || !connected ? null : readStatus();
      const verdict = classifyGatewayFailure({
        code,
        connected,
        activeSinceMs: heartbeat && heartbeat.active_since_ms,
        nowMs: nowMs(),
        stuckMs,
      });
      resolve({
        ...verdict,
        error: verdict.detail
          ? `subscription gateway connected but did not answer: ${verdict.detail}`
          : String(error.message || error),
      });
    });
    req.setTimeout(opts.timeoutMs || 5000, () => req.destroy(new Error('gateway timeout')));
    req.end();
  });
}

async function main() {
  const ingestion = require('./lib/graphiti-ingestion-policy').graphitiIngestionAdmission();
  const [health, subscription] = await Promise.all([
    checkMcpHealth(),
    ingestion.allowed ? checkSubscriptionGateway() : Promise.resolve({ status: 'disabled-by-owner' }),
  ]);
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
  // 'not-deployed' means the socket file does not exist on this host; the
  // gateway was intentionally never started (vector similarity is disabled).
  // This is a tolerated absence, not a live failure. A deployed gateway that
  // returns a non-healthy health response still counts as a live failure.
  const subscriptionOk = isSubscriptionOk(subscription.status);
  const status =
    health.status === 'healthy' &&
    subscriptionOk &&
    hasDataProof &&
    (!ingestion.allowed || ageHours == null || ageHours <= 36)
      ? 'healthy'
      : 'red';
  const subscriptionNote =
    subscription.status === 'not-deployed'
      ? 'Subscription gateway: not deployed (socket absent)'
      : subscription.status === 'busy'
        ? `Subscription gateway: busy on a live subscription job (${subscription.busy_ms}ms, under the ${GATEWAY_STUCK_MS}ms ceiling)`
        : `Subscription gateway: ${subscription.status}`;
  const entry = {
    ts: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    node_count: nodes,
    episode_count: episodes,
    entity_count: entities,
    edge_vector_index_state: vectorIndexState,
    semantic_mode: 'bm25-temporal-subscription',
    ingestion_state: ingestion.allowed ? 'enabled' : 'disabled',
    subscription_gateway_status: subscription.status,
    last_episode_at: Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null,
    last_episode_age_hours: ageHours,
    status,
    source: 'graphiti-live-health',
    notes: stats
      ? `HTTP: ${health.service || 'graphiti-mcp'} ${health.status || '?'}. ${subscriptionNote}. Neo4j: live via ${statsResult.source}. BM25, temporal, and graph-distance recall remain live. Ingestion ${ingestion.allowed ? 'enabled' : 'disabled by owner; graph freshness intentionally frozen'}.`
      : `HTTP: ${health.service || 'graphiti-mcp'} ${health.status || '?'}. Neo4j stats unavailable; using lifetime receipt proof. ${statsResult.error || ''}`.trim(),
  };
  const out = path.join(ROOT, 'data', 'agent', 'graphiti-health.jsonl');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.appendFileSync(out, JSON.stringify(entry) + '\n');
  console.log(JSON.stringify(entry, null, 2));
  process.exit(status === 'healthy' ? 0 : 1);
}

module.exports = {
  GATEWAY_STUCK_MS,
  checkMcpHealth,
  checkSubscriptionGateway,
  classifyGatewayFailure,
  isSubscriptionOk,
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
