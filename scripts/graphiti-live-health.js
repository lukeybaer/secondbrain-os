#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { health: httpHealth } = require('./lib/graphiti-mcp');

const ROOT = process.env.SECONDBRAIN_ROOT || (fs.existsSync('/opt/secondbrain') ? '/opt/secondbrain' : path.resolve(__dirname, '..'));
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'secondbrain_neo4j_pass';

function run(cmd, timeout = 15000) {
  return String(execSync(cmd, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] })).trim();
}

function cypher(query) {
  const q = query.replace(/'/g, "'\\''");
  return run(`docker exec secondbrain-neo4j cypher-shell -u neo4j -p ${NEO4J_PASSWORD} --format plain '${q}'`, 20000);
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

function dockerStats() {
  const nodes = firstInt(cypher('MATCH (n) RETURN count(n) AS nodes;'));
  const episodes = firstInt(cypher('MATCH (n:Episodic) RETURN count(n) AS episodes;'));
  const entities = firstInt(cypher('MATCH (n:Entity) RETURN count(n) AS entities;'));
  const latestRaw = cypher('MATCH (n:Episodic) WHERE n.created_at IS NOT NULL RETURN toString(max(n.created_at)) AS latest;');
  const iso = (latestRaw.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/) || [null])[0];
  return { nodes, episodes, entities, iso };
}

async function main() {
  const health = await httpHealth();
  let stats = null;
  let dockerError = null;
  try {
    stats = dockerStats();
  } catch (e) {
    dockerError = String(e.message || e).slice(0, 220);
  }
  const lifetime = readJson(path.join(ROOT, 'data', 'agent', 'graphiti-lifetime-coverage-health-latest.json'));
  const nodes = stats ? stats.nodes : null;
  const episodes = stats ? stats.episodes : null;
  const entities = stats ? stats.entities : null;
  const iso = stats ? stats.iso : (lifetime && lifetime.chronological_replay ? lifetime.chronological_replay.last_reference_time : null);
  const latestMs = iso ? Date.parse(iso) : NaN;
  const ageHours = Number.isFinite(latestMs) ? Math.round((Date.now() - latestMs) / 3600000) : null;
  const hasDataProof = (nodes > 0 && episodes > 0) || (lifetime && lifetime.status === 'green');
  const status = health.status === 'healthy' && hasDataProof && (ageHours == null || ageHours <= 36)
    ? 'healthy'
    : 'red';
  const entry = {
    ts: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    node_count: nodes,
    episode_count: episodes,
    entity_count: entities,
    last_episode_at: Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null,
    last_episode_age_hours: ageHours,
    status,
    source: 'graphiti-live-health',
    notes: stats
      ? `HTTP: ${health.service || 'graphiti-mcp'} ${health.status || '?'}. Neo4j: live.`
      : `HTTP: ${health.service || 'graphiti-mcp'} ${health.status || '?'}. Docker stats unavailable; using lifetime receipt proof. ${dockerError || ''}`.trim(),
  };
  const out = path.join(ROOT, 'data', 'agent', 'graphiti-health.jsonl');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.appendFileSync(out, JSON.stringify(entry) + '\n');
  console.log(JSON.stringify(entry, null, 2));
  process.exit(status === 'healthy' ? 0 : 1);
}

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
