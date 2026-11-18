// ipc-trace-middleware.ts
//
// Drop-in replacement for ipcMain.handle that wraps every registered channel
// with tool-trace instrumentation. Every call emits a JSONL line to
// data/agent/tool-trace.jsonl so the nightly briefing can surface slow/failing
// IPC handlers without manual instrumentation.
//
// Run 5 of the nightly enhancement cycle built tool-trace.ts but left it
// unwired. This module closes that gap by providing a single-import adapter
// that replaces ipcMain.handle in high-value handlers.
//
// Usage in ipc-handlers.ts:
//   import { makeTracedHandle } from './ipc-trace-middleware';
//   const tracedHandle = makeTracedHandle(app.getPath('userData'));
//   tracedHandle('calls:initiate', async (e, ...args) => { ... });
//
// This is a pure wrapper — no behavior change on success path.
// Failures in tracing never block the handler (best-effort, same as tool-trace).

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { traceTool, makeFileWriter, ToolTraceWriter } from './tool-trace';

export type IpcHandler<T = unknown> = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<T> | T;

/**
 * Returns a tracedHandle function bound to the given userData path.
 * Call once at the top of registerIpcHandlers and use in place of
 * ipcMain.handle for channels you want to observe.
 */
export function makeTracedHandle(userData: string) {
  const tracePath = path.join(userData, 'data', 'agent', 'tool-trace.jsonl');
  const writer: ToolTraceWriter = makeFileWriter(tracePath);

  return function tracedHandle<T>(channel: string, handler: IpcHandler<T>): void {
    ipcMain.handle(channel, (event, ...args) =>
      traceTool(channel, args, () => Promise.resolve(handler(event, ...args)), writer),
    );
  };
}
