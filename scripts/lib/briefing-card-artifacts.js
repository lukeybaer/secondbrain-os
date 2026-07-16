'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CARDS, getCardById } = require('./briefing-card-manifest.js');
const { splitMarkdownCards, qcCard } = require('./briefing-card-qc.js');
const { askAI } = require('./ask-ai.js');
const { writeDataArtifact } = require('./data-root.js');
const {
  providerReceiptPath,
  readProviderUsage,
} = require('./token-usage-receipts.js');
const { listCallSummaryArtifacts } = require('./otter-exec-summary-artifacts.js');
const { renderOtterSpeakerParetoCard } = require('./otter-speaker-pareto-card.js');

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
  'kingdom_equipping',
  'reputation_risk',
  'viral_tech_clips',
  'shorts_proposals',
]);

const RECIPROCAL_MERGE_PARTNERS = Object.freeze({
  content_pipeline: 'video_approval_queue',
  video_approval_queue: 'content_pipeline',
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
  const s = String(status || '').trim().toLowerCase();
  return ['clean', 'defect', 'blocked', 'stale'].includes(s) ? s : 'blocked';
}

function cardTitle(cardOrId) {
  const card = typeof cardOrId === 'string' ? getCardById(cardOrId) : cardOrId;
  if (!card) return String(cardOrId || '').replace(/_/g, ' ').toUpperCase();
  return String(card.title || card.id || '').replace(/_/g, ' ').toUpperCase();
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

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function writeCardArtifact({ dataDir, date, artifact }) {
  if (!artifact || !artifact.id) throw new Error('card artifact requires id');
  return writeJsonAtomic(artifactPathFor({ dataDir, date: date || artifact.date, id: artifact.id }), artifact);
}

function readCardArtifact({ dataDir, date, id }) {
  const json = readJson(artifactPathFor({ dataDir, date, id }));
  if (!json || json.schemaVersion !== SCHEMA_VERSION || !json.id) return null;
  return normalizeArtifactQuality(json);
}

function cardForMarkdownTitle(title) {
  const text = String(title || '');
  return CARDS.find((card) => {
    const re = new RegExp(card.match.source, card.match.flags.includes('i') ? 'i' : '');
    return re.test(text);
  }) || null;
}

function inferMarkdownSectionStatus(body) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines[0] || '';
  const firstFew = lines.slice(0, 4).join('\n');
  if (/^(HARD-BLOCKED|BLOCKED\b|Blocked:|This card is held\b)/i.test(first)) return 'blocked';
  if (/^Status:\s*(blocked|red|stale|unavailable)\b/i.test(firstFew)) return 'blocked';
  if (/^Severity:\s*(red|blocked)\b/i.test(firstFew)) return 'blocked';
  if (/^(Source unavailable|Source expired|Unavailable)\b:?/i.test(first)) return 'blocked';
  if (/^\u2717\s/.test(first)) return 'blocked';
  if (/held back rather than shown as today|more than 24 hours old/i.test(first)) return 'blocked';
  return 'clean';
}

function markdownSectionToArtifact(section, { date, generatedAt = new Date().toISOString() } = {}) {
  const card = cardForMarkdownTitle(section && section.title);
  if (!card) return null;
  const body = String(section.body || '').trim();
  const status = inferMarkdownSectionStatus(body);
  return normalizeArtifactQuality(createCardArtifact({
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
  }));
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
  const parsed = splitMarkdownCards(markdown)[0] || {
    title: artifact.title || cardTitle(artifact.id),
    body: markdown,
  };
  return qcCard(
    {
      id: artifact.id,
      title: parsed.title || artifact.title || cardTitle(artifact.id),
      body: parsed.body || '',
    },
    { surface: 'card-artifact' },
  ).failures;
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
  return orderArtifacts(artifacts).filter((artifact) => !isRepresentedByMergePartnerArtifact(artifact));
}

function artifactsToBriefingMarkdown(artifacts, { date, generatedAt = new Date().toISOString() } = {}) {
  const lines = [`# Daily Briefing - ${date || generatedAt.slice(0, 10)}`, '', `Generated: ${generatedAt}`, ''];
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
  return uniqueList([...(failures || []), artifact && artifact.blockedReason, artifact && artifact.status]);
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
  return liveBoardArtifactFromCards(cards, { date, now, source: 'per-card-artifacts' });
}

function liveBoardArtifactFromCards(
  cards,
  { date, now = new Date(), source = 'per-card-artifacts' } = {},
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
      source: 'per-card-artifacts-scoped',
    });
  }
  const absPath = writeDataArtifact(BOARD_ARTIFACT_REL, artifact, { dataDir });
  return { artifact, absPath };
}

