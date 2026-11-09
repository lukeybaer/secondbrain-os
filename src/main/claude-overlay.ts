// claude-overlay.ts
// Handles the global Claude Code interaction layer:
// - Ctrl+Shift+Space global hotkey → capture screenshot + open overlay
// - IPC handler for sending commands to the EC2 command queue
// - Screenshot capture via webContents.capturePage()

import { globalShortcut, ipcMain, BrowserWindow, screen, nativeImage } from "electron";
import * as path from "path";
import * as fs from "fs";
import { app } from "electron";
import { getConfig } from "./config";

const FALLBACK_EC2_URL = ""; // Set ec2BaseUrl in Settings

function getBaseUrl(): string {
  try {
    return getConfig().ec2BaseUrl || FALLBACK_EC2_URL;
  } catch {
    return FALLBACK_EC2_URL;
  }
}

async function postCommandToQueue(prompt: string, context: string): Promise<string> {
  const fullPrompt = context ? `[Context: ${context}]\n\n${prompt}` : prompt;
  const base = getBaseUrl();
  const res = await fetch(`${base}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "claude", prompt: fullPrompt, replyTo: "telegram" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.id as string;
}

async function captureScreenshot(mainWindow: BrowserWindow): Promise<string | null> {
  try {
    const image = await mainWindow.webContents.capturePage();
    const screenshotDir = path.join(app.getPath("userData"), "screenshots");
    await fs.promises.mkdir(screenshotDir, { recursive: true });
    const filePath = path.join(screenshotDir, `screenshot-${Date.now()}.png`);
    await fs.promises.writeFile(filePath, image.toPNG());
    return filePath;
  } catch (err) {
    console.error("[claude-overlay] screenshot failed:", err);
    return null;
  }
}

export function registerClaudeOverlayHandlers(getMainWindow: () => BrowserWindow | null): void {
  // IPC: send command from the floating chat panel
  ipcMain.handle("claude:sendCommand", async (_e, prompt: string, context: string) => {
    try {
      const commandId = await postCommandToQueue(prompt, context);
      return { success: true, commandId };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // IPC: take screenshot and return file path
  ipcMain.handle("claude:captureScreenshot", async () => {
    const win = getMainWindow();
    if (!win) return { success: false, error: "No window" };
    const filePath = await captureScreenshot(win);
    return filePath ? { success: true, filePath } : { success: false, error: "Capture failed" };
  });

  // IPC: open overlay at specific position (called by renderer after hotkey)
  ipcMain.handle("claude:openOverlayAt", async (_e, x: number, y: number) => {
    const win = getMainWindow();
    if (!win) return;
    // Tell renderer to show the overlay at these screen coords
    const winBounds = win.getBounds();
    const relX = Math.max(0, Math.min(x - winBounds.x, winBounds.width - 400));
    const relY = Math.max(0, Math.min(y - winBounds.y, winBounds.height - 200));
    win.webContents.send("claude:showOverlay", { x: relX, y: relY });
  });

  // Global hotkey: Ctrl+Shift+Space
  try {
    globalShortcut.register("CommandOrControl+Shift+Space", async () => {
      const win = getMainWindow();
      if (!win) return;

      // Get current mouse position
      const cursor = screen.getCursorScreenPoint();

      // Capture screenshot in background
      captureScreenshot(win).then(filePath => {
        if (filePath) {
          win.webContents.send("claude:showOverlay", {
            x: cursor.x - win.getBounds().x,
            y: cursor.y - win.getBounds().y,
            screenshotPath: filePath,
          });
        } else {
          win.webContents.send("claude:showOverlay", {
            x: cursor.x - win.getBounds().x,
            y: cursor.y - win.getBounds().y,
          });
        }
      });
    });
    console.log("[claude-overlay] Registered Ctrl+Shift+Space hotkey");
  } catch (err) {
    console.warn("[claude-overlay] Could not register global hotkey:", err);
  }
}

export function unregisterClaudeOverlayHandlers(): void {
  try {
    globalShortcut.unregister("CommandOrControl+Shift+Space");
  } catch { /* ignore */ }
}
