#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO, 'data', 'life-archive', 'reviews', 'final-sequential-adversarial');
const CHECKPOINT = path.join(REPO, 'data', 'life-archive', 'current-run-checkpoint.json');
const TEMP_CWD = path.join(REPO, 'tmp-life-archive-final-review-chain');
const HEARTBEAT_MS = 30_000;
const CLAUDE_BIN = process.env.CLAUDE_BIN || (process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')
  : 'claude');

const REQUIREMENTS = `
Luke's requirement is a whole-life AWS-first archive and intelligence system, not a component patch.

The plan must cover the entire system end to end:
- AWS/S3 canonical raw archive. Local files are only cache/staging/hot index.
- Raw archive completion, ongoing flow, source health, S3 proof, search, and rebuildability for Gmail all mail/sent/attachments/OCR, SMS/iMessage, LinkedIn network posts/DMs/InMail/comments/profile context, WhatsApp, Otter transcripts/audio, Vapi/Amy calls, Codex sessions, Claude Code sessions, dispatches, prompt histories, and all relevant attachments/media.
- OCR and parsing for images, PDFs, Office docs, slides, spreadsheets, inline Gmail images, and attachments.
- Fast retrieval from Codex, Claude Code, Amy phone, Telegram, and daily briefing web link.
- Health checks by source and layer: raw, S3, index, enrichment, yesterday count, today count, blockers, 24h flow, percent complete, golden-test status, and next action.
- Transcript intelligence: understand conversations, who said what, what happened, why it matters, commitments, decisions, contradictions, projects, people, follow-ups, and provenance.
- Voice identity: consent-aware voice enrollment, diarization, speaker evidence, Luke-first enrollment, no non-Luke enrollment without explicit consent, honest not-enrolled/not-available states, Jack detection by evidence tiers.
- Smarter memory: people/projects/claims/commitments/corrections/Graphiti episodes are derived from raw archive and intelligence artifacts with provenance. Memory rebuild/population is blocked until durability/search/health/rebuildability are proven, but planning and scaffolding are not blocked.
- Retrieval must return proof, confidence, source IDs, provider URLs, S3 URIs, evidence types, and gaps.
- The system must be crash-resistant and not make Codex/Amy unusable while backfills run.
- The plan must include data models, AWS resources, source adapters, backfill and ongoing flow, enrichment pipeline, voice/person identity, retrieval/API surfaces, health/briefing, security/privacy, cost, operations, tests, rollout phases, gates, risks, and definition of done.

Known regression examples:
- BAI/ITM team-credentials Gmail thread 1987a6f469807b79 from 2025-08-05, Harvard/AUD/SUD context, inline image OCR. Do not anchor on the later spouse forward.
- Otter/Jack count failure: literal search undercounts; heuristic-only search risks false positives. Need evidence-tier counts.

Current corrected dependency:
- Archive completion gates memory rebuild/population only.
- Transcript intelligence, voice identity scaffolding, retrieval contracts, schemas, and tests proceed in parallel with archive backfill.
`.trim();

const ROUND_SPEC = {
  1: {
    author: 'Claude',
    stance: 'First-principles system architect. Start from the requirements and design the optimal end-to-end system. Do not rubber-stamp existing files.',
  },
  3: {
    author: 'Claude',
    stance: 'Adversarial principal engineer and operator. Consume reviews 1 and 2, then rebuild the whole plan with failure modes, operational reality, privacy, cost, latency, and rollout gates front and center.',
  },
};

function ensureDirs() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(TEMP_CWD, { recursive: true });
}

function loadCheckpoint() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')); } catch { return {}; }
}

function saveCheckpoint(patch) {
  const prior = loadCheckpoint();
  const next = { ...prior, ...patch, updated_at_utc: new Date().toISOString() };
  fs.mkdirSync(path.dirname(CHECKPOINT), { recursive: true });
  fs.writeFileSync(CHECKPOINT, JSON.stringify(next, null, 2) + '\n');
}

function roundPath(round, ext = 'md') {
  return path.join(OUT_DIR, `review-${String(round).padStart(2, '0')}.${ext}`);
}

function readPrior(round) {
  const parts = [];
  for (let n = 1; n < round; n += 1) {
    const file = roundPath(n, 'md');
    if (fs.existsSync(file)) {
      parts.push(`\n\n===== PRIOR FULL REVIEW ${n} =====\n${fs.readFileSync(file, 'utf8')}`);
    }
  }
  return parts.join('\n');
}

