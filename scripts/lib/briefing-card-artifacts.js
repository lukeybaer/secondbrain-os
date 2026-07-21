'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CARDS, getCardById } = require('./briefing-card-manifest.js');
const { splitMarkdownCards, qcCard } = require('./briefing-card-qc.js');
const { askAI } = require('./ask-ai.js');
const { writeDataArtifact } = require('./data-root.js');
const { defectiveCardCount, readLiveBoardArtifact } = require('./live-board-truth.js');
const { providerReceiptPath, readProviderUsage } = require('./token-usage-receipts.js');
const { listCallSummaryArtifacts } = require('./otter-exec-summary-artifacts.js');
const { renderOtterSpeakerParetoCard } = require('./otter-speaker-pareto-card.js');
const { buildBigDecisionsSection, renderBigDecisionsMarkdown } = require('./big-decisions-card.js');

const SCHEMA_VERSION = 1;
const CARD_ARTIFACT_REL_DIR = path.join('agent', 'briefing-cards');
const BOARD_ARTIFACT_REL = path.join('agent', 'dashboard-qc-result.json');

const LLM_CARD_IDS = Object.freeze([
  'ai_tech_news',
  'us_news',
  'world_news',
  'us_immigration_news',
  'mortgage_industry_news',
  'covid_news',
  'communication_coaching',
  'reputation_risk',
  // shorts_proposals moved to DETERMINISTIC_CARD_BUILDERS (2026-07-21): it has
  // buildShortsProposalsCard that reads agent/shorts-proposals/<date>.json. The
  // LLM only runs inside morning-shorts-proposals.js upstream; routing the card
  // render through LLM_CARD_IDS caused "Blocked: LLM unavailable" whenever the
  // LLM fleet was down, while valid fallback proposals sat unread on disk.
]);

const RECIPROCAL_MERGE_PARTNERS = Object.freeze({
  content_pipeline: 'video_approval_queue',
  video_approval_queue: 'content_pipeline',
});

const CONTENT_HEAL_CARD_CONFIG = Object.freeze({
  ai_tech_news: { key: 'aitech', label: 'AI & TECH NEWS' },
  us_news: { key: 'us', label: 'US NEWS' },
  world_news: { key: 'world', label: 'WORLD NEWS' },
  us_immigration_news: { key: 'immigration', label: 'US IMMIGRATION NEWS' },
  mortgage_industry_news: { key: 'mortgage', label: 'MORTGAGE INDUSTRY NEWS' },
  covid_news: { key: 'covid', label: 'COVID-19 TREATMENTS & NEWS', minimum: 1 },
});

const MENTION_OR_ZERO_CARD_ID = (CARDS.find((card) => card && card.mentionOrZero) || {}).id;

const CARD_TITLE_OVERRIDES = Object.freeze({
  blockers: 'BLOCKERS - briefing quality gates',
  shorts_proposals: "TODAY'S 10 SHORTS PROPOSALS",
  // Derived from the id this would be 'UNCOMMITTED PARKED', which does not
  // satisfy the manifest matcher /^UNCOMMITTED & PARKED WORK\b/i, so the card
  // would emit a header the per-card parser cannot match back to its own row.
  uncommitted_parked: 'UNCOMMITTED & PARKED WORK',
  // Codex gate 50032535f442: derived would be 'FULL LIFE BACKUP', but the
  // manifest matcher is /^FULL[- ]LIFE DATA BACKUP/i. Without this the
  // card's truthful defect renders under a header the parser cannot match,
  // so an honest defect reads as a MISSING card instead.
  full_life_backup: 'FULL-LIFE DATA BACKUP',
});

function defaultDataDir() {
  return (
    process.env.SECONDBRAIN_DATA_DIR ||
    (process.platform === 'linux'
      ? '/opt/secondbrain/data'
      : path.join(
          process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
          'secondbrain',
          'data',
        ))
  );
}

function normalizeStatus(status) {
  const s = String(status || '')
    .trim()
    .toLowerCase();
  return ['clean', 'defect', 'blocked', 'stale'].includes(s) ? s : 'blocked';
}

function cardTitle(cardOrId) {
  const card = typeof cardOrId === 'string' ? getCardById(cardOrId) : cardOrId;
  const id = card ? card.id : String(cardOrId || '');
  if (CARD_TITLE_OVERRIDES[id]) return CARD_TITLE_OVERRIDES[id];
  if (!card)
    return String(cardOrId || '')
      .replace(/_/g, ' ')
      .toUpperCase();
  return String(card.title || card.id || '')
    .replace(/_/g, ' ')
    .toUpperCase();
}

function isLlmCard(id) {
  return LLM_CARD_IDS.includes(String(id || ''));
}

function cardArtifactDir(dataDir, date) {
  return path.join(dataDir || defaultDataDir(), CARD_ARTIFACT_REL_DIR, String(date || 'ExampleCo'));
}

function artifactPathFor({ dataDir, date, id }) {
  return path.join(cardArtifactDir(dataDir, date), `${String(id)}.json`);
}

function createCardArtifact({
  id,
  title,
  date,
  kind,
  status,
  markdown,
  generatedAt = new Date().toISOString(),
  source = {},
  qc = null,
  blockedReason = '',
  stale = false,
} = {}) {
  const card = getCardById(id);
  const normalizedStatus = normalizeStatus(status);
  const normalizedKind = kind || (isLlmCard(id) ? 'llm' : 'data');
  const body = String(markdown || '').trim();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: String(id || (card && card.id) || ''),
    title: title || cardTitle(card || id),
    date: String(date || ''),
    kind: normalizedKind,
    status: normalizedStatus,
    generatedAt,
    markdown:
      body ||
      `${title || cardTitle(card || id)}:\n${
        normalizedStatus === 'clean'
          ? `Produced successfully as of ${String(date || '').trim() || generatedAt}.`
          : blockedReason || 'This card is not publishable yet.'
      }`,
    source,
    qc: qc || {
      ok: normalizedStatus === 'clean',
      failures: normalizedStatus === 'clean' ? [] : [blockedReason || normalizedStatus],
    },
    blockedReason: normalizedStatus === 'blocked' ? blockedReason || 'Card blocked.' : '',
    stale: stale || normalizedStatus === 'stale',
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonl(file, limit = 200) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function writeCardArtifact({ dataDir, date, artifact }) {
  if (!artifact || !artifact.id) throw new Error('card artifact requires id');
  return writeJsonAtomic(
    artifactPathFor({ dataDir, date: date || artifact.date, id: artifact.id }),
    artifact,
  );
}

function readCardArtifact({ dataDir, date, id }) {
  const json = readJson(artifactPathFor({ dataDir, date, id }));
  if (!json || json.schemaVersion !== SCHEMA_VERSION || !json.id) return null;
  return normalizeArtifactQuality(json);
}

function cardForMarkdownTitle(title) {
  const text = String(title || '');
  return (
    CARDS.find((card) => {
      const re = new RegExp(card.match.source, card.match.flags.includes('i') ? 'i' : '');
      return re.test(text);
    }) || null
  );
}

function inferMarkdownSectionStatus(body, cardId = '') {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines[0] || '';
  const firstFew = lines.slice(0, 4).join('\n');
  if (
    String(cardId || '') === 'voice_confirmation' &&
    /\bPast-7-day Otter archive health:\s*RED\b/i.test(String(body || ''))
  ) {
    return 'blocked';
  }
  if (
    /^Card refresh pending:\s*fresh data and scoped live QC are still in progress\./i.test(first)
  ) {
    return 'blocked';
  }
  if (/^(HARD-BLOCKED|BLOCKED\b|Blocked:|This card is held\b)/i.test(first)) return 'blocked';
  if (/^Status:\s*(blocked|red|stale|unavailable)\b/i.test(firstFew)) return 'blocked';
  if (/^Severity:\s*(red|blocked)\b/i.test(firstFew)) return 'blocked';
  if (/^(Source unavailable|Source expired|Unavailable)\b:?/i.test(first)) return 'blocked';
  if (/^\u2717\s/.test(first)) return 'blocked';
  if (
    /did not produce content on the cloud build|Broken for a known reason self-heal could not fix/i.test(
      firstFew,
    )
  ) {
    return 'blocked';
  }
  // "not synced to cloud yet" is the honest fallback emitted by the generated-
  // section-injectors loop when the injector fails or is disabled. It is always
  // a blocker, never a clean card. 2026-07-21.
  if (/^Status:\s*not synced to cloud yet\b/i.test(first)) return 'blocked';
  if (/held back rather than shown as today|more than 24 hours old/i.test(first)) return 'blocked';
  return 'clean';
}

function markdownSectionToArtifact(section, { date, generatedAt = new Date().toISOString() } = {}) {
  const card = cardForMarkdownTitle(section && section.title);
  if (!card) return null;
  const body = String(section.body || '').trim();
  const status = inferMarkdownSectionStatus(body, card.id);
  return normalizeArtifactQuality(
    createCardArtifact({
      id: card.id,
      title: section.title,
      date,
      kind: isLlmCard(card.id) ? 'llm' : 'data',
      status,
      generatedAt,
      markdown: `${section.title}:\n${body}`,
      source: { mode: 'markdown-fallback', path: `briefings/briefing-${date}.md` },
      blockedReason: status === 'blocked' ? body.split(/\r?\n/)[0].slice(0, 200) : '',
      qc: {
        ok: status === 'clean',
        failures: status === 'clean' ? [] : [body.split(/\r?\n/)[0].slice(0, 200) || 'blocked'],
      },
    }),
  );
}

function markdownPathFor(dataDir, date) {
  return path.join(dataDir || defaultDataDir(), 'briefings', `briefing-${date}.md`);
}

function readCompatibilityMarkdown({ dataDir, date } = {}) {
  try {
    return fs.readFileSync(markdownPathFor(dataDir, date), 'utf8');
  } catch {
    return '';
  }
}

function readMarkdownFallbackArtifacts({ dataDir, date } = {}) {
  const file = markdownPathFor(dataDir, date);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  return splitMarkdownCards(raw)
    .map((section) => markdownSectionToArtifact(section, { date }))
    .filter(Boolean);
}

function readExplicitArtifacts({ dataDir, date } = {}) {
  const dir = cardArtifactDir(dataDir, date);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name)))
    .filter((json) => json && json.schemaVersion === SCHEMA_VERSION && json.id)
    .map((json) => normalizeArtifactQuality(json));
}

