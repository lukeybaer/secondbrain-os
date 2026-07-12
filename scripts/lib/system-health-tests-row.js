const fs = require('fs');
const path = require('path');

const { readFreshestLandGateReceipt, isLandGateReceiptFresh } = require('./land-gate-receipt.js');

const INFORMATIONAL_TESTS_ROW =
  '? Automated regression suite: run on the desktop and in CI; no current runtime proof was found for this build.';

// ONE predicate for "this Automated regression suite / Tests row is an
// informational fact, not a failing subsystem". The generator's Attention
// block, the markdown validator, and the non-green parser all consume this so
// a row rename can never desynchronize them again (the 2026-07-12 D9 defect:
// the validator's local carve-out still required the literal word "Tests" and
// hard-failed the renamed row).
function isInformationalTestsRowText(line) {
  const s = String(line || '');
  return (
    /\b(?:Tests|Automated regression suite)\b/i.test(s) &&
    /(not evaluated on the cloud build|run on the desktop and in ci|desktop and in CI|not (?:run|evaluated|measured) (?:live |on )|informational, not a failure|no current runtime proof|land gate)/i.test(
      s,
    )
  );
}

const TEST_CATEGORY_LABELS = Object.freeze({
  briefing: 'Briefing render + sections',
  dispatch: 'Dispatch loop (Otter+Gmail->#Amy)',
  dashboard: 'Dashboard parse + render',
  ranker: 'Action item ranker',
  'auto-reply': 'Inbound auto-reply guardrails',
  health: 'Self-heal probes',
  memory: 'Memory frontmatter + index',
  video: 'Video QC + rubric tools',
  vapi: 'Vapi prompt + assistant config',
  ingest: 'Otter+Gmail+LinkedIn ingest',
  studio: 'Studio renderer + thumbnail',
  devops: 'Dev Ops release hygiene',
  other: 'Other unit + e2e checks',
});

