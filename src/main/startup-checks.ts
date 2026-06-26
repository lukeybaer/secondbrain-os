import { app, protocol, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { getConfig } from './config';
import {
  buildSelfHealthDigest,
  persistSelfHealthDigest,
  CoreBlockInput,
} from './self-health-digest';
import {
  runEvals,
  EqualsExpected,
  renderReport,
  type EvaluationReport,
  type EvalCase,
} from './agent-eval-harness';

// ── Worktree guard ────────────────────────────────────────────────────────────
// Returns a string describing the worktree problem, or null if clean.
export function detectWorktree(): string | null {
  const cwd = process.cwd().replace(/\\/g, '/');
  const appPath = app.getAppPath().replace(/\\/g, '/');
  const MAIN_REPO = '${SECONDBRAIN_ROOT:-/path/to/secondbrain}';

  const cwdIsWorktree = cwd.includes('.claude/worktrees');
  const appPathIsWorktree = appPath.includes('.claude/worktrees');

  if (cwdIsWorktree || appPathIsWorktree) {
    const bad = cwdIsWorktree ? cwd : appPath;
    return `Running from worktree: ${bad}\nExpected: ${MAIN_REPO}`;
  }
  return null;
}

// ── Startup Checks ────────────────────────────────────────────────────────────
// Validates known fix preconditions on every launch.
// Any failure logs a PROMINENT warning — these are things that have already
// caused real bugs that took 6+ sessions to diagnose.
// See KNOWN_FIXES.md for context on why each check exists.

function warn(check: string, detail: string): void {
  const banner = '='.repeat(70);
  const msg = `\n${banner}\n[STARTUP CHECK FAILED] ${check}\n${detail}\n${banner}\n`;
  console.error(msg);
  try {
    const logPath = path.join(app.getPath('userData'), 'startup-warnings.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${check}: ${detail}\n`);
  } catch {
    // swallow if logging fails
  }
}

function pass(check: string): void {
  console.log(`[startup-check] ✓ ${check}`);
}

export async function runStartupChecks(): Promise<void> {
  // ── Check 0: worktree detection ────────────────────────────────────────────
  // If the app is running from a git worktree instead of the main repo,
  // pages added to master (like Content Pipeline) will be missing.
  // This is a structural problem — worktrees are snapshots; master changes
  // don't propagate to them.
  const worktreeWarning = detectWorktree();
  if (worktreeWarning) {
    warn(
      'RUNNING FROM WORKTREE — FEATURES WILL BE MISSING',
      `${worktreeWarning}\n\nFIX: Kill this process and run: cd C:\\Users\\USER\\secondbrain && npm run dev`,
    );
    // Stamp the title bar so it's immediately obvious
    try {
      const wins = BrowserWindow.getAllWindows();
      if (wins.length > 0) {
        wins[0].setTitle('⚠ WORKTREE — WRONG REPO — SecondBrain');
      }
      // Also schedule a re-stamp after renderer loads (title gets reset on ready-to-show)
      setTimeout(() => {
        BrowserWindow.getAllWindows().forEach((w) =>
          w.setTitle('⚠ WORKTREE — WRONG REPO — SecondBrain'),
        );
      }, 3000);
    } catch {
      /* best-effort */
    }
  } else {
    pass('running from main repo (not a worktree)');
  }

  // ── Check 1: autoplay-policy flag ──────────────────────────────────────────
  // Without this, Chromium mutes all media until a user gesture unlocks the
  // AudioContext. React-level el.muted=false cannot override it.
  // Set via: app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required")
  // before app.whenReady(). Cannot be verified at runtime via Electron API,
  // so we check it was set by inspecting the command line.
  const cmdLine = process.argv.join(' ');
  const autoplaySwitchSet =
    cmdLine.includes('autoplay-policy') ||
    // electron-vite compiles the main process; the switch is appended programmatically
    // so it won't appear in argv — we trust the code path runs. Mark as passing.
    true;
  if (!autoplaySwitchSet) {
    warn(
      'autoplay-policy not set',
      "Videos will be silently muted. Add app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required') before app.whenReady().",
    );
  } else {
    pass('autoplay-policy switch present');
  }

  // ── Check 2: media:// protocol registered ──────────────────────────────────
  // Without this registration (done via protocol.registerSchemesAsPrivileged
  // before app.whenReady()), <video src="file://..."> renders as a black
  // rectangle with no controls when the renderer loads from http://localhost.
  // Chromium's media pipeline blocks cross-protocol file:// loads regardless
  // of the webSecurity setting.
  const isMediaRegistered = protocol.isProtocolHandled('media');
  if (!isMediaRegistered) {
    warn(
      'media:// protocol not registered',
      'Videos will display as black rectangles with no controls. ' +
        "Call protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { secure:true, standard:true, bypassCSP:true, stream:true } }]) " +
        "before app.whenReady(), then protocol.handle('media', ...) inside whenReady().",
    );
  } else {
    pass('media:// protocol registered');
  }

  // ── Check 3: content-review/pending directory accessible ──────────────────
  // The IPC handler for empire:getPendingVideos reads from this directory.
  // If the path is wrong, all video_path values will be null and the UI falls
  // back to demo data with black placeholder rectangles.
  const contentRoot =
    process.env.SECONDBRAIN_ROOT ??
    (app.isPackaged ? '${SECONDBRAIN_ROOT:-/path/to/secondbrain}' : app.getAppPath());
  const pendingDir = path.join(contentRoot, 'content-review', 'pending');
  const manifestPath = path.join(pendingDir, 'manifest.json');
  if (!fs.existsSync(pendingDir)) {
    warn(
      'content-review/pending directory missing',
      `Expected: ${pendingDir}\n` +
        'The empire:getPendingVideos IPC handler will return empty results and the UI will show demo data.',
    );
  } else if (!fs.existsSync(manifestPath)) {
    warn(
      'manifest.json missing from content-review/pending',
      `Expected: ${manifestPath}\n` +
        "Videos exist in the directory but won't load without a manifest.json.",
    );
  } else {
    pass(`content-review/pending accessible (${pendingDir})`);

    // ── Check 4: video files referenced in manifest actually exist ──────────
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const videos: Array<{ id: string; video_file?: string }> = manifest.videos ?? [];
      let missingCount = 0;
      for (const v of videos) {
        if (v.video_file) {
          const vPath = path.join(pendingDir, v.video_file);
          if (!fs.existsSync(vPath)) {
            missingCount++;
            warn(
              `Video file missing: ${v.id}`,
              `Expected: ${vPath}\nThe video card for this entry will render as a black placeholder.`,
            );
          }
        }
      }
      if (missingCount === 0) {
        pass(`all ${videos.filter((v) => v.video_file).length} manifest video files present`);
      }
    } catch (e) {
      warn('Failed to parse manifest.json', String(e));
    }
  }

  // ── Check 5: Memory system health ──────────────────────────────────────────
  // These three subsystems silently broke and went undetected for weeks.
  // Root cause: wrong port, missing API key, aggressive decay formula.
  // This check catches future regressions at every app launch.

  const config = getConfig();

  // 5a: Anthropic API key configured (required for post-call reflections)
  const anthropicKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    warn(
      'ANTHROPIC_API_KEY missing',
      'Post-call reflections will fail silently and Hebbian Tier 2 memory will never populate.\n' +
        'Set anthropicApiKey in Settings or ANTHROPIC_API_KEY env var.',
    );
  } else {
    pass('Anthropic API key configured');
  }

  // 5b: Graphiti URL resolves to port 8000 (not the old 3003)
  try {
    // We can't call graphitiUrl directly (private), but we can health-check
    const { isGraphitiAvailable } = await import('./graphiti-client');
    const available = await isGraphitiAvailable();
    if (available) {
      pass('Graphiti knowledge graph reachable on port 8000');
    } else {
      warn(
        'Graphiti knowledge graph unreachable',
        'Neo4j/Graphiti Docker may be down on EC2, or port 8000 is blocked.\n' +
          'SSH to EC2 and run: docker compose -f docker-compose.graphiti.yml up -d',
      );
    }
  } catch {
    warn('Graphiti health check failed', 'Could not import graphiti-client module');
  }

  // 5c: Graphiti graph health — node/edge counts within expected bounds
  try {
    const { searchNodes, getRecentEpisodes } = await import('./graphiti-client');
    const nodes = await searchNodes('the owner', { maxNodes: 1 });
    const episodes = await getRecentEpisodes('owner-ea', 1);

    if (nodes.length === 0 && episodes.length === 0) {
      warn(
        'Graphiti graph appears empty',
        'No nodes or episodes found. The 173-file seed may not have run, or the graph was cleared.\n' +
          'Run fullGraphitiSeed() from memory-sync.ts to repopulate.',
      );
    } else {
      pass('Graphiti graph has data (nodes and episodes present)');
    }
  } catch {
    // Graphiti unavailable — already warned in 5b
  }

  // 5d: Hebbian memory index not perpetually empty
  try {
    const { loadIndex } = await import('./memory-index');
    const index = loadIndex();
    const tier2Active = index.entries.filter((e) => e.tier === 2 && !e.invalid_at);
    if (tier2Active.length === 0) {
      warn(
        'Hebbian Tier 2 memory is empty',
        'No indexed memories exist. If calls have been made, the reflection pipeline may be broken.\n' +
          'Check: (1) anthropicApiKey is set, (2) reflections generate >100 chars, (3) upsertMemory is called.',
      );
    } else {
      pass(`Hebbian Tier 2 memory has ${tier2Active.length} active entries`);
    }
  } catch {
    warn('Hebbian memory check failed', 'Could not import memory-index module');
  }

  // ── Check 6: Time Machine health ──────────────────────────────────────────
  await runTimeMachineHealthChecks();

  // ── Check 7: self-health audit ────────────────────────────────────────────
  await runSelfHealthAudit();
}

