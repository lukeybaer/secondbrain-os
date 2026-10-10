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

// 2026-09-07 (ExampleCo): there is no placeholder metric row. The permanent row set
// lives in scripts/lib/system-health-ledger.js, so a renderer that emits no
// roster can no longer mint a synthetic `system_health:measurement-evidence`
// unit for the controller to plan. This map is the label -> id registry only.

const SYSTEM_HEALTH_MEASUREMENT_IDS = Object.freeze({
  backups: 'system_health:backups',
  ec2: 'system_health:ec2',
  'news summaries': 'system_health:news-summaries',
  'news headlines with a full story': 'system_health:news-headlines-with-a-full-story',
  llm: 'system_health:llm',
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
  ExampleCo: 'system_health:ExampleCo',
  specchanges: 'system_health:spec-changes',
  'video pipeline': 'system_health:video-pipeline',
  'stuck videos': 'system_health:stuck-videos',
  'scheduled tasks': 'system_health:scheduled-tasks',
  'cloud briefing': 'system_health:cloud-briefing',
  'briefing delivery slo': 'system_health:briefing-delivery-slo',
  'laws of amy gravity': 'system_health:amy-gravity',
  'telegram and phone intake': 'system_health:telegram-phone-intake',
  'dispatch backlog': 'system_health:dispatch-backlog',
  'otter speaker enrichment': 'system_health:otter-speaker-enrichment',
  'past week otter speaker enrichment': 'system_health:otter-speaker-enrichment',
  'otter hypothesis projection': 'system_health:otter-hypothesis-projection',
  'otter name resolver': 'system_health:otter-name-resolver',
  'voice name-judge orphans': 'system_health:voice-name-judge-orphans',
  'otter call-processing sla': 'system_health:otter-call-processing-sla',
  'past 24h call processing sla': 'system_health:otter-call-processing-sla',
  'lifetime call processing completion': 'system_health:otter-lifetime-call-processing-completion',
  'voice name conflicts': 'system_health:voice-name-conflicts',
  'voiceprint conflicts with text': 'system_health:voiceprint-text-conflicts',
  'voice identity people file projection': 'system_health:voice-people-projection',
  'voice confirmation save actions': 'system_health:voice-confirmation-save-actions',
  'scheduled tasks health': 'system_health:scheduled-tasks',
  'backend pm2 fleet': 'system_health:backend-pm2-fleet',
  'ec2 disk': 'system_health:ec2-disk',
  'ec2 ssh sessions': 'system_health:ec2-ssh-sessions',
  graphiti: 'system_health:graphiti',
  'graphiti advisor': 'system_health:graphiti-advisor',
  'recall broker': 'system_health:recall-broker',
  'backups/coverage': 'system_health:backups-coverage',
  'life-archive backup': 'system_health:life-archive-backup',
  'life archive backup': 'system_health:life-archive-backup',
  'life: archive parent': 'system_health:life-archive-backup',
  'life: gmail': 'system_health:life-gmail',
  'life: otter': 'system_health:life-otter',
  'life: vapi_amy': 'system_health:life-vapi-amy',
  'life: linkedin_posts': 'system_health:life-linkedin-posts',
  'life: linkedin_dms': 'system_health:life-linkedin-dms',
  'life: whatsapp': 'system_health:life-whatsapp',
  'life: dispatches': 'system_health:life-dispatches',
  'life: codex_sessions': 'system_health:life-codex-sessions',
  'life: claude_code_sessions': 'system_health:life-claude-code-sessions',
  'life: sms_imessage': 'system_health:life-sms-imessage',
  'life: other_prompt_surfaces': 'system_health:life-other-prompt-surfaces',
  tests: 'system_health:tests',
  'dev ops': 'system_health:dev-ops',
  'deploy parity': 'system_health:deploy-parity',
  'watcher interventions': 'system_health:watcher-interventions',
  'lifetime voice name-judge orphans': 'system_health:voice-name-judge-orphans',
  'past week voice name-judge orphans': 'system_health:past-week-voice-name-judge-orphans',
  'session transcript freshness': 'system_health:session-transcript-freshness',
  'session terminal receipts': 'system_health:session-terminal-receipts',
  'session search projection': 'system_health:session-search-projection',
  'signal flow / message completeness': 'system_health:signal-flow-message-completeness',
  'signal flow / capture': 'system_health:signal-flow-capture',
  'signal flow / archive': 'system_health:signal-flow-archive',
  'signal flow / linked context': 'system_health:signal-flow-linked-context',
  'signal flow / graphiti': 'system_health:signal-flow-graphiti',
  'signal flow / people knowledge': 'system_health:signal-flow-people-knowledge',
  // ExampleCo 2026-09-24: Client App health is three live checks, one category.
  'client app app': 'system_health:client-app-app',
  'client app invoice email': 'system_health:client-app-email',
  'client app backups': 'system_health:client-app-backups',
});

