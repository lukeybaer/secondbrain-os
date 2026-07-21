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
  return (files || []).map((f) => `<code>memory/${esc(f)}</code>`).join(' ');
}

function section(title, rows, empty) {
  if (!rows.length) return `<h2>${title}</h2><p class="dim">${empty}</p>`;
  return `<h2>${title}</h2>\n${rows.join('\n')}`;
}

function buildHtml(ctx) {
  const { runIso, scanned, clusterCount, buckets } = ctx;
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="sb-status" content="IMPLEMENTED">
<title>Memory Consolidation, ${esc(day)}</title>
<style>
  :root { --bg:#0f0f0f; --panel:#171717; --border:#2a2a2a; --text:#e6e6e6; --dim:#9a9a9a;
          --accent:#4da3ff; --green:#3ecf8e; --red:#ff5c5c; --ExampleCo:#ffb84d; }
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
  .card.warn { border-left-color:var(--ExampleCo); }
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
</div>

${section('Open questions for ExampleCo', questionRows, 'No ambiguous clusters this run.')}
${section('Actions applied this run', appliedRows, 'Nothing applied this run.')}
${section('Proposals pending approval', proposedRows, 'No pending proposals.')}
${section('Reviewed and kept distinct', distinctRows.length ? [`<ul>${distinctRows.join('\n')}</ul>`] : [], 'None reviewed as distinct this run.')}
${section('Broad theme clusters, top edges reviewed only', edgeOnlyRows.length ? [`<p class="dim">Members of these clusters were NOT individually read; only the strongest similarity edges were adjudicated. They are not counted as reviewed.</p><ul>${edgeOnlyRows.join('\n')}</ul>`] : [], 'No broad clusters this run.')}

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
  const buckets = bucketize(adj.adjudications || []);

  // Receipt provenance (Codex peer review 2b449a3f9b52): the state receipt
  // must bind to its exact inputs, not just to when the report rendered.
  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const inputHashes = { clusters: sha256(clustersRaw), adjudications: sha256(adjRaw) };
  const runId = `mcr-${day}-${sha256(inputHashes.clusters + inputHashes.adjudications).slice(0, 8)}`;
  let gitSha = null;
  try {
    gitSha = require('child_process')
      .execSync('git rev-parse HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    /* not a git checkout (tests); receipt ExampleCos null */
  }

  const reportDir = opts.reportDir || path.join(repoRoot, 'dev-plans');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `memory-consolidation-${day}.html`);
  const html = buildHtml({
    runIso,
    scanned: clusters.scanned || 0,
    clusterCount: clusters.cluster_count || 0,
    buckets,
  });
  fs.writeFileSync(reportPath, html);

  const state = {
    last_run_iso: runIso,
    run_id: runId,
    git_sha: gitSha,
    scan_generated_at: clusters.generated_at || null,
    input_hashes: inputHashes,
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

  return { reportPath, statePath, state };
}

module.exports = { writeReport, isFresh, bucketize, buildHtml };

if (require.main === module) {
  const out = writeReport({
    clustersPath: path.join(REPO, 'data', 'agent', 'memory-consolidation-clusters.json'),
    adjudicationsPath: path.join(REPO, 'data', 'agent', 'memory-consolidation-adjudications.json'),
  });
  process.stdout.write(
    `memory-consolidation-report: ${out.state.counts.applied} applied, ` +
      `${out.state.counts.proposed} proposed, ${out.state.counts.questions_open} questions -> ${out.reportPath}\n`,
  );
}