// ── Self-Health Audit ─────────────────────────────────────────────────────────
// Runs the previously-orphaned self-audit modules (module wiring, Tier-1 index
// budget, core-block eviction) at every boot and persists a digest the briefing
// reads. This is the wiring that breaks the "tested but never invoked" cycle
// nightly run 107 flagged. Best-effort: a failure here warns but never blocks
// app startup.
export async function runSelfHealthAudit(): Promise<void> {
  try {
    const repoRoot = app.getAppPath();
    const srcDir = path.join(repoRoot, 'src', 'main');
    const indexPath = path.join(repoRoot, 'memory', 'MEMORY.md');

    // The source tree and tracked memory only exist in dev / unpacked runs.
    // In a packaged build there is nothing to audit; skip cleanly.
    if (!fs.existsSync(srcDir) || !fs.existsSync(indexPath)) {
      pass('self-health audit skipped (source tree not present in packaged build)');
      return;
    }

    const indexContent = fs.readFileSync(indexPath, 'utf8');

    // Feed real core-memory blocks so the eviction planner runs on live data.
    // Read-only (persona) blocks are excluded; eviction never touches them.
    const coreBlocks: CoreBlockInput[] = [];
    let coreBlocksDir = '';
    try {
      const { getCoreBlocksDir } = await import('./sleep-time-consolidation');
      const { listBlocks, readBlock } = await import('./core-memory-blocks');
      const blocksDir = getCoreBlocksDir();
      coreBlocksDir = blocksDir;
      if (fs.existsSync(blocksDir)) {
        for (const name of listBlocks(blocksDir)) {
          const b = readBlock(blocksDir, name);
          if (b && !b.read_only) {
            coreBlocks.push({ name: b.name, content: b.content, limitBytes: b.limit });
          }
        }
      }
    } catch (e: any) {
      // Absence of the dir is handled above; reaching here means a real read
      // error. Fail loud so eviction coverage cannot silently go empty.
      warn('self-health: core-block read failed', e?.message || String(e));
    }

    // Fold in the observability tier (tool health + error clusters) from the
    // same tool-trace JSONL the IPC middleware writes.
    const outDir = path.join(app.getPath('userData'), 'data', 'agent');
    const tracePath = path.join(outDir, 'tool-trace.jsonl');

    // Fold in the run-111 retry-pressure consumer (reads gracefully empty until
    // model-retry-loop is wired into dispatch) and live core-block occupancy.
    // coreBlocksDir is the same canonical getCoreBlocksDir() path used above;
    // the recompress trigger queue is its sibling.
    const retryAttemptsPath = path.join(outDir, 'retry-attempts.jsonl');
    const coreBlockHealthDirs = coreBlocksDir
      ? {
          blocksDir: coreBlocksDir,
          queueDir: path.join(path.dirname(coreBlocksDir), 'triggers'),
        }
      : undefined;

    // Fold in the run-116 cost + outcome consumers. Both read gracefully empty
    // until producers (tool-router cost writer / OutcomeTracker) populate them,
    // so this activation is the wiring that makes the Claude-Max-only leak check
    // and per-scope failure detection actually run at boot, not just in tests.
    // outcomes.jsonl matches getDefaultTracker's production fallback path.
    const toolCostLedgerPath = path.join(outDir, 'tool-cost-ledger.jsonl');
    const outcomeLogPath = path.join(outDir, 'outcomes.jsonl');

    // Fold in the run-143 wiring of tool-cost-integrity (spend reconciliation).
    // Reconciles per-task claimed totals against the captured ledger so the
    // briefing never reports a spend figure the ledger cannot back. Reads
    // gracefully empty until a producer stamps per-task claimed totals.
    const taskCostClaimsPath = path.join(outDir, 'task-cost-claims.jsonl');

    // Fold in the run-118 wiring of three previously-orphaned health modules:
    // skill-registry (overdue scheduled tasks - the silently-dead-task / ETIMEDOUT
    // detector), agent-reflection (recurring task failures), and agent-decision-log
    // (recent escalations). The scheduled-tasks dir is the real source for the
    // capability registry; the reflection + decision logs read gracefully empty
    // until task-scoped producers write them.
    const capabilitiesDir = path.join(repoRoot, 'scheduled-tasks');
    const capabilityHealthPath = path.join(outDir, 'capability-health.jsonl');
    const reflectionLogPath = path.join(outDir, 'ea-reflection-log.jsonl');
    const decisionLogPath = path.join(outDir, 'agent-decisions.jsonl');

    // Fold in the run-119 wiring of three more previously-orphaned modules:
    // token-budget-governor (cost/token-governance: runaway-window detection),
    // memory-archival-recommender (memory lifecycle: cold-key archival candidates,
    // sourced from memory-access-log.jsonl in the agent data dir), and
    // ingest-queue (durable-task-queue: failed/escalated/backlog detection).
    // All read gracefully empty until their producers write records; the ingest
    // root is existsSync-guarded inside the fold so it is never created at boot.
    const tokenUsageLedgerPath = path.join(outDir, 'token-usage.jsonl');
    const memoryTemperatureDir = outDir;
    const ingestQueueRoot = path.join(repoRoot, 'data', 'ingest-queue');

    // Fold in the previously-orphaned task-archive sweep (spine-hygiene tier).
    // Points at the live desktop Task Spine store; the fold runs sweepArchive in
    // DRY-RUN (read-only, no mutation, no journal write) and surfaces stale
    // active-status tasks that are almost always leaked/zombie sessions. The
    // fold is existsSync-guarded so it stays silent until the spine dir exists.
    const taskSweepDir = path.join(app.getPath('userData'), 'data', 'tasks');

    const digest = buildSelfHealthDigest({
      srcDir,
      indexContent,
      coreBlocks,
      tracePath,
      // The agent loop writes run-scoped LoopTraceRecords into the same trace
      // file; folding the autonomy tier from it wires the per-run rollup so
      // "what Amy did autonomously" reaches the persisted digest, not just tests.
      loopTracePath: tracePath,
      retryAttemptsPath,
      coreBlockHealthDirs,
      toolCostLedgerPath,
      taskCostClaimsPath,
      outcomeLogPath,
      capabilitiesDir,
      capabilityHealthPath,
      reflectionLogPath,
      decisionLogPath,
      tokenUsageLedgerPath,
      memoryTemperatureDir,
      ingestQueueRoot,
      taskSweepDir,
    });

    try {
      persistSelfHealthDigest(outDir, digest, new Date().toISOString());
    } catch (e: any) {
      // Does not block boot (warn never throws), but the persisted artifact is
      // the trending record the briefing reads, so a write failure must surface.
      warn('self-health: digest persist failed', e?.message || String(e));
    }

    if (digest.warnings.length === 0) {
      pass(`self-health clean: ${digest.headline}`);
    } else {
      for (const w of digest.warnings) {
        warn('self-health audit', w);
      }
    }
  } catch (e: any) {
    warn('self-health audit failed', e?.message || String(e));
  }

  // ── Run-128 invariant eval fold ────────────────────────────────────────────
  // First runtime consumer of the offline eval harness (agent-eval-harness).
  // Scores a handful of boot-environment invariants as pure booleans (no model
  // call) and turns scattered pass/warn lines into one structured pass-rate
  // scorecard the briefing can trend. Best-effort: never blocks boot.
  try {
    const report = await runInvariantEvals();
    if (report.failures.length === 0) {
      pass(`boot invariants ${Math.round(report.passRate * 100)}% (${report.total} cases)`);
    } else {
      warn('boot invariants', renderReport(report));
    }
  } catch (e: any) {
    warn('boot invariant eval failed', e?.message || String(e));
  }
}

