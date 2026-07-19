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
const { readProviderUsage } = require('./token-usage-receipts.js');
const {
  readExecSummaryRecord: readOtterExecSummaryRecord,
} = require('./otter-exec-summary-artifacts.js');

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
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 24);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function fileEvidence(file) {
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    // Missing is an honest source condition, not an exception.
  }
  const isFile = Boolean(stat && stat.isFile());
  const json = isFile ? readJson(file) : null;
  const generatedAt =
    (json && (json.generated_at || json.generatedAt || json.ts || json.updatedAt)) ||
    (isFile && stat.mtime.toISOString()) ||
    null;
  const substance = json && typeof json === 'object' ? Object.keys(json).length : 0;
  const detail = {
    file,
    exists: isFile,
    kind: !stat ? 'missing' : isFile ? 'file' : 'directory',
    generatedAt,
    substance,
    bytes: isFile ? stat.size : 0,
  };
  return { digest: sha256(JSON.stringify(detail)), facts: detail };
}

function dataFile(dataDir, ...parts) {
  return path.join(dataDir, ...parts);
}

function cardFamily(cardId) {
  const id = String(cardId || '')
    .trim()
    .toLowerCase();
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

async function runNodeCommand({
  node = process.execPath,
  cwd = REPO_ROOT,
  args,
  env,
  runCommand,
  timeoutMs,
}) {
  if (typeof runCommand !== 'function') {
    return { ok: false, skipped: true, reason: 'no command runner supplied' };
  }
  const result = await runCommand(node, args, { cwd, env, timeoutMs });
  return { ok: result.exitCode === 0 && !result.timedOut, result };
}

function controllerSourceEnv(dataDir, extra = {}) {
  const env = {
    ...process.env,
    ...extra,
    SECONDBRAIN_DATA_DIR: dataDir,
    BRIEFING_CARD_CONTROLLER: '1',
  };
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
  ['life-archive', 'voiceprints', 'speaker-pareto-latest.json'],
  ['life-archive', 'voiceprints', 'otter-speaker-identity-completeness-latest.json'],
  ['life-archive', 'voiceprints', 'voice-discovery-roster-latest.json'],
  ['life-archive', 'voiceprints', 'voiceprint-health-latest.json'],
  ['life-archive', 'voiceprints', 'otter-processing-coverage-probe-latest.json'],
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
  const start = String(markdown || '')
    .toUpperCase()
    .indexOf('OTTER SPEAKER PARETO / PEOPLE TAGGED:');
  if (start < 0) return '';
  const tail = String(markdown).slice(start);
  const end = tail.search(/\n---\s*(?:\n|$)/);
  return end >= 0 ? tail.slice(0, end) : tail;
}

function dateHintFromCallRow(text, briefingDate) {
  const hit = String(text || '').match(/\b([A-Z][a-z]{2})\s+(\d{1,2})\b/);
  if (!hit) return '';
  const month = new Date(`${hit[1]} 1, 2000`).getMonth() + 1;
  const year = /^\d{4}/.test(String(briefingDate || ''))
    ? String(briefingDate).slice(0, 4)
    : String(new Date().getUTCFullYear());
  return Number.isFinite(month)
    ? `${year}-${String(month).padStart(2, '0')}-${String(hit[2]).padStart(2, '0')}`
    : '';
}

function titleKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:meeting|call|session)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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
    if (!summaryNamesPersonAsParticipant(summary, /\bExampleCo\b/i) || /\bExampleCo\b/i.test(speakers))
      continue;
    candidates.push({
      title: title.trim(),
      titleKey: titleKey(title),
      dateHint: dateHintFromCallRow(when, date),
      summary: summary.trim(),
    });
  }
  if (!candidates.length) return [];
  const rosters = readJson(dataFile(dataDir, ...OTTER_ARTIFACTS[0])) || {};
  const execSummaries =
    readJson(dataFile(dataDir, 'agent', 'otter-call-exec-summaries.json'))?.summaries || {};
  const out = [];
  for (const call of Array.isArray(rosters.calls) ? rosters.calls : []) {
    const callTitleKey = titleKey(call.title);
    const callDate = String(call.date || '').trim() || ctDateFromMs(call.start_time);
    const speaksExampleCo = (Array.isArray(call.speakers) ? call.speakers : []).some((speaker) =>
      /\bExampleCo\b/i.test(`${speaker.display_name || ''} ${speaker.person_id || ''}`),
    );
    if (speaksExampleCo) continue;
    const summaryRecord = readOtterExecSummaryRecord({
      dataDir,
      call,
      aggregateSummaries: execSummaries,
    });
    const displayTitleKey = titleKey(
      summaryRecord?.displayTitle || summaryRecord?.display_title || '',
    );
    if (
      candidates.some(
        (candidate) =>
          candidate.titleKey &&
          (candidate.titleKey === callTitleKey || candidate.titleKey === displayTitleKey) &&
          (!candidate.dateHint || candidate.dateHint === callDate),
      )
    ) {
      const otid = String(call.otid || '').trim();
      if (otid && !out.includes(otid)) out.push(otid);
    }
  }
  return out;
}

