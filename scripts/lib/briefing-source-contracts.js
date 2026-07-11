'use strict';

// Cloud briefing card-controller source contracts.
//
// A source contract names the data family a card consumes and, where a safe
// existing producer is available, the narrow data-only refresh that produces
// fresh evidence before the controller repaints the card. Card rendering stays
// in refresh-card.js; this module never writes briefing markdown.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { summaryNamesPersonAsParticipant } = require('../verify-dashboard-cards-live.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const NEWS_CARD_IDS = new Set([
  'ai_tech_news',
  'us_news',
  'world_news',
  'us_immigration_news',
  'mortgage_industry_news',
  'covid_news',
  'ExampleCo_group_news',
]);

const CONTENT_HEAL_KEYS = new Map([
  ['ai_tech_news', 'aitech'],
  ['us_news', 'us'],
  ['world_news', 'world'],
  ['us_immigration_news', 'immigration'],
  ['mortgage_industry_news', 'mortgage'],
  ['covid_news', 'covid'],
  ['viral_tech_clips', 'viral'],
]);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function fileEvidence(file) {
  const json = readJson(file);
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    // Missing is an honest source condition, not an exception.
  }
  const generatedAt =
    (json && (json.generated_at || json.generatedAt || json.ts || json.updatedAt)) ||
    (stat && stat.mtime.toISOString()) ||
    null;
  const substance = json && typeof json === 'object' ? Object.keys(json).length : 0;
  const detail = {
    file,
    exists: !!stat,
    generatedAt,
    substance,
    bytes: stat ? stat.size : 0,
  };
  return { digest: sha256(JSON.stringify(detail)), facts: detail };
}

function dataFile(dataDir, ...parts) {
  return path.join(dataDir, ...parts);
}

function cardFamily(cardId) {
  const id = String(cardId || '').trim().toLowerCase();
  if (id === 'otter_speaker_pareto' || id === 'voice_confirmation') return 'otter';
  if (CONTENT_HEAL_KEYS.has(id)) return 'content';
  if (id === 'action_items') return 'action-items';
  if (id === 'mortgage_rate_indexes') return 'mortgage-rates';
  if (id === 'shorts_proposals') return 'shorts';
  if (id === 'aws_costs') return 'aws-costs';
  if (id === 'token_usage') return 'token-usage';
  if (id === 'kingdom_equipping') return 'kingdom-equipping';
  if (id === 'communication_coaching') return 'communication-coaching';
  if (id === 'linkedin') return 'linkedin';
  return 'card-local';
}

async function runNodeCommand({ node = process.execPath, cwd = REPO_ROOT, args, env, runCommand, timeoutMs }) {
  if (typeof runCommand !== 'function') {
    return { ok: false, skipped: true, reason: 'no command runner supplied' };
  }
  const result = await runCommand(node, args, { cwd, env, timeoutMs });
  return { ok: result.exitCode === 0 && !result.timedOut, result };
}

function controllerSourceEnv(dataDir, extra = {}) {
  const env = { ...process.env, ...extra, SECONDBRAIN_DATA_DIR: dataDir };
  // The controller never gains a paid API lane by inheriting a stray key. The
  // established ask-ai subscription ladder remains available where a producer
  // genuinely needs it, but its paid fallback stays gated elsewhere.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENAI_API_KEY;
  return env;
}

function evidenceForFiles(dataDir, files = []) {
  const artifacts = files.map((parts) => fileEvidence(dataFile(dataDir, ...parts)));
  const facts = artifacts.map((entry) => entry.facts);
  return { digest: sha256(JSON.stringify(facts)), facts };
}

async function refreshCommandSet({
  family,
  dataDir,
  date,
  runCommand,
  node = process.execPath,
  cwd = REPO_ROOT,
  commands = [],
  evidence,
} = {}) {
  const results = [];
  for (const [args, timeoutMs, extraEnv] of commands) {
    const row = await runNodeCommand({
      node,
      cwd,
      args,
      env: controllerSourceEnv(dataDir, extraEnv),
      runCommand,
      timeoutMs,
    });
    results.push({ args, ...row });
    if (!row.ok) return { ok: false, family, results, evidence: evidence({ dataDir, date }) };
  }
  return { ok: true, family, results, evidence: evidence({ dataDir, date }) };
}

