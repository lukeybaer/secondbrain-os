/**
 * Shared Python interpreter resolver.
 *
 * 2026-05-05/06 #learn (feedback_windows_python_shim_fix.md):
 * On Windows, calling bare `python` from a Node spawn() resolves to the
 * Microsoft Store WindowsApps shim (C:\Users\<u>\AppData\Local\Microsoft\
 * WindowsApps\python.exe), which prints "Python was not found" and exits
 * 9009 instead of running the script. Auto-regen, scheduled tasks, and
 * IPC-spawned helpers were all silently dying on this. The fix is to
 * resolve a real interpreter once per process and cache it.
 *
 * Resolution order (first match wins):
 *   1. process.env.PYTHON_EXE if it points at an existing file
 *   2. C:\Python314\python.exe down to C:\Python310\python.exe
 *   3. %LOCALAPPDATA%\Programs\Python\Python3xx\python.exe
 *   4. py.exe (Python launcher) -- always real when present
 *   5. bare 'python' -- last resort, may hit the WindowsApps shim
 */
import * as fs from 'fs';
import * as path from 'path';

let _cached: string | null = null;

export function resolvePythonExe(): string {
  if (_cached) return _cached;
  if (process.platform !== 'win32') {
    _cached = 'python3';
    return _cached;
  }
  const candidates: string[] = [];
  if (process.env.PYTHON_EXE) candidates.push(process.env.PYTHON_EXE);
  for (const v of ['314', '313', '312', '311', '310']) {
    candidates.push(`C:\\Python${v}\\python.exe`);
  }
  if (process.env.LOCALAPPDATA) {
    const userBase = path.join(process.env.LOCALAPPDATA, 'Programs', 'Python');
    try {
      if (fs.existsSync(userBase)) {
        for (const dir of fs.readdirSync(userBase)) {
          if (/^Python\d{2,3}$/.test(dir)) {
            candidates.push(path.join(userBase, dir, 'python.exe'));
          }
        }
      }
    } catch { /* ignore */ }
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        _cached = c;
        return c;
      }
    } catch { /* skip */ }
  }
  _cached = 'py.exe';
  return _cached;
}

/** For test harnesses that need to reset the cache between cases. */
export function _resetCache(): void {
  _cached = null;
}
