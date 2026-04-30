import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'tests/**/*.spec.ts'],
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      'tests/**/*.pw.spec.ts',
      'tests/projects.spec.ts',
    ],
    // Bumped from the 5000ms default. Several tests (backups, integration
    // tests that hit disk, llm-routing-guard file walks) legitimately run
    // in the 2-5s range in isolation and tip over the 5s timeout under
    // parallel worker contention on Windows. 20s gives comfortable headroom
    // without masking real slowness.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
