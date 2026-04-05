import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts", "tests/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", "tests/**/*.pw.spec.ts", "tests/projects.spec.ts"],
  },
});