function uniqueList(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function artifactContentFailures(artifact) {
  const status = normalizeStatus(artifact && artifact.status);
  if (status !== 'clean') return [];
  const markdown = artifactMarkdown(artifact);
  const failures = [];
  if (
    /did not produce content on the cloud build|Broken for a known reason self-heal could not fix/i.test(
      markdown,
    )
  ) {
    failures.push('card ExampleCos broken cloud-build fallback copy');
  }
  if (
    /Card refresh pending:\s*fresh data and scoped live QC are still in progress\./i.test(markdown)
  ) {
    failures.push('card ExampleCos pending refresh shell copy');
  }
  const parsed = splitMarkdownCards(markdown)[0] || {
    title: artifact.title || cardTitle(artifact.id),
    body: markdown,
  };
  const qcFailures = qcCard(
    {
      id: artifact.id,
      title: parsed.title || artifact.title || cardTitle(artifact.id),
      body: parsed.body || '',
    },
    { surface: 'card-artifact' },
  ).failures.filter(
    (failure) =>
      !(artifact.id === 'big_decisions' && /raw operational detail/i.test(String(failure || ''))),
  );
  return uniqueList([...failures, ...qcFailures]);
}

function scheduleEventStart(event) {
  return event && event.start && (event.start.dateTime || event.start.date)
    ? event.start.dateTime || event.start.date
    : event && (event.date || event.when || event.startTime);
}

function ctDateKeyFromEventStart(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return raw.slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function addIsoDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function scheduleDayLabel(dayKey, targetDate) {
  if (dayKey === targetDate) return 'Today';
  const d = new Date(`${dayKey}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return dayKey;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

function scheduleTime(event) {
  const raw = scheduleEventStart(event);
  if (!raw || /^\d{4}-\d{2}-\d{2}$/.test(String(raw))) return 'All day';
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

function normalizeScheduleEvents(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.events)) return raw.events;
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw.days)) {
    return raw.days.flatMap((day) =>
      (day.events || day.meetings || []).map((event) => ({
        ...event,
        date: event.date || day.date,
      })),
    );
  }
  return [];
}

function isRoutineScheduleItem(title) {
  return /\b(lock doors?|vitamins?|pray|read the word|routine|reminder|alarm|sleep|wake up)\b/i.test(
    String(title || ''),
  );
}

function produceMeetingsCardArtifact({ date, dataDir, now = new Date() }) {
  const title = cardTitle('meetings');
  const sourcePath = [
    path.join(dataDir, 'agent', 'google-calendar-snapshot.json'),
    path.join(dataDir, 'agent', 'calendar-snapshot.json'),
    path.join(dataDir, 'calendar', 'events.json'),
    path.join(dataDir, 'calendar-events.json'),
  ].find((file) => fs.existsSync(file));
  if (!sourcePath) return null;
  const raw = readJson(sourcePath);
  const horizonEnd = addIsoDays(date, 7);
  const events = normalizeScheduleEvents(raw)
    .map((event) => {
      const day = ctDateKeyFromEventStart(scheduleEventStart(event));
      return {
        day,
        start: String(scheduleEventStart(event) || ''),
        time: scheduleTime(event),
        title: String(event.title || event.summary || event.name || 'Calendar item').trim(),
        status: String(event.status || ''),
      };
    })
    .filter(
      (event) =>
        event.day >= date &&
        event.day <= horizonEnd &&
        !/cancelled/i.test(event.status) &&
        event.title &&
        !isRoutineScheduleItem(event.title),
    )
    .sort((a, b) => a.day.localeCompare(b.day) || a.start.localeCompare(b.start));
  const todayCount = events.filter((event) => event.day === date).length;
  const upcomingCount = events.filter((event) => event.day !== date).length;
  const body = [
    events.length
      ? `Today: ${todayCount} meeting${todayCount === 1 ? '' : 's'}; next 7 days: ${upcomingCount} upcoming non-routine item${upcomingCount === 1 ? '' : 's'}.`
      : 'Today: no meetings; next 7 days: no non-routine calendar items (calendar read OK).',
    `Source: calendar snapshot read OK; ${Number(raw && raw.eventCount) || normalizeScheduleEvents(raw).length || 0} calendar event(s) scanned.`,
  ];
  if (!events.length) {
    body.push('No non-routine meetings today or next 7 days.');
  } else {
    const groups = new Map();
    for (const event of events) {
      if (!groups.has(event.day)) groups.set(event.day, []);
      groups.get(event.day).push(event);
    }
    for (const [day, rows] of groups) {
      body.push(`${scheduleDayLabel(day, date)}:`);
      rows.forEach((event, index) => {
        body.push(`${index + 1}. ${[event.time, event.title].filter(Boolean).join(' - ')}`);
      });
    }
  }
  const qc = qcCard({ id: 'meetings', title, body: body.join('\n') }, { surface: 'card-artifact' });
  return createCardArtifact({
    id: 'meetings',
    title,
    date,
    kind: 'data',
    status: qc.ok ? 'clean' : 'defect',
    generatedAt: now.toISOString(),
    markdown: `${title}:\n${body.join('\n')}`,
    source: { mode: 'calendar-snapshot', path: path.relative(dataDir, sourcePath) },
    qc,
  });
}

function produceBigDecisionsCardArtifact({ date, dataDir, now = new Date() }) {
  const section = buildBigDecisionsSection({
    ledgerFile: path.join(dataDir, 'agent', 'big-decisions.jsonl'),
    now,
  });
  const markdown = renderBigDecisionsMarkdown(section);
  if (!markdown) return null;
  const body = markdown.replace(/^BIG DECISIONS:\s*/i, '').trim();
  const qc = qcCard(
    { id: 'big_decisions', title: cardTitle('big_decisions'), body },
    { surface: 'card-artifact' },
  );
  return createCardArtifact({
    id: 'big_decisions',
    title: cardTitle('big_decisions'),
    date,
    kind: 'data',
    status: qc.ok ? 'clean' : 'defect',
    generatedAt: now.toISOString(),
    markdown,
    source: { mode: 'big-decisions-ledger', path: 'agent/big-decisions.jsonl' },
    qc,
  });
}

function normalizeArtifactQuality(artifact) {
  if (!artifact || !artifact.id) return artifact;
  const status = normalizeStatus(artifact.status);
  const explicitFailures =
    artifact.qc && Array.isArray(artifact.qc.failures) ? artifact.qc.failures : [];
  const failures = uniqueList([
    ...(status === 'clean' && artifact.qc && artifact.qc.ok === false
      ? explicitFailures.length
        ? explicitFailures
        : ['card artifact qc failed']
      : []),
    ...artifactContentFailures(artifact),
  ]);
  if (status !== 'clean' || failures.length === 0) return artifact;
  return {
    ...artifact,
    status: 'defect',
    qc: {
      ...(artifact.qc || {}),
      ok: false,
      failures,
    },
    blockedReason: '',
  };
}

function orderArtifacts(artifacts) {
  const order = new Map(CARDS.map((card, index) => [card.id, index]));
  return [...(artifacts || [])].sort((a, b) => {
    const ai = order.has(a.id) ? order.get(a.id) : 999;
    const bi = order.has(b.id) ? order.get(b.id) : 999;
    return ai - bi || String(a.id).localeCompare(String(b.id));
  });
}

function readCardArtifactUnion({ dataDir, date, allowMarkdownFallback = true } = {}) {
  const explicit = readExplicitArtifacts({ dataDir, date });
  const byId = new Map();
  let usedFallback = false;
  for (const artifact of explicit) byId.set(artifact.id, artifact);
  if (allowMarkdownFallback) {
    for (const artifact of readMarkdownFallbackArtifacts({ dataDir, date })) {
      if (!byId.has(artifact.id)) {
        byId.set(artifact.id, artifact);
        usedFallback = true;
      }
    }
  }
  const artifacts = orderArtifacts([...byId.values()]);
  const sourceMode =
    explicit.length && usedFallback
      ? 'json-plus-markdown-fallback'
      : explicit.length
        ? 'json'
        : usedFallback
          ? 'markdown-fallback'
          : 'empty';
  return { date, artifacts, sourceMode };
}

function artifactMarkdown(artifact) {
  const text = String(artifact && artifact.markdown ? artifact.markdown : '').trim();
  if (text) return text;
  const title = (artifact && artifact.title) || cardTitle(artifact && artifact.id);
  if (artifact && artifact.status === 'blocked') {
    return `${title}:\nBlocked: ${artifact.blockedReason || 'source unavailable'}`;
  }
  return `${title}:\nCard artifact had no markdown body.`;
}

function isRepresentedByMergePartnerArtifact(artifact) {
  return (
    artifact &&
    normalizeStatus(artifact.status) === 'clean' &&
    artifact.source &&
    artifact.source.mode === 'represented-by-merge-partner' &&
    artifact.source.partnerId
  );
}

function renderableArtifacts(artifacts) {
  return orderArtifacts(artifacts).filter(
    (artifact) => !isRepresentedByMergePartnerArtifact(artifact),
  );
}

function artifactsToBriefingMarkdown(
  artifacts,
  { date, generatedAt = new Date().toISOString(), mode = 'off-cycle' } = {},
) {
  // Compatibility markdown is used by attended artifact-union refreshes today,
  // so off-cycle is the default. Morning callers must pass mode: 'overnight'.
  const briefingMode = mode === 'overnight' ? 'overnight' : 'off-cycle';
  const lines = [
    `# Daily Briefing - ${date || generatedAt.slice(0, 10)}`,
    '',
    `Briefing mode: ${briefingMode}`,
    `Generated: ${generatedAt}`,
    '',
  ];
  for (const artifact of renderableArtifacts(artifacts)) {
    lines.push(artifactMarkdown(artifact), '', '---', '');
  }
  return `${lines.join('\n').replace(/\n---\n\s*$/, '\n')}`;
}

function loadBriefingFromCardArtifacts({ dataDir, date, allowMarkdownFallback = true } = {}) {
  const union = readCardArtifactUnion({ dataDir, date, allowMarkdownFallback });
  if (!union.artifacts.length) return null;
  const generatedAt =
    union.artifacts
      .map((artifact) => artifact.generatedAt)
      .filter(Boolean)
      .sort()
      .slice(-1)[0] || new Date().toISOString();
  return {
    date,
    filename: `briefing-${date}.md`,
    greeting: [`# Daily Briefing - ${date}`, '', `Generated: ${generatedAt}`].join('\n'),
    sourceMode: union.sourceMode,
    sections: renderableArtifacts(union.artifacts).map((artifact, index) => {
      const cards = splitMarkdownCards(artifactMarkdown(artifact));
      const parsed = cards[0] || { title: artifact.title, body: artifactMarkdown(artifact) };
      return {
        title: parsed.title || artifact.title,
        body: parsed.body || '',
        idx: index,
        artifact,
      };
    }),
  };
}

function statusToLiveStatus(status) {
  if (status === 'clean') return 'clean';
  if (status === 'blocked') return 'blocked';
  return 'defect';
}

function artifactDefectKinds(artifact) {
  const failures =
    artifact && artifact.qc && Array.isArray(artifact.qc.failures) ? artifact.qc.failures : [];
  return uniqueList([
    ...(failures || []),
    artifact && artifact.blockedReason,
    artifact && artifact.status,
  ]);
}

function liveBoardArtifactFromCardArtifacts(artifacts, { date, now = new Date() } = {}) {
  const ts = now.toISOString();
  const cards = orderArtifacts(artifacts).map((artifact) => {
    const liveStatus = statusToLiveStatus(artifact.status);
    return {
      id: artifact.id,
      title: artifact.title || cardTitle(artifact.id),
      status: liveStatus,
      defectKinds: liveStatus === 'clean' ? [] : artifactDefectKinds(artifact),
      asOf: artifact.generatedAt || ts,
    };
  });
  return liveBoardArtifactFromCards(cards, { date, now, source: PER_CARD_BOARD_SOURCE });
}

// Board-artifact provenance tags. The controller's post-refresh verifier has to
// recognise every tag this module can emit, so the vocabulary lives HERE (next
// to the only code that writes it) and consumers ask via isPerCardBoardSource().
// Drift scar: b34256fd added the '-scoped' tag for scoped publishes but left
// briefing-card-controller.js comparing to the bare literal, so every scoped
// single-card refresh failed verification and was rolled back even when the
// card built clean -- silently disabling per-card healing.
const PER_CARD_BOARD_SOURCE = 'per-card-artifacts';
const PER_CARD_BOARD_SOURCE_SCOPED = 'per-card-artifacts-scoped';
const PER_CARD_BOARD_SOURCES = Object.freeze([PER_CARD_BOARD_SOURCE, PER_CARD_BOARD_SOURCE_SCOPED]);

/** True when a live board artifact was assembled from per-card artifacts. */
function isPerCardBoardSource(source) {
  return PER_CARD_BOARD_SOURCES.includes(String(source || ''));
}

function liveBoardArtifactFromCards(
  cards,
  { date, now = new Date(), source = PER_CARD_BOARD_SOURCE } = {},
) {
  const ts = now.toISOString();
  return {
    ts,
    date,
    ran: true,
    ok: cards.every((card) => card.status === 'clean'),
    retry: false,
    defectiveCardCount: cards.filter((card) => card.status !== 'clean').length,
    cards,
    defectCount: cards.filter((card) => card.status !== 'clean').length,
    defects: cards
      .filter((card) => card.status !== 'clean')
      .map((card) => `${card.status.toUpperCase()}: ${card.id} ${card.defectKinds.join(', ')}`),
    source,
  };
}

function readExistingLiveBoardArtifact(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, BOARD_ARTIFACT_REL), 'utf8'));
  } catch {
    return null;
  }
}

