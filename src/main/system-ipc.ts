import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { getSystemHealth } from './system-health';
import { createAuditLogger } from './observability/jsonl-logger';
import { listActivityEvents, listAuditEvents } from './observability/readers';

type SystemHandler<T = unknown> = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T> | T;

let registered = false;

export function registerSystemIpc(): void {
  if (registered) return;
  registered = true;

  const userData = app.getPath('userData');
  const appRoot = process.env.SECONDBRAIN_ROOT || app.getAppPath();
  const audit = createAuditLogger(userData, 'system-ipc');

  function handle<T>(channel: string, handler: SystemHandler<T>): void {
    ipcMain.handle(channel, async (event, ...args) => {
      const started = Date.now();
      try {
        const result = await handler(event, ...args);
        audit.info('ipc.complete', {
          channel,
          durationMs: Date.now() - started,
          ok: true,
        });
        return result;
      } catch (error) {
        audit.error('ipc.failed', error, {
          channel,
          durationMs: Date.now() - started,
        });
        throw error;
      }
    });
  }

  handle('system:health', async () => getSystemHealth());
  handle('audit:list', (_event, limit?: number) =>
    listAuditEvents({ userData, appRoot, limit: typeof limit === 'number' ? limit : 60 }),
  );
  handle('activity:list', (_event, limit?: number) =>
    listActivityEvents({ userData, appRoot, limit: typeof limit === 'number' ? limit : 80 }),
  );
}