async function refreshOtter({
  dataDir,
  date,
  runCommand,
  node = process.execPath,
  cwd = REPO_ROOT,
} = {}) {
  // These producers are data-only: no briefing markdown write, no browser, and
  // no paid/model call. The target card is rendered only afterward through
  // refresh-card.js under the controller's serialized publish lane.
  const mismatchOtids = otterSpeakerMismatchOtids({ dataDir, date });
  const otterEnv = {
    VOICE_SKIP_BRIEFING_REFRESH: '1',
    VOICE_SKIP_PEOPLE_SYNC: '1',
    VOICE_SKIP_LIFE_RELEVANCE: '1',
  };
  const commands = [
    [['scripts/otter-ingest-watch.js', '--once'], 4 * 60 * 1000],
    ...(mismatchOtids.length
      ? [
          [
            [
              'scripts/otter-post-ingest-voice-intelligence.js',
              '--otids',
              mismatchOtids.join(','),
              '--reason',
              'briefing-card-controller-otter-speaker-mismatch',
            ],
            45 * 60 * 1000,
            {
              OTTER_POST_INGEST_RESOLVER_LIMIT: '25',
              OTTER_POST_INGEST_PROBE_CONCURRENCY: '2',
              OTTER_POST_INGEST_AUDIO_CONCURRENCY: '2',
              OTTER_VOICE_EFS_LOCK_DIR: '/mnt/sbvoice/life-archive/voiceprints',
            },
          ],
        ]
      : []),
    [
      [
        'scripts/otter-post-ingest-voice-intelligence.js',
        '--reason',
        'briefing-card-controller-otter-refresh',
      ],
      45 * 60 * 1000,
      {
        OTTER_POST_INGEST_RESOLVER_LIMIT: '25',
        OTTER_POST_INGEST_PROBE_CONCURRENCY: '2',
        OTTER_POST_INGEST_AUDIO_CONCURRENCY: '2',
        OTTER_VOICE_EFS_LOCK_DIR: '/mnt/sbvoice/life-archive/voiceprints',
      },
    ],
    [['scripts/otter-call-speaker-rosters.js', '--write'], 5 * 60 * 1000],
    [['scripts/otter-call-completeness-report.js', '--write'], 5 * 60 * 1000],
    [['scripts/otter-text-audio-coverage-report.js', '--write'], 5 * 60 * 1000],
    [['scripts/otter-speaker-pareto-report.js'], 5 * 60 * 1000],
    [['scripts/otter-speaker-identity-completeness.js', '--write'], 5 * 60 * 1000],
    [['scripts/otter-voice-discovery-roster.js', '--write'], 5 * 60 * 1000],
    [['scripts/voiceprint-health-report.js', '--write'], 5 * 60 * 1000],
    [['scripts/otter-processing-coverage-probe.js'], 5 * 60 * 1000],
    // Missing exec summaries and generic/raw call titles are the recurring
    // otter_speaker_pareto defect class (2026-07-09 LEARNINGS): the legacy
    // cloudSelfHealScriptRunsForRefreshTargets path always ran this producer
    // on a self-heal-refresh, but the controller's own source contract never
    // did, so a controller-driven Otter refresh could leave "Summary
    // unavailable" / raw-title rows on the card even after every roster and
    // coverage report came back fresh. This wires it at the source so a
    // generic title or missing summary cannot persist to the briefing.
    [
      [
        'scripts/otter-call-exec-summaries.js',
        '--date',
        date || new Date().toISOString().slice(0, 10),
        '--max',
        '30',
      ],
      15 * 60 * 1000,
    ],
  ];
  const results = [];
  for (const [args, timeoutMs, extraEnv] of commands) {
    const row = await runNodeCommand({
      node,
      cwd,
      args,
      // otter-post-ingest normally owns a broad generated-sections write and
      // people-file sync in its tail. Both are forbidden inside this card
      // controller source lane: only the eventual scoped refresh-card call may
      // write briefing markdown, and people-file Git work needs its own isolated
      // workflow. The acoustic resolver remains enabled.
      env: controllerSourceEnv(dataDir, { ...otterEnv, ...(extraEnv || {}) }),
      runCommand,
      timeoutMs,
    });
    results.push({ args, ...row });
    if (!row.ok) {
      return {
        ok: false,
        family: 'otter',
        mismatchOtids,
        results,
        evidence: otterEvidence({ dataDir }),
      };
    }
  }
  return {
    ok: true,
    family: 'otter',
    mismatchOtids,
    results,
    evidence: otterEvidence({ dataDir }),
  };
}