function writeLiveBoardArtifactFromCardArtifacts({
  dataDir,
  date,
  artifacts,
  refreshedCardId = '',
  now = new Date(),
}) {
  let artifact = liveBoardArtifactFromCardArtifacts(artifacts, { date, now });
  const previous = refreshedCardId ? readExistingLiveBoardArtifact(dataDir) : null;
  if (previous && previous.date === date && Array.isArray(previous.cards)) {
    const previousById = new Map(previous.cards.map((card) => [card.id, card]));
    const cards = artifact.cards.map((card) =>
      card.id === refreshedCardId ? card : previousById.get(card.id) || card,
    );
    artifact = liveBoardArtifactFromCards(cards, {
      date,
      now,
      source: PER_CARD_BOARD_SOURCE_SCOPED,
    });
  }
  const absPath = writeDataArtifact(BOARD_ARTIFACT_REL, artifact, { dataDir });
  return { artifact, absPath };
}

function writeCompatibilityMarkdown({
  dataDir,
  date,
  artifacts,
  now = new Date(),
  mode = 'off-cycle',
}) {
  const markdown = artifactsToBriefingMarkdown(artifacts, {
    date,
    generatedAt: now.toISOString(),
    mode,
  });
  const file = markdownPathFor(dataDir, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, markdown, 'utf8');
  return file;
}

function isMissingSourcePlaceholderArtifact(artifact) {
  if (!artifact) return false;
  const source = artifact.source || {};
  const reason = `${artifact.blockedReason || ''}\n${artifact.markdown || ''}`;
  return (
    normalizeStatus(artifact.status) !== 'clean' &&
    (((source.missing === true || source.mode === 'data') &&
      /deterministic source artifact missing/i.test(reason)) ||
      /did not produce content on the cloud build|Broken for a known reason self-heal could not fix/i.test(
        reason,
      ))
  );
}

// The 11pm bootstrap writes every card a "Card refresh pending" shell. The
// generic fallthrough preserves an artifact's own status, so any shell that was
// stamped clean got REPUBLISHED as clean and the board counted a non-card as a
// good card. Measured on ExampleCo's 2026-07-20 board: voice_confirmation was status
// clean carrying nothing but that shell.
//
// artifactContentFailures already recognises the shell copy; it simply never
// got to override an inherited clean. A shell is not a card, whatever it says
// about itself, so this is the single place that decides. Fixing it here covers
// every card at once instead of one producer at a time.
function cleanStatusUnlessPendingShell(existing) {
  const markdown = String((existing && existing.markdown) || '');
  if (/Card refresh pending/i.test(markdown)) return 'defect';
  return existing && existing.status === 'clean'
    ? 'clean'
    : normalizeStatus(existing && existing.status);
}

function existingSourceArtifact({ dataDir, date, id }) {
  const current = readCardArtifact({ dataDir, date, id });
  const fallback = readMarkdownFallbackArtifacts({ dataDir, date }).find(
    (artifact) => artifact.id === id,
  );
  if (current) {
    if (fallback && isMissingSourcePlaceholderArtifact(current)) {
      return {
        ...fallback,
        source: {
          ...(fallback.source || {}),
          replacedMissingSourceArtifact: true,
          replacedArtifactGeneratedAt: current.generatedAt || current.generated_at || null,
        },
      };
    }
    const markdownMs = (() => {
      try {
        return fs.statSync(markdownPathFor(dataDir, date)).mtimeMs;
      } catch {
        return NaN;
      }
    })();
    const currentMs = Date.parse(current.generatedAt || current.generated_at || '');
    if (
      fallback &&
      Number.isFinite(markdownMs) &&
      (!Number.isFinite(currentMs) || markdownMs > currentMs)
    ) {
      return {
        ...fallback,
        source: { ...(fallback.source || {}), replacedStaleArtifact: true },
      };
    }
    return { ...current, source: { ...(current.source || {}), ExampleCodForward: true } };
  }
  return fallback || null;
}

function firstRedSystemHealthRow(markdown) {
  return (
    String(markdown || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^\u2717\s+/.test(line)) || ''
  );
}

function systemHealthStatusFromMarkdown(markdown) {
  return firstRedSystemHealthRow(markdown) ? 'blocked' : 'clean';
}

function previousIsoDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return String(date || '');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function tokenUsageSourceArtifactPaths(dataDir, date) {
  const agentDir = path.join(dataDir || defaultDataDir(), 'agent');
  return [
    path.join(agentDir, `token-usage-${previousIsoDate(date)}.json`),
    providerReceiptPath(dataDir || defaultDataDir(), date, 'claude'),
    providerReceiptPath(dataDir || defaultDataDir(), date, 'codex'),
    providerReceiptPath(dataDir || defaultDataDir(), date, 'bedrock'),
    path.join(agentDir, 'claude-plan-usage.json'),
    path.join(agentDir, 'codex-token-usage-week.json'),
    path.join(agentDir, 'bedrock-budget-usage.json'),
  ];
}

function hasTokenUsageSourceArtifact({ dataDir, date } = {}) {
  return tokenUsageSourceArtifactPaths(dataDir, date).some((file) => fs.existsSync(file));
}

function produceSystemHealthCardArtifact({
  date,
  dataDir = defaultDataDir(),
  now = new Date(),
  markdownForProof,
  renderSystemHealthSectionFn,
} = {}) {
  const renderer =
    renderSystemHealthSectionFn ||
    require('../refresh-briefing-generated-sections.js').renderSystemHealthSection;
  const proof =
    markdownForProof === undefined
      ? readCompatibilityMarkdown({ dataDir, date })
      : markdownForProof;
  const markdown = String(renderer(proof, { dataDir, date }) || '').trim();
  const status = systemHealthStatusFromMarkdown(markdown);
  const redRow = firstRedSystemHealthRow(markdown);
  const blockedReason = redRow ? redRow.replace(/^\u2717\s+/, '').slice(0, 220) : '';
  return createCardArtifact({
    id: 'system_health',
    title: cardTitle('system_health'),
    date,
    kind: 'data',
    status,
    generatedAt: now.toISOString(),
    markdown,
    source: { mode: 'system-health-renderer' },
    blockedReason:
      status === 'blocked' ? blockedReason || 'System Health still has red subsystem rows.' : '',
    qc: {
      ok: status === 'clean',
      failures: status === 'clean' ? [] : [blockedReason || 'System Health red subsystem rows'],
    },
  });
}

// Pull the live board's own QC messages for one card. The board records
// defects as free-form strings that name the card id and/or its title, e.g.
// 'VALUE-SANITY: aws_costs (AWS COSTS) metric "unavailable" ...'. Match on
// either, dedupe, and cap so one noisy card cannot crowd out the rest.
function defectMessagesForCard(artifact, card, { max = 2 } = {}) {
  const raw = Array.isArray(artifact && artifact.defects) ? artifact.defects : [];
  const id = String((card && card.id) || '').trim();
  const title = String((card && card.title) || '').trim();
  if (!id && !title) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const message = String(
      typeof entry === 'string' ? entry : (entry && (entry.message || entry.title)) || '',
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (!message) continue;
    // Whole-token match, not naked substring. No current manifest id or title
    // contains another (verified across all 35 cards), but `includes` would
    // start misattributing the moment someone adds e.g. `us_news_weekly`
    // alongside `us_news`. Codex flagged the latent hazard; this closes it.
    const names = [id, title].some((needle) => {
      if (!needle || needle.length < 3) return false;
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, 'i').test(message);
    });
    if (!names) continue;
    const key = message.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(message.length > 300 ? `${message.slice(0, 297)}...` : message);
    if (out.length >= max) break;
  }
  return out;
}

function formatBlockersCardBodyFromLiveBoard(liveBoardEnvelope = {}) {
  const artifact = liveBoardEnvelope.artifact || null;
  const cards = Array.isArray(artifact && artifact.cards) ? artifact.cards : [];
  const defectiveCards = cards.filter(
    (card) => card && card.status !== 'clean' && card.id !== 'blockers',
  );
  const count = defectiveCards.length;
  const lines = [];
  if (!artifact || defectiveCardCount(artifact) === null) {
    return 'Blocked: the live board count source is missing or invalid; cannot render the canonical Blockers count.';
  }
  if (count === 0) {
    lines.push('Clean? yes. Live dashboard QC reports 0 survived defects for this briefing.');
  } else {
    lines.push(
      `Clean? no. Live dashboard QC reports ${count} card${count === 1 ? '' : 's'} needing repair for this briefing.`,
    );
  }
  if (liveBoardEnvelope.stale) {
    lines.push(
      `Live card badge count: stale (last verified ${artifact.ts || 'ExampleCo time'}, older than one briefing cycle) -- do not treat this as the current Blockers issue count.`,
    );
  } else {
    lines.push(`Live card badge count: ${count} card(s) needing repair as of ${artifact.ts}.`);
  }
  defectiveCards.forEach((card, index) => {
    const title = card.title || card.id || `Defective card ${index + 1}`;
    lines.push('');
    lines.push(`${index + 1}. ${title}`);
    // The live board already ExampleCos the real QC diagnosis for every defect it
    // counted. Surface it. Restating "this card is not clean" tells ExampleCo only
    // what the heading above already said, and it is the same evidence-stripping
    // class as the 2026-06-11 rule-recital incident
    // (scripts/__tests__/blocker-copy-from-artifact.test.js). Guarded here by
    // scripts/__tests__/blockers-card-ExampleCos-real-defect-evidence.test.js.
    const evidence = defectMessagesForCard(artifact, card);
    if (evidence.length) {
      // ONE Evidence line only. ec2-server.js:6626-6632 parses `Evidence:` with
      // `cur.blocker = ...`, a plain assignment, so a second line silently
      // overwrites the first and the renderer shows only the last. Codex caught
      // this (review d28809172c23) after I verified the builder output but not
      // the rendered surface. Join instead, so every diagnosis survives.
      lines.push(`Evidence: ${evidence.join(' | ')}`);
    } else if (card.id === 'system_health') {
      lines.push(
        'Evidence: The health card needs attention; subsystem detail stays in SYSTEM HEALTH.',
      );
    } else {
      // Never invent a diagnosis. Say plainly that the board recorded none.
      lines.push(
        'Evidence: the live board counted this card as defective but recorded no defect detail for it.',
      );
    }
    lines.push('Next step: refresh this card source and republish.');
  });
  return lines.join('\n').trim();
}

