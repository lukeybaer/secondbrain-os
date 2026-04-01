import { defineConfig } from "@playwright/test";
import path from "path";
import os from "os";

// Playwright stores browsers under %LOCALAPPDATA%\ms-playwright on Windows.
// Set the env var here so tests work without needing it set externally.
const localAppData = process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local");
process.env["PLAYWRIGHT_BROWSERS_PATH"] = path.join(localAppData, "ms-playwright");

export default defineConfig({
  testDir: "./tests",
  // Only pick up .pw.spec.ts files — avoids colliding with vitest .spec.ts tests
  // that also live in tests/ and import from "vitest".
  testMatch: "**/*.pw.spec.ts",
  timeout: 30000,
  retries: 0,
  use: {
    headless: true,
  },
  reporter: [["list"]],
});