function writeCompatibilityMarkdown({ dataDir, date, artifacts, now = new Date() }) {
  const markdown = artifactsToBriefingMarkdown(artifacts, {
    date,
    generatedAt: now.toISOString(),
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
    normalizeStatus(artifact.status) === 'blocked' &&
    (source.missing === true || source.mode === 'data') &&
    /deterministic source artifact missing/i.test(reason)
  );
}

function existingSourceArtifact({ dataDir, date, id }) {
  const current = readCardArtifact({ dataDir, date, id });
  const fallback = readMarkdownFallbackArtifacts({ dataDir, date }).find((artifact) => artifact.id === id);
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
    markdownForProof === undefined ? readCompatibilityMarkdown({ dataDir, date }) : markdownForProof;
  const markdown = String(renderer(proof, { dataDir, date }) || '').trim();
  const status = systemHealthStatusFromMarkdown(markdown);
  const redRow = firstRedSystemHealthRow(markdown);
  const blockedReason = redRow
    ? redRow.replace(/^\u2717\s+/, '').slice(0, 220)
    : '';
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
      status === 'blocked'
        ? blockedReason || 'System Health still has red subsystem rows.'
        : '',
    qc: {
      ok: status === 'clean',
      failures: status === 'clean' ? [] : [blockedReason || 'System Health red subsystem rows'],
    },
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
  const body = String(renderer(dataDir, date) || '').trim();
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
  if (
    !aggregate ||
    aggregate.schemaVersion !== 2 ||
    aggregate.source !== 'per-call-artifacts'
  ) {
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
  const markdown = String(
    rendered && typeof rendered === 'object' ? rendered.markdown || '' : rendered || '',
  ).trim();
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
  if (!card || card.id !== 'covid_news') return null;
  try {
    const { formatHealedNewsSection } = require('../cloud-morning-briefing.js');
    if (typeof formatHealedNewsSection !== 'function') return null;
    const rendered = formatHealedNewsSection(
      dataDir,
      date,
      'covid',
      'COVID-19 TREATMENTS & NEWS',
    );
    const markdown = String((rendered && rendered.markdown) || '').trim();
    const state = (rendered && rendered.state) || {};
    const count = Number(state.count || 0);
    if (!markdown || state.ok !== true || count < 1 || state.source === 'missing') return null;
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
        cardKey: 'covid',
        count,
        renderer: 'formatHealedNewsSection',
      },
      qc: { ok: true, failures: [] },
    });
  } catch {
    return null;
  }
}

function produceDataCardArtifact({ card, date, dataDir, now = new Date() }) {
  if (card.id === 'system_health') {
    return produceSystemHealthCardArtifact({ date, dataDir, now });
  }
  if (card.id === 'token_usage') {
    const existing = existingSourceArtifact({ dataDir, date, id: card.id });
    if (!hasTokenUsageSourceArtifact({ dataDir, date }) && existing) {
      return normalizeArtifactQuality({
        ...existing,
        kind: 'data',
        status: existing.status === 'clean' ? 'clean' : normalizeStatus(existing.status),
        generatedAt: now.toISOString(),
        source: { ...(existing.source || {}), producer: 'data-card-artifact' },
      });
    }
    return produceTokenUsageCardArtifact({ date, dataDir, now });
  }
  if (card.id === 'otter_speaker_pareto') {
    return produceOtterSpeakerParetoCardArtifact({ date, dataDir, now });
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
      status: existing.status === 'clean' ? 'clean' : normalizeStatus(existing.status),
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

async function produceCardArtifact({ cardId, date, dataDir = defaultDataDir(), now = new Date() } = {}) {
  const card = getCardById(cardId);
  if (!card) throw new Error(`ExampleCo briefing card '${cardId}'`);
  const artifact = isLlmCard(card.id)
    ? produceSourceBackedLlmCardArtifact({ card, date, dataDir, now }) ||
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
          mode: error && error.code === 'CARD_PRODUCER_TIMEOUT' ? 'producer-timeout' : 'producer-exception',
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
  const blocked = union.artifacts.filter((artifact) => artifact.status === 'blocked').map((a) => a.id);
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
  produceSystemHealthCardArtifact,
  produceTokenUsageCardArtifact,
  produceOtterSpeakerParetoCardArtifact,
  produceAllCardArtifacts,
  producerTimeoutMs,
  withProducerTimeout,
  listCardArtifactDates,
  briefingArtifactWatchdog,
};