function produceBlockersCardArtifact({ date, dataDir, now = new Date() } = {}) {
  const title = cardTitle('blockers');
  const liveBoardEnvelope = readLiveBoardArtifact({
    dataDir,
    nowMs: new Date(now).getTime(),
  });
  const body = formatBlockersCardBodyFromLiveBoard(liveBoardEnvelope);
  const qc = qcCard({ id: 'blockers', title, body }, { surface: 'card-artifact' });
  const missing =
    !liveBoardEnvelope.artifact || defectiveCardCount(liveBoardEnvelope.artifact) === null;
  return createCardArtifact({
    id: 'blockers',
    title,
    date,
    kind: 'data',
    status: missing ? 'blocked' : qc.ok ? 'clean' : 'defect',
    generatedAt: now.toISOString(),
    markdown: `${title}:\n${body}`,
    source: {
      mode: 'dashboard-qc-result',
      path: liveBoardEnvelope.absPath || null,
      stale: Boolean(liveBoardEnvelope.stale),
      defectiveCardCount: liveBoardEnvelope.artifact
        ? defectiveCardCount(liveBoardEnvelope.artifact)
        : null,
    },
    blockedReason: missing ? 'dashboard-qc-result.json missing or invalid.' : '',
    qc,
  });
}

function produceTokenUsageCardArtifact({
  date,
  dataDir = defaultDataDir(),
  now = new Date(),
  formatTokenUsageSectionFn,
} = {}) {
  const renderer =
    formatTokenUsageSectionFn || require('../cloud-morning-briefing.js').formatTokenUsageSection;
  const body = String(renderer(dataDir, date, { now }) || '').trim();
  const providerStates = ['claude', 'codex', 'bedrock'].map((provider) =>
    readProviderUsage({ dataDir, date, provider, now }),
  );
  const failures = providerStates
    .filter((state) => state.state !== 'fresh')
    .map((state) => {
      const label = state.provider.charAt(0).toUpperCase() + state.provider.slice(1);
      const detail = state.defect?.detail || `${state.provider} usage is ${state.state}`;
      return `${label} usage ${state.state}: ${detail}`;
    });
  const dailyUsagePath = path.join(dataDir, 'agent', `token-usage-${previousIsoDate(date)}.json`);
  if (!fs.existsSync(dailyUsagePath)) {
    failures.unshift(`Daily usage missing: ${path.basename(dailyUsagePath)}`);
  }
  if (!body) {
    return createCardArtifact({
      id: 'token_usage',
      title: cardTitle('token_usage'),
      date,
      kind: 'data',
      status: 'blocked',
      generatedAt: now.toISOString(),
      markdown: `${cardTitle('token_usage')}:\nBlocked: token usage renderer returned no content.`,
      blockedReason: 'Token usage renderer returned no content.',
      source: { mode: 'token-usage-renderer', missing: true },
    });
  }
  return createCardArtifact({
    id: 'token_usage',
    title: cardTitle('token_usage'),
    date,
    kind: 'data',
    status: failures.length ? 'blocked' : 'clean',
    generatedAt: now.toISOString(),
    markdown: `${cardTitle('token_usage')}:\n${body}`,
    source: {
      mode: 'token-usage-renderer',
      artifacts: [
        `agent/token-usage-${previousIsoDate(date)}.json`,
        'agent/claude-plan-usage.json',
        'agent/codex-token-usage-week.json',
        'agent/bedrock-budget-usage.json',
      ],
      providerReceipts: providerStates.map((state) => ({
        provider: state.provider,
        state: state.state,
        path: path.relative(dataDir, state.file).replace(/\\/g, '/'),
        sourceMode: state.sourceMode,
      })),
    },
    blockedReason: failures[0] || '',
    qc: { ok: failures.length === 0, failures },
  });
}

// AWS COSTS had no named producer, so produceDataCardArtifact fell through to
// existingSourceArtifact and copied whatever sat on disk. On 2026-07-20 that
// was the 11pm bootstrap shell ("Card refresh pending"), stamped clean. The
// card could never carry a spend figure because the per-card path never called
// the real builder. This producer calls it, and gates on CONTENT freshness
// rather than filename: agent/aws-costs-2026-07-20.md existed with today's name
// while carrying an April-May window, so a filename-only check passes a
// 71-day-old number off as today's spend.
// Parse the window end date out of either artifact dialect. The live EC2
// artifact writes "Window: <start> through <end>"; the PC multi-profile format
// writes "AWS COST DETAIL <dash> <start> to <end>" (the dash is U+2014, matched
// as a short non-digit run so no forbidden literal appears in source).
const {
  awsCostContractFailures,
  awsCostArtifactIsSelfSufficient,
} = require('./aws-cost-window.js');

// The local awsCostWindowEnd / awsCostStaleDays / awsCostArtifactNeedsRebuild
// helpers that lived here are gone, replaced by ./aws-cost-window.js above.
// awsCostArtifactNeedsRebuild was a NEGATIVE gate whose default was "reuse",
// and its last line `return staleDays !== null && staleDays > 1` short-circuited
// to false for every artifact with no parseable window. Running the real code
// proved that a reworded pending shell carrying an unrelated "$15.05" reached
// the board with status clean and qc.ok true. The replacement is positive:
// an artifact is reused only if it PROVES its own freshness and structure, so
// every ExampleCo falls through to a real rebuild.

function produceAwsCostsCardArtifact({
  date,
  dataDir = defaultDataDir(),
  now = new Date(),
  buildAwsCostsCardFn,
} = {}) {
  const title = cardTitle('aws_costs');
  const artifactRef = `agent/aws-costs-${date}.md`;
  const blocked = (reason, source = {}) =>
    createCardArtifact({
      id: 'aws_costs',
      title,
      date,
      kind: 'data',
      status: 'blocked',
      generatedAt: now.toISOString(),
      markdown: `${title}:\n${reason}`,
      blockedReason: reason,
      source: { mode: 'aws-cost-explorer-live', artifact: artifactRef, ...source },
      qc: { ok: false, failures: [reason] },
    });

  const build = buildAwsCostsCardFn || require('../cloud-morning-briefing.js').buildAwsCostsCard;
  let card;
  try {
    // allowLiveRefresh drives the live Cost Explorer query on the EC2 build
    // host, which rewrites the dated snapshot before it is parsed back.
    card = build(dataDir, date, { allowLiveRefresh: true });
  } catch (error) {
    const detail = String((error && error.message) || error).slice(0, 200);
    return blocked(`AWS cost builder threw: ${detail}`, { threw: true });
  }

  if (!card || card.real !== true) {
    // card.detail is already answer-first prose that ec2-server's
    // parseAwsCostsBody recognizes verbatim. Do not prefix it.
    return blocked(
      String((card && card.detail) || 'AWS cost builder returned no verified spend figure.'),
      { missing: true },
    );
  }

  const body = String(card.body || '');
  // ONE validator, shared with the source contract and the 5:30 full build, so
  // the three can never drift apart again. The inline copy this replaced parsed
  // for a "Window:" line that buildAwsCostsCard has never emitted, so it would
  // have blocked every genuine success while its own tests stayed green (they
  // used an invented fixture). It also required a "Top services" heading that
  // appears in no real artifact.
  const { failures: contractFailures, freshness } = awsCostContractFailures({
    text: body,
    date,
    snapshotDate: card.snapshotDate || null,
  });

  if (!freshness.current) {
    const totalLine = body.match(/^Total:\s*(\$[\d,.]+)/im);
    const totalLabel = totalLine ? totalLine[1] : 'no total parsed';
    return blocked(
      `AWS cost snapshot is not current: ${freshness.reason}, so today's spend cannot be ` +
        `verified. Dated context only: ${totalLabel}. Remediation: re-run the live Cost ` +
        `Explorer scan on the EC2 build host (SECONDBRAIN_DATA_DIR=/opt/secondbrain/data node ` +
        `scripts/refresh-card.js aws_costs --publish).`,
      { staleWindowEnd: freshness.windowEnd, staleDays: freshness.staleDays },
    );
  }

  const cardTitleText = String(card.title || title);
  const localFailures = contractFailures.slice();
  if (/\$\s?\d/.test(body) && /\$0(?:\.00)?\b|unavailable|n\/a/i.test(cardTitleText)) {
    localFailures.push(
      'AWS metric shows $0/unavailable while the body ExampleCos a verified dollar figure',
    );
  }

  const qc = qcCard({ id: 'aws_costs', title: cardTitleText, body }, { surface: 'card-artifact' });
  const failures = [...(qc.failures || []), ...localFailures];

  // DO NOT add a threshold-based failure here. A projected monthly over $1000
  // renders RED by policy and that is a correctly surfaced business fact, not a
  // card defect. Deriving status from the size of the dollar figure would make
  // self-heal chase a number it must never "repair".
  const pick = (re) => (body.match(re) || [])[1] || null;
  return createCardArtifact({
    id: 'aws_costs',
    // The builder's title ExampleCos the run-rate figure that both the ec2-server
    // awsCosts tile branch and awsCostsIsCleanThresholdAlert parse. Keep it.
    title: cardTitleText,
    date,
    kind: 'data',
    status: failures.length ? 'defect' : 'clean',
    generatedAt: now.toISOString(),
    markdown: `${cardTitleText}:\n${body}`,
    source: {
      mode: 'aws-cost-explorer-live',
      artifact: artifactRef,
      builder: 'cloud-morning-briefing.buildAwsCostsCard',
      windowStart: freshness.windowStart,
      windowEnd: freshness.windowEnd,
      staleDays: freshness.staleDays,
      priorDay: freshness.priorDay,
      dialect: freshness.dialect,
      total: pick(/^Verified accessible AWS spend:\s*\$?([\d,.]+)/im),
      projectedMonthly: pick(/^Projected monthly \(from 72h avg\):\s*\$([\d,.]+)/im),
      currentMonthlyRunRate: pick(/^Current monthly run-rate:\s*\$([\d,.]+)/im),
      liveRefresh: true,
    },
    blockedReason: '',
    qc: { ok: failures.length === 0, failures },
  });
}

// UNCOMMITTED & PARKED WORK had no named producer, so it fell through to the
// generic existingSourceArtifact copy and published the 11pm "Card refresh
// pending" shell as clean, while the real git-hygiene data sat unread on the
// same host. The snapshot REFRESHER was already wired (briefing-card-producers
// 'git-hygiene' maps this card to git-hygiene-snapshot.json); only the artifact
// producer was missing, so the refreshed snapshot was never rendered.
function produceUncommittedParkedCardArtifact({
  date,
  dataDir = defaultDataDir(),
  now = new Date(),
  formatUncommittedParkedWorkSectionFn,
} = {}) {
  const title = cardTitle('uncommitted_parked');
  const render =
    formatUncommittedParkedWorkSectionFn ||
    require('./git-hygiene-briefing.js').formatUncommittedParkedWorkSection;
  const snapshotPath = path.join(dataDir, 'agent', 'git-hygiene-snapshot.json');

  let body = '';
  try {
    // snapshotPath ONLY. Never pass cwd or classifier: EC2 has no working git
    // tree, and on the desktop the live classifier shells out ~6 git calls
    // against a 248-branch .git, which is the pinned hang class (483cd8ee).
    body = String(render({ today: date, snapshotPath, nowMs: now.getTime() }) || '').trim();
  } catch (error) {
    const reason = `git hygiene renderer threw: ${String((error && error.message) || error).slice(0, 200)}`;
    return createCardArtifact({
      id: 'uncommitted_parked',
      title,
      date,
      kind: 'data',
      status: 'blocked',
      generatedAt: now.toISOString(),
      markdown: `${title}:\n${reason}`,
      blockedReason: reason,
      source: {
        mode: 'git-hygiene-snapshot',
        artifact: 'agent/git-hygiene-snapshot.json',
        threw: true,
      },
      qc: { ok: false, failures: [reason] },
    });
  }

  if (!body) {
    const reason = 'Git hygiene renderer returned no content.';
    return createCardArtifact({
      id: 'uncommitted_parked',
      title,
      date,
      kind: 'data',
      status: 'blocked',
      generatedAt: now.toISOString(),
      markdown: `${title}:\n${reason}`,
      blockedReason: reason,
      source: { mode: 'git-hygiene-snapshot', missing: true },
      qc: { ok: false, failures: [reason] },
    });
  }

  // Drop the operational preamble. The renderer's canonical body ExampleCos an
  // Actions legend, a branch-state glossary, and the janitor's own invocation
  // ("git-janitor --apply --cap=5"). That is maintenance plumbing for whoever
  // runs the janitor, not something ExampleCo needs in a briefing, and the shared
  // artifact QC correctly flags it as raw operational detail. Trimming it is
  // honest; suppressing the QC failure would not be. The substance (which
  // branches are parked, stray, landed, locked) is untouched below.
  const OPERATIONAL_PREAMBLE = /^(?:Actions|Legend|Janitor timing):/i;
  body = body
    .split('\n')
    .filter((line) => !OPERATIONAL_PREAMBLE.test(line.trim()))
    .join('\n')
    .trim();

  // The renderer already emits its own honest blocker prose when the snapshot
  // is missing, stale past 30h, or malformed. Carry that verdict through rather
  // than re-deriving it, so builder and card never disagree.
  const rendererBlocked = /^hard blocker:/i.test(body);
  const qc = qcCard({ id: 'uncommitted_parked', title, body }, { surface: 'card-artifact' });
  const failures = rendererBlocked ? [body.split('\n')[0]] : qc.failures || [];

  return createCardArtifact({
    id: 'uncommitted_parked',
    title,
    date,
    kind: 'data',
    status: rendererBlocked ? 'blocked' : failures.length ? 'defect' : 'clean',
    generatedAt: now.toISOString(),
    markdown: `${title}:\n${body}`,
    source: { mode: 'git-hygiene-snapshot', artifact: 'agent/git-hygiene-snapshot.json' },
    blockedReason: rendererBlocked ? body.split('\n')[0] : '',
    qc: { ok: failures.length === 0, failures },
  });
}

