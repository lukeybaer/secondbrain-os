#!/usr/bin/env node
// memory-consolidation-report.js
//
// Renders the weekly memory consolidation pass into (1) a human HTML report
// under dev-plans/ with the applied actions, pending proposals, and OPEN
// QUESTIONS for ExampleCo on ambiguous clusters, and (2) a machine state receipt
// (data/agent/memory-consolidation-state.json) that the MEMORY HYGIENE
// briefing card reads: last run time, report link, question count.
//
// Inputs:
//   clusters.json       from scripts/memory-consolidation-scan.js
//   adjudications.json  written by the consolidation session (LLM pass), one
//                       entry per cluster: verdict merge|supersede|
//                       keep_distinct|ambiguous, rationale, action, applied,
//                       question (ambiguous only).
//
// Design: dev-plans/memory-hygiene-tooling-audit-2026-07-18.html, plan step 5.
// The report never deletes anything itself; it documents what the pass did
// and asks where the pass could not decide.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildRecords, serializeRecords } = require('./build-dev-plans-records.js');
const { REVIEW_DIMENSIONS } = require('./memory-consolidation-scan.js');
const { reviewManifestSha256 } = require('./lib/memory-consolidation-evidence.js');

const REPO = path.resolve(__dirname, '..');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// The card's literal freshness boolean: did the pass run within `hours`?
function isFresh(lastRunIso, now, hours) {
  if (!lastRunIso) return false;
  const t = Date.parse(lastRunIso);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t <= hours * 3600 * 1000;
}

function bucketize(adjudications) {
  const applied = [];
  const proposed = [];
  const questions = [];
  const distinct = [];
  const edgeOnly = [];
  let qSeq = 0;
  for (const a of adjudications) {
    if (a.verdict === 'ambiguous') {
      qSeq += 1;
      questions.push({ id: `q-${String(qSeq).padStart(3, '0')}`, ...a });
    } else if (a.verdict === 'merge' || a.verdict === 'supersede') {
      (a.applied ? applied : proposed).push(a);
    } else if (a.reviewed === 'edges_only') {
      // Broad theme clusters where only the strongest edges were read.
      // Counting unread members as "reviewed and kept distinct" would
      // overstate coverage (Codex peer review 2b449a3f9b52, high finding).
      edgeOnly.push(a);
    } else {
      distinct.push(a);
    }
  }
  return { applied, proposed, questions, distinct, edgeOnly };
}

function fileList(files) {
  return (files || [])
    .map((f) => {
      const rel = String(f || '').replace(/\\/g, '/');
      return `<code>${esc(rel.includes('/') ? rel : `memory/${rel}`)}</code>`;
    })
    .join(' ');
}

function section(title, rows, empty) {
  if (!rows.length) return `<h2>${title}</h2><p class="dim">${empty}</p>`;
  return `<h2>${title}</h2>\n${rows.join('\n')}`;
}

function requireFullCoverage(coverage, evidence, reviewManifest) {
  const byDimension = new Map((coverage || []).map((entry) => [entry.dimension, entry]));
  const missing = REVIEW_DIMENSIONS.filter((dimension) => !byDimension.has(dimension));
  if (missing.length) {
    throw new Error(`missing reviewed coverage for: ${missing.join(', ')}`);
  }
  if (!evidence || evidence.schema !== 'amy.memory_consolidation_evidence.v1') {
    throw new Error('memory consolidation coverage has no structured evidence artifact');
  }
  if (evidence.status !== 'complete') {
    throw new Error(`memory consolidation evidence is not complete: ${evidence.status || 'missing'}`);
  }
  if (evidence.manifest_sha256 !== reviewManifestSha256(reviewManifest || {})) {
    throw new Error('memory consolidation evidence does not match the scan review manifest');
  }
  const checks = new Map((evidence.checks || []).map((entry) => [entry.id, entry]));
  for (const dimension of REVIEW_DIMENSIONS) {
    const entry = byDimension.get(dimension);
    if (!['verified', 'sampled'].includes(entry.status)) {
      throw new Error(`${dimension} coverage is not evidence-backed`);
    }
    const ids = Array.isArray(entry.evidence_check_ids) ? entry.evidence_check_ids : [];
    if (!ids.length) throw new Error(`${dimension} coverage has no evidence check ids`);
    for (const id of ids) {
      const proof = checks.get(id);
      if (!proof) throw new Error(`${dimension} coverage references missing evidence check ${id}`);
      if (proof.dimension !== dimension) {
        throw new Error(`${dimension} coverage references a ${proof.dimension} evidence check`);
      }
      if (Number(proof.examined) !== Number(proof.population)) {
        throw new Error(`${dimension} evidence check ${id} did not examine its declared population`);
      }
    }
  }
  return REVIEW_DIMENSIONS.map((dimension) => byDimension.get(dimension));
}