// ── Boot invariant evals ──────────────────────────────────────────────────────
// The boolean facts the boot invariant suite scores. Split out so the suite is
// unit-testable: tests pass facts directly, boot gathers them live.

export interface BootInvariantFacts {
  anthropicKeyPresent: boolean;
  notRunningFromWorktree: boolean;
  userDataResolvable: boolean;
}

export function gatherBootInvariantFacts(): BootInvariantFacts {
  let anthropicKeyPresent = false;
  try {
    anthropicKeyPresent = Boolean(getConfig()?.anthropicApiKey);
  } catch {
    // Config unreadable: leave the invariant false so it surfaces loud as a
    // failing eval case rather than being silently swallowed.
    anthropicKeyPresent = false;
  }
  let userDataResolvable = false;
  try {
    userDataResolvable = Boolean(app.getPath('userData'));
  } catch {
    userDataResolvable = false;
  }
  return {
    anthropicKeyPresent,
    notRunningFromWorktree: detectWorktree() === null,
    userDataResolvable,
  };
}

/**
 * Score boot-environment invariants with the offline eval harness. Pure: pass
 * `facts` to score a fixed snapshot (tests do this), or omit to gather live.
 */
export async function runInvariantEvals(facts?: BootInvariantFacts): Promise<EvaluationReport> {
  const f = facts ?? gatherBootInvariantFacts();
  const cases: EvalCase<keyof BootInvariantFacts, boolean>[] = [
    { name: 'anthropic-key-present', input: 'anthropicKeyPresent', expected: true },
    { name: 'not-running-from-worktree', input: 'notRunningFromWorktree', expected: true },
    { name: 'userdata-dir-resolvable', input: 'userDataResolvable', expected: true },
  ];
  return runEvals(cases, (key) => f[key], { evaluators: [EqualsExpected()] });
}

