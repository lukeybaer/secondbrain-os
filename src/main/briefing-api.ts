import { dialog, BrowserWindow, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { app } from 'electron';
import {
  listBriefingFiles,
  loadBriefingByDate,
  parseBriefing,
  pruneOldBriefings,
  ParsedBriefing,
  BriefingSummary,
} from './briefing-parser';
import { sendDailyBriefing } from './briefing';
import { getConfig } from './config';

const DISPATCH_LOG = (): string =>
  path.join(
    process.env.SECONDBRAIN_ROOT || app.getAppPath(),
    'data',
    'agent',
    'amy-dispatch-log.jsonl',
  );

const SEND_GMAIL_PY = (): string =>
  path.join(process.env.SECONDBRAIN_ROOT || app.getAppPath(), 'scripts', 'send-gmail.py');

function appendDispatchLog(entry: Record<string, unknown>): void {
  try {
    fs.appendFileSync(DISPATCH_LOG(), JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('[briefing-api] dispatch log write failed:', (e as Error).message);
  }
}

function resolvePython(): string {
  // Prefer explicit env, fall back to system python. Windows uses 'python'.
  return process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
}

/**
 * Sends a #Amy dispatch email to the owner's own inbox with the section context
 * and comment. This is the "right-click on briefing section -> comment"
 * pathway: it feeds the same #Amy email dispatch convention the Gmail scan
 * already processes. Returns { ok: true } on successful send.
 */
async function dispatchAmyComment(params: {
  date: string;
  sectionTitle: string;
  comment: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { date, sectionTitle, comment } = params;
  const subject = `#Amy dashboard feedback: ${sectionTitle} (${date})`;
  const bodyLines = [
    '#Amy',
    '',
    `Section: ${sectionTitle}`,
    `Briefing date: ${date}`,
    '',
    'Feedback:',
    comment,
    '',
    '(Sent from briefing dashboard right-click dispatch.)',
  ];
  const body = bodyLines.join('\n');

  const python = resolvePython();
  const script = SEND_GMAIL_PY();

  return new Promise((resolve) => {
    const cfg = getConfig();
    const toEmail = cfg.ownerEmail || cfg.otterEmail;
    if (!toEmail) {
      resolve({ ok: false, error: 'No owner email configured. Set Owner Email in Settings.' });
      return;
    }
    const proc = cp.spawn(
      python,
      [script, '--to', toEmail, '--subject', subject, '--body', body],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (e) => {
      resolve({ ok: false, error: e.message });
    });
    proc.on('close', (code) => {
      if (code === 0) {
        appendDispatchLog({
          thread_id: null,
          subject,
          sent_at: new Date().toISOString(),
          source: 'briefing_dashboard_right_click',
          briefing_date: date,
          section: sectionTitle,
          comment,
          action: 'self_dispatch',
          action_summary: 'Queued as #Amy email to self for next Gmail scan to process',
          status: 'queued',
        });
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: stderr.trim() || `send-gmail.py exit ${code}` });
      }
    });
  });
}

async function exportBriefing(
  win: BrowserWindow | null,
  date: string,
): Promise<{ ok: boolean; filePath?: string; error?: string }> {
  const parsed = loadBriefingByDate(date);
  if (!parsed) return { ok: false, error: `No briefing found for ${date}` };

  const defaultName = `briefing-${date}.md`;
  const chosen = await dialog.showSaveDialog(win || BrowserWindow.getFocusedWindow()!, {
    title: `Export briefing ${date}`,
    defaultPath: defaultName,
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Text', extensions: ['txt'] },
    ],
  });
  if (chosen.canceled || !chosen.filePath) return { ok: false, error: 'cancelled' };

  try {
    fs.writeFileSync(chosen.filePath, parsed.raw, 'utf-8');
    return { ok: true, filePath: chosen.filePath };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function registerBriefingIpc(): void {
  ipcMain.handle('briefing:listDays', async (): Promise<BriefingSummary[]> => {
    pruneOldBriefings(3);
    return listBriefingFiles();
  });

  ipcMain.handle('briefing:get', async (_e, date: string): Promise<ParsedBriefing | null> => {
    return loadBriefingByDate(date);
  });

  ipcMain.handle(
    'briefing:dispatch',
    async (
      _e,
      params: { date: string; sectionTitle: string; comment: string },
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!params?.comment?.trim()) return { ok: false, error: 'empty comment' };
      return dispatchAmyComment(params);
    },
  );

  ipcMain.handle(
    'briefing:export',
    async (e, date: string): Promise<{ ok: boolean; filePath?: string; error?: string }> => {
      const win = BrowserWindow.fromWebContents(e.sender);
      return exportBriefing(win, date);
    },
  );

  ipcMain.handle('briefing:openExternal', async (_e, url: string): Promise<{ ok: boolean }> => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return { ok: false };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle(
    'briefing:generate',
    async (_e, force = true): Promise<{ ok: boolean; error?: string }> => {
      try {
        await sendDailyBriefing(force);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );
}

export { parseBriefing, pruneOldBriefings };
