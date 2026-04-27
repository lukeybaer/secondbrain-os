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
 * Sends a #Amy dispatch email to Luke's own inbox with the section context
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
  // Plain notification email — NO #Amy tag. The Gmail #Amy scanner watches
  // Luke-to-Luke emails with #Amy; this dashboard path is a separate
  // direct-trigger channel and must not double-fire.
  const subject = `Dashboard feedback: ${sectionTitle} (${date})`;
  const bodyLines = [
    `Section: ${sectionTitle}`,
    `Briefing date: ${date}`,
    '',
    'Feedback:',
    comment,
    '',
    '(Sent from briefing dashboard right-click dispatch.)',
  ];
  const body = bodyLines.join('\n');

  const ts = new Date().toISOString();
  // Direct-trigger queue first — guarantees the click persists even if Gmail fails.
  try {
    const queuePath = path.join(
      process.env.SECONDBRAIN_ROOT || app.getAppPath(),
      'data', 'agent', 'dispatch-queue.jsonl',
    );
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    fs.appendFileSync(queuePath, JSON.stringify({
      ts, source: 'dashboard_electron', date, section: sectionTitle,
      comment, status: 'queued',
    }) + '\n');
  } catch (qErr) {
    console.error('[briefing-api] dispatch queue write failed:', (qErr as Error).message);
  }

  const python = resolvePython();
  const script = SEND_GMAIL_PY();

  return new Promise((resolve) => {
    const proc = cp.spawn(
      python,
      [script, '--to', 'luke.d.baer@gmail.com', '--subject', subject, '--body', body],
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
          sent_at: ts,
          source: 'briefing_dashboard_right_click',
          briefing_date: date,
          section: sectionTitle,
          comment,
          action: 'direct_trigger_queued',
          action_summary: 'Written to data/agent/dispatch-queue.jsonl for immediate processing by process-dispatches.js',
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
}

export { parseBriefing, pruneOldBriefings };