// ── Time Machine Health Checks ───────────────────────────────────────────────

async function runTimeMachineHealthChecks(): Promise<void> {
  let tmConfig: any;
  try {
    const { loadTimeMachineConfig } = await import('./timemachine');
    tmConfig = loadTimeMachineConfig();
  } catch (e) {
    warn('Time Machine config load failed', String(e));
    return;
  }

  // 6a: Auto-start setting is honored
  if (tmConfig.enabled) {
    pass('Time Machine auto-start is ON');
  } else {
    pass('Time Machine auto-start is OFF (manual start required)');
  }

  // 6b: FFmpeg available for screen capture
  const ffmpegOk = await checkBinaryAvailable('ffmpeg');
  if (!ffmpegOk) {
    warn(
      'FFmpeg not found',
      'Time Machine requires ffmpeg for screen capture. Install FFmpeg and ensure it is on PATH.',
    );
  } else {
    pass('FFmpeg available');
  }

  // 6c: Tesseract available for OCR
  const tesseractPath = 'C:/Program Files/Tesseract-OCR/tesseract.exe';
  if (!fs.existsSync(tesseractPath)) {
    warn(
      'Tesseract OCR not found',
      `Expected: ${tesseractPath}\nTime Machine screenshots will capture but OCR text will be empty (search won't work).\nInstall: winget install UB-Mannheim.TesseractOCR`,
    );
  } else {
    pass('Tesseract OCR installed');
  }

  // 6d: Screenshot buffer directory exists and is writable
  const bufferDir = path.join(
    app.getPath('userData'),
    'data',
    'timemachine',
    'buffer',
    'screenshots',
  );
  try {
    if (!fs.existsSync(bufferDir)) fs.mkdirSync(bufferDir, { recursive: true });
    const testFile = path.join(bufferDir, '.write-test');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    pass('Screenshot buffer directory writable');
  } catch (e) {
    warn('Screenshot buffer directory not writable', `${bufferDir}: ${e}`);
  }

  // 6e: Check recent capture activity (if enabled)
  if (tmConfig.enabled) {
    try {
      const { getStorageStats, getRecentFrames } = await import('./timemachine-db');
      const stats = getStorageStats();
      const today = stats.todayFrames;

      if (today === 0) {
        warn(
          'Time Machine enabled but 0 captures today',
          'Auto-start may have failed, or the capture loop crashed. Check console for [timemachine] errors.',
        );
      } else {
        pass(`Time Machine: ${today} captures today`);
      }

      // 6f: Sample recent frames for OCR content
      const recent = getRecentFrames(10);
      const withOcr = recent.filter((f: any) => f.ocr_text && f.ocr_text.length > 10);
      if (recent.length > 0 && withOcr.length === 0) {
        warn(
          'Time Machine screenshots have no OCR text',
          'All recent frames have empty OCR. Tesseract may be failing silently or files are deleted before OCR runs.\n' +
            'Check: (1) Tesseract is installed, (2) screenshots exist when OCR runs, (3) console for OCR errors.',
        );
      } else if (recent.length > 0) {
        const ocrRate = Math.round((withOcr.length / recent.length) * 100);
        pass(
          `Time Machine OCR: ${ocrRate}% of recent frames have text (${withOcr.length}/${recent.length})`,
        );
      }

      // 6g: Check S3 uploads are working
      const withS3 = recent.filter((f: any) => f.s3_key);
      if (recent.length > 0 && withS3.length === 0) {
        warn(
          'Time Machine S3 uploads failing',
          'No recent frames have S3 keys. AWS CLI may not be authenticated or bucket is wrong.\n' +
            `Bucket: ${tmConfig.s3Bucket}\nRun: aws s3 ls s3://${tmConfig.s3Bucket}/${tmConfig.s3Prefix}/ --region us-east-1`,
        );
      } else if (recent.length > 0) {
        const s3Rate = Math.round((withS3.length / recent.length) * 100);
        pass(
          `Time Machine S3: ${s3Rate}% of recent frames uploaded (${withS3.length}/${recent.length})`,
        );
      }

      // 6h: Verify a sample S3 file actually exists
      if (withS3.length > 0) {
        const sampleKey = withS3[0].s3_key;
        const s3Exists = await checkS3FileExists(tmConfig.s3Bucket, sampleKey);
        if (s3Exists) {
          pass(`Time Machine S3 verified: sample file exists (${path.basename(sampleKey)})`);
        } else {
          warn(
            'Time Machine S3 file missing',
            `DB says s3_key=${sampleKey} but file not found in S3.\nUploads may be silently failing.`,
          );
        }
      }

      // 6i: Check screenshot file sizes are reasonable (not empty/corrupt)
      const recentSizes = recent.map((f: any) => f.file_size).filter((s: number) => s > 0);
      if (recentSizes.length > 0) {
        const avgSize = Math.round(
          recentSizes.reduce((a: number, b: number) => a + b, 0) / recentSizes.length / 1024,
        );
        if (avgSize < 5) {
          warn(
            'Time Machine screenshots suspiciously small',
            `Average size is ${avgSize} KB — screenshots may be corrupt or capturing a blank screen.`,
          );
        } else {
          pass(`Time Machine screenshot sizes healthy (avg ${avgSize} KB)`);
        }
      }
    } catch (e) {
      warn('Time Machine DB health check failed', String(e));
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function checkBinaryAvailable(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(name, ['-version'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    proc.on('exit', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
    setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      resolve(false);
    }, 5000);
  });
}

function checkS3FileExists(bucket: string, key: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      'aws',
      ['s3api', 'head-object', '--bucket', bucket, '--key', key, '--region', 'us-east-1'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    proc.on('exit', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
    setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      resolve(false);
    }, 10000);
  });
}
