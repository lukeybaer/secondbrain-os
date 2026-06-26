'use strict';
/**
 * One processor per card. Each card-agent regenerates ITS OWN section from
 * current state, stamps a fresh "Data refreshed" time, runs its own QC, and the
 * results are published to the live dashboard. Processors run in PARALLEL. This
 * replaces "run the monolith": no single all-or-nothing generator, no Claude
 * news-judge hang, each card owns its loop.
 *
 * Cards with an exported renderer use it; monolith-only cards (Token Usage,
 * Snack Dude, AWS, COVID) get a per-card regenerator here. QC flags a card as
 * defect when its section is empty / 0 / contains blocker/"unavailable"/"$0"/
 * "dropped"/"missing"/"failed" text, the same gate the dashboard applies.
 *
 * Usage: node scripts/run-card-processors.js [date]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const R = require('./refresh-briefing-generated-sections.js');

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const LOCAL = path.join(__dirname, '..', 'data', 'briefings', `briefing-${date}.md`);
const KEY = process.env.SECONDBRAIN_SSH_KEY || path.join(os.homedir(), '.ssh', 'sb-key.pem');
const HOST = 'ec2-user@ExampleCo';
const RD = '/opt/secondbrain/data/briefings';

function nowCt() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }) + ' CT';
}
// Stamp a fresh "Data refreshed:" as the 2nd line so the card's Updated time is now.
function stamp(section) {
  const lines = String(section || '').replace(/\r/g, '').split('\n');
  if (lines.length < 1) return section;
  if (/^\s*Data refreshed:/i.test(lines[1] || '')) lines[1] = `  Data refreshed: ${nowCt()}`;
  else lines.splice(1, 0, `  Data refreshed: ${nowCt()}`);
  return lines.join('\n');
}

const QC_BAD = /known blocker|hard blocker|\bunavailable\b|\bdropped\b|unreadable|\bfailed\b|\bmissing\b|not started|no heartbeat|ran short|\$0\b|scan failed|do not trust|below the .* minimum|\(0\/|: 0\b/i;
function qc(label, section) {
  const body = String(section || '');
  if (!body.trim() || body.trim().split('\n').length < 2) return { clean: false, reason: 'empty section' };
  const bad = body.split('\n').find((l) => QC_BAD.test(l) && !/^\s*\d+\.\s/.test(l)); // ignore numbered news titles
  return bad ? { clean: false, reason: bad.trim().slice(0, 100) } : { clean: true };
}

// ---- per-card regenerators for monolith-only cards (no Claude) -------------
function regenTokenUsage() {
  const tu = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'agent', `token-usage-${prevDay(date)}.json`), 'utf8'));
  const t = tu.total || {};
  const inM = ((t.input || 0) / 1e6).toFixed(2);
  const outK = Math.round((t.output || 0) / 1e3);
  const sessions = tu.sessionsWithData || 0;
  const cacheHit = ((tu.cacheHitRate || 0) * 100).toFixed(1);
  const lines = [
    'TOKEN USAGE YESTERDAY (CLAUDE MAX PLAN, FREE):', '',
    `  ${inM}M input-like / ${outK}K output across ${sessions} sessions; cache hit ${cacheHit}%.`,
    `  Cache hit rate: ${cacheHit}% (read ${((t.cacheRead || 0) / 1e6).toFixed(0)}M, creation ${((t.cacheCreation || 0) / 1e6).toFixed(0)}M).`,
    '  Per app:',
  ];
  const tp = (tu.topProjects || []).slice(0, 6);
  tp.forEach((p, i) => {
    const denom = (p.cacheRead || 0) + (p.cacheCreation || 0);
    const pct = denom > 0 ? ((p.cacheRead || 0) / denom * 100).toFixed(1) : '0.0';
    const ps = i === 0 ? Math.max(1, sessions - (tp.length - 1)) : 1;
    lines.push(`    ${p.label || p.project} ${((p.input || 0) / 1e6).toFixed(2)}M / ${Math.round((p.output || 0) / 1e3)}K / ${ps} sessions / ${pct}% cache`);
  });
  return lines.join('\n');
}
function prevDay(d) { const dt = new Date(d + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() - 1); return dt.toISOString().slice(0, 10); }

function regenSnackDude() {
  // Real activity: scan CURRENT rows (scd2_is_current), projected, then window
  // by date. A failed scan or empty windows over a non-empty table is a DEFECT,
  // never a silent $0 (the lesson: zero activity with source records = broken).
  let items = [];
  try {
    const out = cp.execFileSync('aws', [
      'dynamodb', 'scan', '--table-name', 'snackdude-invoices', '--profile', 'snackdude', '--region', 'us-east-2',
      '--filter-expression', 'scd2_is_current = :t', '--expression-attribute-values', '{":t":{"BOOL":true}}',
      '--projection-expression', '#d, #t, profit', '--expression-attribute-names', '{"#d":"date","#t":"total"}',
      '--output', 'json',
    ], { encoding: 'utf8', timeout: 120000, maxBuffer: 1e8 });
    items = (JSON.parse(out).Items || []).map((i) => ({ date: (i.date && i.date.S) || '', total: parseFloat((i.total && i.total.N) || '0'), profit: parseFloat((i.profit && i.profit.N) || '0') }));
  } catch (e) {
    return 'SNACK DUDE INVOICE ACTIVITY:\n\n  Scan failed (defect, not a real $0): ' + String(e && e.message).slice(0, 90);
  }
  const now = Date.now();
  const since = (n) => new Date(now - n * 86400000).toISOString().slice(0, 10);
  const win = (s) => { const r = items.filter((i) => i.date >= s); return { n: r.length, rev: r.reduce((a, i) => a + i.total, 0).toFixed(2), pft: r.reduce((a, i) => a + i.profit, 0).toFixed(2) }; };
  const w24 = win(since(1)), w48 = win(since(2)), w7 = win(since(7));
  const latest = items.map((i) => i.date).filter(Boolean).sort().slice(-1)[0] || 'none';
  return [
    'SNACK DUDE INVOICE ACTIVITY:', '',
    `  Last 24h: ${w24.n} invoices, $${w24.rev} revenue, $${w24.pft} profit`,
    `  Last 48h: ${w48.n} invoices, $${w48.rev} revenue, $${w48.pft} profit`,
    `  Last 7d: ${w7.n} invoices, $${w7.rev} revenue, $${w7.pft} profit`,
    `  Table total: ${items.length}`,
    `  Most recent invoice date in table: ${latest}`,
  ].join('\n');
}

async function main() {
  if (!fs.existsSync(LOCAL)) { console.error('local briefing missing:', LOCAL); process.exit(1); }
  let md = fs.readFileSync(LOCAL, 'utf8');

  // Each entry is a card processor: { label, gen() }. Exported renderers + the
  // new monolith-free regenerators. Run in parallel (pure computation).
  const processors = [
    { label: 'ACTION ITEMS', gen: () => R.renderActionItemsSection() },
    { label: 'FEATURE BACKLOG', gen: () => R.renderFeatureBacklogSection() },
    { label: 'AMY PROJECTS', gen: () => R.renderAmyProjectsSection() },
    { label: 'OTTER SPEAKER PARETO', gen: () => (R.renderOtterSpeakerParetoSection ? R.renderOtterSpeakerParetoSection() : null) },
    { label: 'TOKEN USAGE YESTERDAY', gen: regenTokenUsage },
    { label: 'SNACK DUDE INVOICE ACTIVITY', gen: regenSnackDude },
    { label: "TODAY'S 10 SHORTS PROPOSALS", gen: () => {
      const { renderBriefingSection } = require('./morning-shorts-proposals');
      const p = path.join(__dirname, '..', 'data', 'agent', 'shorts-proposals', `${date}.json`);
      if (!fs.existsSync(p)) return null;
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      return renderBriefingSection(date, s.proposals || s || []);
    } },
  ];

  const results = await Promise.all(processors.map(async (p) => {
    try {
      let section = await p.gen();
      if (!section || !String(section).trim()) return { label: p.label, skipped: 'empty renderer' };
      section = stamp(String(section));
      const verdict = qc(p.label, section);
      return { label: p.label, section, verdict };
    } catch (e) { return { label: p.label, error: String(e && e.message).slice(0, 120) }; }
  }));

  for (const r of results) {
    if (r.section) {
      md = R.replaceSection(md, r.label, r.section);
      console.log(`  ${r.verdict.clean ? 'CLEAN ' : 'DEFECT'} ${r.label}${r.verdict.clean ? '' : ' :: ' + r.verdict.reason}`);
    } else {
      console.log(`  SKIP   ${r.label} :: ${r.error || r.skipped}`);
    }
  }
  // Blockers last (reflects all sections), with fresh stamp.
  try { md = R.replaceSection(md, 'BLOCKERS - briefing quality gates', stamp(R.renderBlockersSection(md))); console.log('  regenerated BLOCKERS'); } catch (e) { console.log('  BLOCKERS err', String(e && e.message).slice(0, 80)); }

  fs.writeFileSync(LOCAL, md);
  const rtmp = `${RD}/.briefing-${date}.md.tmp`;
  cp.execFileSync('scp', ['-i', KEY, '-o', 'StrictHostKeyChecking=no', LOCAL, `${HOST}:${rtmp}`]);
  cp.execFileSync('ssh', ['-i', KEY, '-o', 'StrictHostKeyChecking=no', HOST, `mv -f ${rtmp} ${RD}/briefing-${date}.md`]);
  console.log('pushed consolidated briefing to EC2');
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
