#!/usr/bin/env node
/**
 * dispatch-feedback-to-claude.js
 *
 * Locked 2026-05-02 from ExampleCo's feature ask: "all feedback should go
 * through claude code sessions, not some videos only mode."
 *
 * The pre-2026-05-02 flow handled video rejections via a Node script
 * (auto-regen-rejected-videos.js) and a JS audit (process-rejection-
 * into-rubric.js). That flow:
 *   - was video-specific (no thumbnail, briefing, content-pipeline,
 *     etc. handling)
 *   - couldn't build new analyzers when the rubric had no detector
 *     for the rejection signal (the audit only logged a JSONL entry)
 *   - kept producing the same broken video four times in a row when
 *     the rubric had no thumbnail-first-frame check
 *
 * This dispatcher routes EVERY feedback signal (any artifact type)
 * through a Claude Code session that can:
 *   - read the manifest, rubric scores, recent rejection history
 *   - decide whether to fix the build pipeline, build a new rubric
 *     analyzer, lower a threshold, or escalate
 *   - actually do the work in the same session (build, commit, push)
 *   - regen + score + promote when the rubric clears
 *
 * Triggered by:
 *   - empire:rejectVideo IPC handler (alongside the existing flow
 *     while we migrate)
 *   - any other feedback channel that wants Claude-led handling
 *
 * Usage:
 *   node scripts/dispatch-feedback-to-claude.js \
 *     --kind video-rejection \
 *     --id ai_agent_income_formula \
 *     --note "awkward silence at the beginning"
 *
 *   --dry-run prints the prompt that would be sent without spawning.
 *
 * Spawn semantics:
 *   - claude --print (non-interactive) so the session is autonomous.
 *   - --permission-mode bypassPermissions so Amy can edit/commit
 *     without prompting ExampleCo for each tool call.
 *   - The worker launches this dispatcher as a detached process. Inside this
 *     process, provider children stay referenced until exit so the fallback
 *     callback and output capture cannot disappear early.
 *   - Output piped to .tmp/diag/claude-dispatch-<id>-<ts>.log for
 *     audit (the rejection IPC's previous stdio:'ignore' was the
 *     direct cause of "did regen actually fire?" mysteries).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { buildClaudeCliEnv } = require('./lib/cli-output-guard.js');
const { claudeCliPins, codexExecPins, decideSpawnModel } = require('./lib/model-router.js');
// 2026-06-11 universal LLM ladder: non-authorized feedback falls back to a
// read-only Codex audit. A rejected video is different: ExampleCo explicitly asked
// for a change, so a failed Claude provider may fall through to a full Codex
// production session without widening the authorization.
const { askAI } = require('./lib/ask-ai.js');

const REPO = path.resolve(__dirname, '..');

function loadJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function recentRejectionsFor(id, n = 5) {
  const p = path.join(REPO, 'content-review', 'rejections.jsonl');
  if (!fs.existsSync(p)) return [];
  const lines = fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  const all = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return all.filter((r) => r.id === id).slice(-n);
}

function manifestEntryFor(id) {
  const p = path.join(REPO, 'content-review', 'pending', 'manifest.json');
  const m = loadJsonSafe(p, { videos: [] });
  return (m.videos || []).find((v) => v.id === id) || null;
}

function rejectionIsOpen(id) {
  const entry = manifestEntryFor(id);
  return Boolean(
    entry && (entry.video_needs_regen === true || entry.thumbnail_needs_regen === true),
  );
}

function rejectionRevision(entry = {}, target = 'video') {
  const stamp =
    target === 'thumbnail'
      ? entry.thumbnail_rejected_at || entry.rejected_at
      : entry.video_rejected_at || entry.rejected_at;
  return String(stamp || '').trim() || null;
}

function latestFeedbackText(note) {
  const raw = String(note || '').trim();
  if (!raw) return '';
  const marker = 'LATEST (this round):';
  const ix = raw.lastIndexOf(marker);
  return ix >= 0 ? raw.slice(ix + marker.length).trim() : raw;
}

function buildPromptForVideoRejection(id, note, target) {
  const v = manifestEntryFor(id) || {};
  const recent = recentRejectionsFor(id, 5);
  const latestNote = latestFeedbackText(
    note || v.video_rejection_note || recent[recent.length - 1]?.note || '',
  );
  const scores = v.rubric_scores || {};
  const scoresSummary = Object.entries(scores)
    .map(([k, val]) => `  ${k}: ${typeof val === 'object' ? val.score : val}`)
    .join('\n');
  const recentNotes = recent
    .map(
      (r) =>
        `  - [${String(r.rejectedAt || r.rejected_at || r.ts || '').slice(0, 19)}] (${r.target}) ${(r.note || '').slice(0, 1000)}`,
    )
    .join('\n');

  return `# Feedback dispatch: video rejection

ExampleCo just rejected this video with the following feedback:

  id: ${id}
  title: ${v.title || '(unknown)'}
  target: ${target}
  note: ${JSON.stringify(latestNote)}
  rejectedAt: ${new Date().toISOString()}

## Manifest state

  status: ${v.status}
  rubric_overall_score: ${v.rubric_overall_score}
  rubric_virality_score: ${v.rubric_virality_score}
  video_file: content-review/pending/${v.video_file || id + '.mp4'}
  thumbnail_file: content-review/pending/${v.thumbnail_file || id + '_thumb.jpg'}
  transcript_file: ${v.transcript_file ? 'content-review/pending/' + v.transcript_file : '(none)'}

## Most recent rubric scores

${scoresSummary || '  (none -- rubric has not scored this build)'}

## Recent rejection history (last 5)

${recentNotes || '  (no prior rejections)'}

## Your job

Follow the workflow in memory/feedback_rejection_audit_must_build_the_analyzer.md:

1. Classify the rejection note into a defect bucket. Read scripts/process-rejection-into-rubric.js DEFECT_BUCKETS for the existing buckets.

2. Decide:
   a. If an existing rubric tool should have caught this and it scored low, the threshold needs to be raised in data/agent/video-quality-thresholds.json.
   b. If an existing rubric tool should have caught this but scored high, the tool's detection logic is too lax -- tighten it.
   c. If NO existing rubric tool catches this, build a new one (analyze-<criterion>.py), wire it into run-quality-check-fast.py, add a threshold, AND fix the build pipeline if needed.

3. Add a regression test under src/main/__tests__/ that locks the new rubric tool / threshold / build constant.

4. Commit + push.

5. Reset state (video_needs_regen=true) and trigger regen via:
   node scripts/auto-regen-rejected-videos.js --id ${id}

6. Verify the new rubric scoring clears all thresholds.

7. If pass: confirm status=pending_approval in the manifest and tell ExampleCo. If fail: investigate the gap.

DO NOT just queue a JSONL entry and exit. The whole point is that Amy actually closes the loop in this session.

If the generic renderer failed closed because it cannot preserve authentic-source footage, approved audio, source-cut narration, or another approved production layer, do not weaken that gate and do not retry the stock renderer. Read skills/work/video-production/SKILL.md and its required learning preflight, then use the full production workflow to revise the actual source-based film. Preserve every approved layer, address the latest unresolved feedback, issue fresh SHA-bound release receipts for the exact final bytes, return the item to pending_approval, and verify the deduplicated Telegram completion acknowledgement.

Use the bypassPermissions mode you're already running in. You don't need to ask ExampleCo for each tool call. Push to remote when done.
`;
}

function buildPrompt(args) {
  switch (args.kind) {
    case 'video-rejection':
      return buildPromptForVideoRejection(args.id, args.note, args.target || 'video');
    default:
      return `# Feedback dispatch: ${args.kind}\n\nid: ${args.id}\nnote: ${JSON.stringify(args.note)}\n\nNo specialized handler for kind=${args.kind} yet. Read the rejection note, decide on the right workflow, and execute it.\n`;
  }
}

// Wrap the dispatch prompt for the codex fallback rung. The codex rung is
// read-only by contract: it produces a rubric-audit TEXT recorded to the
// dispatch log, never an autonomous code change, commit, push, or regen.
function codexAuditPrompt(prompt) {
  return [
    prompt,
    '',
    'IMPORTANT OVERRIDE: you are running as the READ-ONLY Codex fallback rung',
    '(the Claude Code session could not be spawned). Do NOT modify code, do',
    'NOT commit, push, regen, or take any autonomous action. Produce a',
    'rubric-audit TEXT ONLY: classify the rejection into a defect bucket, say',
    'which rubric tool or threshold should have caught it, and list the',
    'concrete follow-ups a later Claude session should execute.',
  ].join('\n');
}

function codexWorkPrompt(prompt) {
  return [
    prompt,
    '',
    'IMPORTANT OVERRIDE: you are the FULL PRODUCTION FALLBACK for an open',
    'video rejection after the first provider was unavailable. This is an',
    'authorized change request, not a read-only audit. Work autonomously until',
    'the requested edit is regenerated, verified, and returned to pending_approval.',
    'Read skills/work/video-production/SKILL.md completely and complete its',
    'required LEARNINGS.md preflight before any media action. Preserve authentic-source lineage',
    'and approved audio, script, music, or visual layers unless the latest',
    'feedback explicitly changes them. Never route an authentic-source rejection',
    'back through the generic stock renderer or weaken a fail-closed quality gate.',
    'Use an isolated worktree or production directory, keep the current good MP4',
    'until replacement passes, and finish the SHA-bound text-fit, QA, promotion,',
    'and one-per-video-plus-SHA Telegram acknowledgement gates. If the automation',
    'itself is the blocker, fix and test that automation, deploy it, then retrigger',
    'the official automatic regeneration path. Do not stop at a diagnosis.',
    'On EC2, use /home/ec2-user/secondbrain-current only as the Git source checkout.',
    'The live runtime, queue, manifest, and pending artifacts are under /opt/secondbrain;',
    'inspect and promote against that live state rather than a stale checkout copy.',
  ].join('\n');
}

function shouldEscalateToCodexWork(exitCode, output) {
  if (Number(exitCode) !== 0) return true;
  return /out of (?:extra )?usage|usage limit|rate limit|resets? (?:at|on|tomorrow)|authentication (?:failed|required)|not logged in|subscription.*(?:exhausted|unavailable)/i.test(
    String(output || ''),
  );
}

function codexWorkspaceRoot() {
  const candidates = [
    process.env.SECONDBRAIN_SOURCE_ROOT,
    '/home/ec2-user/secondbrain-current',
    REPO,
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, '.git'))) || REPO;
}

function captureChild(child, logPath, onClose) {
  let transcript = '';
  let closed = false;
  const append = (chunk) => {
    const text = String(chunk || '');
    if (!text) return;
    fs.appendFileSync(logPath, text);
    transcript = (transcript + text).slice(-512 * 1024);
  };
  if (child.stdout) child.stdout.on('data', append);
  if (child.stderr) child.stderr.on('data', append);
  child.once('close', (code, signal) => {
    if (closed) return;
    closed = true;
    onClose(code, signal, transcript);
  });
}

function spawnCodexWork(prompt, logPath, deps = {}) {
  const spawnFn = deps.spawnFn || spawn;
  const workspaceRoot = deps.workspaceRoot || codexWorkspaceRoot();
  const modelDecision = deps.modelDecision || decideSpawnModel('dispatch-feedback-to-claude', 'codex', {
    taskType: 'repair-code',
    ownerVideoWork: true,
  });
  fs.appendFileSync(
    logPath,
    '\n=== CLAUDE PROVIDER UNAVAILABLE; CODEX FULL PRODUCTION FALLBACK ===\n',
  );
  const child = spawnFn(
    'codex',
    [
      'exec',
      ...codexExecPins(modelDecision, {
        env: deps.env || process.env,
        ledgerPath: deps.ledgerPath,
      }),
      '--ephemeral',
      '--dangerously-bypass-approvals-and-sandbox',
      '--cd',
      workspaceRoot,
      '--skip-git-repo-check',
      '--json',
      '-',
    ],
    {
      cwd: workspaceRoot,
      detached: true,
      windowsHide: true,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.once('spawn', () => {
    console.log(`spawned codex full production fallback (pid ${child.pid}, log ${logPath})`);
  });
  child.once('error', (e) => {
    fs.appendFileSync(logPath, `\n=== CODEX FULL FALLBACK SPAWN FAILED: ${e.message} ===\n`);
  });
  captureChild(child, logPath, (code, signal) => {
    fs.appendFileSync(
      logPath,
      `\n=== CODEX FULL FALLBACK EXIT code=${code} signal=${signal || ''} ===\n`,
    );
  });
  if (child.stdin) {
    child.stdin.on?.('error', (e) => {
      fs.appendFileSync(logPath, `\n=== CODEX PROMPT PIPE FAILED: ${e.message} ===\n`);
    });
    child.stdin.end(codexWorkPrompt(prompt));
  }
  return child;
}

// Codex read-only rubric audit, recorded to the SAME dispatch log the claude
// session would have written. Returns true when an audit was recorded.
// deps is a test seam: { askAIFn }.
async function codexRubricAudit(prompt, logPath, deps = {}) {
  const ladder = deps.askAIFn || askAI;
  let out = null;
  try {
    out = await ladder(codexAuditPrompt(prompt), {
      surface: 'dispatch-feedback-to-claude',
      rungOrder: ['codex'],
      silent: true,
    });
  } catch {
    out = null;
  }
  if (out && out.text) {
    fs.appendFileSync(
      logPath,
      `\n=== CODEX RUBRIC AUDIT (read-only fallback rung; no autonomous changes) ===\n${out.text}\n`,
    );
    return true;
  }
  fs.appendFileSync(logPath, '\n=== CODEX RUNG ALSO FAILED; no audit recorded ===\n');
  return false;
}

function parseArgs(argv) {
  const out = { dryRun: false, onlyIfOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--only-if-open') out.onlyIfOpen = true;
    else if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.kind || !args.id) {
    console.error(
      'usage: dispatch-feedback-to-claude.js --kind <kind> --id <id> [--note "..."] [--target video|thumbnail] [--dry-run]',
    );
    process.exit(2);
  }
  const manifestEntry = args.kind === 'video-rejection' ? manifestEntryFor(args.id) : null;
  if (args.onlyIfOpen) {
    if (!manifestEntry) {
      console.error(`feedback manifest entry not found for ${args.id}; refusing blind escalation`);
      process.exitCode = 1;
      return;
    }
    if (manifestEntry.video_needs_regen !== true && manifestEntry.thumbnail_needs_regen !== true) {
      console.log(`feedback already resolved for ${args.id}; agentic escalation not needed`);
      return;
    }
    if (
      args.revision &&
      rejectionRevision(manifestEntry, args.target || 'video') !== args.revision
    ) {
      console.log(
        `feedback revision ${args.revision} was superseded for ${args.id}; stale dispatch not started`,
      );
      return;
    }
  }
  const prompt = buildPrompt(args);

  if (args.dryRun) {
    console.log('=== DRY RUN -- prompt that would be sent to Claude Code ===');
    console.log(prompt);
    return;
  }

  // Spawn claude --print (non-interactive) with bypassPermissions so the
  // session is autonomous. The outer worker detached this dispatcher already;
  // keep this child referenced until close so provider exhaustion reliably
  // descends to the Codex production rung.
  const tmpDir = path.join(REPO, '.tmp', 'diag');
  fs.mkdirSync(tmpDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logPath = path.join(tmpDir, `claude-dispatch-${args.id}-${ts}.log`);
  fs.appendFileSync(
    logPath,
    `=== DISPATCH ${ts} kind=${args.kind} id=${args.id} ===\n${prompt}\n=== END PROMPT, CLAUDE OUTPUT FOLLOWS ===\n`,
  );

  // MODEL ROUTING. This spawn passed no model and no effort, so it inherited the
  // account's most expensive default.
  // Classification, honest: the prompt this dispatcher builds is a code job. It
  // tells the session to tighten or build a rubric analyzer, wire it into the
  // quality pipeline, add a regression test, commit, push, and re-verify. That
  // is TASK_TIER 'repair-code'. No signal is invented: the work is fixed by the
  // prompt this file writes, not by the rejection note it carries.
  const proc = spawn(
    'claude',
    [
      ...claudeCliPins(
        decideSpawnModel('dispatch-feedback-to-claude', 'claude', {
          taskType: 'repair-code',
          // ExampleCo 2026-09-23: a video he rejected in the UI runs the owner video
          // route (model-router.js OWNER_VIDEO_CLAUDE_ROUTE).
          ownerVideoWork: args.kind === 'video-rejection',
        }),
      ),
      '--permission-mode',
      'bypassPermissions',
      '--print',
      prompt,
    ],
    {
      cwd: REPO,
      detached: true,
      windowsHide: true,
      env: buildClaudeCliEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // On spawn failure (CLI, usage, or auth), descend to the authorized full
  // Codex lane for video rejections and retain the read-only audit for other
  // feedback. Do not unref this provider: doing so lets Node exit before the
  // close callback can inspect a zero-exit usage-limit message.
  let fallbackStarted = false;
  const startFallback = (reason) => {
    if (fallbackStarted) return;
    fallbackStarted = true;
    fs.appendFileSync(logPath, `\n=== CLAUDE PROVIDER FAILED: ${reason} ===\n`);
    if (args.kind === 'video-rejection') {
      spawnCodexWork(prompt, logPath);
      return;
    }
    codexRubricAudit(prompt, logPath).catch(() => {});
  };
  proc.once('spawn', () => {
    console.log(`spawned claude code dispatch (pid ${proc.pid}, log ${logPath})`);
  });
  proc.once('error', (e) => {
    startFallback(`spawn error: ${e.message}`);
  });
  captureChild(proc, logPath, (code, signal, output) => {
    fs.appendFileSync(logPath, `\n=== CLAUDE EXIT code=${code} signal=${signal || ''} ===\n`);
    if (shouldEscalateToCodexWork(code, output)) {
      startFallback(`exit=${code}; provider output indicated unavailable usage or auth`);
    } else if (args.kind === 'video-rejection' && rejectionIsOpen(args.id)) {
      startFallback(`exit=${code}; provider returned but the rejection is still open`);
    }
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  buildPromptForVideoRejection,
  codexAuditPrompt,
  codexRubricAudit,
  codexWorkPrompt,
  shouldEscalateToCodexWork,
  spawnCodexWork,
  latestFeedbackText,
  codexWorkspaceRoot,
  rejectionIsOpen,
};
