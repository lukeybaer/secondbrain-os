'use strict';

/**
 * Durable Codex peer-review bridge.
 *
 * Claude/Amy sometimes writes a "please ask Codex" breadcrumb and a placeholder
 * input file, which looks like coordination but never produces a review. This
 * script is the repeatable bridge: read the real artifact, refuse placeholder
 * input, run the existing durable Codex runner, then write a receipt and
 * optionally upsert the result into the plan's peer-review section.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const { withCodexAmyPrelude } = require('./lib/codex-amy-prelude.js');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const DEFAULT_RESULTS = path.join(REPO, 'data', 'agent', 'codex-peer-review-results.jsonl');
const DEFAULT_PROMPT_DIR = path.join(REPO, 'data', 'agent', 'codex-peer-review-prompts');
const AUTO_START = '<!-- codex-peer-review:auto:start -->';
const AUTO_END = '<!-- codex-peer-review:auto:end -->';

function parseArgs(argv) {
  const out = { focus: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write-plan') out.writePlan = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--timeout-min') out.timeoutMin = Number(argv[++i]) || 20;
    else if (a === '--plan-file' || a === '--artifact-file') out.artifactFile = argv[++i];
    else if (a === '--results-file') out.resultsFile = argv[++i];
    else if (a === '--prompt-dir') out.promptDir = argv[++i];
    else if (a === '--runner') out.runner = argv[++i];
    else if (a === '--focus') out.focus.push(argv[++i]);
    else if (a === '--title') out.title = argv[++i];
  }
  return out;
}

function rel(p) {
  const abs = path.resolve(REPO, p);
  return path.relative(REPO, abs).replace(/\\/g, '/');
}

function looksLikePlaceholder(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (s.length < 120 && /\bplaceholder\b|\bstub\b|full findings in task prompt/i.test(s)) {
    return true;
  }
  try {
    const j = JSON.parse(s);
    const joined = JSON.stringify(j);
    if (joined.length < 180 && /\bplaceholder\b|\bstub\b|full findings in task prompt/i.test(joined)) {
      return true;
    }
  } catch {
    /* not JSON */
  }
  return false;
}

function readRealArtifact(artifactFile) {
  if (!artifactFile) throw new Error('Pass --plan-file or --artifact-file.');
  const artifactPath = path.resolve(REPO, artifactFile);
  const text = fs.readFileSync(artifactPath, 'utf8');
  if (looksLikePlaceholder(text)) {
    throw new Error(`Refusing placeholder peer-review input: ${artifactPath}`);
  }
  if (text.trim().length < 500) {
    throw new Error(`Peer-review artifact is too small to be the real plan: ${artifactPath}`);
  }
  return { artifactPath, text };
}

function buildReviewPrompt({ artifactPath, text, focus = [], title }) {
  const focusLines =
    focus && focus.length
      ? focus.map((f) => `- ${f}`).join('\n')
      : [
          '- Verify whether the plan claims are supported by source, not just prose.',
          '- Lead with bugs, behavioral regressions, missing tests, and unsafe assumptions.',
          '- Call out any path that still writes only a placeholder or waits for manual handoff.',
        ].join('\n');
  return withCodexAmyPrelude([
    'You are Amy operating through the Codex runtime, acting as an automated peer reviewer for Claude Code.',
    'Do not edit files. Inspect the repository read-only and produce review findings only.',
    '',
    `Artifact: ${rel(artifactPath)}`,
    `Review title: ${title || path.basename(artifactPath)}`,
    '',
    'Review stance:',
    '- Findings first, ordered by severity.',
    '- Cite concrete files and lines whenever possible.',
    '- Distinguish confirmed facts from inferences.',
    '- If there are no issues, say so and name residual risk.',
    '- Lifecycle note: this invocation writes its receipt after your answer returns. Review whether the code has a durable receipt path; do not flag the current run for lacking its own not-yet-written receipt.',
    '',
    'Focus:',
    focusLines,
    '',
    'Return format:',
    'VERDICT: approve | changes-required | blocked',
    'FINDINGS:',
    '- [severity] file:line - issue, impact, suggested fix',
    'OPEN QUESTIONS:',
    '- ...',
    'TESTS/RISK:',
    '- ...',
    '',
    'Artifact content follows. Use it as the starting point, but verify against source.',
    '',
    '```',
    text,
    '```',
  ].join('\n'));
}

function writePrompt(prompt, promptDir = DEFAULT_PROMPT_DIR) {
  const id = crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 12);
  fs.mkdirSync(promptDir, { recursive: true });
  const promptPath = path.join(promptDir, `codex-peer-review-${id}.md`);
  fs.writeFileSync(promptPath, prompt, 'utf8');
  return { id, promptPath };
}

function assertRealReview(review) {
  if (looksLikePlaceholder(review)) {
    throw new Error('Codex peer review returned a placeholder/stub instead of findings.');
  }
  return review;
}

