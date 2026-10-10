'use strict';

// SYSTEM HEALTH FACE NAMES AND CATEGORIES.
//
// ExampleCo, 2026-09-24: "All metric names should be a little more obvious what
// they're covering ... I don't mind if you spend 5 or 8 words just as long as
// it's obvious what it is that it's testing", and "consolidate things into the
// category that they are ... so that there's fewer metrics".
//
// This module is presentation only. Every measurement keeps its stable
// `system_health:<slug>` id, its producer label (the parse key), its ledger
// row, its live-QC proof and its healer policy. What changes is what ExampleCo
// reads: each id gets one plain-English name that says what passing means, and
// related ids fold into one category chip on the card face. The drilldown
// still lists every member check with its own chip and proof, so live QC keeps
// exactly one chip and one article per measurement.

const {
  isRetiredSystemHealthMeasurementId,
  stableMeasurementKey,
} = require('./system-health-nongreen.js');

// id -> the name ExampleCo reads. Each name states the passing condition.
const METRIC_FACE_NAMES = Object.freeze({
  'system_health:ec2': 'Cloud server answering its health check',
  'system_health:ec2-disk': 'Cloud server disk under 90% full',
  'system_health:backend-pm2-fleet': 'Every Amy background service running',
  'system_health:ec2-ssh-sessions': 'Cloud server SSH logins under 300',
  'system_health:dev-ops': 'Code checkout clean and synced with master',
  'system_health:deploy-parity': 'Live server runs the released code',
  'system_health:watcher-interventions': 'Overnight runs needed zero human rescues',
  'system_health:backups': "Last night's backup finished and restores",
  'system_health:backups-coverage': 'Every data source included in backups',
  'system_health:life-archive-backup': 'Every life archive source flowed today',
  'system_health:life-gmail': 'Life archive: Gmail history saved',
  'system_health:life-otter': 'Life archive: Otter calls saved',
  'system_health:life-vapi-amy': 'Life archive: Amy phone calls saved',
  'system_health:life-linkedin-posts': 'Life archive: LinkedIn posts saved',
  'system_health:life-linkedin-dms': 'Life archive: LinkedIn messages saved',
  'system_health:life-whatsapp': 'Life archive: WhatsApp messages saved',
  'system_health:life-dispatches': 'Life archive: #Amy dispatches saved',
  'system_health:life-codex-sessions': 'Life archive: Codex sessions saved',
  'system_health:life-claude-code-sessions': 'Life archive: Claude Code sessions saved',
  'system_health:life-sms-imessage': 'Life archive: texts and iMessages saved',
  'system_health:life-other-prompt-surfaces': 'Life archive: other AI chats saved',
  'system_health:gmail-scan': 'Gmail checked for #Amy emails within 12 minutes',
  'system_health:api-audit': 'No paid API used without a documented reason',
  'system_health:graphiti': 'Knowledge graph database running',
  'system_health:graphiti-advisor': 'Knowledge graph lookups answering',
  'system_health:recall-broker': 'Memory recall routing answering',
  'system_health:neo4j-cpu-cap': 'Knowledge graph held to 1.5 CPUs',
  'system_health:memory': "Amy's memory files intact and under size limit",
  'system_health:spec-changes': 'Briefing rules edited at most twice today',
  'system_health:session-transcript-freshness': 'AI session transcripts reach cloud within 10 minutes',
  'system_health:session-terminal-receipts': 'Every finished AI session transcript saved',
  'system_health:session-search-projection': 'Finished AI sessions searchable',
  'system_health:signal-flow-message-completeness': 'Signal: every message captured exactly once',
  'system_health:signal-flow-capture': 'Signal: receipt saved for every message',
  'system_health:signal-flow-archive': 'Signal: messages and attachments saved to cloud',
  'system_health:signal-flow-linked-context': 'Signal: shared links fetched and saved',
  'system_health:signal-flow-graphiti': 'Signal: messages added to knowledge graph',
  'system_health:signal-flow-people-knowledge': 'Signal: facts filed into People files',
  'system_health:otter-speaker-enrichment': "Past week's calls fully processed with speakers",
  'system_health:otter-call-processing-sla': 'Calls from last 24h processed within 60 minutes',
  'system_health:otter-lifetime-call-processing-completion': 'Every call ever recorded fully processed',
  'system_health:otter-hypothesis-projection': "Voice name guesses use today's voice roster",
  'system_health:otter-name-resolver': 'Unknown voices got name guesses in last 4 hours',
  'system_health:voice-name-conflicts': 'No voice confidently matches a different person',
  'system_health:voiceprint-text-conflicts': 'Voice and transcript agree on who spoke',
  'system_health:voice-name-judge-orphans': 'No voice name suggestions lost, all time',
  'system_health:past-week-voice-name-judge-orphans': 'No voice name suggestions lost, past week',
  'system_health:voice-people-projection': 'Confirmed voices written into People files',
  'system_health:voice-confirmation-save-actions': 'Voice confirmation Save clicks finish end to end',
  'system_health:video-pipeline': 'Video pipeline showing progress today',
  'system_health:stuck-videos': 'No rejected video stuck without a rebuild',
  'system_health:scheduled-tasks': "Every scheduled job due today ran",
  'system_health:cloud-briefing': "Today's briefing published to the dashboard",
  'system_health:briefing-delivery-slo': 'Briefing reached Telegram and email by 5:30 AM',
  'system_health:amy-gravity': 'Amy obeying every constitutional law today',
  'system_health:telegram-phone-intake': 'Telegram and phone lines answering (15-minute check)',
  'system_health:dispatch-backlog': "ExampleCo's requests moving, none stuck over 2 hours",
  'system_health:news-headlines-with-a-full-story': 'News: every usable headline got its full story',
  'system_health:ExampleCo': 'ExampleCo website loading',
  'system_health:client-app-app': 'Client App app and invoice system online',
  'system_health:client-app-email': 'Client App invoice email login working',
  'system_health:client-app-backups': 'Client App data backed up within the last hour',
  'system_health:automated-regression-suite': 'Automated tests: overall suite status',
  'system_health:tests-briefing': 'Tests: briefing sections build correctly',
  'system_health:tests-dispatch': 'Tests: Otter and Gmail turn into #Amy tasks',
  'system_health:tests-dashboard': 'Tests: dashboard displays data correctly',
  'system_health:tests-action-item-ranker': 'Tests: action items ranked correctly',
  'system_health:tests-auto-reply': 'Tests: auto-reply safety rules hold',
  'system_health:tests-self-heal': 'Tests: self-repair loop behaves correctly',
  'system_health:tests-memory': 'Tests: memory files formatted and indexed',
  'system_health:tests-video': 'Tests: video quality checks work',
  'system_health:tests-vapi': 'Tests: phone assistant configured correctly',
  'system_health:tests-ingest': 'Tests: Otter, Gmail and LinkedIn intake works',
  'system_health:tests-studio': 'Tests: video studio and thumbnails render',
  'system_health:tests-devops': 'Tests: release hygiene checks pass',
  'system_health:tests-other': 'Tests: all remaining checks pass',
});