function promptForRound(round) {
  const spec = ROUND_SPEC[round];
  if (!spec) throw new Error(`No Claude spec for round ${round}`);
  return `
You are ${spec.author}, performing full-system adversarial planning review ${round} of 4.

Stance: ${spec.stance}

This is NOT a component inquiry. Produce a complete end-to-end plan for all of Luke's archive, voice identity, transcript intelligence, retrieval, health, and smarter memory requirements.

${REQUIREMENTS}

${readPrior(round)}

Required output:
1. Reiterate the interpreted full-system requirements.
2. Identify what prior plan(s) miss, overbuild, underbuild, or get wrong.
3. Produce the best full end-to-end plan from scratch, covering every required dimension.
4. Include concrete data models and AWS/resource choices.
5. Include implementation phases, gates, tests, rollback/recovery, cost/security/privacy/ops.
6. Include explicit "deltas the next reviewer must incorporate."
7. Make adversarial tradeoffs and say what should NOT be built yet.
`.trim();
}

function parseClaudeOutput(raw) {
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const result = [...entries].reverse().find((item) => item && item.type === 'result');
  if (!result || !result.result) throw new Error('Claude output did not include a result item');
  return result.result;
}

function runClaude(round, { force = false } = {}) {
  ensureDirs();
  const mdPath = roundPath(round, 'md');
  const promptPath = roundPath(round, 'prompt.txt');
  const rawPath = roundPath(round, 'raw.json');
  if (fs.existsSync(mdPath) && !force) {
    console.log(JSON.stringify({ skipped: true, round, path: mdPath }));
    return Promise.resolve();
  }
  const prompt = promptForRound(round);
  fs.writeFileSync(promptPath, prompt, 'utf8');
  saveCheckpoint({
    status: `running-final-full-review-${round}`,
    current_review_round: round,
    current_review_output: mdPath,
    current_review_prompt: promptPath,
    runner_pid: process.pid,
    last_heartbeat_at: new Date().toISOString(),
  });

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, [
      '--print',
      '--input-format', 'text',
      '--setting-sources', 'local',
      '--disable-slash-commands',
      '--tools', '',
      '--no-session-persistence',
      '--model', 'opus',
      '--effort', 'max',
      '--output-format', 'json',
      '--verbose',
    ], {
      cwd: TEMP_CWD,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let raw = '';
    const out = fs.createWriteStream(rawPath, { encoding: 'utf8' });
    const append = (chunk) => {
      const text = chunk.toString();
      raw += text;
      out.write(text);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.stdin.end(prompt);
    const heartbeat = setInterval(() => {
      saveCheckpoint({
        status: `running-final-full-review-${round}`,
        current_review_round: round,
        child_pid: child.pid,
        current_raw_output: rawPath,
        last_heartbeat_at: new Date().toISOString(),
      });
    }, HEARTBEAT_MS);
    child.on('error', (error) => {
      clearInterval(heartbeat);
      out.end();
      reject(error);
    });
    child.on('close', (code) => {
      clearInterval(heartbeat);
      out.end();
      if (code !== 0) {
        reject(new Error(`Claude review ${round} failed with exit ${code}; raw=${rawPath}`));
        return;
      }
      try {
        const text = parseClaudeOutput(raw);
        fs.writeFileSync(mdPath, text, 'utf8');
        saveCheckpoint({
          status: `completed-final-full-review-${round}`,
          last_completed_review_round: round,
          last_completed_review_path: mdPath,
          child_pid: null,
          last_heartbeat_at: new Date().toISOString(),
        });
        console.log(JSON.stringify({ completed: true, round, path: mdPath, chars: text.length }));
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function status() {
  const cp = loadCheckpoint();
  const files = [1, 2, 3, 4].map((round) => {
    const file = roundPath(round, 'md');
    return {
      round,
      exists: fs.existsSync(file),
      bytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
      path: file,
    };
  });
  console.log(JSON.stringify({
    checkpoint_status: cp.status || null,
    current_review_round: cp.current_review_round || null,
    last_completed_review_round: cp.last_completed_review_round || null,
    last_heartbeat_at: cp.last_heartbeat_at || null,
    files,
  }, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--status')) return status();
  const roundArg = args.find((a) => /^--round=/.test(a));
  if (!roundArg) throw new Error('Usage: node scripts/run-life-archive-final-review-chain.js --round=1|3 [--force] or --status');
  const round = Number(roundArg.split('=')[1]);
  if (!ROUND_SPEC[round]) throw new Error('Only Claude rounds 1 and 3 are supported by this runner');
  await runClaude(round, { force: args.includes('--force') });
}

main().catch((error) => {
  saveCheckpoint({
    status: 'final-full-review-runner-failed',
    blocker: error && error.message ? error.message : String(error),
    runner_pid: process.pid,
    last_heartbeat_at: new Date().toISOString(),
  });
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