// viral_tech_clips and kingdom_equipping were listed in LLM_CARD_IDS, so
// produceCardArtifact routed them down the LLM branch and asked a model to
// "Produce the <id> Daily Briefing card. Return concise markdown only." with no
// access to their data. Both outcomes were wrong: if the model answered, the
// card ExampleCod FABRICATED clip proposals with invented sources stamped clean
// (feedback_no_fabrication_in_briefings.md); if it failed, the card was blocked
// with "LLM unavailable" while real verified proposals sat unread on disk.
// Verified live 2026-07-20: viral_tech_clips.json was blocked at 11:12:57Z
// while agent/viral-tech-clips/2026-07-20.json held 3 real YouTube-sourced
// proposals. Neither card is LLM-rendered; both have deterministic builders
// reading a dated artifact. The LLM only participates upstream, inside the
// generator that writes that artifact.
const DETERMINISTIC_CARD_BUILDERS = Object.freeze({
  ...(MENTION_OR_ZERO_CARD_ID
    ? {
        [MENTION_OR_ZERO_CARD_ID]: (dataDir, date) =>
          require('../cloud-morning-briefing.js').formatExampleCoNewsSection(dataDir, date),
      }
    : {}),
  viral_tech_clips: (dataDir, date, now) =>
    require('../cloud-morning-briefing.js').buildViralTechCard(dataDir, date, [], now),
  kingdom_equipping: (dataDir, date) =>
    require('./briefing-cards/kingdom-equipping-card.js').buildKingdomEquippingCard(dataDir, date),
  mortgage_rate_indexes: (dataDir, date) =>
    require('./briefing-cards/mortgage-rate-indexes-card.js').buildMortgageRateIndexesCard(
      dataDir,
      date,
    ),
  tesla_cybercab: (_dataDir, date) =>
    require('./briefing-cards/tesla-cybercab-card.js').buildTeslaCybercabCard(date),
  // self_heal_health: generateSelfHealHealthCard always produces real content
  // (zero-state or counts + executor status), so state.ok is always true here.
  // The card's defect/clean status is determined by qcCard on the rendered
  // markdown, not by state.ok. This builder fixes the produceDataCardArtifact
  // fallthrough that was returning the stale markdown-fallback placeholder
  // "Card refresh pending..." instead of the real self-heal data.
  self_heal_health: (dataDir, date) => {
    const { generateSelfHealHealthCard } = require('../self-heal/self-heal-health-card.js');
    const { card, section } = generateSelfHealHealthCard({ dataDir, date, write: false });
    return { markdown: section, state: { ok: true, severity: card.severity } };
  },
  // memory_hygiene: formatMemoryHygieneSection reads the weekly consolidation
  // receipt (data/agent/memory-consolidation-state.json) and returns a body
  // string, or null when the receipt is missing or unreadable. Returning null
  // here causes produceDeterministicBuilderCardArtifact to emit an honest
  // blocked artifact instead of laundering the stale markdown-fallback
  // "Card refresh pending" as a defect on every cycle.
  memory_hygiene: (dataDir, _date, now) => {
    const { formatMemoryHygieneSection } = require('../cloud-morning-briefing.js');
    const nowMs = now instanceof Date ? +now : now || Date.now();
    const body = formatMemoryHygieneSection(dataDir, nowMs);
    if (!body) return null;
    return {
      markdown: `MEMORY HYGIENE:\n\n${body}`,
      state: { ok: true },
    };
  },
  // snack_dude_invoice: buildSnackDudeInvoiceCard reads the on-disk
  // snackdude-invoices-cache.json snapshot and formats invoice activity lines
  // deterministically. Without this entry the card fell through to
  // existingSourceArtifact, which returned the stale markdown-fallback
  // "Card refresh pending" as a defect on every cycle (2026-07-20 incident).
  snack_dude_invoice: (dataDir, date) => {
    const { buildSnackDudeInvoiceCard } = require('./briefing-cards/snack-dude-invoice-card.js');
    const raw = readJson(path.join(dataDir, 'agent', 'snackdude-invoices-cache.json'));
    return buildSnackDudeInvoiceCard(raw, date);
  },
  // shorts_proposals: buildShortsProposalsCard reads agent/shorts-proposals/<date>.json
  // and falls back to the latest complete set within 2 days. Without this entry
  // the card was routed through LLM_CARD_IDS, so any LLM outage produced
  // "Blocked: LLM unavailable" while real fallback proposals sat unread on disk.
  // The LLM belongs in morning-shorts-proposals.js (the generator), not the
  // render layer (2026-07-21 incident, same class as viral_tech_clips 2026-07-20).
  shorts_proposals: (dataDir, date, now) => {
    const { buildShortsProposalsCard } = require('./briefing-cards/shorts-proposals-card.js');
    return buildShortsProposalsCard(dataDir, date, [], now);
  },
});

function produceDeterministicBuilderCardArtifact({
  id,
  date,
  dataDir = defaultDataDir(),
  now = new Date(),
  buildFn,
} = {}) {
  const title = cardTitle(id);
  const build = buildFn || DETERMINISTIC_CARD_BUILDERS[id];
  const blocked = (reason, source = {}) =>
    createCardArtifact({
      id,
      title,
      date,
      kind: 'data',
      status: 'blocked',
      generatedAt: now.toISOString(),
      markdown: `${title}:\n${reason}`,
      blockedReason: reason,
      source: { mode: 'deterministic-card-builder', ...source },
      qc: { ok: false, failures: [reason] },
    });

  if (!build) return blocked(`No deterministic builder registered for ${id}.`, { missing: true });

  let built;
  try {
    built = build(dataDir, date, now);
  } catch (error) {
    return blocked(
      `${id} builder threw: ${String((error && error.message) || error).slice(0, 200)}`,
      { threw: true },
    );
  }

  // These builders return { markdown, state } where markdown already ExampleCos
  // the card's own canonical header, e.g. "VIRAL TECH CLIP PROPOSALS (3)".
  // Keep it: cardTitle() derives "VIRAL TECH CLIPS" from the id, which does not
  // satisfy the manifest matcher /^VIRAL TECH CLIP PROPOSALS\b/i.
  const markdown = String((built && built.markdown) || '').trim();
  if (!markdown) return blocked(`${id} builder returned no content.`, { empty: true });

  const firstLine = markdown.split('\n')[0] || '';
  const body = markdown.split('\n').slice(1).join('\n').trim();
  const qc = qcCard({ id, title: firstLine, body }, { surface: 'card-artifact' });
  const failures = [...(qc.failures || [])];
  // Codex gate 50032535f442: the builder's OWN verdict outranks generic text
  // QC. viral-tech-clips emits nonempty placeholder prose ("No viral clip
  // proposals are ready yet.") with state.ok false when there is no data, and
  // that text passes every generic check. Ignoring state.ok traded a
  // fabrication path for a fake-green one.
  const builderState = (built && built.state) || null;
  if (builderState && builderState.ok === false) {
    failures.unshift(
      `${id} builder reported insufficient data (state.ok false${
        builderState.count == null ? '' : `, count ${builderState.count}`
      }).`,
    );
  }

  return createCardArtifact({
    id,
    title: firstLine.replace(/:\s*$/, '') || title,
    date,
    kind: 'data',
    status: failures.length ? 'defect' : 'clean',
    generatedAt: now.toISOString(),
    markdown,
    source: {
      mode: 'deterministic-card-builder',
      builder: id,
      state: (built && built.state) || null,
    },
    blockedReason: '',
    qc: { ok: failures.length === 0, failures },
  });
}

// FULL LIFE BACKUP renders from life-archive/health-latest.json. On EC2 that
// file is 42 days stale (generated_at 2026-06-08), its db_path is a Windows
// desktop path proving it was produced on the OLD PC and hand-copied, and NO
// GENERATOR EXISTS: maybeRegenLifeArchiveHealth spawns gmail-s3-flow-health.py,
// which writes a DIFFERENT file with no `sources` array, so the regen has been
// a silent no-op since June. A repo-wide search for writers of this path finds
// only readers.
//
// The 5:30 path published this card CLEAN off that frozen snapshot, rendering
// "Data refreshed: Jun 7, 2026" with +0 deltas on all 11 sources. Presenting
// 42-day-old numbers as today's backup health is fabrication (law G13,
// feedback_no_fabrication_in_briefings.md). Until a generator exists this card
// cannot be clean, so it says so and names the missing generator.
// Shared with cloud-morning-briefing.js buildFullLifeBackupCard. Codex gate
// 05a8e5b45303 finding 1: the two readers had different rules, and the LIVE
// 5:30 builder was the permissive one, so the same snapshot was a defect here
// and published as real there. One module, one rule.
const {
  LIFE_ARCHIVE_MAX_SNAPSHOT_AGE_MS,
  lifeArchiveSnapshotFreshness,
} = require('./life-archive-freshness.js');