function contentEvidence({ dataDir, date }) {
  return evidenceForFiles(dataDir, [['agent', `content-heal-${date}.json`]]);
}

async function refreshContent({ dataDir, date, cardIds = [], runCommand, node, cwd } = {}) {
  const keys = [
    ...new Set((cardIds || []).map((cardId) => CONTENT_HEAL_KEYS.get(cardId)).filter(Boolean)),
  ];
  if (!keys.length)
    return {
      ok: true,
      family: 'content',
      results: [],
      evidence: contentEvidence({ dataDir, date }),
    };
  return refreshCommandSet({
    family: 'content',
    dataDir,
    date,
    runCommand,
    node,
    cwd,
    commands: [
      [['scripts/content-heal.js', '--date', date, '--cards', keys.join(',')], 16 * 60 * 1000],
    ],
    evidence: contentEvidence,
  });
}

function actionItemsEvidence({ dataDir }) {
  return evidenceForFiles(dataDir, [
    ['briefing-action-items.json'],
    // Both heartbeat surfaces: the stable .json snapshot AND the append-only
    // .jsonl the refresh gate (actionItemsNeedRefresh) actually reads. Evidence
    // must track what the gate consumes or a skip/refresh decision is invisible
    // to the durable receipt (Codex peer review b7e87031510f).
    ['agent', 'gmail-scan-heartbeat.json'],
    ['agent', 'gmail-scan-heartbeat.jsonl'],
  ]);
}

function actionItemsBuilderHelpers() {
  try {
    return require('../cloud-morning-briefing.js');
  } catch {
    return null;
  }
}

