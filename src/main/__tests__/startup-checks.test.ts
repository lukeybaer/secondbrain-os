/**
 * Tests for src/main/startup-checks.ts
 *
 * Covers three areas:
 *   1. detectWorktree() — unit tests for all path/platform edge cases
 *   2. Autoplay-policy fix — source structure assertions (no dead || true,
 *      uses app.commandLine.hasSwitch instead of process.argv)
 *   3. Tesseract cross-platform fix — source structure assertions for all
 *      platform branches and install hints
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── Electron mock (must be declared before importing startup-checks) ──────────

const mockGetAppPath = vi.fn(() => '/Users/user/secondbrain');

vi.mock('electron', () => ({
  app: {
    getAppPath: () => mockGetAppPath(),
    getPath: vi.fn((key: string) => `/tmp/sb-startup-test-${key}`),
    commandLine: {
      hasSwitch: vi.fn(() => true),
    },
    isPackaged: false,
  },
  protocol: {
    isProtocolHandled: vi.fn(() => true),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({ anthropicApiKey: '', ec2BaseUrl: '' })),
}));

// Import after mocks are in place
import { detectWorktree } from '../startup-checks';

// ── Source file for structure assertions ──────────────────────────────────────

const SOURCE_PATH = path.resolve(__dirname, '../startup-checks.ts');
const source = fs.readFileSync(SOURCE_PATH, 'utf-8');

// ── 1. detectWorktree() ───────────────────────────────────────────────────────

describe('detectWorktree() — normal paths return null', () => {
  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue('/Users/user/secondbrain');
    mockGetAppPath.mockReturnValue('/Users/user/secondbrain');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when cwd and appPath are normal', () => {
    expect(detectWorktree()).toBeNull();
  });

  it('returns null when path contains "worktrees" but not ".claude/worktrees"', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/Users/user/myworktrees/secondbrain');
    mockGetAppPath.mockReturnValue('/Users/user/myworktrees/secondbrain');
    expect(detectWorktree()).toBeNull();
  });

  it('returns null when path contains ".claude" but not ".claude/worktrees"', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/Users/user/.claude/projects/secondbrain');
    expect(detectWorktree()).toBeNull();
  });

  it('returns null for a deep normal path', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/home/runner/work/secondbrain-os/secondbrain-os');
    mockGetAppPath.mockReturnValue('/home/runner/work/secondbrain-os/secondbrain-os');
    expect(detectWorktree()).toBeNull();
  });
});

describe('detectWorktree() — worktree paths return a descriptive string', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns non-null when cwd contains .claude/worktrees', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(
      '/Users/user/.claude/worktrees/fix-calls-branch/secondbrain',
    );
    mockGetAppPath.mockReturnValue('/Users/user/secondbrain');
    const result = detectWorktree();
    expect(result).not.toBeNull();
  });

  it('returned string mentions "Running from worktree"', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(
      '/Users/user/.claude/worktrees/feat-whatsapp/secondbrain',
    );
    mockGetAppPath.mockReturnValue('/Users/user/secondbrain');
    expect(detectWorktree()).toContain('Running from worktree');
  });

  it('returned string includes the bad path when cwd is the worktree', () => {
    const badPath = '/Users/user/.claude/worktrees/some-branch/secondbrain';
    vi.spyOn(process, 'cwd').mockReturnValue(badPath);
    mockGetAppPath.mockReturnValue('/Users/user/secondbrain');
    expect(detectWorktree()).toContain(badPath.replace(/\\/g, '/'));
  });

  it('returns non-null when appPath contains .claude/worktrees (cwd is clean)', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/Users/user/secondbrain');
    mockGetAppPath.mockReturnValue(
      '/Users/user/.claude/worktrees/fix-branch/secondbrain',
    );
    expect(detectWorktree()).not.toBeNull();
  });

  it('returned string includes appPath when only appPath is a worktree', () => {
    const badAppPath = '/Users/user/.claude/worktrees/feat-x/secondbrain';
    vi.spyOn(process, 'cwd').mockReturnValue('/Users/user/secondbrain');
    mockGetAppPath.mockReturnValue(badAppPath);
    expect(detectWorktree()).toContain(badAppPath);
  });

  it('cwd takes priority over appPath in the returned message when both are worktrees', () => {
    const badCwd = '/Users/user/.claude/worktrees/branch-a/secondbrain';
    const badApp = '/Users/user/.claude/worktrees/branch-b/secondbrain';
    vi.spyOn(process, 'cwd').mockReturnValue(badCwd);
    mockGetAppPath.mockReturnValue(badApp);
    const result = detectWorktree();
    expect(result).toContain(badCwd.replace(/\\/g, '/'));
    expect(result).not.toContain(badApp);
  });

  it('normalises Windows backslashes before checking', () => {
    // Windows paths use backslashes; the function replaces them before the check
    vi.spyOn(process, 'cwd').mockReturnValue(
      'C:\\Users\\user\\.claude\\worktrees\\feat-branch\\secondbrain',
    );
    mockGetAppPath.mockReturnValue('C:\\Users\\user\\secondbrain');
    expect(detectWorktree()).not.toBeNull();
  });

  it('includes "Expected:" in the returned message so the user knows where to run from', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(
      '/Users/user/.claude/worktrees/any-branch/secondbrain',
    );
    mockGetAppPath.mockReturnValue('/Users/user/secondbrain');
    expect(detectWorktree()).toContain('Expected:');
  });
});

// ── 2. Autoplay-policy source structure ───────────────────────────────────────

describe('startup-checks.ts — autoplay-policy fix (no dead || true)', () => {
  it('uses app.commandLine.hasSwitch to detect the autoplay-policy switch', () => {
    expect(source).toContain("app.commandLine.hasSwitch('autoplay-policy')");
  });

  it('does NOT fall back to || true (dead code removed)', () => {
    // The old implementation had `cmdLine.includes('autoplay-policy') || true`
    // which made the check always pass regardless of the actual switch state.
    expect(source).not.toMatch(/autoplay.*\|\|\s*true/s);
  });

  it('does NOT inspect process.argv for the autoplay-policy switch', () => {
    // process.argv never contains switches added via app.commandLine.appendSwitch
    expect(source).not.toContain('process.argv.join');
  });

  it('still warns if the switch is missing', () => {
    expect(source).toContain('autoplay-policy not set');
  });

  it('still passes if the switch is present', () => {
    expect(source).toContain("pass('autoplay-policy switch present')");
  });
});

// ── 3. Tesseract cross-platform source structure ──────────────────────────────

describe('startup-checks.ts — Tesseract detection is cross-platform', () => {
  it('branches on process.platform for win32', () => {
    expect(source).toContain("process.platform === 'win32'");
  });

  it('branches on process.platform for darwin (macOS)', () => {
    expect(source).toContain("process.platform === 'darwin'");
  });

  it('checks Apple Silicon Homebrew path on macOS', () => {
    expect(source).toContain('/opt/homebrew/bin/tesseract');
  });

  it('checks Intel Mac Homebrew path on macOS', () => {
    expect(source).toContain('/usr/local/bin/tesseract');
  });

  it('checks /usr/bin/tesseract for Linux', () => {
    expect(source).toContain('/usr/bin/tesseract');
  });

  it('falls back to PATH probe (checkBinaryAvailable) on non-Windows platforms', () => {
    expect(source).toContain("checkBinaryAvailable('tesseract')");
  });

  it('gives macOS-specific install hint via Homebrew', () => {
    expect(source).toContain('brew install tesseract');
  });

  it('gives Windows-specific install hint via winget', () => {
    expect(source).toContain('winget install UB-Mannheim.TesseractOCR');
  });

  it('gives Linux-specific install hint via apt-get', () => {
    expect(source).toContain('apt-get install tesseract-ocr');
  });

  it('Windows branch still checks the known installer exe path', () => {
    expect(source).toContain('C:/Program Files/Tesseract-OCR/tesseract.exe');
  });

  it('does not use the Windows path as the only detection method', () => {
    // The old code: single `const tesseractPath = 'C:/...'` with no platform check.
    // The new code: the Windows path appears only inside a win32 branch.
    const winPathIdx = source.indexOf('C:/Program Files/Tesseract-OCR/tesseract.exe');
    const win32BranchIdx = source.indexOf("process.platform === 'win32'");
    // win32 branch must appear before the Windows path
    expect(win32BranchIdx).toBeGreaterThanOrEqual(0);
    expect(winPathIdx).toBeGreaterThan(win32BranchIdx);
  });
});
