'use strict';

// Morning retrospective: model-free numbers for the night, compared with the
// night before and with a rolling normal band (core: briefing, self-heal).
// Reads existing receipts only; the one live reading is the server vitals.
// The overnight report (scripts/overnight-watch-report.js) is NOT replaced: it
// reads the receipt this module writes and shows it as evidence.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'morning-retro@1';
const BAND_NIGHTS = 14;
const MIN_HISTORY = 5;

// bad: which direction is worse. floor: smallest band half-width worth a flag.
const METRICS = {
  reds: { bad: 'high', floor: 2, label: 'Reds at delivery' },
  green_share: { bad: 'low', floor: 0.05, label: 'Green share at delivery' },
  first_pass_minutes: { bad: 'high', floor: 15, label: 'First pass length (min)' },
  close_minutes: { bad: 'high', floor: 30, label: 'Night length to close (min)' },
  capacity_waits_first_pass: { bad: 'high', floor: 50, label: 'Capacity waits, first pass' },
  tokens_total: { bad: 'high', floor: 1_000_000, label: 'Overnight tokens' },
  tokens_repair_rows: { bad: 'high', floor: 1_000_000, label: 'Tokens in repair rows' },
  shipped_unproven: { bad: 'high', floor: 1, label: 'Shipped fixes not proven live' },
  control_processes_morning: { bad: 'high', floor: 50, label: 'Control-lane processes at 5:25 AM' },
  control_processes_growth: { bad: 'high', floor: 50, label: 'Control-lane process growth overnight' },
  process_count_morning: { bad: 'high', floor: 100, label: 'Server processes at 5:25 AM' },
  swap_out_pages: { bad: 'high', floor: 2_000_000, label: 'Pages swapped out overnight' },
  live_swap_used_mib: { bad: 'high', floor: 512, label: 'Swap in use now (MiB)' },
  live_load1: { bad: 'high', floor: 1, label: 'Load average now' },
  live_open_ssh_logins: { bad: 'high', floor: 25, label: 'Open SSH logins now' },
};

function shiftDate(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // one malformed row is absent evidence, not a crash
    }
  }
  return rows;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function agentDir(dataDir) {
  return path.join(dataDir, 'agent');
}

function ctLabel(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function minutesBetween(a, b) {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 60000) : null;
}