async function refreshActionItems({ dataDir, date, runCommand, node, cwd, builderHelpers } = {}) {
  // Producer parity with the 5:30 full build (rebuild(x) == build(x)): the
  // morning builder runs the regenerator ONLY when shouldRefreshActionItemsForCloud
  // says the source needs it (stale review, integrity issue, or stale Gmail
  // heartbeat). Rerunning it against a fresh reply-verified source can only
  // degrade the shared state: an IMAP failure inside the rerun silently falls
  // back to the local archive and drops the reply-verification proof, which is
  // exactly how the SAME day's data graded clean at 5:30 and blocked in the
  // per-card rebuild (frozen supervised run 20260719103219-9552bdcc). When the
  // source is fresh and proven, skip the mutation so the target render reads
  // the same state the full build read.
  //
  // Intentional divergence from the narrow self-heal lane: the full build's
  // SELF_HEAL_REFRESH_CARDS path force-refreshes a live-QC-named action_items
  // target even when fresh. The controller's source lane plans ALL cards
  // (bootstrap and supervised runs alike), so an unconditional force here is
  // the exact degrade vector this gate removes. When the source itself is
  // broken, the gate's integrity/staleness checks fire and the regenerator
  // still runs.
  const helpers = builderHelpers === undefined ? actionItemsBuilderHelpers() : builderHelpers;
  if (!helpers || typeof helpers.shouldRefreshActionItemsForCloud !== 'function') {
    // FAIL CLOSED (Codex peer review b7e87031510f): with no gate available we
    // cannot prove the source needs a rewrite, and an unconditional
    // regeneration is the known degrade vector. Preserving the source is safe
    // on both axes: a fresh source renders clean, a genuinely stale source
    // still grades honestly blocked by the artifact producer.
    return {
      ok: true,
      family: 'action-items',
      skipped: true,
      skipReason: 'refresh-gate-unavailable: preserving source state instead of a blind rewrite',
      results: [],
      evidence: actionItemsEvidence({ dataDir }),
    };
  }
  if (!helpers.shouldRefreshActionItemsForCloud({ dataDir })) {
    return {
      ok: true,
      family: 'action-items',
      skipped: true,
      skippedFreshSource: true,
      skipReason: 'source-fresh-and-proven: full-build gate says no refresh needed',
      results: [],
      evidence: actionItemsEvidence({ dataDir }),
    };
  }
  const outcome = await refreshCommandSet({
    family: 'action-items',
    dataDir,
    date,
    runCommand,
    node,
    cwd,
    commands: [
      [
        [
          'scripts/regenerate-action-items.js',
          '--date',
          date,
          '--limit',
          '100',
          '--incremental',
          '--preserve-on-empty',
        ],
        5 * 60 * 1000,
      ],
    ],
    evidence: actionItemsEvidence,
  });
  // The full build stamps the Gmail-scan heartbeat after a successful
  // regeneration (refreshActionItemsForCloud); mirror it so the data state the
  // per-card lane produces is the state the full build would have produced.
  if (outcome.ok && helpers && typeof helpers.writeGmailScanHeartbeat === 'function') {
    try {
      helpers.writeGmailScanHeartbeat(dataDir, 'card-controller-action-items');
    } catch {
      // Non-fatal, matching the full build's heartbeat handling.
    }
  }
  return outcome;
}

function simpleEvidence(parts) {
  return ({ dataDir }) => evidenceForFiles(dataDir, parts);
}

function datedArtifactEvidence(partsForDate) {
  return ({ dataDir, date }) => {
    const normalizedDate = String(date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
      const facts = [
        {
          file: dataFile(dataDir, 'agent', 'missing-briefing-date'),
          exists: false,
          kind: 'missing-date',
          generatedAt: null,
          substance: 0,
          bytes: 0,
        },
      ];
      return { digest: sha256(JSON.stringify(facts)), facts };
    }
    return evidenceForFiles(dataDir, partsForDate(normalizedDate));
  };
}

function previousIsoDate(isoDate) {
  const [year, month, day] = String(isoDate || '')
    .split('-')
    .map(Number);
  const value = new Date(Date.UTC(year || 1970, (month || 1) - 1, (day || 1) - 1, 12));
  return value.toISOString().slice(0, 10);
}

function tokenUsageArtifactParts(date) {
  return [
    ['agent', `token-usage-${previousIsoDate(date)}.json`],
    ['agent', 'token-usage-receipts', date, 'claude.json'],
    ['agent', 'token-usage-receipts', date, 'codex.json'],
    ['agent', 'token-usage-receipts', date, 'bedrock.json'],
  ];
}

function planUsageIsCurrent({ dataDir, date, now = Date.now() }) {
  const state = readProviderUsage({
    dataDir,
    date,
    provider: 'claude',
    now: new Date(now),
  });
  const plan = state.payload;
  const generatedAt = Date.parse(state.observedAt || (plan && plan.generated_at));
  const resetDate = String((plan && plan.weekly_all_models_resets_at) || '').slice(0, 10);
  return (
    state.state === 'fresh' &&
    Number.isFinite(generatedAt) &&
    now - generatedAt <= 24 * 60 * 60 * 1000 &&
    (!resetDate || resetDate >= String(date || ''))
  );
}

function tokenUsageEvidence({ dataDir, date }) {
  return evidenceForFiles(dataDir, tokenUsageArtifactParts(date));
}

