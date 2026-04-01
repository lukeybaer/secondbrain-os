import { app, BrowserWindow, shell, protocol, net } from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { registerIpcHandlers } from "./ipc-handlers";
import { loadConfig } from "./config";
import { startOtterPolling } from "./otter-ingest";
import { startCommandQueueWorker } from "./command-queue";
import { startKnowledgeWorker } from "./knowledge-worker";
import { startScheduler } from "./scheduler";
import { startServer } from "./server";
import { registerClaudeOverlayHandlers, unregisterClaudeOverlayHandlers } from "./claude-overlay";
import { getAgentMemory } from "./agent-memory";
import { initDatabase } from "./database-sqlite";
import { initVault } from "./pii-vault";
import { initMemoryIndex } from "./memory-index";
import { runStartupChecks } from "./startup-checks";
import * as fs from "fs";
import * as path from "path";

// ── Crash / error log ─────────────────────────────────────────────────────────
// Written to %APPDATA%\secondbrain\error.log so errors survive the process dying.
function getLogPath(): string {
  return path.join(app.getPath("userData"), "error.log");
}

function writeLog(label: string, err: unknown): void {
  try {
    const line = `[${new Date().toISOString()}] ${label}: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`;
    fs.appendFileSync(getLogPath(), line, "utf-8");
    console.error(line);
  } catch {
    // if logging itself fails, swallow silently
  }
}

process.on("uncaughtException", (err) => {
  writeLog("uncaughtException", err);
});

process.on("unhandledRejection", (reason) => {
  writeLog("unhandledRejection", reason);
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
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      backgroundThrottling: false,
      // Allow file:// URLs to load in the renderer when running against the
      // Vite dev server (http://localhost).  In production the renderer is
      // loaded from file:// itself so this flag isn't needed.
      webSecurity: !is.dev,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
    if (is.dev) {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  });

  mainWindow.webContents.setWindowOpenHandler(details => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  // Log renderer-side uncaught errors to the same file
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    writeLog("render-process-gone", JSON.stringify(details));
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  registerIpcHandlers(mainWindow);
  return mainWindow;
}

// Disable Chromium's autoplay audio gate globally.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Enable remote debugging in dev mode so we can inspect the renderer from Chrome.
if (process.env["NODE_ENV"] !== "production") {
  app.commandLine.appendSwitch("remote-debugging-port", "9222");
}

// Register a privileged custom scheme for serving local media files.
// Must be called before app.whenReady().
// Without this, <video src="file://..."> fails silently when the renderer
// is loaded from http://localhost (dev) because Chromium's media pipeline
// blocks cross-protocol file:// loads regardless of webSecurity setting.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "media",
    privileges: {
      secure: true,
      standard: true,
      bypassCSP: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);

app.whenReady().then(() => {
  writeLog("info", `App starting — userData: ${app.getPath("userData")}`);
  electronApp.setAppUserModelId("com.secondbrain.app");
  loadConfig();

  // Handle media:// URLs by proxying through net.fetch with the file:// protocol.
  // URL format: media://local/C:/path/to/file.mp4
  // pathname = /C:/path/to/file.mp4 → strip leading slash → file:///C:/path/to/file.mp4
  protocol.handle("media", (request) => {
    try {
      const url = new URL(request.url);
      const filePath = url.pathname.replace(/^\//, "");
      return net.fetch(`file:///${filePath}`);
    } catch (e) {
      writeLog("media-protocol", e);
      return new Response("File not found", { status: 404 });
    }
  });

  // Validate known fix preconditions — warns loudly if something regressed.
  // Must run AFTER protocol.handle("media") so isProtocolHandled returns true.
  runStartupChecks();

  // Initialize SQLite database (migrations + seed whitelist)
  try { initDatabase(); } catch (e) { writeLog("initDatabase", e); }

  // Initialize PII vault (AES-256 encrypted)
  try { initVault(); } catch (e) { writeLog("initVault", e); }

  // Initialize three-tier memory index
  try { initMemoryIndex(); } catch (e) { writeLog("initMemoryIndex", e); }

  // Initialize EA agent memory (creates seed file on first run)
  getAgentMemory("ea").ensure().catch(err => writeLog("agent-memory init", err));

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  const mainWindowRef = createWindow();

  // Register Claude Code overlay handlers (global hotkey + IPC)
  let _mainWindow: BrowserWindow | null = mainWindowRef;
  registerClaudeOverlayHandlers(() => _mainWindow);

  // Start Otter transcript polling — every 5 minutes
  startOtterPolling(5 * 60 * 1000);

  // Start local HTTP server (Vapi webhooks, Claude Code command endpoint)
  try { startServer(); } catch (e) { writeLog("startServer", e); }

  // Start EC2 command queue worker (polls for claude/search tasks)
  startCommandQueueWorker();

  // Start knowledge query worker (answers mid-call knowledge queries from Vapi)
  startKnowledgeWorker();

  // Start daily briefing + evening update scheduler
  startScheduler();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(err => {
  writeLog("app.whenReady failed", err);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
