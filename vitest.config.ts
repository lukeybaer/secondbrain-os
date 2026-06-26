import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
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
    // Timeouts sized for the shared box, NOT for speed. ExampleCo 2026-06-15:
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
  },
});