const OTTER_ARTIFACTS = [
  ['life-archive', 'voiceprints', 'otter-call-speaker-rosters-latest.json'],
  ['life-archive', 'voiceprints', 'otter-call-completeness-latest.json'],
  ['life-archive', 'voiceprints', 'otter-text-audio-coverage-latest.json'],
];

function otterEvidence({ dataDir }) {
  const artifacts = OTTER_ARTIFACTS.map((parts) => fileEvidence(dataFile(dataDir, ...parts)));
  const facts = artifacts.map((entry) => entry.facts);
  return { digest: sha256(JSON.stringify(facts)), facts };
}

function ctDateFromMs(value) {
  const raw = Number(value || NaN);
  if (!Number.isFinite(raw)) return '';
  const ms = raw > 10_000_000_000 ? raw : raw * 1000;
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function otterSection(markdown) {
  const start = String(markdown || '').toUpperCase().indexOf('OTTER SPEAKER PARETO / PEOPLE TAGGED:');
  if (start < 0) return '';
  const tail = String(markdown).slice(start);
  const end = tail.search(/\n---\s*(?:\n|$)/);
  return end >= 0 ? tail.slice(0, end) : tail;
}

function dateHintFromCallRow(text, briefingDate) {
  const hit = String(text || '').match(/\b([A-Z][a-z]{2})\s+(\d{1,2})\b/);
  if (!hit) return '';
  const month = new Date(`${hit[1]} 1, 2000`).getMonth() + 1;
  const year = /^\d{4}/.test(String(briefingDate || '')) ? String(briefingDate).slice(0, 4) : String(new Date().getUTCFullYear());
  return Number.isFinite(month) ? `${year}-${String(month).padStart(2, '0')}-${String(hit[2]).padStart(2, '0')}` : '';
}

function titleKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:meeting|call|session)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function execSummaryRecord(summaries, call) {
  const keys = [call && call.otid, call && call.id, call && call.file, call && call.title]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  for (const key of keys) {
    if (summaries && summaries[key] && typeof summaries[key] === 'object') return summaries[key];
  }
  return null;
}