function runCompanionCodexRunner({ promptPath, timeoutMin = 20, runner, spawnSyncFn = spawnSync }) {
  const runnerPath = runner ? path.resolve(REPO, runner) : path.join(REPO, 'scripts', 'codex-run.js');
  const args = [
    runnerPath,
    '--read-only',
    '--timeout-min',
    String(timeoutMin),
    '--prompt-file',
    promptPath,
  ];
  const res = spawnSyncFn(process.execPath, args, {
    cwd: REPO,
    encoding: 'utf8',
    timeout: (timeoutMin + 2) * 60 * 1000,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  if (res.error || res.status !== 0) {
    const detail = [res.error && res.error.message, res.stderr, res.stdout].filter(Boolean).join('\n');
    throw new Error(`Codex peer review failed: ${detail.slice(0, 4000)}`);
  }
  const review = String(res.stdout || '').trim();
  return assertRealReview(review);
}

function runDirectCodex({ promptPath, timeoutMin = 20, spawnSyncFn = spawnSync }) {
  const outFile = path.join(
    os.tmpdir(),
    `codex-peer-review-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  const prompt = fs.readFileSync(promptPath, 'utf8');
  const args = [
    'exec',
    '--skip-git-repo-check',
    '-s',
    'read-only',
    '--output-last-message',
    outFile,
  ];
  try {
    const res = spawnSyncFn('codex', args, {
      cwd: REPO,
      input: prompt,
      encoding: 'utf8',
      timeout: timeoutMin * 60 * 1000,
      shell: process.platform === 'win32',
      env: { ...process.env, CLAUDECODE: '' },
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    let review = '';
    try {
      review = fs.readFileSync(outFile, 'utf8').trim();
    } catch {
      review = String(res.stdout || '').trim();
    }
    if (res.error || res.status !== 0) {
      const detail = [res.error && res.error.message, res.stderr, review || res.stdout]
        .filter(Boolean)
        .join('\n');
      throw new Error(`Direct Codex peer review failed: ${detail.slice(0, 4000)}`);
    }
    return assertRealReview(review);
  } finally {
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* already gone */
    }
  }
}

function runCodexRunner(options) {
  try {
    return runCompanionCodexRunner(options);
  } catch (companionErr) {
    try {
      return runDirectCodex(options);
    } catch (directErr) {
      throw new Error(
        [
          'Codex peer review failed in both automated paths.',
          `Companion path: ${companionErr && companionErr.message ? companionErr.message : companionErr}`,
          `Direct path: ${directErr && directErr.message ? directErr.message : directErr}`,
        ].join('\n'),
      );
    }
  }
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtmlBlock({ review, ts, id }) {
  return [
    AUTO_START,
    '  <section class="callout">',
    `    <h3>Codex peer review (automated ${escapeHtml(ts)})</h3>`,
    `    <p>Receipt: <code>${escapeHtml(id)}</code>. Generated by <code>scripts/codex-peer-review.js</code> from the real plan artifact, not a placeholder handoff.</p>`,
    `    <pre style="white-space: pre-wrap">${escapeHtml(review)}</pre>`,
    '  </section>',
    AUTO_END,
  ].join('\n');
}

function upsertPlanReview(html, block) {
  const existing = new RegExp(`${AUTO_START}[\\s\\S]*?${AUTO_END}`);
  if (existing.test(html)) return html.replace(existing, block);
  const authorPreReview = html.search(/<h3>\s*Author pre-review/i);
  if (authorPreReview !== -1) {
    return `${html.slice(0, authorPreReview)}${block}\n\n${html.slice(authorPreReview)}`;
  }
  const bodyClose = html.lastIndexOf('</body>');
  if (bodyClose !== -1) {
    return `${html.slice(0, bodyClose)}${block}\n${html.slice(bodyClose)}`;
  }
  return `${html}\n${block}\n`;
}

async function runReview(opts, deps = {}) {
  const { artifactPath, text } = readRealArtifact(opts.artifactFile);
  const prompt = buildReviewPrompt({
    artifactPath,
    text,
    focus: opts.focus,
    title: opts.title,
  });
  const { id, promptPath } = writePrompt(prompt, opts.promptDir || DEFAULT_PROMPT_DIR);
  if (opts.dryRun) return { id, artifactPath, promptPath, dryRun: true };

  const runner = deps.runner || runCodexRunner;
  const review = await Promise.resolve(
    runner({
      promptPath,
      timeoutMin: opts.timeoutMin || 20,
      runner: opts.runner,
    }),
  );
  const ts = new Date().toISOString();
  const row = {
    ts,
    id,
    artifactPath: rel(artifactPath),
    promptPath: rel(promptPath),
    review,
    source: 'scripts/codex-peer-review.js',
  };
  appendJsonl(opts.resultsFile || DEFAULT_RESULTS, row);
  if (opts.writePlan) {
    const html = fs.readFileSync(artifactPath, 'utf8');
    const block = buildHtmlBlock({ review, ts, id });
    fs.writeFileSync(artifactPath, upsertPlanReview(html, block), 'utf8');
  }
  return row;
}

if (require.main === module) {
  runReview(parseArgs(process.argv.slice(2)))
    .then((row) => {
      console.log(JSON.stringify(row, null, 2));
    })
    .catch((err) => {
      console.error(err && err.message ? err.message : String(err));
      process.exit(1);
    });
}

module.exports = {
  AUTO_END,
  AUTO_START,
  buildReviewPrompt,
  looksLikePlaceholder,
  parseArgs,
  readRealArtifact,
  runCodexRunner,
  runCompanionCodexRunner,
  runDirectCodex,
  runReview,
  upsertPlanReview,
};
