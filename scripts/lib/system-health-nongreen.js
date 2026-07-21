'use strict';

// ONE shared source of truth for "which SYSTEM HEALTH rows are non-green".
// The publish validator (validate-briefing-quality.js) and the cloud briefing
// generator (cloud-morning-briefing.js) BOTH parse the SYSTEM HEALTH body for
// the same set of measurement work units. The dashboard reports them on System
// Health, while Blockers deliberately excludes them. Defining the parser once
// here keeps those consumers from drifting.

// D9 (wave 3a, 2026-07-12): the informational tests-row carve-out is also ONE
// shared predicate now (scripts/lib/system-health-tests-row.js), so a row
// rename or new receipt-backed wording can never desynchronize the parsers
// from the generator again.
const { isInformationalTestsRowText } = require('./system-health-tests-row.js');

const SYSTEM_HEALTH_MEASUREMENT_IDS = Object.freeze({
  backups: 'system_health:backups',
  ec2: 'system_health:ec2',
  'llm summarizer': 'system_health:llm-summarizer',
  llm: 'system_health:llm',
  'content readiness': 'system_health:content-readiness',
  'automated regression suite': 'system_health:automated-regression-suite',
  'briefing render + sections': 'system_health:tests-briefing',
  'dispatch loop (otter+gmail->#amy)': 'system_health:tests-dispatch',
  'dashboard parse + render': 'system_health:tests-dashboard',
  'action item ranker': 'system_health:tests-action-item-ranker',
  'inbound auto-reply guardrails': 'system_health:tests-auto-reply',
  'self-heal probes': 'system_health:tests-self-heal',
  'memory frontmatter + index': 'system_health:tests-memory',
  'video qc + rubric tools': 'system_health:tests-video',
  'vapi prompt + assistant config': 'system_health:tests-vapi',
  'otter+gmail+linkedin ingest': 'system_health:tests-ingest',
  'studio renderer + thumbnail': 'system_health:tests-studio',
  'dev ops release hygiene': 'system_health:tests-devops',
  'other unit + e2e checks': 'system_health:tests-other',
  'gmail scan': 'system_health:gmail-scan',
  'api audit': 'system_health:api-audit',
  'neo4j cpu cap': 'system_health:neo4j-cpu-cap',
  memory: 'system_health:memory',
  'self-heal health': 'system_health:self-heal-health',
  contacts: 'system_health:contacts',
  filechurn: 'system_health:file-churn',
  memorydelta: 'system_health:memory-delta',
  ExampleCo: 'system_health:ExampleCo',
  specchanges: 'system_health:spec-changes',
  'video pipeline': 'system_health:video-pipeline',
  'stuck videos': 'system_health:stuck-videos',
  'scheduled tasks': 'system_health:scheduled-tasks',
  'cloud briefing': 'system_health:cloud-briefing',
  'telegram and phone intake': 'system_health:telegram-phone-intake',
  'dispatch backlog': 'system_health:dispatch-backlog',
  calendar: 'system_health:calendar',
  'snack dude': 'system_health:snack-dude',
  'gmail action scan': 'system_health:gmail-action-scan',
  'otter speaker enrichment': 'system_health:otter-speaker-enrichment',
  'scheduled tasks health': 'system_health:scheduled-tasks',
  'backend pm2 fleet': 'system_health:backend-pm2-fleet',
  'ec2 disk': 'system_health:ec2-disk',
  graphiti: 'system_health:graphiti',
  'graphiti advisor': 'system_health:graphiti-advisor',
  'recall broker': 'system_health:recall-broker',
  'backups/coverage': 'system_health:backups-coverage',
  'life-archive backup': 'system_health:life-archive-backup',
  'life archive backup': 'system_health:life-archive-backup',
  tests: 'system_health:tests',
  'dev ops': 'system_health:dev-ops',
  'deploy parity': 'system_health:deploy-parity',
  'ai & tech news': 'system_health:ai-tech-news',
  'us news': 'system_health:us-news',
  'world news': 'system_health:world-news',
  'covid treatments': 'system_health:covid-treatments',
  'us immigration news': 'system_health:us-immigration-news',
  'mortgage industry news': 'system_health:mortgage-industry-news',
  'mortgage rate indexes': 'system_health:mortgage-rate-indexes',
  'shorts proposals': 'system_health:shorts-proposals',
  'viral clip proposals': 'system_health:viral-clip-proposals',
  'video approval queue': 'system_health:video-approval-queue',
  'system health measurement evidence': 'system_health:measurement-evidence',
});

