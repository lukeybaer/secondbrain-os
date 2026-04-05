import { defineConfig } from "vitest/config";

/**
 * Vitest config for main-process unit tests (calls, config, etc.)
 * Run with: npx vitest run --config vitest.unit.config.ts
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/calls.spec.ts",
      "tests/config.spec.ts",
      "src/**/__tests__/**/*.test.ts",
    ],
    // Give modules time to settle for async electron mock setup
    testTimeout: 15000,
  },
});