function readControllerRuns(dataDir, date) {
  const dir = path.join(agentDir(dataDir), 'card-controller', 'runs', date);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const runs = [];
  for (const n of names) {
    const r = readJson(path.join(dir, n));
    if (r && r.mode === 'overnight' && r.startedAt) runs.push(r);
  }
  return runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

function cardCount(run) {
  const c = run?.cards;
  if (Array.isArray(c)) return c.length;
  return c && typeof c === 'object' ? Object.keys(c).length : 0;
}

function repairRowTokens(pareto) {
  const rows = {};
  for (const platform of Object.values(pareto?.platforms || {})) {
    for (const p of platform?.byProcess || []) {
      const key = String(p?.key || '');
      if (!/^(Metric|Briefing) repair:/.test(key)) continue;
      rows[key] = (rows[key] || 0) + (num(p.tokens) || 0);
    }
  }
  return rows;
}

// Shipped = distinct deployed release hashes recorded by repair attempts inside
// the night window. Proven live = some attempt on that hash cleared.
function shippedFixes(dataDir, date) {
  const startMs = Date.parse(`${date}T03:00:00Z`);
  const endMs = Date.parse(`${date}T11:30:00Z`);
  const rows = readJsonl(path.join(agentDir(dataDir), 'briefing-repair-ledger', `briefing-${date}.jsonl`));
  const byHash = new Map();
  for (const r of rows) {
    if (r?.type !== 'attempt' || !r.deployedHash) continue;
    const t = Date.parse(r.ts);
    if (!(t >= startMs && t <= endMs)) continue;
    const cur = byHash.get(r.deployedHash) || false;
    byHash.set(r.deployedHash, cur || r.qcResult === 'cleared');
  }
  const shipped = byHash.size;
  const proven = [...byHash.values()].filter(Boolean).length;
  return { present: rows.length > 0, shipped, proven, unproven: shipped - proven };
}

// Server vitals for the night from the existing 5-minute capacity samples.
function nightVitals(dataDir, date) {
  const file = path.join(agentDir(dataDir), 'overnight-capacity', 'samples', `${shiftDate(date, -1)}.jsonl`);
  const samples = readJsonl(file);
  if (!samples.length) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const lanes = (s) => s?.process_lanes || {};
  const total = (s) => Object.values(lanes(s)).reduce((a, l) => a + (num(l?.processes) || 0), 0);
  const ctrl = (s) => num(lanes(s).control?.processes);
  const pswpout = (s) => num(s?.vmstat?.pswpout);
  const loads = samples.map((s) => num(s.load1)).filter((v) => v !== null);
  const ctrlStart = ctrl(first);
  const ctrlEnd = ctrl(last);
  return {
    sampleCount: samples.length,
    startAt: first.sampled_at,
    endAt: last.sampled_at,
    controlStart: ctrlStart,
    controlEnd: ctrlEnd,
    processStart: total(first),
    processEnd: total(last),
    swapOutPages: pswpout(first) !== null && pswpout(last) !== null ? pswpout(last) - pswpout(first) : null,
    oomKills: num(last?.vmstat?.oom_kill),
    maxLoad1: loads.length ? Math.max(...loads) : null,
  };
}

function collectNightMetrics({ dataDir, date }) {
  const dir = agentDir(dataDir);
  const sources = [];
  const terminal = readJson(path.join(dir, `briefing-terminal-state-${date}.json`))?.observation;
  const notify = readJson(path.join(dir, `briefing-notify-${date}.json`));
  const pareto = readJson(path.join(dir, `token-spend-pareto-overnight-${date}.json`));
  const runs = readControllerRuns(dataDir, date);
  const vit = nightVitals(dataDir, date);
  const fixes = shippedFixes(dataDir, date);
  if (terminal) sources.push(`briefing-terminal-state-${date}.json`);
  if (notify) sources.push(`briefing-notify-${date}.json`);
  if (pareto) sources.push(`token-spend-pareto-overnight-${date}.json`);
  if (runs.length) sources.push(`card-controller/runs/${date}`);
  if (vit) sources.push(`overnight-capacity/samples/${shiftDate(date, -1)}.jsonl`);

  const firstPass = runs[0] || null;
  const cardRuns = runs.filter((r) => cardCount(r) > 5 && r.finishedAt);
  const closeAt = cardRuns.length ? cardRuns.map((r) => r.finishedAt).sort().pop() : null;
  const waits = (firstPass?.capacityRequeues || []).filter((c) => c?.reason === 'critical-capacity-full');
  const rowTokens = repairRowTokens(pareto);
  const green = num(notify?.green);
  const total = num(notify?.total);

  const metrics = {
    reds: num(terminal?.board?.redUnitCount),
    green_share: green !== null && total ? Math.round((green / total) * 1000) / 1000 : null,
    first_pass_minutes: firstPass?.finishedAt ? minutesBetween(firstPass.startedAt, firstPass.finishedAt) : null,
    close_minutes: closeAt && firstPass ? minutesBetween(firstPass.startedAt, closeAt) : null,
    capacity_waits_first_pass: firstPass ? waits.length : null,
    tokens_total: num(pareto?.combinedTokens),
    tokens_repair_rows: pareto ? Object.values(rowTokens).reduce((a, b) => a + b, 0) : null,
    shipped_unproven: fixes.present ? fixes.unproven : null,
    control_processes_morning: vit?.controlEnd ?? null,
    control_processes_growth: vit && vit.controlStart !== null && vit.controlEnd !== null ? vit.controlEnd - vit.controlStart : null,
    process_count_morning: vit?.processEnd ?? null,
    swap_out_pages: vit?.swapOutPages ?? null,
    live_swap_used_mib: null,
    live_load1: null,
    live_open_ssh_logins: null,
  };
  return {
    metrics,
    detail: {
      greenCount: green,
      greenTotal: total,
      firstPassCards: firstPass ? cardCount(firstPass) : null,
      closeAt,
      closeAtCt: ctLabel(closeAt),
      shippedFixes: fixes.shipped,
      provenLive: fixes.proven,
      repairRowTokens: Object.fromEntries(Object.entries(rowTokens).sort((a, b) => b[1] - a[1]).slice(0, 5)),
      vitals: vit,
    },
    sources,
  };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Rolling normal band: median +/- max(3 robust sigma, 20% of median, floor).
function bandFor(values, floor) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (v.length < MIN_HISTORY) return { n: v.length, ready: false };
  const med = median(v);
  const mad = median(v.map((x) => Math.abs(x - med)));
  const half = Math.max(3 * 1.4826 * mad, Math.abs(med) * 0.2, floor);
  return { n: v.length, ready: true, median: med, low: Math.max(0, med - half), high: med + half };
}

function judge(value, band, bad) {
  if (value === null || value === undefined) return 'missing';
  if (!band?.ready) return 'no-band';
  const out = bad === 'high' ? value > band.high : value < band.low;
  return out ? 'out-of-band' : 'in-band';
}

// Pure core. `accepted[key]` holds the recent normal values of that metric
// (nights flagged out of band are left out, so a long leak does not become the
// normal band). `prior` is the previous night's metrics.
function evaluate({ metrics, prior, accepted }) {
  const rows = {};
  const flags = [];
  for (const [key, spec] of Object.entries(METRICS)) {
    const value = metrics[key] ?? null;
    const band = bandFor((accepted[key] || []).slice(-BAND_NIGHTS), spec.floor);
    const status = judge(value, band, spec.bad);
    const priorValue = prior?.[key] ?? null;
    rows[key] = {
      label: spec.label,
      value,
      prior: priorValue,
      delta: value !== null && priorValue !== null ? Math.round((value - priorValue) * 1000) / 1000 : null,
      band: band.ready ? { low: Math.round(band.low * 1000) / 1000, median: band.median, high: Math.round(band.high * 1000) / 1000, n: band.n } : { n: band.n },
      status,
    };
    if (status === 'out-of-band') flags.push(key);
  }
  return { rows, flags };
}

// Walk nights oldest to newest. A flagged value is kept out of the band unless
// the metric has been flagged 7 nights running (a new normal is then adopted).
function acceptedFromHistory(history) {
  const accepted = {};
  const streak = {};
  for (const h of history) {
    const { flags } = evaluate({ metrics: h.metrics, prior: null, accepted });
    for (const key of Object.keys(METRICS)) {
      const v = h.metrics[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const flagged = flags.includes(key);
      streak[key] = flagged ? (streak[key] || 0) + 1 : 0;
      if (!flagged || streak[key] >= 7) (accepted[key] ||= []).push(v);
    }
  }
  return accepted;
}

function receiptPath(dataDir, date) {
  return path.join(agentDir(dataDir), 'morning-retro', `${date}.json`);
}

// History: a stored receipt wins; otherwise recompute from raw receipts.
function historyMetrics({ dataDir, date, nights = BAND_NIGHTS * 2 }) {
  const out = [];
  for (let i = nights; i >= 1; i--) {
    const d = shiftDate(date, -i);
    const stored = readJson(receiptPath(dataDir, d));
    if (stored?.schema === SCHEMA && stored.metrics) {
      out.push({ date: d, metrics: stored.metrics });
      continue;
    }
    const m = collectNightMetrics({ dataDir, date: d });
    if (m.sources.length) out.push({ date: d, metrics: m.metrics });
  }
  return out;
}

function parseMeminfoSwapUsedMib(text) {
  const get = (k) => {
    const m = new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text || '');
    return m ? Number(m[1]) : null;
  };
  const total = get('SwapTotal');
  const free = get('SwapFree');
  return total !== null && free !== null ? Math.round((total - free) / 1024) : null;
}

function parseLoad1(text) {
  const n = Number(String(text || '').trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? n : null;
}

// `ss -Htn state established '( sport = :22 )'` prints one line per connection.
function countLines(text) {
  return String(text || '').split('\n').filter((l) => l.trim()).length;
}

function collectLiveVitals({ read = (f) => fs.readFileSync(f, 'utf8'), run } = {}) {
  const safe = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  return {
    live_swap_used_mib: safe(() => parseMeminfoSwapUsedMib(read('/proc/meminfo'))),
    live_load1: safe(() => parseLoad1(read('/proc/loadavg'))),
    live_open_ssh_logins: safe(() => (run ? countLines(run('ss', ['-Htn', 'state', 'established', '( sport = :22 )'])) : null)),
  };
}

function buildRetro({ dataDir, date, live = {}, nowIso = new Date().toISOString() }) {
  const night = collectNightMetrics({ dataDir, date });
  Object.assign(night.metrics, live);
  const hist = historyMetrics({ dataDir, date });
  const prior = hist.find((h) => h.date === shiftDate(date, -1))?.metrics || null;
  const { rows, flags } = evaluate({ metrics: night.metrics, prior, accepted: acceptedFromHistory(hist) });
  return {
    schema: SCHEMA,
    date,
    generatedAt: nowIso,
    metrics: night.metrics,
    detail: night.detail,
    rows,
    flags,
    historyNights: hist.length,
    // The model write-up of five fixes is left manual: the Task spine ignores
    // passive briefing-origin work (explicit-request gate), so nothing queues.
    writeup: flags.length
      ? { status: 'manual-pending', reason: 'out-of-band metrics; ask for the five-fix write-up', metrics: flags }
      : { status: 'not-needed' },
    sources: night.sources,
  };
}

function writeReceipt(dataDir, retro) {
  const file = receiptPath(dataDir, retro.date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(retro, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

// Newest receipt dated on or before `date` (the report finalizes before the
// same-morning receipt exists, so it shows the latest finished night).
function readLatestRetro(dataDir, date) {
  const dir = path.join(agentDir(dataDir), 'morning-retro');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
  } catch {
    return null;
  }
  const pick = names.map((n) => n.slice(0, 10)).filter((d) => d <= date).sort().pop();
  const r = pick ? readJson(path.join(dir, `${pick}.json`)) : null;
  return r?.schema === SCHEMA ? r : null;
}

function fmt(v) {
  if (v === null || v === undefined) return 'n/a';
  return Number.isInteger(v) ? v.toLocaleString('en-US') : String(v);
}

function compactRetro(r) {
  if (!r) return null;
  return {
    date: r.date,
    flags: r.flags,
    writeup: r.writeup?.status,
    metrics: Object.fromEntries(
      Object.entries(r.rows || {}).map(([k, v]) => [k, { value: v.value, prior: v.prior, status: v.status }]),
    ),
  };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderRetroSection(r) {
  if (!r) return '';
  const out = new Set(r.flags || []);
  const body = Object.entries(r.rows || {})
    .map(([k, v]) => {
      const band = v.band?.low !== undefined ? `${fmt(v.band.low)} to ${fmt(v.band.high)}` : `needs ${MIN_HISTORY} nights`;
      const flag = out.has(k) ? ' <strong class="red">out of band</strong>' : '';
      return `<tr><td>${escapeHtml(v.label)}</td><td>${fmt(v.value)}</td><td>${fmt(v.prior)}</td><td>${band}</td><td>${v.status}${flag}</td></tr>`;
    })
    .join('');
  const note = out.size
    ? `<p>${out.size} number(s) moved outside the normal band. Ask for the five-fix write-up; it is not queued automatically.</p>`
    : '<p>Every measured number is inside its normal band.</p>';
  return `<h2>Morning retrospective numbers (night closed ${escapeHtml(r.date)})</h2>
<p class="src">Model-free, from receipts. Normal band is the last ${BAND_NIGHTS} nights. Receipt: data/agent/morning-retro/${escapeHtml(r.date)}.json</p>
${note}
<table><tr><th>Number</th><th>Tonight</th><th>Night before</th><th>Normal band</th><th>Status</th></tr>${body}</table>`;
}

module.exports = {
  SCHEMA,
  METRICS,
  BAND_NIGHTS,
  MIN_HISTORY,
  shiftDate,
  collectNightMetrics,
  bandFor,
  judge,
  evaluate,
  acceptedFromHistory,
  buildRetro,
  writeReceipt,
  receiptPath,
  readLatestRetro,
  compactRetro,
  renderRetroSection,
  collectLiveVitals,
  parseMeminfoSwapUsedMib,
  parseLoad1,
  countLines,
};