// Category chips on the card face. Order is the face order. A metric not
// named in any group renders as its own chip after the groups.
const METRIC_FACE_GROUPS = Object.freeze([
  Object.freeze({
    key: 'cloud-server',
    name: 'Cloud server up, services running, disk and logins OK',
    members: [
      'system_health:ec2',
      'system_health:backend-pm2-fleet',
      'system_health:ec2-disk',
      'system_health:ec2-ssh-sessions',
    ],
  }),
  Object.freeze({
    key: 'briefing-delivery',
    name: 'Briefing published and delivered by 5:30 AM',
    members: ['system_health:cloud-briefing', 'system_health:briefing-delivery-slo'],
  }),
  Object.freeze({
    key: 'code-release',
    name: 'Live code matches the released version',
    members: ['system_health:deploy-parity', 'system_health:dev-ops'],
  }),
  Object.freeze({
    key: 'backups',
    name: 'Backups complete, restorable, every source covered',
    members: ['system_health:backups', 'system_health:backups-coverage'],
  }),
  Object.freeze({
    key: 'call-processing',
    name: 'Otter calls processed on time',
    members: [
      'system_health:otter-call-processing-sla',
      'system_health:otter-speaker-enrichment',
      'system_health:otter-lifetime-call-processing-completion',
    ],
  }),
  Object.freeze({
    key: 'voice-names',
    name: 'Voice names accurate and none lost',
    members: [
      'system_health:voice-name-conflicts',
      'system_health:voiceprint-text-conflicts',
      'system_health:otter-name-resolver',
      'system_health:otter-hypothesis-projection',
      'system_health:past-week-voice-name-judge-orphans',
      'system_health:voice-name-judge-orphans',
    ],
  }),
  Object.freeze({
    key: 'voice-people-files',
    name: 'Confirmed voices saved into People files',
    members: ['system_health:voice-confirmation-save-actions', 'system_health:voice-people-projection'],
  }),
  Object.freeze({
    key: 'signal',
    name: 'Signal messages captured, saved and filed',
    members: [
      'system_health:signal-flow-message-completeness',
      'system_health:signal-flow-capture',
      'system_health:signal-flow-archive',
      'system_health:signal-flow-linked-context',
      'system_health:signal-flow-people-knowledge',
      'system_health:signal-flow-graphiti',
    ],
  }),
  Object.freeze({
    key: 'ai-sessions',
    name: 'AI session transcripts saved and searchable',
    members: [
      'system_health:session-transcript-freshness',
      'system_health:session-terminal-receipts',
      'system_health:session-search-projection',
    ],
  }),
  Object.freeze({
    key: 'videos',
    name: 'Videos moving through production',
    members: ['system_health:video-pipeline', 'system_health:stuck-videos'],
  }),
  Object.freeze({
    key: 'client-app',
    name: 'Client App site up, invoices emailing, data backed up',
    members: ['system_health:client-app-app', 'system_health:client-app-email', 'system_health:client-app-backups'],
  }),
  Object.freeze({
    key: 'knowledge-graph',
    name: 'Knowledge graph (turned off by ExampleCo)',
    members: [
      'system_health:graphiti',
      'system_health:graphiti-advisor',
      'system_health:recall-broker',
      'system_health:neo4j-cpu-cap',
    ],
  }),
  Object.freeze({
    key: 'tests',
    name: 'Automated tests passing on this release',
    members: [
      'system_health:automated-regression-suite',
      'system_health:tests-briefing',
      'system_health:tests-dispatch',
      'system_health:tests-dashboard',
      'system_health:tests-action-item-ranker',
      'system_health:tests-auto-reply',
      'system_health:tests-self-heal',
      'system_health:tests-memory',
      'system_health:tests-video',
      'system_health:tests-vapi',
      'system_health:tests-ingest',
      'system_health:tests-studio',
      'system_health:tests-devops',
      'system_health:tests-other',
    ],
  }),
  Object.freeze({
    key: 'life-archive',
    name: 'Life archive catch-up (every source saved)',
    members: [
      'system_health:life-archive-backup',
      'system_health:life-gmail',
      'system_health:life-otter',
      'system_health:life-vapi-amy',
      'system_health:life-linkedin-posts',
      'system_health:life-linkedin-dms',
      'system_health:life-whatsapp',
      'system_health:life-dispatches',
      'system_health:life-codex-sessions',
      'system_health:life-claude-code-sessions',
      'system_health:life-sms-imessage',
      'system_health:life-other-prompt-surfaces',
    ],
    // Life: rows for sources that have no registered id yet still belong here.
    matchName: /^life:\s/i,
  }),
]);