// RETIRED measurements. ExampleCo removed these rows from his board and the
// producers no longer emit them, so they are deliberately absent from
// SYSTEM_HEALTH_MEASUREMENT_IDS above (that map is also the metric-skill-page
// registry via scripts/lib/card-skills.js, so an entry here would demand a page
// for a row that no longer exists).
//
// The labels stay RESOLVABLE for one reason only: a historical briefing that
// still carries the rendered row must keep parsing to its known id. Without
// this fallback stableMeasurementKey() would mint
// `system_health:unregistered-overnight-watcher-run`, which the parser grades
// `unverified` + actionable, so deleting a row would manufacture a brand-new
// red defect on every archived briefing. A retired id parses, renders as
// informational, and is never actionable and never a non-green subsystem.
//
// 2026-08-24 ExampleCo, on watcher liveness / "Overnight watcher run": "the metric
// Overnight watcher run is not needed, remove it." The watcher machinery,
// its heartbeat, and its dated report are untouched; only ExampleCo's health row is
// gone.
// 2026-08-24 ExampleCo, on the name-hypothesis backlog: "I don't need to review
// where I don't know voices and know names, in that one metric, I have the
// voice confirmation card for that." The hypothesis DATA still feeds the
// voice_confirmation card and the People projection; only the review-surface
// metric is retired.
const RETIRED_SYSTEM_HEALTH_MEASUREMENT_IDS = Object.freeze({
  'watcher liveness': 'system_health:watcher-liveness',
  'overnight watcher run': 'system_health:watcher-liveness',
  'voiceprint name hypotheses awaiting identity': 'system_health:voiceprint-name-hypotheses',
  // 2026-09-24 ExampleCo: "if there's a card that can go red by itself just because
  // the card doesn't have enough news in it then I don't need another metric
  // that measures that same thing". Retired: every row that only restated a
  // card's own verdict (the news, video, proposal, Calendar, Gmail action scan
  // and Client App invoice rows, Content readiness, News write-ups, Self-heal
  // health) and three fixed green strings with no probe behind them
  // (Contacts, FileChurn, MemoryDelta).
  'llm summarizer': 'system_health:llm-summarizer',
  'news write-ups': 'system_health:llm-summarizer',
  'news write ups': 'system_health:llm-summarizer',
  'content readiness': 'system_health:content-readiness',
  'self-heal health': 'system_health:self-heal-health',
  contacts: 'system_health:contacts',
  filechurn: 'system_health:file-churn',
  memorydelta: 'system_health:memory-delta',
  calendar: 'system_health:calendar',
  'client app': 'system_health:client-app',
  'gmail action scan': 'system_health:gmail-action-scan',
  'ai & tech news': 'system_health:ai-tech-news',
  'us news': 'system_health:us-news',
  'world news': 'system_health:world-news',
  'science treatments': 'system_health:science-treatments',
  'us policy news': 'system_health:us-policy-news',
  'finance industry news': 'system_health:finance-industry-news',
  'finance rate indexes': 'system_health:finance-rate-indexes',
  'shorts proposals': 'system_health:shorts-proposals',
  'viral clip proposals': 'system_health:viral-clip-proposals',
  'video approval queue': 'system_health:video-approval-queue',
});

const RETIRED_SYSTEM_HEALTH_MEASUREMENT_ID_SET = new Set(
  Object.values(RETIRED_SYSTEM_HEALTH_MEASUREMENT_IDS),
);

function isRetiredSystemHealthMeasurementId(id) {
  return RETIRED_SYSTEM_HEALTH_MEASUREMENT_ID_SET.has(String(id || '').trim());
}