function requireCurrentClusterAdjudications(adjudications, clusters) {
  const rows = Array.isArray(adjudications) ? adjudications : [];
  const byId = new Map(rows.map((entry) => [entry.cluster_id, entry]));
  const missing = [];
  const stale = [];
  for (const cluster of clusters || []) {
    const row = byId.get(cluster.id);
    if (!row || !['full', 'edges_only'].includes(row.reviewed)) {
      missing.push(cluster.id);
      continue;
    }
    const expected = [...(cluster.files || [])].sort().join('\n');
    const actual = [...(row.files || [])].sort().join('\n');
    if (expected !== actual) stale.push(cluster.id);
  }
  if (missing.length) {
    throw new Error(`missing current cluster adjudications for: ${missing.join(', ')}`);
  }
  if (stale.length) {
    throw new Error(`stale cluster membership in adjudications for: ${stale.join(', ')}`);
  }
  return true;
}

function requireAdjudicationManifest(adjudicationManifestSha256, evidence, reviewManifest) {
  const current = reviewManifestSha256(reviewManifest || {});
  if (String(adjudicationManifestSha256 || '') !== current) {
    throw new Error('memory consolidation adjudications do not match the scan review manifest');
  }
  if (String(evidence?.manifest_sha256 || '') !== current) {
    throw new Error('memory consolidation evidence does not match the scan review manifest');
  }
  return true;
}

function requireCurrentManifestFiles(reviewManifest, repoRoot) {
  const root = path.resolve(repoRoot || REPO);
  const stale = [];
  for (const row of reviewManifest?.files || []) {
    const rel = String(row?.path || '').replace(/\\/g, '/');
    const file = path.resolve(root, rel);
    const outside = path.relative(root, file).startsWith('..') || path.isAbsolute(path.relative(root, file));
    let raw = null;
    if (!rel || outside) {
      stale.push(rel || '(missing path)');
      continue;
    }
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      stale.push(rel);
      continue;
    }
    const actual = crypto.createHash('sha256').update(raw).digest('hex');
    if (actual !== String(row.content_sha256 || '')) stale.push(rel);
  }
  if (stale.length) {
    throw new Error(
      `stale review manifest content for ${stale.length} file(s): ${stale.slice(0, 8).join(', ')}`,
    );
  }
  return true;
}

