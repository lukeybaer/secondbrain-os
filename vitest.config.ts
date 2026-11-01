import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const quietChildProcessesPath = fileURLToPath(new URL('./scripts/test-setup/quiet-child-processes.cjs', import.meta.url));
const { withRequire } = require(quietChildProcessesPath);

export default defineConfig({
  test: {
    environment: 'node',
    // The pristine temp dir, read here in the main process before any test can
    // repoint TEMP: the boundary scripts/test-setup/forbid-writes-outside-tmp.mjs enforces.
    env: { TEST_WRITE_GUARD_TMP_ROOTS: JSON.stringify([os.tmpdir()]) },
    setupFiles: [
      // Background tests and Node descendants must never open console windows.
      'scripts/test-setup/quiet-child-processes.cjs',
      'scripts/test-setup/clear-model-rung-marker.js',
      // Tests may write only under the OS temp dir (Oct 23 audit M3).
      'scripts/test-setup/forbid-writes-outside-tmp.mjs',
      // Default runtime-state paths land in a per-file temp dir (Oct 23 audit M3).
      'scripts/test-setup/redirect-runtime-state.mjs',
      // Paid model APIs (Jev, OpenAI, Anthropic, Bedrock) are off and refuse network in tests (Oct 29).
      'scripts/test-setup/block-paid-model-apis.mjs',
    ],
    globals: true,
    include: [
      'src/**/__tests__/**/*.test.ts',
      'tests/**/*.spec.ts',
      'scripts/__tests__/**/*.test.js',
    ],
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      'tests/**/*.pw.spec.ts',
      'tests/projects.spec.ts',
    ],
    // Timeouts sized for the shared box, NOT for speed. owner decision:
    // compute/dev/box time is free (this is an agent fleet, seconds or overnight
    // to him), so optimize for correctness, never for cycle count. The recurring
    // red-trunk freezes were load-induced TIMEOUTS, not real failures: tests that
    // run in 2-5s alone tip over under 14-session contention. The fix is to keep
    // the FULL-suite gate (maximally safe, no regression slips from scoping the
    // gate down) and give it large headroom plus one retry so contention can
    // never freeze the shared trunk. A genuinely slow/hung test just takes its
    // full window to surface, which is fine because time is not the constraint.
    testTimeout: 180000,
    hookTimeout: 180000,
    // One retry absorbs a load-induced flake (a second pass under lighter
    // contention) without heavily masking a truly broken test.
    retry: 1,
    execArgv: withRequire(process.execArgv, quietChildProcessesPath),
  },
});
