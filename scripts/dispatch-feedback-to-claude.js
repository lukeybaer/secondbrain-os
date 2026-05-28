#!/usr/bin/env node
/**
 * dispatch-feedback-to-claude.js
 *
 * Locked 2026-05-02 from Luke's feature ask: "all feedback should go
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
 *     without prompting Luke for each tool call.
 *   - Detached + unref so the dispatcher returns immediately.
 *   - Output piped to .tmp/diag/claude-dispatch-<id>-<ts>.log for
 *     audit (the rejection IPC's previous stdio:'ignore' was the
 *     direct cause of "did regen actually fire?" mysteries).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');

function loadJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}

function recentRejectionsFor(id, n = 5) {
  const p = path.join(REPO, 'content-review', 'rejections.jsonl');
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
  const all = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return all.filter((r) => r.id === id).slice(-n);
}

function manifestEntryFor(id) {
  const p = path.join(REPO, 'content-review', 'pending', 'manifest.json');
  const m = loadJsonSafe(p, { videos: [] });
  return (m.videos || []).find((v) => v.id === id) || null;
}

function buildPromptForVideoRejection(id, note, target) {
  const v = manifestEntryFor(id) || {};
  const recent = recentRejectionsFor(id, 5);
  const scores = v.rubric_scores || {};
  const scoresSummary = Object.entries(scores)
    .map(([k, val]) => `  ${k}: ${typeof val === 'object' ? val.score : val}`)
    .join('\n');
  const recentNotes = recent
    .map((r) => `  - [${(r.rejectedAt || '').slice(0, 19)}] (${r.target}) ${(r.note || '').slice(0, 200)}`)
    .join('\n');

  return `# Feedback dispatch: video rejection

Luke just rejected this video with the following feedback:

  id: ${id}
  title: ${v.title || '(unknown)'}
  target: ${target}
  note: ${JSON.stringify(note)}
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

7. If pass: confirm status=pending_approval in the manifest and tell Luke. If fail: investigate the gap.

DO NOT just queue a JSONL entry and exit. The whole point is that Amy actually closes the loop in this session.

Use the bypassPermissions mode you're already running in. You don't need to ask Luke for each tool call. Push to remote when done.
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

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1]; i++;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.kind || !args.id) {
    console.error('usage: dispatch-feedback-to-claude.js --kind <kind> --id <id> [--note "..."] [--target video|thumbnail] [--dry-run]');
    process.exit(2);
  }
  const prompt = buildPrompt(args);

  if (args.dryRun) {
    console.log('=== DRY RUN -- prompt that would be sent to Claude Code ===');
    console.log(prompt);
    return;
  }

  // Spawn claude --print (non-interactive) with bypassPermissions so the
  // session is autonomous. Detached so the IPC handler returns instantly.
  const tmpDir = path.join(REPO, '.tmp', 'diag');
  fs.mkdirSync(tmpDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logPath = path.join(tmpDir, `claude-dispatch-${args.id}-${ts}.log`);
  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');

  fs.appendFileSync(logPath, `=== DISPATCH ${ts} kind=${args.kind} id=${args.id} ===\n${prompt}\n=== END PROMPT, CLAUDE OUTPUT FOLLOWS ===\n`);

  const proc = spawn('claude', ['--permission-mode', 'bypassPermissions', '--print', prompt], {
    cwd: REPO,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
  });
  proc.unref();
  console.log(`spawned claude code dispatch (pid ${proc.pid}, log ${logPath})`);
}

if (require.main === module) {
  main();
}

module.exports = { buildPromptForVideoRejection };