function produceFullLifeBackupCardArtifact({
  date,
  dataDir = defaultDataDir(),
  now = new Date(),
} = {}) {
  const title = cardTitle('full_life_backup');
  const rel = 'life-archive/health-latest.json';
  const file = path.join(dataDir, 'life-archive', 'health-latest.json');
  const defect = (reason, source = {}) =>
    createCardArtifact({
      id: 'full_life_backup',
      title,
      date,
      kind: 'data',
      status: 'defect',
      generatedAt: now.toISOString(),
      markdown: `${title}:\n${reason}`,
      blockedReason: reason,
      source: { mode: 'life-archive-health-snapshot', artifact: rel, ...source },
      qc: { ok: false, failures: [reason] },
    });

  let snapshot = null;
  try {
    snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return defect(
      `Life-archive backup health cannot be read: ${rel} is missing or unparseable, so backup ` +
        `coverage cannot be verified. Remediation: run the Windows life-archive producer and ` +
        `ship its proven snapshot to the cloud host.`,
      { missing: true },
    );
  }

  const generatedAt = String((snapshot && snapshot.generated_at) || '').trim();
  const generatedMs = Date.parse(generatedAt);
  const ageMs = Number.isFinite(generatedMs) ? now.getTime() - generatedMs : null;
  const ageDays = ageMs == null ? null : Math.round(ageMs / 86400000);
  const sources = Array.isArray(snapshot && snapshot.sources) ? snapshot.sources : [];

  if (ageMs == null || ageMs > LIFE_ARCHIVE_MAX_SNAPSHOT_AGE_MS) {
    const dbPath = String((snapshot && snapshot.db_path) || '');
    // A Windows path on a Linux host proves the snapshot was ExampleCod over from
    // the desktop rather than generated where it is read.
    const foreignHost = /^[A-Za-z]:\\/.test(dbPath) && process.platform !== 'win32';
    return defect(
      `Blocked: Life-archive backup health is ${ageDays == null ? 'undated' : `${ageDays} days`} stale ` +
        `(snapshot generated ${generatedAt || 'ExampleCo'}), so today's backup coverage across ` +
        `${sources.length} source(s) is unverified. ` +
        (foreignHost ? 'It was produced on another host (desktop-origin snapshot). ' : '') +
        `Remediation: run the Windows life-archive producer and ship a fresh proven snapshot.`,
      { generatedAt, ageDays, sourceCount: sources.length },
    );
  }

  if (snapshot.proof_complete !== true) {
    return defect(
      `Blocked: Life-archive backup health is fresh, but live S3 inventory proof is incomplete, ` +
        `so backup coverage cannot be verified. Remediation: ExampleCo the briefing host read-only ` +
        `Windows life-archive producer, ship its proven snapshot, then refresh this card.`,
      {
        generatedAt,
        ageDays,
        sourceCount: sources.length,
        proofComplete: false,
        proofErrors: Array.isArray(snapshot.proof_errors) ? snapshot.proof_errors : [],
      },
    );
  }

  if (!sources.length) {
    return defect(
      `Life-archive backup health snapshot ExampleCos no sources array, so no backup coverage can be reported.`,
      { generatedAt, malformed: true },
    );
  }

  // SCHEMA, not a guess. Production life-archive snapshots carry the boolean
  // flowing_last_24h (cloud-morning-briefing.js:6031 and :6780 both filter on
  // it). The first cut tested `status !== 'FLOWING_24H'`, so a genuinely
  // non-flowing source with flowing_last_24h:false and NO status field counted
  // as healthy. Codex gate ff30fbb4d641 caught it: a false-health path inside
  // the card whose entire job is refusing to report false health.
  //
  // A source is flowing ONLY on an explicit true. Missing or malformed reads
  // as not flowing, so the failure direction is a visible defect.
  const stale = sources.filter((s) => !(s && s.flowing_last_24h === true));
  const body = [
    `Backup coverage: ${sources.length - stale.length}/${sources.length} source(s) flowing in the last 24h.`,
    `Snapshot generated ${generatedAt}.`,
    ...(stale.length
      ? [`Not flowing: ${stale.map((s) => s.id || s.source).join(', ')}.`]
      : ['All tracked sources are flowing.']),
  ].join('\n');
  const qc = qcCard({ id: 'full_life_backup', title, body }, { surface: 'card-artifact' });
  const failures = qc.failures || [];

  return createCardArtifact({
    id: 'full_life_backup',
    title,
    date,
    kind: 'data',
    status: failures.length ? 'defect' : 'clean',
    generatedAt: now.toISOString(),
    markdown: `${title}:\n${body}`,
    source: {
      mode: 'life-archive-health-snapshot',
      artifact: rel,
      generatedAt,
      ageDays,
      sourceCount: sources.length,
    },
    blockedReason: '',
    qc: { ok: failures.length === 0, failures },
  });
}

// voice_confirmation has no bespoke producer, so it fell through to the generic
// existingSourceArtifact path which read the morning build's "not synced to cloud
// yet" fallback and incorrectly marked it clean. The fix: produce the card
// directly from renderVoiceConfirmationSection() the same way the morning build
// intended to, so the artifact always reflects the live injector result.
// 2026-07-21.
function produceVoiceConfirmationCardArtifact({
  date,
  dataDir,
  now = new Date(),
  renderVoiceConfirmationSectionFn = null,
} = {}) {
  const title = 'VOICE CONFIRMATION / SPEAKER LEARNING';
  const id = 'voice_confirmation';
  const blocked = (reason, extra = {}) =>
    createCardArtifact({
      id,
      title,
      date,
      kind: 'data',
      status: 'blocked',
      generatedAt: now.toISOString(),
      markdown: `${title}:\n${reason}`,
      blockedReason: reason,
      source: { mode: 'voice-injector', ...extra },
      qc: { ok: false, failures: [reason] },
    });

  let rendered = '';
  try {
    const fn =
      renderVoiceConfirmationSectionFn ||
      require('../refresh-briefing-generated-sections.js').renderVoiceConfirmationSection;
    if (typeof fn !== 'function')
      return blocked('renderVoiceConfirmationSection is not a function.');
    rendered = String(fn() || '').trim();
  } catch (e) {
    return blocked(`Voice injector threw: ${String((e && e.message) || e).slice(0, 200)}`);
  }
  if (!rendered) return blocked('Voice injector returned no content.');

  // Past-7-day archive health RED is a hard blocker for this card (pinned lesson
  // 2026-07-18). Detect it here so the artifact honestly says blocked rather than
  // carrying a clean status that contradicts the rendered RED tile.
  if (/\bPast-7-day Otter archive health:\s*RED\b/i.test(rendered)) {
    const reason = 'Past-7-day Otter archive health is RED.';
    return createCardArtifact({
      id,
      title,
      date,
      kind: 'data',
      status: 'blocked',
      generatedAt: now.toISOString(),
      markdown: `${title}:\n${rendered}`,
      blockedReason: reason,
      source: { mode: 'voice-injector', archiveHealthRed: true },
      qc: { ok: false, failures: [reason] },
    });
  }

  const parsed = splitMarkdownCards(rendered)[0] || { title, body: rendered };
  const qc = qcCard(
    { id, title: parsed.title || title, body: parsed.body || '' },
    { surface: 'card-artifact' },
  );
  const failures = qc.failures || [];
  return createCardArtifact({
    id,
    title,
    date,
    kind: 'data',
    status: failures.length ? 'defect' : 'clean',
    generatedAt: now.toISOString(),
    markdown: `${title}:\n${parsed.body || rendered}`,
    source: { mode: 'voice-injector' },
    blockedReason: '',
    qc: { ok: failures.length === 0, failures },
  });
}

function produceOtterSpeakerParetoCardArtifact({
  date,
  dataDir,
  now = new Date(),
  renderOtterSpeakerParetoSectionFn = null,
} = {}) {
  const aggregatePath = path.join(dataDir, 'agent', 'otter-call-exec-summaries.json');
  const aggregate = readJson(aggregatePath);
  const source = {
    mode: 'otter-per-call-summary-renderer',
    aggregate: path.relative(dataDir, aggregatePath).replace(/\\/g, '/'),
  };
  if (!aggregate || aggregate.schemaVersion !== 2 || aggregate.source !== 'per-call-artifacts') {
    const reason = 'Otter per-call summary aggregate is missing or invalid.';
    return createCardArtifact({
      id: 'otter_speaker_pareto',
      title: cardTitle('otter_speaker_pareto'),
      date,
      kind: 'data',
      status: 'blocked',
      generatedAt: now.toISOString(),
      markdown: `${cardTitle('otter_speaker_pareto')}:\nBlocked: ${reason}`,
      source: { ...source, missing: true },
      blockedReason: reason,
      qc: { ok: false, failures: [reason] },
    });
  }

  const perCallArtifacts = listCallSummaryArtifacts(dataDir);
  const clean = perCallArtifacts.filter((artifact) => artifact.status === 'clean').length;
  const blocked = perCallArtifacts.length - clean;
  const renderer = renderOtterSpeakerParetoSectionFn || renderOtterSpeakerParetoCard;
  const rendered = renderer({ date, dataDir, aggregate });
  if (rendered && typeof rendered === 'object' && rendered.blockedReason) {
    const reason = String(rendered.blockedReason);
    return createCardArtifact({
      id: 'otter_speaker_pareto',
      title: cardTitle('otter_speaker_pareto'),
      date,
      kind: 'data',
      status: 'blocked',
      generatedAt: now.toISOString(),
      markdown: `${cardTitle('otter_speaker_pareto')}:\nBlocked: ${reason}`,
      source: { ...source, perCallArtifacts: perCallArtifacts.length, clean, blocked },
      blockedReason: reason,
      qc: { ok: false, failures: [reason] },
    });
  }
  // Drop the table-header instruction. The renderer emits
  // "Columns: Time | Call | Length | Speakers | Executive summary", which is
  // layout scaffolding for a fixed-width dump, not content, and the shared
  // artifact QC correctly flags it as raw operational detail. That single line
  // is why this card was DEFECT on ExampleCo's 2026-07-20 board while its data was
  // fine. Trimmed here rather than in the renderer, which the 5:30 monolith and
  // an existing test both depend on.
  const markdown = String(
    rendered && typeof rendered === 'object' ? rendered.markdown || '' : rendered || '',
  )
    .split('\n')
    .filter((line) => !/^\s*Columns:\s/i.test(line))
    .join('\n')
    .trim();
  if (!markdown) {
    const reason = 'Otter per-call summary renderer returned no content.';
    return createCardArtifact({
      id: 'otter_speaker_pareto',
      title: cardTitle('otter_speaker_pareto'),
      date,
      kind: 'data',
      status: 'blocked',
      generatedAt: now.toISOString(),
      markdown: `${cardTitle('otter_speaker_pareto')}:\nBlocked: ${reason}`,
      source: { ...source, perCallArtifacts: perCallArtifacts.length, clean, blocked },
      blockedReason: reason,
      qc: { ok: false, failures: [reason] },
    });
  }

  const parsed = splitMarkdownCards(markdown)[0] || {
    title: cardTitle('otter_speaker_pareto'),
    body: markdown,
  };
  const qc = qcCard(
    {
      id: 'otter_speaker_pareto',
      title: parsed.title || cardTitle('otter_speaker_pareto'),
      body: parsed.body || '',
    },
    { surface: 'card-artifact' },
  );
  return createCardArtifact({
    id: 'otter_speaker_pareto',
    title: cardTitle('otter_speaker_pareto'),
    date,
    kind: 'data',
    status: qc.ok ? 'clean' : 'defect',
    generatedAt: now.toISOString(),
    markdown,
    source: {
      ...source,
      ...(rendered && typeof rendered === 'object' ? rendered.source || {} : {}),
      perCallArtifacts: perCallArtifacts.length,
      clean,
      blocked,
      aggregateGeneratedAt: aggregate.generatedAt || null,
      lastRun: aggregate.lastRun || null,
    },
    blockedReason: '',
    qc,
  });
}

function representedByMergePartnerArtifact({ card, date, dataDir, now = new Date() } = {}) {
  const partnerId = RECIPROCAL_MERGE_PARTNERS[card && card.id];
  if (!partnerId) return null;
  const partner = existingSourceArtifact({ dataDir, date, id: partnerId });
  if (!partner || normalizeStatus(partner.status) !== 'clean') return null;
  const partnerTitle = cardTitle(partnerId);
  const title = cardTitle(card);
  return createCardArtifact({
    id: card.id,
    title,
    date,
    kind: 'data',
    status: 'clean',
    generatedAt: now.toISOString(),
    markdown: `${title}:\nRepresented by ${partnerTitle} for ${date}. The dashboard renders this reciprocal pipeline pair as one live tile today, and ${partnerTitle} is clean.`,
    source: {
      mode: 'represented-by-merge-partner',
      partnerId,
      partnerStatus: 'clean',
      partnerGeneratedAt: partner.generatedAt || partner.generated_at || null,
    },
    qc: { ok: true, failures: [] },
  });
}

