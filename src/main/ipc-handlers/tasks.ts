// ipc-handlers/tasks.ts
//
// IPC slice for the Task Spine. Kept as its own file rather than added to the
// ~1565-line ipc-handlers.ts. registerTaskHandlers is called from inside
// registerIpcHandlers.
//
// Channels:
//   tasks:list   -> Task[]            (optionally filtered)
//   tasks:get    -> Task | null
//   tasks:run    -> Task              (dispatch a new task from the UI)
//   tasks:cancel -> Task              (cancel a running/queued task)
//   tasks:push   <- Task              (live update, fired on every change)

import { ipcMain, type BrowserWindow } from 'electron';
import {
  listTasks,
  getTask,
  transition,
  approveTask,
  replyTaskFeedback,
  taskEmitter,
  type Task,
  type TaskKind,
  type TaskOrigin,
  type ListTasksFilter,
} from '../task-store';
import { runTask } from '../task-service';
import { projectAmyTasks } from '../amy-projects';

export function registerTaskHandlers(mainWindow: BrowserWindow): void {
  // Live-push every task change to the renderer (no polling).
  taskEmitter.on('task', (task: Task) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:push', task);
  });

  ipcMain.handle('tasks:list', (_e, filter?: ListTasksFilter) => projectAmyTasks(listTasks(filter)));

  ipcMain.handle('tasks:get', (_e, id: string) => getTask(id));

  ipcMain.handle(
    'tasks:run',
    (_e, input: { kind?: TaskKind; origin?: TaskOrigin; prompt: string; title?: string }) => {
      const { task } = runTask({
        kind: input.kind ?? 'action',
        origin: input.origin ?? 'app',
        prompt: input.prompt,
        ...(input.title ? { title: input.title } : {}),
      });
      return task;
    },
  );

  // The human-approval gate for the act worker. The worker runs only
  // approved tasks, so this is the one place a scraped directive gets a
  // human in the loop before it can autonomously execute.
  ipcMain.handle('tasks:approve', (_e, id: string, approved?: boolean) =>
    approveTask(id, approved !== false),
  );

  ipcMain.handle('tasks:reply', (_e, id: string, reply: string) => replyTaskFeedback(id, reply));

  ipcMain.handle('tasks:cancel', (_e, id: string) => {
    const task = getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    // Kill the claude subprocess if one is still running for this task.
    if (task.status === 'running' && task.pid) {
      try {
        process.kill(task.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    return transition(id, 'cancelled', 'cancelled from the Tasks tab');
  });
}