const GROUP_BY_ID = new Map();
for (const group of METRIC_FACE_GROUPS) {
  for (const id of group.members) GROUP_BY_ID.set(id, group);
}

// Roll-up lines that restate other rows. They are not measurements, so they
// never render as a chip. `Quality gate` lists the other non-green rows.
const FACE_SUMMARY_ROW = /^quality gate$/i;

function isSystemHealthFaceSummaryRow(name) {
  return FACE_SUMMARY_ROW.test(String(name || '').trim());
}

// Rows that never render: roll-up lines, and retired measurements that an
// already-published or archived briefing still carries (ExampleCo 2026-09-24:
// a metric that only restates a card is gone, from every briefing date).
function isHiddenFromSystemHealthFace(name) {
  return isSystemHealthFaceSummaryRow(name) || isRetiredSystemHealthMeasurementId(metricIdForName(name));
}

function metricIdForName(name) {
  const raw = String(name || '').trim();
  return raw.startsWith('system_health:') ? raw : stableMeasurementKey(raw);
}

// The plain-English name for a producer label or a measurement id.
function metricFaceName(nameOrId) {
  const raw = String(nameOrId || '').trim();
  const id = metricIdForName(raw);
  if (METRIC_FACE_NAMES[id]) return METRIC_FACE_NAMES[id];
  const life = raw.match(/^life:\s*(.+)$/i);
  if (life) return `Life archive: ${life[1].replace(/_/g, ' ')} saved`;
  return raw;
}

function groupForName(name) {
  const id = metricIdForName(name);
  const byId = GROUP_BY_ID.get(id);
  if (byId) return byId;
  return METRIC_FACE_GROUPS.find((group) => group.matchName && group.matchName.test(String(name || ''))) || null;
}

// Worst-first status order for a category chip: one red member makes the
// category red, otherwise one yellow member makes it yellow.
const STATUS_RANK = { red: 4, yellow: 3, neutral: 2, green: 1 };

function worstStatus(statuses) {
  let worst = 'green';
  for (const status of statuses) {
    if ((STATUS_RANK[status] || 0) > (STATUS_RANK[worst] || 0)) worst = status;
  }
  return worst;
}

// Fold rendered rows into face entries. `statusOf(item)` returns the chip
// class (green | yellow | red | neutral) the renderer already uses, so a
// category can never be greener than its worst member.
function groupSystemHealthFace(items, { statusOf = (item) => item.status } = {}) {
  const entries = [];
  const byGroup = new Map();
  for (const item of items || []) {
    if (!item || isHiddenFromSystemHealthFace(item.name)) continue;
    const group = groupForName(item.name);
    if (!group) {
      entries.push({ key: `metric:${metricIdForName(item.name)}`, name: metricFaceName(item.name), members: [item], group: false });
      continue;
    }
    let entry = byGroup.get(group.key);
    if (!entry) {
      entry = { key: `group:${group.key}`, name: group.name, members: [], group: true, order: METRIC_FACE_GROUPS.indexOf(group) };
      byGroup.set(group.key, entry);
    }
    entry.members.push(item);
  }
  const groups = [...byGroup.values()].sort((a, b) => a.order - b.order);
  return [...groups, ...entries].map((entry) => ({
    ...entry,
    status: worstStatus(entry.members.map(statusOf)),
  }));
}

module.exports = {
  METRIC_FACE_NAMES,
  METRIC_FACE_GROUPS,
  groupSystemHealthFace,
  isHiddenFromSystemHealthFace,
  isSystemHealthFaceSummaryRow,
  metricFaceName,
  groupForName,
  worstStatus,
};