function normalizedMeasurementName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stableMeasurementKey(name) {
  const normalized = normalizedMeasurementName(name);
  const registered = SYSTEM_HEALTH_MEASUREMENT_IDS[normalized];
  if (registered) return registered;
  // A retired row in an archived briefing resolves to its real id, never to an
  // `unregistered-` key that would be graded as a fresh actionable defect.
  const retired = RETIRED_SYSTEM_HEALTH_MEASUREMENT_IDS[normalized];
  if (retired) return retired;
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
const { isOwnerGatedSystemHealthWorkUnit } = require('./system-health-owner-gated.js');
const { isOwnerDisabledGraphitiItem } = require('./system-health-face-status.js');

function systemHealthWorkUnits(systemHealthBody, options) {
  const units = [];
  const byId = new Map();
  for (const line of String(systemHealthBody || '').split(/\r?\n/)) {
    if (
      /^\s*(?:Attention on \d+ subsystem\(s\):|Probe detail \(proof of health\))\s*$/i.test(line)
    ) {
      break;
    }
    const match = line.match(
      /^\s*([\u2713\u2717\u26a0?])\s+((?:Life:\s+)?[A-Za-z][\w:\s+&/().#>\-]*?):\s*(.+?)\s*$/,
    );
    if (!match) continue;
    const name = match[2].trim();
    const key = stableMeasurementKey(name);
    const registered = !key.startsWith('system_health:unregistered-');
    const informational = isInformationalTestsRowText(line);
    const lifeAdvisory = key.startsWith('system_health:life-');
    const graphitiAdvisory = isOwnerDisabledGraphitiItem({ id: key }, options);
    // Owner-gated lanes (lifetime catch-up, release bookkeeping, owner-disabled
    // services) are informational yellow unless green, even when an older
    // producer wrote a red glyph (ExampleCo 2026-09-02 and 2026-09-14). They are
    // never actionable from the board.
    const ownerGatedLane = isOwnerGatedSystemHealthWorkUnit(key, options);
    const status =
      graphitiAdvisory ? 'yellow' : lifeAdvisory || ownerGatedLane
      ? match[1] === '\u2713'
        ? 'green'
        : 'yellow'
      : match[1] === '\u2713'
        ? 'green'
        : match[1] === '\u2717'
          ? 'red'
          : match[1] === '\u26a0'
            ? 'yellow'
            : 'unknown';
    const manualOnly = normalizedMeasurementName(name) === 'laws of amy gravity';
    const immutableWatcher = key === 'system_health:watcher-interventions';
    // A retired row only ever reaches this parser from an ARCHIVED briefing.
    // It is history, never current work: informational, never actionable, and
    // never a red the healer or the board can be asked to clear.
    const retired = isRetiredSystemHealthMeasurementId(key);
    // A yellow orphan row means proposals stranded by reclusters that happened
    // BEFORE this repair existed, already queued and shrinking. That is work in
    // progress with a named owner, not a defect ExampleCo has to act on at 5:30am.
    // New stranding, a stalled repair, and an unverifiable count all render RED
    // and stay fully actionable, so this can never hide a live regression.
    const orphanBacklogInProgress =
      key === 'system_health:voice-name-judge-orphans' && status === 'yellow';
    const unit = {
      id: key,
      cardId: 'system_health',
      name,
      status: !registered ? 'unverified' : retired || informational ? 'informational' : status,
      actionable:
        retired ||
        manualOnly ||
        lifeAdvisory ||
        graphitiAdvisory ||
        ownerGatedLane ||
        immutableWatcher ||
        orphanBacklogInProgress
          ? false
          : !registered || (!informational && status !== 'green'),
      autoHeal: manualOnly ? false : undefined,
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
      // An owner-gated lane keeps the conflict visible in its detail but never
      // escalates to an actionable red (ExampleCo 2026-09-02).
      const ownerGatedDuplicate = isOwnerGatedSystemHealthWorkUnit(key, options);
      units[existingIndex] = {
        ...existing,
        status: ownerGatedDuplicate ? 'yellow' : 'unverified',
        actionable: ownerGatedDuplicate ? false : true,
        detail: `Conflicting duplicate measurement rows: [${existing.status}] ${existing.detail} | [${unit.status}] ${unit.detail}`,
      };
    }
  }
  // An empty roster returns an empty list. The board's row set comes from the
  // permanent ledger, never from what this renderer happened to emit, so a
  // missing roster can no longer shrink the board or mint a synthetic unit.
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
  // CI), so the cloud SYSTEM HEALTH card carries a "?" Tests row that is
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
    const m = line.match(/^\s*([✗?])\s+([A-Za-z][\w:\s+&/().#>\-]*?)\s*(?::\s+.+)?$/);
    if (m) {
      if (isInformationalNotEvaluatedRow(line)) continue;
      const name = m[2].trim().replace(/:$/, '');
      if (normalizedMeasurementName(name) === 'life' || /^life:\s*/i.test(name)) continue;
      if (fileChurnWatchOnly && /^FileChurn(?: probe)?$/i.test(name)) continue;
      if (isInformationalNotEvaluatedRow(line)) continue;
      // A retired row is history. An archived briefing that still shows it must
      // not report a health failure for a measurement ExampleCo deleted.
      if (isRetiredSystemHealthMeasurementId(stableMeasurementKey(name))) continue;
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
    const m = line.match(/^\s*([✓✗?])\s+([A-Za-z][\w:\s+&/().#>\-]*?)\s*(?::\s+.+)?$/);
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
  isRetiredSystemHealthMeasurementId,
  SYSTEM_HEALTH_MEASUREMENT_IDS,
  RETIRED_SYSTEM_HEALTH_MEASUREMENT_IDS,
};
