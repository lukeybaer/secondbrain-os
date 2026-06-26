import { app, BrowserWindow, shell, protocol, session } from 'electron';
import { join } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { registerIpcHandlers } from './ipc-handlers';
import { registerBriefingIpc } from './briefing-api';
import { loadConfig, getConfig } from './config';
import { startOtterPolling } from './otter-ingest';
import { startCommandQueueWorker, setCommandStatusHandler } from './command-queue';
import { startKnowledgeWorker } from './knowledge-worker';
import { startDataSync } from './data-sync';
import { startScheduler } from './scheduler';
import { startServer } from './server';
import { registerClaudeOverlayHandlers, unregisterClaudeOverlayHandlers } from './claude-overlay';
import { getAgentMemory } from './agent-memory';
import { initDatabase } from './database-sqlite';
import { initVault } from './pii-vault';
import { initMemoryIndex } from './memory-index';
import { runStartupChecks, detectWorktree } from './startup-checks';
import { autoConnectIfSession } from './whatsapp-web';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';

const ENABLE_LIGHT_STARTUP =
  process.env.SECONDBRAIN_LIGHT_STARTUP === '1' && process.env.SECONDBRAIN_FULL_STARTUP !== '1';
const ENABLE_BACKGROUND_STARTUP = !ENABLE_LIGHT_STARTUP;
const ENABLE_DEV_TOOLS = process.env.SECONDBRAIN_ENABLE_DEVTOOLS === '1';

// ── Crash / error log ─────────────────────────────────────────────────────────
// Written to %APPDATA%\secondbrain\error.log so errors survive the process dying.
function getLogPath(): string {
  return path.join(app.getPath('userData'), 'error.log');
}

function writeLog(label: string, err: ExampleCo): void {
  try {
    const line = `[${new Date().toISOString()}] ${label}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`;
    fs.appendFileSync(getLogPath(), line, 'utf-8');
    console.error(line);
  } catch {
    // if logging itself fails, swallow silently
  }
}

process.on('uncaughtException', (err) => {
  writeLog('uncaughtException', err);
});

process.on('unhandledRejection', (reason) => {
  writeLog('unhandledRejection', reason);
});
// ─────────────────────────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false,
      // Allow file:// URLs to load in the renderer when running against the
      // Vite dev server (http://localhost).  In production the renderer is
      // loaded from file:// itself so this flag isn't needed.
      webSecurity: !is.dev,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
    const wtWarning = detectWorktree();
    mainWindow.setTitle(wtWarning ? `⚠ WORKTREE — WRONG REPO — SecondBrain` : 'SecondBrain');
    if (is.dev && ENABLE_DEV_TOOLS) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  // Log renderer-side uncaught errors to the same file
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    writeLog('render-process-gone', JSON.stringify(details));
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  registerIpcHandlers(mainWindow);
  registerBriefingIpc();
  return mainWindow;
}

// ── Single-instance lock (cross-binary) ──────────────────────────────────────
// requestSingleInstanceLock() is scoped to the Electron app user data directory.
// A packaged SecondBrain.exe and the dev electron.exe historically used different
// userData paths ("SecondBrain" vs "secondbrain") so the lock didn't catch both.
// We fix that two ways:
//   1. package.json productName is now "secondbrain" (lowercase) so both builds
//      share the same userData path and Electron's own lock WILL catch duplicates.
//   2. Belt-and-suspenders: a PID lock file at a fixed path that any build checks.
const LOCK_FILE = path.join(require('os').tmpdir(), 'secondbrain-app.lock');

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLockFile(): boolean {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const existingPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      if (!isNaN(existingPid) && existingPid !== process.pid && isProcessRunning(existingPid)) {
        return false; // another live instance holds the lock
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf-8');
    return true;
  } catch {
    return true; // if we can't check, let this instance proceed
  }
}

function releaseLockFile(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    /* ignore */
  }
}

const gotElectronLock = app.requestSingleInstanceLock();
const gotFileLock = acquireLockFile();

if (!gotElectronLock || !gotFileLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      const win = wins[0];
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('before-quit', releaseLockFile);
  app.on('will-quit', releaseLockFile);
}
// ─────────────────────────────────────────────────────────────────────────────

