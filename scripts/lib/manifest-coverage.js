'use strict';

// Manifest coverage: the seam that ties every LIVE self-heal surface (a health
// probe, a comms channel) back to the self-heal design manifest (dev-plans/_domains.json).
//
// Why this exists: dev-plans/_domains.json declares 37 cards but the running code
// grew its probes and channels independently, so the design and the code drifted
// far apart with mismatched naming (manifest "gmail-watcher" vs probe "gmailScan").
// This module is the FIRST load-bearing reader of that relationship: a drift-lint
// (scripts/__tests__/manifest-coverage-drift.test.js) consumes it as a ratchet.
//
// Ratchet semantics: COVERAGE below records every CURRENT live surface, mapped to
// a manifest cardId where one exists or null ("baseline-gap", grandfathered, not
// yet reconciled). The lint passes today (everything current is registered) and
// fails the moment a NEW probe or channel is added without a COVERAGE entry. That
// is what stops the design from rotting further while the full reconciliation (the
// orchestrator-to-manifest wiring) is built. This is intentionally a no-op on
// runtime behavior: nothing here is called by the orchestrator yet.

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HEALTH_SELF_HEAL = path.join(REPO_ROOT, 'scripts', 'health-self-heal.js');
const CHANNEL_MONITOR = path.join(REPO_ROOT, 'scripts', 'lib', 'channel-health-monitor.js');
const DOMAINS_JSON = path.join(REPO_ROOT, 'dev-plans', '_domains.json');

// --- Live-surface extractors (read the source of truth, stay self-maintaining) ---

// Every probe wired into a heal pass shows up as `report.before.<key> = probe...()`.
// Extracting from source means a newly wired probe is detected automatically.
function extractLiveProbeKeys(src) {
  const keys = new Set();
  const re = /report\.before\.([A-Za-z0-9_]+)\s*=\s*probe[A-Za-z0-9_]*\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) keys.add(m[1]);
  return [...keys].sort();
}

// Channels are the `name:` entries of the defaultDefs array in the monitor.
function extractLiveChannelKeys(src) {
  const start = src.indexOf('const defaultDefs');
  if (start === -1) return [];
  // Scope to the defaultDefs array region so we do not catch unrelated `name:` keys.
  const region = src.slice(
    start,
    src.indexOf('const defs', start) === -1 ? src.length : src.indexOf('const defs', start),
  );
  const keys = new Set();
  const re = /name:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(region)) !== null) keys.add(m[1]);
  return [...keys].sort();
}

function liveProbeKeys() {
  return extractLiveProbeKeys(fs.readFileSync(HEALTH_SELF_HEAL, 'utf8'));
}
function liveChannelKeys() {
  return extractLiveChannelKeys(fs.readFileSync(CHANNEL_MONITOR, 'utf8'));
}
function manifestCardIds() {
  const domains = JSON.parse(fs.readFileSync(DOMAINS_JSON, 'utf8'));
  const arr = Array.isArray(domains) ? domains : domains.domains || [];
  const ids = [];
  for (const d of arr) for (const c of d.cards || []) if (c.cardId) ids.push(c.cardId);
  return ids;
}

// --- The coverage registry (the baseline) ---
// value = manifest cardId this live surface maps to, or null for a known baseline
// gap (live today, not yet reconciled to a manifest card). Adding a new live
// probe/channel REQUIRES adding it here, or the drift-lint fails. null is allowed
// (honest "not yet mapped"), an absent key is not.
const COVERAGE = {
  probes: {
    backups: 's3-backup',
    s3Parity: 's3-backup',
    ec2: 'ec2-backend',
    llm: 'llm-summarizer',
    schedDispatch: 'codex-sched-dispatch',
    scheduledSkills: null,
    nightlyEnhancements: 'nightly-enhancement',
    videoPipeline: 'video-pipeline',
    videoFeedbackLoop: null,
    staleUploads: 'stuck-videos',
    apiAudit: 'api-audit',
    ec2DeployDrift: null,
    branchDivergence: 'branch-divergence',
    youtubeOauth: null,
    tokenUsageCollector: null,
    tokenReductionSuggestion: null,
    fileChurn: null,
    memoryDelta: 'memory-index',
    ExampleCo: 'app-ExampleCo',
    briefingSpecChanges: null,
    spineTasks: null,
    gmailScan: 'gmail-watcher',
    voiceIdentity: 'otter-ingest',
    otterPcMirror: 'otter-ingest',
    videoRegen: 'video-regen',
    gmailBackfill: null,
    actionItems: null,
    news: 'news-us',
    devOps: null,
    graphitiCoverage: null,
    neo4jCpuCap: null,
  },
  channels: {
    telegram: 'escalation-channel',
    proxy: null,
    backend: 'ec2-backend',
    vapi: 'app-amy-calls',
    gmail: 'gmail-watcher',
    linkedin: null,
    pm2: null,
    'claude-max-token': null,
    'graphiti-advisor': null,
  },
};

// --- The auditor (pure, injectable, so the lint can prove it catches drift) ---
function auditCoverage({ liveProbes, liveChannels, coverage, cardIds }) {
  const unregisteredProbes = liveProbes.filter((k) => !(k in coverage.probes));
  const unregisteredChannels = liveChannels.filter((k) => !(k in coverage.channels));
  const idSet = new Set(cardIds);
  const staleMappings = [];
  for (const [bucket, map] of [
    ['probes', coverage.probes],
    ['channels', coverage.channels],
  ]) {
    for (const [key, cardId] of Object.entries(map)) {
      if (cardId !== null && !idSet.has(cardId)) staleMappings.push({ bucket, key, cardId });
    }
  }
  return { unregisteredProbes, unregisteredChannels, staleMappings };
}

// Convenience: audit the real live sources against the checked-in COVERAGE.
function auditLive() {
  return auditCoverage({
    liveProbes: liveProbeKeys(),
    liveChannels: liveChannelKeys(),
    coverage: COVERAGE,
    cardIds: manifestCardIds(),
  });
}

module.exports = {
  extractLiveProbeKeys,
  extractLiveChannelKeys,
  liveProbeKeys,
  liveChannelKeys,
  manifestCardIds,
  auditCoverage,
  auditLive,
  COVERAGE,
};
