/**
 * Shared Python interpreter resolver for Node-launched scripts.
 *
 * Mirror of src/main/util/python.ts. Use from any .js file that spawns a
 * Python script. Resolves a real interpreter once per process and caches
 * it so the WindowsApps shim never gets selected.
 *
 * Usage:
 *   const { resolvePythonExe } = require('./lib/python-resolver');
 *   const py = resolvePythonExe();
 *   spawnSync(py, [scriptPath, ...args], opts);
 *
 * Resolution order (first match wins):
 *   1. process.env.PYTHON_EXE if it points at an existing file
 *   2. process.env.PY_LAUNCHER if it points at an existing file
 *   3. C:\Python314\python.exe down to C:\Python310\python.exe
 *   4. %LOCALAPPDATA%\Programs\Python\Python3xx\python.exe
 *   5. py.exe (Python launcher) -- always real when present, on PATH
 *   6. bare 'python' -- last resort, may hit the WindowsApps shim
 */
'use strict';

const fs = require('fs');
const path = require('path');

let _cached = null;

function resolvePythonExe() {
  if (_cached) return _cached;
  if (process.platform !== 'win32') {
    _cached = 'python3';
    return _cached;
  }
  const candidates = [];
  if (process.env.PYTHON_EXE) candidates.push(process.env.PYTHON_EXE);
  if (process.env.PY_LAUNCHER) candidates.push(process.env.PY_LAUNCHER);
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

/** For test harnesses that need a clean slate between cases. */
function _resetCache() {
  _cached = null;
}

module.exports = { resolvePythonExe, _resetCache };