function normalizedMeasurementName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function stableMeasurementKey(name) {
  const registered = SYSTEM_HEALTH_MEASUREMENT_IDS[normalizedMeasurementName(name)];
  if (registered) return registered;
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `system_health:unregistered-${slug || 'unnamed-measurement'}`;
}

// Parse the primary SYSTEM HEALTH roster into independent measurement work
// units. The later Attention and probe-detail blocks repeat or expand those
// rows, so they are deliberately excluded. This is the durable seam used by
// the card artifact, live-board receipt, controller, and healer coordinator.
function systemHealthWorkUnits(systemHealthBody) {
  const units = [];
  const byId = new Map();
  for (const line of String(systemHealthBody || '').split(/\r?\n/)) {
    if (/^\s*(?:Attention on \d+ subsystem\(s\):|Probe detail \(proof of health\))\s*$/i.test(line)) {
      break;
    }
    const match = line.match(
      /^\s*([\u2713\u2717?])\s+([A-Za-z][\w:\s+&/().#-]*?):\s*(.+?)\s*$/,
    );
    if (!match) continue;
    const name = match[2].trim();
    const key = stableMeasurementKey(name);
    const registered = !key.startsWith('system_health:unregistered-');
    const informational = isInformationalTestsRowText(line);
    const status = match[1] === '\u2713' ? 'green' : match[1] === '\u2717' ? 'red' : 'ExampleCo';
    const unit = {
      id: key,
      cardId: 'system_health',
      name,
      status: !registered ? 'unverified' : informational ? 'informational' : status,
      actionable: !registered || (!informational && status !== 'green'),
      detail: !registered
        ? `Unregistered System Health measurement label: ${name}. ${match[3].trim()}`
        : match[3].trim(),
    };
    const existingIndex = byId.get(key);
    if (existingIndex == null) {
      byId.set(key, units.length);
      units.push(unit);
      continue;
    }
    const existing = units[existingIndex];
    if (existing.status !== unit.status || existing.detail !== unit.detail) {
      units[existingIndex] = {
        ...existing,
        status: 'unverified',
        actionable: true,
        detail: `Conflicting duplicate measurement rows: [${existing.status}] ${existing.detail} | [${unit.status}] ${unit.detail}`,
      };
    }
  }
  if (!units.length) {
    units.push({
      id: SYSTEM_HEALTH_MEASUREMENT_IDS['system health measurement evidence'],
      cardId: 'system_health',
      name: 'System Health measurement evidence',
      status: 'unverified',
      actionable: true,
      detail: 'No registered primary measurement rows were parsed from the System Health card.',
    });
  }
  return units;
}

// Parse the SYSTEM HEALTH section for every non-green subsystem row.
// A non-green row starts with the cross/X glyph or a question glyph, then the
// subsystem name. Returns the de-duped list of bare subsystem names.
function nonGreenSubsystems(systemHealthBody) {
  const out = [];
  const text = String(systemHealthBody || '');
  const lines = text.split(/\r?\n/);
  const fileChurnWatchOnly =
    /\bFileChurn\b/i.test(text) && /watch alert,\s*not a failure/i.test(text);
  // The cloud build cannot run the test suite (tests run on the desktop and in
  // CI), so the cloud SYSTEM HEALTH card ExampleCos a "?" Tests row that is
  // INFORMATIONAL, not a failing subsystem. Treat a Tests row that explicitly
  // declares it is not evaluated on the cloud build (or runs on the desktop/CI)
  // as informational, NOT a non-green subsystem requiring a health-failure count. This
  // mirrors the FileChurn watch-only carve-out above. Category, not literal
  // trigger: any subsystem row that states on its own line that it is not
  // evaluated/measured on this build is informational. ExampleCo 2026-06-20 #gap.
  const isInformationalNotEvaluatedRow = (line) => isInformationalTestsRowText(line);
  for (const line of lines) {
    // The "Probe detail (proof of health)" funnel is a DRILL-DOWN, not the
    // subsystem roster. Its lines (e.g. "<glyph> Otter speaker enrichment
    // probe:") look like roster rows but name the probe, not a subsystem. Once
    // we reach that block, stop scanning: a "... probe:" line was being parsed
    // as a PHANTOM subsystem ("Otter speaker enrichment probe") and inflated the
    // health count (ExampleCo 2026-06-29 green-tomorrow WAVE 1).
    // The block is always appended AFTER the roster + Attention block, so a hard
    // break is safe and never drops a real subsystem.
    if (/^\s*Probe detail \(proof of health\)\s*$/.test(line)) break;
    // A non-green row starts with the cross/X glyph or a question glyph, then
    // the subsystem name. Match both the "name: detail" and bare "name" forms
    // (the Attention block lists bare names).
    const m = line.match(/^\s*([✗?])\s+([A-Za-z][\w:\s+&/().#-]*?)\s*(?::\s+.+)?$/);
    if (m) {
      if (isInformationalNotEvaluatedRow(line)) continue;
      const name = m[2].trim().replace(/:$/, '');
      if (fileChurnWatchOnly && /^FileChurn(?: probe)?$/i.test(name)) continue;
      if (isInformationalNotEvaluatedRow(line)) continue;
      out.push(name);
    }
  }
  // De-dupe: the same subsystem appears once in the roster and again in the
  // Attention block.
  return Array.from(new Set(out));
}

// Parse the SYSTEM HEALTH section for EVERY subsystem row PRESENT in the roster,
// regardless of glyph (green checkmark, cross, or question). Used by the REVERSE
// health<->blockers consistency check: a blocker that names a subsystem the
// SYSTEM HEALTH card shows GREEN or OMITS entirely is a contradiction (ExampleCo
// 2026-07-01: BLOCKERS named "Scheduled tasks health" non-green while SYSTEM
// HEALTH showed only a green Graphiti row because the rest of the roster
// vanished). Same probe-detail cutoff + informational-Tests carve-out as
// nonGreenSubsystems so the two parsers cannot drift. Returns de-duped bare
// subsystem names.
function presentSubsystems(systemHealthBody) {
  const out = [];
  const text = String(systemHealthBody || '');
  const lines = text.split(/\r?\n/);
  const isInformationalNotEvaluatedRow = (line) => isInformationalTestsRowText(line);
  for (const line of lines) {
    if (/^\s*Probe detail \(proof of health\)\s*$/.test(line)) break;
    // Any glyph (green checkmark, cross, question) then the subsystem name, in
    // both the "name: detail" and bare-name (Attention block) forms.
    const m = line.match(/^\s*([✓✗?])\s+([A-Za-z][\w:\s+&/().#-]*?)\s*(?::\s+.+)?$/);
    if (m) {
      if (isInformationalNotEvaluatedRow(line)) continue;
      const name = m[2].trim().replace(/:$/, '');
      out.push(name);
    }
  }
  return Array.from(new Set(out));
}

module.exports = {
  nonGreenSubsystems,
  presentSubsystems,
  stableMeasurementKey,
  systemHealthWorkUnits,
  SYSTEM_HEALTH_MEASUREMENT_IDS,
};