async function produceLlmCardArtifact({ card, date, dataDir, now = new Date() }) {
  const prompt = [
    `Produce the ${card.id} Daily Briefing card for ${date}.`,
    'Return concise markdown only.',
    'If the model is unavailable, the caller will block only this card.',
  ].join('\n');
  const response = await askAI(prompt, {
    surface: `briefing-card:${card.id}`,
    rungOrder: ['claude-cli', 'codex'],
    rungTimeoutMs: Number(process.env.ASK_AI_FAIL_FAST_MS || 15000),
    rungRetries: 0,
    silent: true,
    maxTokens: 500,
  });
  if (response && response.text) {
    return createCardArtifact({
      id: card.id,
      title: cardTitle(card),
      date,
      kind: 'llm',
      status: 'clean',
      generatedAt: now.toISOString(),
      markdown: `${cardTitle(card)}:\n${response.text}`,
      source: { mode: 'llm', rung: response.rung, attempts: response.attempts },
      qc: { ok: true, failures: [] },
    });
  }
  return createCardArtifact({
    id: card.id,
    title: cardTitle(card),
    date,
    kind: 'llm',
    status: 'blocked',
    generatedAt: now.toISOString(),
    markdown: `${cardTitle(card)}:\nBlocked: LLM unavailable. This card is held without blocking sibling cards.`,
    blockedReason: 'LLM unavailable after bounded Codex and Claude attempts.',
    source: { mode: 'llm', attempts: response ? response.attempts : [] },
  });
}

function produceSourceBackedLlmCardArtifact({ card, date, dataDir, now = new Date() } = {}) {
  if (card && card.id === 'communication_coaching') {
    try {
      const snapshotPath = path.join(dataDir, 'agent', 'comm-coaching', `${date}.json`);
      const snapshot = readJson(snapshotPath);
      if (snapshot && snapshot.date === date && snapshot.status === 'blocked') {
        const reason = String(snapshot.reason || 'No qualified recent ExampleCo evidence is available.');
        return createCardArtifact({
          id: card.id,
          title: cardTitle(card),
          date,
          kind: 'llm',
          status: 'blocked',
          generatedAt: now.toISOString(),
          markdown: `${cardTitle(card)}:\nBlocked: ${reason}`,
          blockedReason: reason,
          source: { mode: 'comm-coaching-snapshot', path: snapshotPath },
          qc: { ok: false, failures: [reason] },
        });
      }
      const { formatCommCoachingSection } = require('../cloud-morning-briefing.js');
      if (typeof formatCommCoachingSection !== 'function') return null;
      const body = formatCommCoachingSection(dataDir, date);
      if (!body && snapshot && snapshot.date === date) {
        const reason =
          'Communication Coaching has no complete ExampleCo-only evidence from the briefing day or prior day.';
        return createCardArtifact({
          id: card.id,
          title: cardTitle(card),
          date,
          kind: 'llm',
          status: 'blocked',
          generatedAt: now.toISOString(),
          markdown: `${cardTitle(card)}:\nBlocked: ${reason}`,
          blockedReason: reason,
          source: { mode: 'comm-coaching-snapshot', path: snapshotPath },
          qc: { ok: false, failures: [reason] },
        });
      }
      if (!body) return null;
      const title = cardTitle(card);
      const markdown = `${title}:\n${body}`;
      const qc = qcCard({ id: card.id, title, body }, { surface: 'card-artifact' });
      if (!qc.ok) return null;
      return createCardArtifact({
        id: card.id,
        title,
        date,
        kind: 'llm',
        status: 'clean',
        generatedAt: now.toISOString(),
        markdown,
        source: { mode: 'comm-coaching-snapshot' },
        qc: { ok: true, failures: [] },
      });
    } catch {
      return null;
    }
  }
  if (card && card.id === 'reputation_risk') {
    try {
      const { buildReputationCard } = require('../cloud-morning-briefing.js');
      if (typeof buildReputationCard !== 'function') return null;
      const rendered = buildReputationCard(dataDir, date, { allowLiveRefresh: false });
      const markdown = `${rendered.title || cardTitle(card)}:\n${rendered.body || rendered.detail || ''}`;
      if (rendered.real) {
        return createCardArtifact({
          id: card.id,
          title: cardTitle(card),
          date,
          kind: 'llm',
          status: 'clean',
          generatedAt: now.toISOString(),
          markdown,
          source: { mode: 'reputation-scan-artifact' },
          qc: { ok: true, failures: [] },
        });
      }
      return createCardArtifact({
        id: card.id,
        title: cardTitle(card),
        date,
        kind: 'llm',
        status: 'blocked',
        generatedAt: now.toISOString(),
        markdown,
        source: { mode: 'reputation-scan-artifact' },
        blockedReason: rendered.detail || 'Reputation scan artifact missing or stale.',
      });
    } catch {
      return null;
    }
  }
  const contentConfig = card ? CONTENT_HEAL_CARD_CONFIG[card.id] : null;
  if (!contentConfig) return null;
  try {
    const { formatHealedNewsSection } = require('../cloud-morning-briefing.js');
    if (typeof formatHealedNewsSection !== 'function') return null;
    const rendered = formatHealedNewsSection(dataDir, date, contentConfig.key, contentConfig.label);
    const markdown = String((rendered && rendered.markdown) || '').trim();
    const state = (rendered && rendered.state) || {};
    const count = Number(state.count || 0);
    const minimum = Number(contentConfig.minimum || state.target || card.newsTarget || 1);
    if (!markdown || state.source === 'missing') return null;
    if (state.ok !== true || count < minimum) {
      return createCardArtifact({
        id: card.id,
        title: cardTitle(card),
        date,
        kind: 'llm',
        status: 'blocked',
        generatedAt: now.toISOString(),
        markdown,
        blockedReason: `content-heal shortfall: ${count}/${minimum} source-backed items ready`,
        source: {
          mode: 'content-heal',
          cardKey: contentConfig.key,
          count,
          minimum,
          renderer: 'formatHealedNewsSection',
        },
      });
    }
    return createCardArtifact({
      id: card.id,
      title: cardTitle(card),
      date,
      kind: 'llm',
      status: 'clean',
      generatedAt: now.toISOString(),
      markdown,
      source: {
        mode: 'content-heal',
        cardKey: contentConfig.key,
        count,
        renderer: 'formatHealedNewsSection',
      },
      qc: { ok: true, failures: [] },
    });
  } catch {
    return null;
  }
}

function produceAmyProjectsCardArtifact({ date, dataDir, now = new Date() }) {
  try {
    const {
      formatAmyProjectsSection,
      normalizeCommandQueue,
      readTaskRows,
      summarizeServiceState,
    } = require('../cloud-morning-briefing.js');
    if (typeof formatAmyProjectsSection !== 'function') return null;
    const queueRows = normalizeCommandQueue(
      readJson(path.join(dataDir, 'agent', 'command-queue.json'), []),
    );
    const dispatchRows = readJsonl(path.join(dataDir, 'agent', 'dispatch-queue.jsonl'), 500);
    const sessionRows = [
      readJson(path.join(dataDir, 'agent-collab', 'current-session.json')),
      readJson(path.join(dataDir, 'agent-collab', 'amy-outbox.json')),
      readJson(path.join(dataDir, 'agent-collab', 'codex-outbox.json')),
    ].filter(Boolean);
    const taskRows = readTaskRows(dataDir);
    const healthRows = readJsonl(path.join(dataDir, 'agent', 'channel-health.jsonl'), 100);
    const service = summarizeServiceState({
      healthRows,
      queueRows,
      taskRows,
      simulatePcOff: false,
    });
    const title = 'AMY PROJECTS RECEIVED (email, phone, otter)';
    const body = formatAmyProjectsSection(service, {
      dispatchRows,
      sessionRows,
      taskRows,
      nowMs: now.getTime(),
    });
    const markdown = `${title}:\n${String(body || '').trim()}`;
    const qc = qcCard({ id: 'amy_projects', title, body }, { surface: 'card-artifact' });
    return createCardArtifact({
      id: 'amy_projects',
      title,
      date,
      kind: 'data',
      status: qc.ok ? 'clean' : 'defect',
      generatedAt: now.toISOString(),
      markdown,
      source: { mode: 'amy-projects-received', renderer: 'formatAmyProjectsSection' },
      qc,
    });
  } catch (error) {
    return createCardArtifact({
      id: 'amy_projects',
      title: 'AMY PROJECTS RECEIVED (email, phone, otter)',
      date,
      kind: 'data',
      status: 'blocked',
      generatedAt: now.toISOString(),
      markdown: `AMY PROJECTS RECEIVED (email, phone, otter):\nBlocked: ${String(
        (error && error.message) || error,
      )}`,
      blockedReason: String((error && error.message) || error),
      source: { mode: 'amy-projects-received' },
    });
  }
}

function produceActionItemsCardArtifact({ date, dataDir, now = new Date() }) {
  try {
    const {
      ACTION_ITEMS_CLOUD_DEFAULT_LIMIT,
      actionSourceIntegrityIssue,
      extractActionItems,
      extractApprovalQueue,
      extractOpenCommitments,
      formatActionCommitmentsBlockedSection,
      formatActionCommitmentsSection,
      inspectActionSource,
      standingReminderCommitmentLines,
    } = require('../cloud-morning-briefing.js');
    const source = readJson(path.join(dataDir, 'briefing-action-items.json')) || {};
    // Producer parity (frozen supervised run 20260719103219-9552bdcc): the
    // clean/blocked decision is the full build's inspectActionSource, never a
    // locally re-derived variant. The legacy math here graded staleness on
    // lastFullReviewAt FIRST (the full build grades the newest of both stamps)
    // and skipped latestActionRefreshIssue, so the per-card rebuild could
    // disagree with the 5:30 build on the identical data state. The typeof
    // fallback keeps a skewed deployed copy honest rather than throwing.
    const inspection =
      typeof inspectActionSource === 'function'
        ? inspectActionSource(dataDir, now)
        : (() => {
            const generatedMs = Date.parse(source.lastFullReviewAt || source.generatedAt || '');
            const legacyStale =
              !Number.isFinite(generatedMs) || now.getTime() - generatedMs > 24 * 3600 * 1000;
            const legacyIssue =
              typeof actionSourceIntegrityIssue === 'function'
                ? actionSourceIntegrityIssue(source, dataDir)
                : null;
            return {
              stale: legacyStale,
              issue: legacyIssue,
              blocked: Boolean(legacyIssue || legacyStale),
            };
          })();
    const issue = inspection.issue;
    const title = 'ACTION ITEMS & OPEN COMMITMENTS';
    // Standing reminders are direct owner dispatches, not Gmail-derived rows.
    // The full morning builder preserves them when Gmail is blocked; a targeted
    // card refresh must produce that same truthful floor instead of replacing it
    // with only the Gmail-repair notice.
    const standingCommitments =
      typeof standingReminderCommitmentLines === 'function'
        ? standingReminderCommitmentLines(dataDir, now)
        : [];
    if (inspection.blocked) {
      const body = formatActionCommitmentsBlockedSection(standingCommitments);
      return createCardArtifact({
        id: 'action_items',
        title,
        date,
        kind: 'data',
        status: 'blocked',
        generatedAt: now.toISOString(),
        markdown: `${title}:\n${body}\n\nStatus: ${issue || 'Action-item source is stale.'}`,
        blockedReason: issue || 'Action-item source is stale.',
        source: { mode: 'briefing-action-items', generatedAt: source.generatedAt || null },
      });
    }
    const actionItems = extractActionItems(source);
    const openCommitments = [
      ...new Set([...standingCommitments, ...extractOpenCommitments(source)]),
    ].slice(0, ACTION_ITEMS_CLOUD_DEFAULT_LIMIT);
    const approvalQueue = extractApprovalQueue(source);
    const body = formatActionCommitmentsSection(actionItems, openCommitments, approvalQueue);
    const qc = qcCard({ id: 'action_items', title, body }, { surface: 'card-artifact' });
    return createCardArtifact({
      id: 'action_items',
      title,
      date,
      kind: 'data',
      status: qc.ok ? 'clean' : 'defect',
      generatedAt: now.toISOString(),
      markdown: `${title}:\n${body}`,
      source: {
        mode: 'briefing-action-items',
        generatedAt: source.generatedAt || null,
        actionItems: actionItems.length,
        openCommitments: openCommitments.length,
      },
      qc,
    });
  } catch (error) {
    return createCardArtifact({
      id: 'action_items',
      title: 'ACTION ITEMS & OPEN COMMITMENTS',
      date,
      kind: 'data',
      status: 'blocked',
      generatedAt: now.toISOString(),
      markdown: `ACTION ITEMS & OPEN COMMITMENTS:\nBlocked: ${String(
        (error && error.message) || error,
      )}`,
      blockedReason: String((error && error.message) || error),
      source: { mode: 'briefing-action-items' },
    });
  }
}

