import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Electron main-process code is Node.js — the renderer (jsdom) is tested
    // separately via Playwright (*.pw.spec.ts, run by `npm run test:e2e`).
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'tests/**/*.spec.ts'],
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      'tests/**/*.pw.spec.ts',
      'tests/projects.spec.ts',
    ],
    // We import vitest helpers explicitly (`import { describe, it } from
    // 'vitest'`). No ambient globals → cleaner test files and no implicit
    // dependency on vitest types being world-visible.
    globals: false,
    // Tests that mock `electron` (via vi.mock) keep module-scope mock state
    // (e.g. a rotating `testRoot`). Threads share the V8 module registry
    // across files in the same worker, so a mock set by one file can leak
    // into another. Forks give a clean process per test file at modest cost
    // (~1-2s on this suite), which is well worth the determinism.
    pool: 'forks',
    // Default is true but make it explicit: each test file gets its own
    // module registry, no cross-file globals leak.
    isolate: true,
    // Auto-clear `.mock.calls` and `.mock.results` between tests so call-
    // count assertions don't accidentally see prior-test data. Does NOT
    // reset implementations (use `mockReset: true` for that, but that
    // would clobber `beforeAll` mock implementations).
    clearMocks: true,
    // Bumped from the 5000ms default. Several tests (backups, integration
    // tests that hit disk, llm-routing-guard file walks) legitimately run
    // in the 2-5s range in isolation and tip over the 5s timeout under
    // parallel worker contention on Windows. 20s gives comfortable headroom
    // without masking real slowness.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