// Find the source otids behind the precise live-QC class
// OTTER-SPEAKER-MISMATCH. The card's rendered executive summary is used only to
// decide WHICH call needs fresh acoustic work. It is never identity evidence:
// the only thing that may place ExampleCo back in the roster is the voice resolver.
function otterSpeakerMismatchOtids({ dataDir, date }) {
  const markdown = (() => {
    try {
      return fs.readFileSync(dataFile(dataDir, 'briefings', `briefing-${date}.md`), 'utf8');
    } catch {
      return '';
    }
  })();
  const candidates = [];
  for (const line of otterSection(markdown).split(/\r?\n/)) {
    const row = line.match(/^\s*-\s+([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*(.+)$/);
    if (!row) continue;
    const [, when, title, , speakers, summary] = row;
    if (!summaryNamesPersonAsParticipant(summary, /\bExampleCo\b/i) || /\bExampleCo\b/i.test(speakers)) continue;
    candidates.push({ title: title.trim(), titleKey: titleKey(title), dateHint: dateHintFromCallRow(when, date), summary: summary.trim() });
  }
  if (!candidates.length) return [];
  const rosters = readJson(dataFile(dataDir, ...OTTER_ARTIFACTS[0])) || {};
  const execSummaries = readJson(dataFile(dataDir, 'agent', 'otter-call-exec-summaries.json'))?.summaries || {};
  const out = [];
  for (const call of Array.isArray(rosters.calls) ? rosters.calls : []) {
    const callTitleKey = titleKey(call.title);
    const callDate = String(call.date || '').trim() || ctDateFromMs(call.start_time);
    const speaksExampleCo = (Array.isArray(call.speakers) ? call.speakers : []).some((speaker) =>
      /\bExampleCo\b/i.test(`${speaker.display_name || ''} ${speaker.person_id || ''}`),
    );
    if (speaksExampleCo) continue;
    const summaryRecord = execSummaryRecord(execSummaries, call);
    const displayTitleKey = titleKey(summaryRecord?.displayTitle || summaryRecord?.display_title || '');
    if (candidates.some((candidate) =>
      candidate.titleKey &&
      (candidate.titleKey === callTitleKey || candidate.titleKey === displayTitleKey) &&
      (!candidate.dateHint || candidate.dateHint === callDate),
    )) {
      const otid = String(call.otid || '').trim();
      if (otid && !out.includes(otid)) out.push(otid);
    }
  }
  return out;
}

async function refreshOtter({ dataDir, date, runCommand, node = process.execPath, cwd = REPO_ROOT } = {}) {
  // These producers are data-only: no briefing markdown write, no browser, and
  // no paid/model call. The target card is rendered only afterward through
  // refresh-card.js under the controller's serialized publish lane.
  const mismatchOtids = otterSpeakerMismatchOtids({ dataDir, date });
  const commands = [
    // This is deliberately source-targeted. A summary/prose mention identifies
    // a suspect call, but this process uses the established voice-only 0.56
    // score and margin gates to decide whether a track is actually ExampleCo.
    ...(mismatchOtids.length
      ? [[
          ['scripts/otter-post-ingest-voice-intelligence.js', '--otids', mismatchOtids.join(','), '--reason', 'briefing-card-controller-otter-speaker-mismatch'],
          45 * 60 * 1000,
        ]]
      : []),
    [['scripts/otter-call-speaker-rosters.js', '--write'], 5 * 60 * 1000],
    [['scripts/otter-call-completeness-report.js', '--write'], 5 * 60 * 1000],
    [['scripts/otter-text-audio-coverage-report.js', '--write'], 5 * 60 * 1000],
  ];
  const results = [];
  for (const [args, timeoutMs] of commands) {
    const row = await runNodeCommand({
      node,
      cwd,
      args,
      // otter-post-ingest normally owns a broad generated-sections write and
      // people-file sync in its tail. Both are forbidden inside this card
      // controller source lane: only the eventual scoped refresh-card call may
      // write briefing markdown, and people-file Git work needs its own isolated
      // workflow. The acoustic resolver remains enabled.
      env: controllerSourceEnv(dataDir, {
        VOICE_SKIP_BRIEFING_REFRESH: '1',
        VOICE_SKIP_PEOPLE_SYNC: '1',
      }),
      runCommand,
      timeoutMs,
    });
    results.push({ args, ...row });
    if (!row.ok) {
      return { ok: false, family: 'otter', mismatchOtids, results, evidence: otterEvidence({ dataDir }) };
    }
  }
  return { ok: true, family: 'otter', mismatchOtids, results, evidence: otterEvidence({ dataDir }) };
}

function contentEvidence({ dataDir, date }) {
  return evidenceForFiles(dataDir, [['agent', `content-heal-${date}.json`]]);
}

async function refreshContent({ dataDir, date, cardIds = [], runCommand, node, cwd } = {}) {
  const keys = [...new Set((cardIds || []).map((cardId) => CONTENT_HEAL_KEYS.get(cardId)).filter(Boolean))];
  if (!keys.length) return { ok: true, family: 'content', results: [], evidence: contentEvidence({ dataDir, date }) };
  return refreshCommandSet({
    family: 'content',
    dataDir,
    date,
    runCommand,
    node,
    cwd,
    commands: [[['scripts/content-heal.js', '--date', date, '--cards', keys.join(',')], 16 * 60 * 1000]],
    evidence: contentEvidence,
  });
}

function actionItemsEvidence({ dataDir }) {
  return evidenceForFiles(dataDir, [
    ['briefing-action-items.json'],
    ['agent', 'gmail-scan-heartbeat.json'],
  ]);
}

async function refreshActionItems({ dataDir, date, runCommand, node, cwd } = {}) {
  return refreshCommandSet({
    family: 'action-items',
    dataDir,
    date,
    runCommand,
    node,
    cwd,
    commands: [[
      ['scripts/regenerate-action-items.js', '--date', date, '--limit', '100', '--incremental', '--preserve-on-empty'],
      5 * 60 * 1000,
    ]],
    evidence: actionItemsEvidence,
  });
}

function simpleEvidence(parts) {
  return ({ dataDir }) => evidenceForFiles(dataDir, parts);
}

function simpleProducer({ family, cards, command, timeoutMs, artifacts, extraEnv } = {}) {
  return {
    family,
    cards,
    evidence: simpleEvidence(artifacts),
    refresh: ({ dataDir, date, runCommand, node, cwd }) => refreshCommandSet({
      family,
      dataDir,
      date,
      runCommand,
      node,
      cwd,
      commands: [[command(date, dataDir), timeoutMs, extraEnv]],
      evidence: simpleEvidence(artifacts),
    }),
  };
}

const CONTRACTS = {
  otter: {
    family: 'otter',
    cards: ['otter_speaker_pareto', 'voice_confirmation'],
    evidence: otterEvidence,
    refresh: refreshOtter,
  },
  content: {
    family: 'content',
    cards: [...CONTENT_HEAL_KEYS.keys()],
    evidence: contentEvidence,
    refresh: refreshContent,
  },
  'action-items': {
    family: 'action-items',
    cards: ['action_items'],
    evidence: actionItemsEvidence,
    refresh: refreshActionItems,
  },
  'mortgage-rates': simpleProducer({
    family: 'mortgage-rates',
    cards: ['mortgage_rate_indexes'],
    command: (date) => ['scripts/mortgage-rate-indexes.js', '--date', date],
    timeoutMs: 6 * 60 * 1000,
    artifacts: [['agent', 'mortgage-rates']],
  }),
  shorts: simpleProducer({
    family: 'shorts',
    cards: ['shorts_proposals'],
    command: (date) => ['scripts/morning-shorts-proposals.js', '--date', date],
    timeoutMs: 18 * 60 * 1000,
    artifacts: [['agent', 'shorts-proposals']],
  }),
  'aws-costs': simpleProducer({
    family: 'aws-costs',
    cards: ['aws_costs'],
    command: (date) => ['scripts/aws-cost-section.js', '--date', date],
    timeoutMs: 5 * 60 * 1000,
    artifacts: [['agent', 'aws-costs-latest.json']],
  }),
  'token-usage': {
    family: 'token-usage',
    cards: ['token_usage'],
    evidence: simpleEvidence([['agent', 'token-usage-latest.json']]),
    refresh: ({ dataDir, date, runCommand, node, cwd }) => refreshCommandSet({
      family: 'token-usage',
      dataDir,
      date,
      runCommand,
      node,
      cwd,
      commands: [
        [['scripts/collect-daily-token-usage.js', '--date', date], 4 * 60 * 1000],
        [['scripts/collect-claude-plan-usage.js', '--date', date], 4 * 60 * 1000],
        [['scripts/collect-codex-token-usage.js', '--date', date], 4 * 60 * 1000],
      ],
      evidence: simpleEvidence([['agent', 'token-usage-latest.json']]),
    }),
  },
  'kingdom-equipping': simpleProducer({
    family: 'kingdom-equipping',
    cards: ['kingdom_equipping'],
    command: (date, dataDir) => ['scripts/kingdom-equipping-ideas.js', '--date', date, '--data-dir', dataDir],
    timeoutMs: 4 * 60 * 1000,
    artifacts: [['agent', 'kingdom-equipping-ideas.json']],
  }),
  'communication-coaching': simpleProducer({
    family: 'communication-coaching',
    cards: ['communication_coaching'],
    command: (date) => ['scripts/comm-coaching-card.js', '--date', date],
    timeoutMs: 4 * 60 * 1000,
    artifacts: [['agent', 'communication-coaching-latest.json']],
  }),
  linkedin: { family: 'linkedin', cards: ['linkedin'], evidence: simpleEvidence([['agent', 'linkedin-scan-status.json']]) },
  'card-local': { family: 'card-local', cards: [], evidence: () => ({ digest: 'card-local', facts: {} }) },
};

function getSourceContract(cardId) {
  return CONTRACTS[cardFamily(cardId)] || CONTRACTS['card-local'];
}

module.exports = {
  NEWS_CARD_IDS,
  CONTENT_HEAL_KEYS,
  OTTER_ARTIFACTS,
  cardFamily,
  getSourceContract,
  otterEvidence,
  otterSpeakerMismatchOtids,
  refreshOtter,
  refreshContent,
  refreshActionItems,
  refreshCommandSet,
  controllerSourceEnv,
  fileEvidence,
};