function buildHtml(ctx) {
  const { runIso, scanned, clusterCount, buckets, coverage, tokenUsage, evidence } = ctx;
  const day = runIso.slice(0, 10);
  const appliedRows = buckets.applied.map(
    (a) => `<div class="card ok"><div class="files">${fileList(a.files)}</div>
<p><strong>${esc(a.verdict)}</strong>: ${esc(a.action || a.rationale)}</p></div>`,
  );
  const proposedRows = buckets.proposed.map(
    (a) => `<div class="card warn"><div class="files">${fileList(a.files)}</div>
<p><strong>proposed ${esc(a.verdict)}</strong>: ${esc(a.action || a.rationale)}</p></div>`,
  );
  const questionRows = buckets.questions.map(
    (a) => `<div class="card ask" id="${esc(a.id)}"><div class="files">${fileList(a.files)}</div>
<p class="q"><strong>QUESTION ${esc(a.id)}:</strong> ${esc(a.question)}</p>
<p class="dim">${esc(a.rationale || '')}</p></div>`,
  );
  const distinctRows = buckets.distinct.map(
    (a) => `<li>${fileList(a.files)} <span class="dim">${esc(a.rationale || '')}</span></li>`,
  );
  const edgeOnlyRows = buckets.edgeOnly.map(
    (a) => `<li>${fileList(a.files)} <span class="dim">${esc(a.rationale || '')}</span></li>`,
  );
  const coverageRows = coverage.map((entry) => {
    const proofCount = Array.isArray(entry.evidence_check_ids) ? entry.evidence_check_ids.length : 0;
    return `<li><strong>${esc(entry.dimension)}</strong>: ${esc(entry.status)}, ${esc(entry.items_reviewed || 0)} items in scope, ${esc(proofCount)} evidence check(s)${Array.isArray(entry.finding_ids) && entry.finding_ids.length ? `, ${esc(entry.finding_ids.length)} finding(s)` : ''}</li>`;
  });
  const allOpenFindings = (evidence?.findings || []).filter((finding) => finding.status === 'open');
  const openFindings = allOpenFindings.filter((finding) => finding.severity !== 'info');
  const infoFindings = allOpenFindings.filter((finding) => finding.severity === 'info');
  const findingRows = openFindings.map(
    (finding) => `<div class="card ${finding.severity === 'red' ? 'ask' : 'warn'}"><p><strong>${esc(finding.id)}: ${esc(finding.title)}</strong></p><p>${esc(finding.summary || '')}</p><div class="files">${fileList((finding.files || []).map((file) => file.replace(/^memory\//, '')))}</div></div>`,
  );
  const infoRows = infoFindings.map(
    (finding) => `<div class="card"><p><strong>${esc(finding.id)}: ${esc(finding.title)}</strong></p><p>${esc(finding.summary || '')}</p></div>`,
  );
  const tokenLine = tokenUsage
    ? tokenUsage.measurement_status === 'unavailable'
      ? `Unavailable for this run: ${esc(tokenUsage.reason || 'the interactive runtime did not expose a task-scoped token receipt')}. No prior-run token count was reused.`
      : `${esc(tokenUsage.total_tokens)} total: ${esc(tokenUsage.input_tokens)} input, ${esc(tokenUsage.cached_input_tokens)} cached input, ${esc(tokenUsage.output_tokens)} output (${esc(tokenUsage.provider)}${tokenUsage.model ? `, ${esc(tokenUsage.model)}` : ''}). Accounting basis: ${esc(tokenUsage.total_definition || 'provider-reported input plus output; inspect the receipt for cache semantics')}.`
    : 'Measurement pending wrapper closure.';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="sb-status" content="IMPLEMENTED">
<title>Memory Consolidation, ${esc(day)}</title>
<style>
  :root { --bg:#0f0f0f; --panel:#171717; --border:#2a2a2a; --text:#e6e6e6; --dim:#9a9a9a;
          --accent:#4da3ff; --green:#3ecf8e; --red:#ff5c5c; --amber:#ffb84d; }
  * { box-sizing: border-box; }
  body { background:var(--bg); color:var(--text); font-family:'Segoe UI',system-ui,sans-serif;
         margin:0; padding:2rem 1rem; line-height:1.55; }
  .wrap { max-width: 940px; margin: 0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .2rem; }
  h2 { font-size:1.15rem; margin:2rem 0 .6rem; border-bottom:1px solid var(--border); padding-bottom:.3rem; }
  .meta { color:var(--dim); font-size:.85rem; margin-bottom:1.4rem; }
  .stats { display:flex; gap:1rem; flex-wrap:wrap; margin:1rem 0 1.5rem; }
  .stat { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:.6rem 1rem; }
  .stat b { font-size:1.3rem; display:block; }
  .card { background:var(--panel); border:1px solid var(--border); border-left-width:4px;
          border-radius:8px; padding: .8rem 1rem; margin:.6rem 0; }
  .card.ok { border-left-color:var(--green); }
  .card.warn { border-left-color:var(--amber); }
  .card.ask { border-left-color:var(--accent); }
  .files code { background:#222; border:1px solid var(--border); border-radius:4px;
                padding:.05rem .35rem; font-size:.8em; margin-right:.35rem; word-break:break-all; }
  .q { margin:.5rem 0 .2rem; }
  .dim { color:var(--dim); }
  ul { padding-left:1.2rem; } li { margin:.35rem 0; }
  p { margin:.4rem 0; }
</style>
</head>
<body>
<div class="wrap">
<h1>Memory Consolidation Pass</h1>
<div class="meta">${esc(runIso)} &middot; weekly semantic pass over the Tier-2 memory corpus &middot; scanner: tf-idf candidate clustering, adjudication: LLM &middot; nothing is hard-deleted, superseded content is archived with markers</div>

<div class="stats">
  <div class="stat"><b>${scanned}</b>files scanned</div>
  <div class="stat"><b>${clusterCount}</b>candidate clusters</div>
  <div class="stat"><b>${buckets.applied.length}</b>actions applied</div>
  <div class="stat"><b>${buckets.proposed.length}</b>proposals pending</div>
  <div class="stat"><b>${buckets.questions.length}</b>open questions</div>
  <div class="stat"><b>${openFindings.length}</b>actionable evidence findings</div>
  <div class="stat"><b>${infoFindings.length}</b>information notes</div>
</div>

${section('Actionable evidence findings', findingRows, 'No unresolved red or yellow evidence findings.')}
${section('Informational observations', infoRows, 'No informational observations.')}
${section('Open questions for ExampleCo', questionRows, 'No ambiguous clusters this run.')}
${section('Actions applied this run', appliedRows, 'Nothing applied this run.')}
${section('Proposals pending approval', proposedRows, 'No pending proposals.')}
${section('Reviewed and kept distinct', distinctRows.length ? [`<ul>${distinctRows.join('\n')}</ul>`] : [], 'None reviewed as distinct this run.')}
${section('Broad theme clusters, top edges reviewed only', edgeOnlyRows.length ? [`<p class="dim">Members of these clusters were NOT individually read; only the strongest similarity edges were adjudicated. They are not counted as reviewed.</p><ul>${edgeOnlyRows.join('\n')}</ul>`] : [], 'No broad clusters this run.')}

<h2>Full-corpus review coverage</h2>
<p class="dim">Coverage is accepted only when each claim names a hash-bound mechanical or sampled evidence check over the declared population. A manifest count alone is not review evidence.</p>
<ul>${coverageRows.join('\n')}</ul>

<h2>Measured subscription CLI tokens</h2>
<p>${tokenLine}</p>

</div>
</body>
</html>
`;
}

function writeReport(opts) {
  const now = opts.now ? opts.now() : new Date();
  const runIso = now.toISOString();
  const day = runIso.slice(0, 10);
  const repoRoot = opts.repoRoot || REPO;

  const clustersRaw = fs.readFileSync(opts.clustersPath, 'utf8');
  const adjRaw = fs.readFileSync(opts.adjudicationsPath, 'utf8');
  const clusters = JSON.parse(clustersRaw);
  const adj = JSON.parse(adjRaw);
  if (!opts.evidencePath || !fs.existsSync(opts.evidencePath)) {
    if (!Array.isArray(adj.coverage) || !adj.coverage.length) {
      requireFullCoverage(adj.coverage, null, clusters.review_manifest);
    }
    throw new Error('memory consolidation report requires a hash-bound evidence artifact');
  }
  const evidenceRaw = fs.readFileSync(opts.evidencePath, 'utf8');
  const evidence = JSON.parse(evidenceRaw);
  requireCurrentManifestFiles(clusters.review_manifest, repoRoot);
  requireAdjudicationManifest(adj.review_manifest_sha256, evidence, clusters.review_manifest);
  requireCurrentClusterAdjudications(adj.adjudications || [], clusters.clusters || []);
  const buckets = bucketize(adj.adjudications || []);
  const coverage = requireFullCoverage(adj.coverage, evidence, clusters.review_manifest);
  let tokenUsage = null;
  if (opts.tokenUsagePath && fs.existsSync(opts.tokenUsagePath)) {
    tokenUsage = JSON.parse(fs.readFileSync(opts.tokenUsagePath, 'utf8'));
  }

  // Receipt provenance (Codex peer review 2b449a3f9b52): the state receipt
  // must bind to its exact inputs, not just to when the report rendered.
  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const inputHashes = {
    clusters: sha256(clustersRaw),
    adjudications: sha256(adjRaw),
    evidence: sha256(evidenceRaw),
  };
  const runId = `mcr-${day}-${sha256(inputHashes.clusters + inputHashes.adjudications + inputHashes.evidence).slice(0, 8)}`;
  let gitSha = null;
  try {
    gitSha = require('child_process')
      .execSync('git rev-parse HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    /* not a git checkout (tests); receipt carries null */
  }

  const reportDir = opts.reportDir || path.join(repoRoot, 'dev-plans');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `memory-consolidation-${day}.html`);
  const html = buildHtml({
    runIso,
    scanned: clusters.scanned || 0,
    clusterCount: clusters.cluster_count || 0,
    buckets,
    coverage,
    tokenUsage,
    evidence,
  });
  fs.writeFileSync(reportPath, html);

  // Regenerate dev-plans/records.json so the land gate test (dev-plans-index.test.js)
  // passes without a stale-records failure. The HTML report is a dev-plans/*.html so
  // adding it without regenerating records.json causes that test to fail, which in turn
  // causes the first land attempt to run a rebase that modifies INDEX.md, permanently
  // blocking all subsequent promotion retries via the verifySnapshot file-hash check.
  const recordsPath = path.join(reportDir, 'records.json');
  try {
    fs.writeFileSync(recordsPath, serializeRecords(buildRecords(reportDir)));
  } catch (recordsErr) {
    process.stderr.write(
      `[memory-consolidation-report] warning: could not regenerate records.json: ${recordsErr.message}\n`,
    );
  }

  const state = {
    last_run_iso: runIso,
    run_id: runId,
    git_sha: gitSha,
    scan_generated_at: clusters.generated_at || null,
    input_hashes: inputHashes,
    review_coverage: coverage,
    evidence_summary: {
      checks: Array.isArray(evidence.checks) ? evidence.checks.length : 0,
      open_red: (evidence.findings || []).filter(
        (finding) => finding.status === 'open' && finding.severity === 'red',
      ).length,
      open_yellow: (evidence.findings || []).filter(
        (finding) => finding.status === 'open' && finding.severity === 'yellow',
      ).length,
      open_info: (evidence.findings || []).filter(
        (finding) => finding.status === 'open' && finding.severity === 'info',
      ).length,
      manifest_sha256: evidence.manifest_sha256,
    },
    open_findings: (evidence.findings || [])
      .filter((finding) => finding.status === 'open' && finding.severity !== 'info')
      .map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
        count: finding.count,
        files: finding.files,
        summary: finding.summary,
      })),
    token_usage: tokenUsage,
    report_relpath: path.relative(repoRoot, reportPath).replace(/\\/g, '/'),
    counts: {
      scanned: clusters.scanned || 0,
      clusters: clusters.cluster_count || 0,
      adjudicated: (adj.adjudications || []).length,
      applied: buckets.applied.length,
      proposed: buckets.proposed.length,
      questions_open: buckets.questions.length,
      keep_distinct: buckets.distinct.length,
      edge_reviewed_only: buckets.edgeOnly.length,
      // A file can sit in a broad hub and in its oversized sub-cluster; count
      // each skimmed file once.
      edge_reviewed_only_files: new Set(
        buckets.edgeOnly.flatMap((a) => (Array.isArray(a.files) ? a.files : [])),
      ).size,
    },
    actions: buckets.applied.map((a) => ({
      id: a.cluster_id || a.id || '',
      verdict: a.verdict || '',
      summary: a.action || a.rationale || '',
      files: Array.isArray(a.files) ? a.files : [],
    })),
    questions: buckets.questions.map((q) => ({
      id: q.id,
      question: q.question,
      files: q.files,
      rationale: q.rationale || '',
    })),
  };
  const statePath =
    opts.statePath || path.join(repoRoot, 'data', 'agent', 'memory-consolidation-state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

  return { reportPath, statePath, recordsPath, state };
}

module.exports = {
  writeReport,
  isFresh,
  bucketize,
  buildHtml,
  requireFullCoverage,
  requireCurrentClusterAdjudications,
  requireAdjudicationManifest,
  requireCurrentManifestFiles,
};

if (require.main === module) {
  const out = writeReport({
    clustersPath: path.join(REPO, 'data', 'agent', 'memory-consolidation-clusters.json'),
    adjudicationsPath: path.join(REPO, 'data', 'agent', 'memory-consolidation-adjudications.json'),
    evidencePath: path.join(REPO, 'data', 'agent', 'memory-consolidation-evidence.json'),
    tokenUsagePath: path.join(REPO, 'data', 'agent', 'memory-consolidation-token-usage.json'),
  });
  process.stdout.write(
    `memory-consolidation-report: ${out.state.counts.applied} applied, ` +
      `${out.state.counts.proposed} proposed, ${out.state.counts.questions_open} questions -> ${out.reportPath}\n`,
  );
}