function produceDataCardArtifact({ card, date, dataDir, now = new Date() }) {
  if (card.id === 'blockers') {
    return produceBlockersCardArtifact({ date, dataDir, now });
  }
  if (card.id === 'system_health') {
    return produceSystemHealthCardArtifact({ date, dataDir, now });
  }
  if (card.id === 'action_items') {
    const artifact = produceActionItemsCardArtifact({ date, dataDir, now });
    if (artifact) return artifact;
  }
  if (card.id === 'meetings') {
    const artifact = produceMeetingsCardArtifact({ date, dataDir, now });
    if (artifact) return artifact;
  }
  if (card.id === 'big_decisions') {
    const artifact = produceBigDecisionsCardArtifact({ date, dataDir, now });
    if (artifact) return artifact;
  }
  if (card.id === 'amy_projects') {
    const artifact = produceAmyProjectsCardArtifact({ date, dataDir, now });
    if (artifact) return artifact;
  }
  if (card.id === 'token_usage') {
    const existing = existingSourceArtifact({ dataDir, date, id: card.id });
    if (!hasTokenUsageSourceArtifact({ dataDir, date }) && existing) {
      return normalizeArtifactQuality({
        ...existing,
        kind: 'data',
        status: cleanStatusUnlessPendingShell(existing),
        generatedAt: now.toISOString(),
        source: { ...(existing.source || {}), producer: 'data-card-artifact' },
      });
    }
    return produceTokenUsageCardArtifact({ date, dataDir, now });
  }
  if (card.id === 'voice_confirmation') {
    return produceVoiceConfirmationCardArtifact({ date, dataDir, now });
  }
  if (card.id === 'otter_speaker_pareto') {
    return produceOtterSpeakerParetoCardArtifact({ date, dataDir, now });
  }
  if (DETERMINISTIC_CARD_BUILDERS[card.id]) {
    return produceDeterministicBuilderCardArtifact({ id: card.id, date, dataDir, now });
  }
  if (card.id === 'full_life_backup') {
    return produceFullLifeBackupCardArtifact({ date, dataDir, now });
  }
  if (card.id === 'uncommitted_parked') {
    return produceUncommittedParkedCardArtifact({ date, dataDir, now });
  }
  if (card.id === 'aws_costs') {
    // Take over ONLY when the on-disk artifact cannot stand on its own: the
    // pending bootstrap shell, no dollar figure at all, or a content-stale
    // window wearing today's filename. Those are the three ways the generic
    // fallthrough laundered a non-card into a clean one. A genuinely populated
    // artifact is reused as-is, which keeps desktop and fixture runs honest and
    // avoids re-billing Cost Explorer on every scoped refresh.
    //
    // A self-sufficient but DEFECTIVE artifact is also re-produced: its QC
    // failures may be false positives that a code fix just resolved (e.g. a
    // Cost Explorer service name like "Claude Sonnet 4.6 (Amazon Bedrock
    // Edition)" triggering the soft-vendor-term check before aws_costs was
    // added to isSoftTermNeutralizedCardTitle). Re-running the producer
    // re-evaluates the artifact against current QC rules without re-querying
    // Cost Explorer (buildAwsCostsCard reads the on-disk snapshot).
    const existing = existingSourceArtifact({ dataDir, date, id: card.id });
    if (
      !existing ||
      isMissingSourcePlaceholderArtifact(existing) ||
      !awsCostArtifactIsSelfSufficient(existing, date) ||
      existing.status === 'defect'
    ) {
      return produceAwsCostsCardArtifact({ date, dataDir, now });
    }
  }
  const existing = existingSourceArtifact({ dataDir, date, id: card.id });
  if (!existing || isMissingSourcePlaceholderArtifact(existing)) {
    const represented = representedByMergePartnerArtifact({ card, date, dataDir, now });
    if (represented) return represented;
  }
  if (existing) {
    return normalizeArtifactQuality({
      ...existing,
      kind: 'data',
      status: cleanStatusUnlessPendingShell(existing),
      generatedAt: now.toISOString(),
      source: { ...(existing.source || {}), producer: 'data-card-artifact' },
    });
  }
  return createCardArtifact({
    id: card.id,
    title: cardTitle(card),
    date,
    kind: 'data',
    status: 'blocked',
    generatedAt: now.toISOString(),
    markdown: `${cardTitle(card)}:\nBlocked: deterministic source artifact missing for ${date}.`,
    blockedReason: 'Deterministic source artifact missing.',
    source: { mode: 'data', missing: true },
  });
}

async function produceCardArtifact({
  cardId,
  date,
  dataDir = defaultDataDir(),
  now = new Date(),
} = {}) {
  const card = getCardById(cardId);
  if (!card) throw new Error(`ExampleCo briefing card '${cardId}'`);
  const artifact = isLlmCard(card.id)
    ? // A partial source-backed content-heal card is a real blocked artifact and
      // must not fall through to generic LLM-unavailable copy.
      produceSourceBackedLlmCardArtifact({ card, date, dataDir, now }) ||
      produceLlmCardArtifact({ card, date, dataDir, now })
    : produceDataCardArtifact({ card, date, dataDir, now });
  return normalizeArtifactQuality(await artifact);
}

function producerConcurrency() {
  const n = Number(process.env.BRIEFING_CARD_PRODUCER_CONCURRENCY || 4);
  return Number.isInteger(n) && n > 0 ? n : 4;
}

function producerTimeoutMs(value = process.env.BRIEFING_CARD_PRODUCER_TIMEOUT_MS) {
  const n = Number(value || 60000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60000;
}

async function withProducerTimeout(work, { cardId, timeoutMs }) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Card producer timed out after ${timeoutMs}ms: ${cardId}`);
      error.code = 'CARD_PRODUCER_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(work), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  const count = Math.min(Math.max(1, limit), items.length || 1);
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

async function produceAllCardArtifacts({
  dataDir = defaultDataDir(),
  date,
  now = new Date(),
  cardTimeoutMs,
  produceCardArtifactFn = produceCardArtifact,
} = {}) {
  const timeoutMs = producerTimeoutMs(cardTimeoutMs);
  const artifacts = await mapLimit(CARDS, producerConcurrency(), async (card) => {
    try {
      const work = Promise.resolve().then(() =>
        produceCardArtifactFn({ cardId: card.id, dataDir, date, now }),
      );
      return await withProducerTimeout(work, {
        cardId: card.id,
        timeoutMs,
      });
    } catch (error) {
      const message = String((error && error.message) || error);
      return createCardArtifact({
        id: card.id,
        title: cardTitle(card),
        date,
        kind: isLlmCard(card.id) ? 'llm' : 'data',
        status: 'blocked',
        generatedAt: now.toISOString(),
        markdown: `${cardTitle(card)}:\nBlocked: ${message}`,
        blockedReason: message,
        source: {
          mode:
            error && error.code === 'CARD_PRODUCER_TIMEOUT'
              ? 'producer-timeout'
              : 'producer-exception',
        },
      });
    }
  });
  for (const artifact of artifacts) writeCardArtifact({ dataDir, date, artifact });
  const board = writeLiveBoardArtifactFromCardArtifacts({ dataDir, date, artifacts, now });
  return { artifacts: orderArtifacts(artifacts), board };
}

function listCardArtifactDates({ dataDir = defaultDataDir() } = {}) {
  const root = path.join(dataDir, CARD_ARTIFACT_REL_DIR);
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

function briefingArtifactWatchdog({ dataDir = defaultDataDir(), date, now = new Date() } = {}) {
  const union = readCardArtifactUnion({ dataDir, date, allowMarkdownFallback: false });
  const total = CARDS.length;
  const present = union.artifacts.length;
  const missing = CARDS.map((card) => card.id).filter(
    (id) => !union.artifacts.some((artifact) => artifact.id === id),
  );
  const blocked = union.artifacts
    .filter((artifact) => artifact.status === 'blocked')
    .map((a) => a.id);
  const stale = union.artifacts.filter((artifact) => artifact.status === 'stale').map((a) => a.id);
  return {
    ok: present === total && missing.length === 0,
    date,
    checkedAt: now.toISOString(),
    cardArtifacts: { present, total, missing, blocked, stale },
    hungDependencyIsolation:
      'Each card has its own artifact. Hung dependencies affect only cards listed as blocked or stale.',
  };
}

module.exports = {
  SCHEMA_VERSION,
  PER_CARD_BOARD_SOURCE,
  PER_CARD_BOARD_SOURCE_SCOPED,
  PER_CARD_BOARD_SOURCES,
  isPerCardBoardSource,
  CARD_ARTIFACT_REL_DIR,
  BOARD_ARTIFACT_REL,
  LLM_CARD_IDS,
  defaultDataDir,
  normalizeStatus,
  cardTitle,
  isLlmCard,
  cardArtifactDir,
  artifactPathFor,
  createCardArtifact,
  writeCardArtifact,
  readCardArtifact,
  cardForMarkdownTitle,
  markdownSectionToArtifact,
  markdownPathFor,
  readCompatibilityMarkdown,
  readMarkdownFallbackArtifacts,
  readExplicitArtifacts,
  orderArtifacts,
  readCardArtifactUnion,
  artifactMarkdown,
  isRepresentedByMergePartnerArtifact,
  renderableArtifacts,
  artifactsToBriefingMarkdown,
  loadBriefingFromCardArtifacts,
  liveBoardArtifactFromCardArtifacts,
  writeLiveBoardArtifactFromCardArtifacts,
  writeCompatibilityMarkdown,
  produceCardArtifact,
  produceSourceBackedLlmCardArtifact,
  produceBlockersCardArtifact,
  produceSystemHealthCardArtifact,
  produceTokenUsageCardArtifact,
  produceAwsCostsCardArtifact,
  produceUncommittedParkedCardArtifact,
  produceFullLifeBackupCardArtifact,
  cleanStatusUnlessPendingShell,
  produceDeterministicBuilderCardArtifact,
  produceVoiceConfirmationCardArtifact,
  _produceVoiceConfirmationCardArtifact: produceVoiceConfirmationCardArtifact,
  produceOtterSpeakerParetoCardArtifact,
  produceAllCardArtifacts,
  producerTimeoutMs,
  withProducerTimeout,
  listCardArtifactDates,
  briefingArtifactWatchdog,
};