async function refreshTokenUsage({ dataDir, date, runCommand, node, cwd }) {
  const receiptEnv = { TOKEN_USAGE_RECEIPT_DATE: date };
  const commands = [
    [
      ['scripts/collect-daily-token-usage.js', '--date', previousIsoDate(date)],
      4 * 60 * 1000,
      receiptEnv,
    ],
    [['scripts/collect-codex-token-usage.js'], 4 * 60 * 1000, receiptEnv],
    [['scripts/collect-bedrock-budget-usage.js'], 4 * 60 * 1000, receiptEnv],
  ];
  // The Claude plan endpoint is Cloudflare-protected. A current durable
  // snapshot is already the authoritative proof the card renders, so do not
  // spend a second bounded attempt on it. When it is genuinely stale, one
  // controller-owned attempt is useful; a retry storm is not.
  if (!planUsageIsCurrent({ dataDir, date })) {
    commands.unshift([
      ['scripts/collect-claude-plan-usage.js'],
      45 * 1000,
      {
        CLAUDE_PLAN_USAGE_ATTEMPTS: '1',
        TOKEN_USAGE_RECEIPT_DATE: date,
      },
    ]);
  }
  return refreshCommandSet({
    family: 'token-usage',
    dataDir,
    date,
    runCommand,
    node,
    cwd,
    commands,
    evidence: tokenUsageEvidence,
  });
}

function simpleProducer({ family, cards, command, timeoutMs, artifacts, evidence, extraEnv } = {}) {
  const contractEvidence = evidence || simpleEvidence(artifacts);
  return {
    family,
    cards,
    evidence: contractEvidence,
    refresh: ({ dataDir, date, runCommand, node, cwd }) =>
      refreshCommandSet({
        family,
        dataDir,
        date,
        runCommand,
        node,
        cwd,
        commands: [[command(date, dataDir), timeoutMs, extraEnv]],
        evidence: contractEvidence,
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
    evidence: datedArtifactEvidence((date) => [['agent', 'mortgage-rates', `${date}.json`]]),
  }),
  shorts: simpleProducer({
    family: 'shorts',
    cards: ['shorts_proposals'],
    command: (date) => ['scripts/morning-shorts-proposals.js', '--date', date],
    timeoutMs: 18 * 60 * 1000,
    evidence: datedArtifactEvidence((date) => [['agent', 'shorts-proposals', `${date}.json`]]),
  }),
  'aws-costs': simpleProducer({
    family: 'aws-costs',
    cards: ['aws_costs'],
    command: (date) => ['scripts/aws-cost-section.js', '--date', date],
    timeoutMs: 5 * 60 * 1000,
    // The live card reads the dated markdown snapshot, not a legacy JSON alias.
    evidence: datedArtifactEvidence((date) => [['agent', `aws-costs-${date}.md`]]),
  }),
  'token-usage': {
    family: 'token-usage',
    cards: ['token_usage'],
    evidence: tokenUsageEvidence,
    refresh: refreshTokenUsage,
  },
  'kingdom-equipping': simpleProducer({
    family: 'kingdom-equipping',
    cards: ['kingdom_equipping'],
    command: (date, dataDir) => [
      'scripts/kingdom-equipping-ideas.js',
      '--date',
      date,
      '--data-dir',
      dataDir,
    ],
    timeoutMs: 4 * 60 * 1000,
    evidence: datedArtifactEvidence((date) => [['agent', 'kingdom-equipping', `${date}.json`]]),
  }),
  'communication-coaching': simpleProducer({
    family: 'communication-coaching',
    cards: ['communication_coaching'],
    command: (date) => ['scripts/comm-coaching-card.js', '--date', date],
    timeoutMs: 4 * 60 * 1000,
    evidence: datedArtifactEvidence((date) => [['agent', 'comm-coaching', `${date}.json`]]),
  }),
  linkedin: {
    family: 'linkedin',
    cards: ['linkedin'],
    evidence: simpleEvidence([['agent', 'linkedin-scan-status.json']]),
  },
  'card-local': {
    family: 'card-local',
    cards: [],
    evidence: () => ({ digest: 'card-local', facts: {} }),
  },
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
  previousIsoDate,
  tokenUsageArtifactParts,
  tokenUsageEvidence,
  planUsageIsCurrent,
  refreshTokenUsage,
  refreshCommandSet,
  controllerSourceEnv,
  fileEvidence,
};