// Disable Chromium's autoplay audio gate globally.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Enable remote debugging only when explicitly requested.
if (process.env['NODE_ENV'] !== 'production' && process.env.SECONDBRAIN_ENABLE_REMOTE_DEBUG === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

// Register a privileged custom scheme for serving local media files.
// Must be called before app.whenReady().
// Without this, <video src="file://..."> fails silently when the renderer
// is loaded from http://localhost (dev) because Chromium's media pipeline
// blocks cross-protocol file:// loads regardless of webSecurity setting.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      secure: true,
      standard: true,
      bypassCSP: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);

app
  .whenReady()
  .then(async () => {
    writeLog('info', `App starting — userData: ${app.getPath('userData')}`);
    electronApp.setAppUserModelId('com.secondbrain.app');
    loadConfig();

    // Deny camera/mic access — SecondBrain has no UI that needs the camera or mic.
    // This prevents the app from competing with Google Meet and other video call tools.
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      if (permission === 'media') {
        callback(false);
      } else {
        callback(true);
      }
    });

    // Handle media:// URLs with explicit Range support so HTML5 <video>
    // playback works for files larger than the initial buffer.
    //
    // 2026-04-29 fix: previous implementation just did `net.fetch(file://...)`
    // which returned the whole file but did not propagate Range headers and
    // did not advertise Accept-Ranges: bytes. The video element buffered the
    // first chunk (~3s of a 36s clip), then stalled when Chromium tried to
    // fetch the next byte range and got a non-Range response back -- ExampleCo
    // saw playback halt at 0:02 of every video in the Content Pipeline
    // dashboard.
    //
    // Real fix: parse the Range request, fs.createReadStream the requested
    // byte slice, return 206 Partial Content with Content-Range and stream
    // the slice as a Web ReadableStream. For non-Range requests, return 200
    // with Accept-Ranges: bytes so the client knows it can seek.
    //
    // URL format: media://local/C:/path/to/file.mp4
    // pathname = /C:/path/to/file.mp4 -> strip leading slash -> C:/path/to/file.mp4
    protocol.handle('media', (request) => {
      try {
        const url = new URL(request.url);
        const filePath = url.pathname.replace(/^\//, '');

        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch {
          return new Response('File not found', { status: 404 });
        }
        const fileSize = stat.size;

        const ext = path.extname(filePath).toLowerCase();
        const contentType =
          ext === '.mp4' ? 'video/mp4'
          : ext === '.webm' ? 'video/webm'
          : ext === '.mov' ? 'video/quicktime'
          : ext === '.mp3' ? 'audio/mpeg'
          : ext === '.wav' ? 'audio/wav'
          : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
          : ext === '.png' ? 'image/png'
          : 'application/octet-stream';

        const rangeHeader = request.headers.get('range');
        if (rangeHeader) {
          // Range: bytes=START-END (END is optional)
          const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
          if (!match) {
            return new Response('Invalid Range', {
              status: 416,
              headers: { 'Content-Range': `bytes */${fileSize}` },
            });
          }
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
          if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= fileSize) {
            return new Response('Range Not Satisfiable', {
              status: 416,
              headers: { 'Content-Range': `bytes */${fileSize}` },
            });
          }
          const chunkSize = end - start + 1;
          const nodeStream = fs.createReadStream(filePath, { start, end });
          // Convert Node Readable -> Web ReadableStream so it fits the Response API.
          const webStream = Readable.toWeb(nodeStream) as ExampleCo as ReadableStream<Uint8Array>;
          return new Response(webStream, {
            status: 206,
            headers: {
              'Content-Type': contentType,
              'Content-Length': String(chunkSize),
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'no-cache',
            },
          });
        }

        // No Range header: return the whole file but advertise Accept-Ranges
        // so the client knows it can seek with subsequent Range requests.
        const nodeStream = fs.createReadStream(filePath);
        const webStream = Readable.toWeb(nodeStream) as ExampleCo as ReadableStream<Uint8Array>;
        return new Response(webStream, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(fileSize),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
          },
        });
      } catch (e) {
        writeLog('media-protocol', e);
        return new Response('File not found', { status: 404 });
      }
    });

    // Validate known fix preconditions — warns loudly if something regressed.
    // Must run AFTER protocol.handle("media") so isProtocolHandled returns true.
    runStartupChecks().catch((err) => console.error('[startup-checks] Error:', err));

    // Initialize SQLite database (migrations + seed whitelist)
    try {
      initDatabase();
    } catch (e) {
      writeLog('initDatabase', e);
    }

    // Initialize PII vault (AES-256 encrypted)
    try {
      initVault();
    } catch (e) {
      writeLog('initVault', e);
    }

    // Initialize three-tier memory index
    try {
      initMemoryIndex();
    } catch (e) {
      writeLog('initMemoryIndex', e);
    }

    // Initialize EA agent memory (creates seed file on first run)
    getAgentMemory('ea')
      .ensure()
      .catch((err) => writeLog('agent-memory init', err));

    // Establish SSH tunnel to Graphiti on EC2 (localhost:8000 → EC2:8000)
    // Graphiti MCP only accepts localhost connections (Host header validation).
    try {
      const { spawn } = require('child_process');
      const sshKeyPath = join(app.getPath('home'), '.ssh', 'secondbrain-backend-key.pem');
      if (fs.existsSync(sshKeyPath)) {
        const ssh = spawn(
          'ssh',
          [
            '-i',
            sshKeyPath,
            '-fNL',
            '8000:localhost:8000',
            '-o',
            'StrictHostKeyChecking=no',
            '-o',
            'ExitOnForwardFailure=yes',
            '-o',
            'ServerAliveInterval=60',
            'ec2-user@ExampleCo',
          ],
          { detached: true, stdio: 'ignore', windowsHide: true },
        );
        ssh.unref();
        console.log('[startup] SSH tunnel to Graphiti established (pid:', ssh.pid, ')');
      }
    } catch (e) {
      writeLog('graphiti-tunnel', e);
    }

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    const mainWindowRef = createWindow();

    // Register Claude Code overlay handlers (global hotkey + IPC)
    let _mainWindow: BrowserWindow | null = mainWindowRef;
    registerClaudeOverlayHandlers(() => _mainWindow);

    // Point the Task Spine store at the real data dir before any poller or
    // command worker can create spine records.
    const spineDataDir = getConfig().dataDir;
    try {
      const { setTasksDir } = await import('./task-store');
      setTasksDir(join(spineDataDir, 'tasks'));
    } catch (err) {
      writeLog('task-store-init', err);
    }

    if (ENABLE_BACKGROUND_STARTUP) {
      // Start Otter transcript polling every 5 minutes.
      startOtterPolling(5 * 60 * 1000);

      // Start local HTTP server (Vapi webhooks, Claude Code command endpoint).
      try {
        startServer();
      } catch (e) {
        writeLog('startServer', e);
      }

      // Start EC2 command queue worker (polls for claude/search tasks).
      setCommandStatusHandler((event) => {
        const wins = BrowserWindow.getAllWindows();
        if (wins.length > 0 && !wins[0].isDestroyed()) {
          wins[0].webContents.send('command:status', event);
        }
      });
      startCommandQueueWorker();

      // Start the Task Spine intake watcher and workers.
      try {
        const { startIntakeWatcher } = await import('./task-intake');
        startIntakeWatcher(
          join(spineDataDir, 'agent', 'dispatch-queue.jsonl'),
          join(spineDataDir, 'tasks', 'intake-consumed.json'),
        );
        const { startTaskWorker } = await import('./task-worker');
        startTaskWorker();
        const { startTaskNotifier } = await import('./task-notify');
        startTaskNotifier();
      } catch (err) {
        writeLog('task-intake-autostart', err);
      }

      startKnowledgeWorker();
      startDataSync();
      startScheduler();

      try {
        const { loadTimeMachineConfig, startTimeMachine } = await import('./timemachine');
        const tmConfig = loadTimeMachineConfig();
        if (tmConfig.enabled) {
          startTimeMachine().catch((err) => writeLog('timemachine-autostart', err));
        }
      } catch (err) {
        writeLog('timemachine-import', err);
      }

      autoConnectIfSession().catch((err) => writeLog('whatsapp-autoconnect', err));
    } else {
      console.log(
        '[startup] Background workers disabled by SECONDBRAIN_LIGHT_STARTUP=1. Set SECONDBRAIN_FULL_STARTUP=1 to override.',
      );
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((err) => {
    writeLog('app.whenReady failed', err);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
