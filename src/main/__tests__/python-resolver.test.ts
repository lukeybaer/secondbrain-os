/**
 * Regression test: Python shim resolver. Locked 2026-05-06.
 *
 * Original defect: bare `python` from a Node spawn on Windows resolves to
 * the Microsoft Store WindowsApps shim and exits 9009 instead of running.
 * Auto-regen, scheduled tasks, and IPC-spawned helpers were all silently
 * dying on this. The fix is `src/main/util/python.ts::resolvePythonExe()`
 * which probes explicit C:\Python3xx paths before any bare command.
 *
 * This test asserts:
 *   1. PYTHON_EXE env override wins when it exists
 *   2. C:\Python3xx paths are checked next
 *   3. Falls through to py.exe as last resort, never bare 'python'
 *      (the WindowsApps shim risk)
 *   4. Result is cached between calls
 *   5. On non-Windows, returns 'python3' deterministically
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock fs at module load. This is required because vitest in ESM mode
// cannot spy on namespace imports after the module is loaded.
const existsSet: Set<string> = new Set();
let existsCalls = 0;
vi.mock('fs', () => ({
  default: {
    existsSync: (p: string) => { existsCalls += 1; return existsSet.has(p); },
    readdirSync: () => [],
  },
  existsSync: (p: string) => { existsCalls += 1; return existsSet.has(p); },
  readdirSync: () => [],
}));

// Import after mock is registered.
import { resolvePythonExe, _resetCache } from '../util/python';

describe('resolvePythonExe', () => {
  const realPlatform = process.platform;
  const realEnv = { ...process.env };

  beforeEach(() => {
    _resetCache();
    existsSet.clear();
    existsCalls = 0;
  });
  afterEach(() => {
    _resetCache();
    Object.defineProperty(process, 'platform', { value: realPlatform });
    process.env = { ...realEnv };
  });

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: p });
  }

  it('returns python3 on linux without probing', () => {
    setPlatform('linux');
    expect(resolvePythonExe()).toBe('python3');
    expect(existsCalls).toBe(0);
  });

  it('returns python3 on darwin without probing', () => {
    setPlatform('darwin');
    expect(resolvePythonExe()).toBe('python3');
  });

  it('prefers PYTHON_EXE env when it exists', () => {
    setPlatform('win32');
    process.env.PYTHON_EXE = 'D:\\Custom\\python.exe';
    existsSet.add('D:\\Custom\\python.exe');
    expect(resolvePythonExe()).toBe('D:\\Custom\\python.exe');
  });

  it('skips PYTHON_EXE when the path is missing, falls to C:\\Python3xx', () => {
    setPlatform('win32');
    process.env.PYTHON_EXE = 'D:\\Missing\\python.exe';
    existsSet.add('C:\\Python313\\python.exe');
    expect(resolvePythonExe()).toBe('C:\\Python313\\python.exe');
  });

  it('finds the highest-version C:\\Python3xx that exists', () => {
    setPlatform('win32');
    delete process.env.PYTHON_EXE;
    existsSet.add('C:\\Python311\\python.exe');
    existsSet.add('C:\\Python313\\python.exe');
    // Order in resolver is 314, 313, 312, 311 ... so 313 is picked first.
    expect(resolvePythonExe()).toBe('C:\\Python313\\python.exe');
  });

  it('falls through to py.exe when no real install is found', () => {
    setPlatform('win32');
    delete process.env.PYTHON_EXE;
    delete process.env.LOCALAPPDATA;
    expect(resolvePythonExe()).toBe('py.exe');
  });

  it('never returns bare "python" on Windows (WindowsApps shim risk)', () => {
    setPlatform('win32');
    delete process.env.PYTHON_EXE;
    delete process.env.LOCALAPPDATA;
    const result = resolvePythonExe();
    expect(result).not.toBe('python');
    expect(result).not.toBe('python.exe');
  });

  it('caches the result between calls', () => {
    setPlatform('win32');
    delete process.env.PYTHON_EXE;
    existsSet.add('C:\\Python314\\python.exe');
    const a = resolvePythonExe();
    const callsAfterFirst = existsCalls;
    const b = resolvePythonExe();
    expect(a).toBe(b);
    expect(existsCalls).toBe(callsAfterFirst);
  });
});