const TEST_CATEGORY_RULES = [
  [
    'briefing',
    /\bbriefing\b|cloud-morning|manual-briefing|system-health|dashboard-qc|news-prose|news-summar/i,
  ],
  ['dispatch', /\bdispatch\b|#amy|amy-dispatch|gmail-amy|telegram|command-queue/i],
  ['dashboard', /\bdashboard\b|ec2-server|briefing-parser|detail-overlay|render-card|live-board/i],
  ['ranker', /\branker\b|action item rank|action-items-rank|priority/i],
  ['auto-reply', /auto-reply|reply drafter|inbound reply|intent/i],
  ['health', /self-heal|health-self-heal|overnight-self-heal|probe|watchdog/i],
  ['memory', /\bmemory\b|frontmatter|contacts\/|graphiti|hebbian|session-start/i],
  ['video', /\bvideo\b|content-review|thumbnail|rubric|virality|youtube/i],
  ['vapi', /\bvapi\b|caller-id|voice call|phone assistant|twilio/i],
  ['ingest', /\bingest\b|otter|gmail|linkedin|archive|scanner|scan/i],
  ['studio', /\bstudio\b|obs|camera|recording|ExampleCo/i],
  [
    'devops',
    /devops|deploy|release|git hygiene|sync-build|pii-screen|public-sync|shared checkout/i,
  ],
];

function firstErrorLine(item) {
  return (
    String((item && (item.error || item.errorDetail)) || '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('at ')) || ''
  );
}

function parseJsonFileMaybe(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function artifactTimeMs(json, absPath) {
  const raw =
    json &&
    (json.ranAt ||
      json.generated_at ||
      json.generatedAt ||
      json.checkedAt ||
      json.timestamp ||
      json.ts);
  const parsed = raw ? new Date(raw).getTime() : NaN;
  if (Number.isFinite(parsed)) return parsed;
  try {
    return fs.statSync(absPath).mtimeMs;
  } catch {
    return 0;
  }
}

function readFreshestTestsBlocked(opts = {}) {
  const repo = path.resolve(
    opts.repo || process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..', '..'),
  );
  const dataDir = opts.dataDir || process.env.SECONDBRAIN_DATA_DIR || '';
  const candidates = [
    dataDir ? path.join(dataDir, 'agent', 'tests-blocked.json') : null,
    path.join(repo, 'data', 'agent', 'tests-blocked.json'),
    process.platform === 'linux' ? '/opt/secondbrain/data/agent/tests-blocked.json' : null,
  ].filter(Boolean);
  const seen = new Set();
  let best = null;
  for (const absPath of candidates) {
    const full = path.resolve(absPath);
    if (seen.has(full)) continue;
    seen.add(full);
    const json = parseJsonFileMaybe(full);
    if (!json || typeof json !== 'object') continue;
    const timeMs = artifactTimeMs(json, full);
    if (!best || timeMs > best.timeMs) best = { json, path: full, timeMs };
  }
  return best;
}

function testCategoryKey(item) {
  const haystack = [
    item && item.file,
    item && item.name,
    item && item.error,
    item && item.errorDetail,
  ]
    .filter(Boolean)
    .join(' ');
  for (const [key, re] of TEST_CATEGORY_RULES) {
    if (re.test(haystack)) return key;
  }
  return 'other';
}

function categoryLabelForKey(key) {
  return TEST_CATEGORY_LABELS[key] || TEST_CATEGORY_LABELS.other;
}

function summarizeTestsByCategory(tests) {
  const failed = Number((tests && tests.failed) || 0);
  const items = Array.isArray(tests && tests.items) ? tests.items : [];
  const buckets = new Map();
  for (const item of items) {
    const key = testCategoryKey(item);
    if (!buckets.has(key)) {
      buckets.set(key, { key, label: categoryLabelForKey(key), count: 0, names: [], items: [] });
    }
    const bucket = buckets.get(key);
    bucket.count += 1;
    bucket.items.push(item);
    const name = String((item && (item.name || item.file)) || '').trim();
    if (name && !bucket.names.includes(name)) bucket.names.push(name.slice(0, 80));
  }
  const itemBackedCount = Array.from(buckets.values()).reduce(
    (sum, bucket) => sum + bucket.count,
    0,
  );
  const missingCount = Math.max(0, failed - itemBackedCount);
  if (missingCount > 0) {
    const existing = buckets.get('other');
    if (existing) {
      existing.count += missingCount;
    } else {
      buckets.set('other', {
        key: 'other',
        label: categoryLabelForKey('other'),
        count: missingCount,
        names: [],
        items: [],
      });
    }
  }
  const order = Object.keys(TEST_CATEGORY_LABELS);
  return Array.from(buckets.values()).sort((a, b) => {
    const ao = order.indexOf(a.key);
    const bo = order.indexOf(b.key);
    return (ao === -1 ? order.length : ao) - (bo === -1 ? order.length : bo);
  });
}

function summarizeFailingTests(tests) {
  const buckets = summarizeTestsByCategory(tests);
  const failed =
    buckets.reduce((sum, bucket) => sum + bucket.count, 0) || Number((tests && tests.failed) || 0);
  const names = buckets.flatMap((bucket) => bucket.names.map((name) => `${bucket.label}: ${name}`));
  const shown = names.slice(0, 3);
  const more = Math.max(0, names.length - shown.length);
  const list = shown.length ? `: ${shown.join('; ')}${more ? `; +${more} more` : ''}` : '';
  return `${failed} failing test${failed === 1 ? '' : 's'}${list}.`;
}

// D9 (ExampleCo wave 3a, 2026-07-12): when there is no fresh desktop/CI test-run
// artifact, the row reads the LAST LAND-GATE RECEIPT as its runtime proof.
// The land gate runs the scoped suite green on every land (scripts/land.js
// writes data/agent/land-gate-receipt.json; the deploy ships it to /opt), so
// this is a factual, timestamped status instead of the bare "no current
// runtime proof" line. A red land-gate receipt is still informational -- a
// rejected session branch never landed, so master is unchanged -- and a stale
// receipt is shown as dated context, never as a live green claim.
function formatLandGateTestsRow(receipt, now = Date.now()) {
  if (!receipt) return null;
  const ranAt = String(receipt.ranAt || '');
  const commit = String(receipt.commit || '').slice(0, 8);
  const files = Number(receipt.scopedTestFileCount) || 0;
  const scopeText = files
    ? `${files} scoped test file${files === 1 ? '' : 's'}`
    : 'core guards only';
  if (receipt.status === 'green' && isLandGateReceiptFresh(receipt, now)) {
    return `✓ Automated regression suite: land gate green at ${ranAt}: ${scopeText} passed on ${receipt.branch || 'a session branch'}${commit ? ` (commit ${commit})` : ''}; full suite runs on the desktop and in CI.`;
  }
  if (receipt.status === 'red' && isLandGateReceiptFresh(receipt, now)) {
    return `? Automated regression suite: last land gate ran RED at ${ranAt} on ${receipt.branch || 'a session branch'} and did not land, so master is unchanged; full suite runs on the desktop and in CI.`;
  }
  return `? Automated regression suite: last land gate ${receipt.status} at ${ranAt} (older than the freshness window); no current runtime proof for this build. Full suite runs on the desktop and in CI.`;
}

function formatTestsHealthRows(tests, opts = {}) {
  if (!tests || typeof tests !== 'object') {
    const receipt =
      opts.landReceipt !== undefined
        ? opts.landReceipt
        : readFreshestLandGateReceipt({ dataDir: opts.dataDir, repoRoot: opts.repoRoot });
    const landRow = formatLandGateTestsRow(receipt, opts.now || Date.now());
    return [landRow || INFORMATIONAL_TESTS_ROW];
  }
  const failed = Number(tests.failed || 0);
  if (failed > 0) {
    return summarizeTestsByCategory(tests).map((bucket) => {
      const shown = bucket.names.slice(0, 3);
      const more = Math.max(0, bucket.names.length - shown.length);
      const list = shown.length ? `: ${shown.join('; ')}${more ? `; +${more} more` : ''}` : '';
      return `✗ ${bucket.label}: ${bucket.count} failing assertion${bucket.count === 1 ? '' : 's'}${list}.`;
    });
  }
  return [
    `✓ Automated regression suite: 0 failed; ${tests.passed || 0} passed, ${tests.skipped || 0} skipped across ${tests.files || 0} files. Full suite command: ${tests.command || 'not recorded'}.`,
  ];
}

function formatTestsHealthRow(tests, opts = {}) {
  return formatTestsHealthRows(tests, opts)[0];
}

module.exports = {
  INFORMATIONAL_TESTS_ROW,
  TEST_CATEGORY_LABELS,
  artifactTimeMs,
  categoryLabelForKey,
  firstErrorLine,
  formatLandGateTestsRow,
  formatTestsHealthRow,
  formatTestsHealthRows,
  isInformationalTestsRowText,
  parseJsonFileMaybe,
  readFreshestTestsBlocked,
  summarizeFailingTests,
  summarizeTestsByCategory,
  testCategoryKey,
};
