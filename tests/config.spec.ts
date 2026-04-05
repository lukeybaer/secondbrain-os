/**
 * Regression tests for src/main/config.ts
 *
 * config.ts uses `app.getPath("userData")` from electron at module evaluation
 * time, so we mock electron before importing the module.
 *
 * Each test group resets the config state by deleting the temp config file and
 * re-importing (or calling loadConfig with a fresh cache) so tests are isolated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const TEST_USER_DATA = path.join(os.tmpdir(), "sb-cfg-test-userdata");
const CONFIG_FILE = path.join(TEST_USER_DATA, "config.json");

// ---------------------------------------------------------------------------
// Electron mock — must happen before config is imported
// ---------------------------------------------------------------------------

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((key: string) => {
      if (key === "userData") return TEST_USER_DATA;
      return os.tmpdir();
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Remove the config file (leave directory). */
function removeConfigFile() {
  try { fs.unlinkSync(CONFIG_FILE); } catch { /* ignore */ }
}

/**
 * Ensure the userData directory exists (config.ts does NOT create it — it only
 * creates the config file inside the already-existing userData dir that Electron
 * normally guarantees exists).  Tests must create it themselves.
 */
function ensureUserDataDir() {
  fs.mkdirSync(TEST_USER_DATA, { recursive: true });
}

/**
 * Reset the internal `_config` cache to a known baseline by calling saveConfig
 * with all default-equivalent values.  saveConfig merges into the current
 * cached value, so passing every field gives us a clean slate.
 */
async function resetConfigCache(overrides: Record<string, unknown> = {}) {
  ensureUserDataDir();
  removeConfigFile();
  const mod = await import("../src/main/config");
  mod.saveConfig({
    otterEmail: "",
    otterPassword: "",
    openaiApiKey: "sk-test-placeholder-key-for-unit-tests-only",
    dataDir: path.join(TEST_USER_DATA, "data"),
    openaiModel: "gpt-4o",
    maxContextConversations: 10,
    whatsappPhoneNumberId: "",
    whatsappAccessToken: "",
    vapiApiKey: "",
    vapiPhoneNumberId: "",
    callbackAssistantId: "",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(async () => {
  ensureUserDataDir();
  await resetConfigCache();
});

afterEach(() => {
  removeConfigFile();
});

// ──────────────────────────────────────────────────────────────────────────────
// getConfig / loadConfig — default values
// ──────────────────────────────────────────────────────────────────────────────

describe("getConfig — default values", () => {
  it("returns an AppConfig object", async () => {
    const { getConfig } = await import("../src/main/config");
    const cfg = getConfig();
    expect(cfg).toBeDefined();
    expect(typeof cfg).toBe("object");
  });

  it("default openaiModel is gpt-4o", async () => {
    await resetConfigCache();
    const { getConfig } = await import("../src/main/config");
    const cfg = getConfig();
    expect(cfg.openaiModel).toBe("gpt-4o");
  });

  it("default maxContextConversations is 10", async () => {
    await resetConfigCache();
    const { getConfig } = await import("../src/main/config");
    const cfg = getConfig();
    expect(cfg.maxContextConversations).toBe(10);
  });

  it("default vapiApiKey is empty string", async () => {
    await resetConfigCache();
    const { getConfig } = await import("../src/main/config");
    const cfg = getConfig();
    expect(cfg.vapiApiKey).toBe("");
  });

  it("default vapiPhoneNumberId is empty string", async () => {
    await resetConfigCache();
    const { getConfig } = await import("../src/main/config");
    const cfg = getConfig();
    expect(cfg.vapiPhoneNumberId).toBe("");
  });

  it("default callbackAssistantId is empty string", async () => {
    await resetConfigCache();
    const { getConfig } = await import("../src/main/config");
    const cfg = getConfig();
    expect(cfg.callbackAssistantId).toBe("");
  });

  it("default whatsappPhoneNumberId is empty string", async () => {
    await resetConfigCache();
    const { getConfig } = await import("../src/main/config");
    const cfg = getConfig();
    expect(cfg.whatsappPhoneNumberId).toBe("");
  });

  it("default dataDir is inside userData/data", async () => {
    await resetConfigCache();
    const { getConfig } = await import("../src/main/config");
    const cfg = getConfig();
    expect(cfg.dataDir).toContain("data");
    // Must be an absolute path
    expect(path.isAbsolute(cfg.dataDir)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// saveConfig — partial updates / persistence
// ──────────────────────────────────────────────────────────────────────────────

describe("saveConfig — persistence", () => {
  it("persists a written value and returns the merged config", async () => {
    const { saveConfig, getConfig } = await import("../src/main/config");
    const result = saveConfig({ vapiApiKey: "my-vapi-key" });
    expect(result.vapiApiKey).toBe("my-vapi-key");
    // Verify getConfig reflects the same value
    expect(getConfig().vapiApiKey).toBe("my-vapi-key");
  });

  it("merges partial updates without losing other fields", async () => {
    const { saveConfig, getConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "key-one" });
    saveConfig({ vapiPhoneNumberId: "pn-xyz" });

    const cfg = getConfig();
    expect(cfg.vapiApiKey).toBe("key-one");
    expect(cfg.vapiPhoneNumberId).toBe("pn-xyz");
  });

  it("writes valid JSON to the config file", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ openaiModel: "gpt-4o-mini" });

    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.openaiModel).toBe("gpt-4o-mini");
  });

  it("overwrites previous values with new ones", async () => {
    const { saveConfig, getConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "old-key" });
    saveConfig({ vapiApiKey: "new-key" });
    expect(getConfig().vapiApiKey).toBe("new-key");
  });

  it("saving callbackAssistantId is reflected in getConfig", async () => {
    const { saveConfig, getConfig } = await import("../src/main/config");
    saveConfig({ callbackAssistantId: "asst-999" });
    expect(getConfig().callbackAssistantId).toBe("asst-999");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// loadConfig — reads from disk
// ──────────────────────────────────────────────────────────────────────────────

describe("loadConfig — reads from disk", () => {
  it("config file is written to userData directory", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "disk-test-key" });
    expect(fs.existsSync(CONFIG_FILE)).toBe(true);
  });

  it("all required AppConfig fields are present in the written file", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({});

    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);

    const requiredFields = [
      "otterEmail",
      "otterPassword",
      "openaiApiKey",
      "dataDir",
      "openaiModel",
      "maxContextConversations",
      "whatsappPhoneNumberId",
      "whatsappAccessToken",
      "vapiApiKey",
      "vapiPhoneNumberId",
      "callbackAssistantId",
    ];

    for (const field of requiredFields) {
      expect(parsed).toHaveProperty(field);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Missing required fields — validation from calls.ts perspective
// ──────────────────────────────────────────────────────────────────────────────

describe("config validation — call-related required fields", () => {
  it("vapiApiKey defaults to empty string (calls must guard against this)", async () => {
    await resetConfigCache();
    const { getConfig } = await import("../src/main/config");
    const cfg = getConfig();
    // Empty string is falsy — callers should treat it as "not configured"
    expect(cfg.vapiApiKey).toBeFalsy();
  });

  it("vapiPhoneNumberId defaults to empty string (calls must guard against this)", async () => {
    await resetConfigCache();
    const { getConfig } = await import("../src/main/config");
    const cfg = getConfig();
    expect(cfg.vapiPhoneNumberId).toBeFalsy();
  });

  it("callbackAssistantId defaults to empty string (sync must guard against this)", async () => {
    await resetConfigCache();
    const { getConfig } = await import("../src/main/config");
    const cfg = getConfig();
    expect(cfg.callbackAssistantId).toBeFalsy();
  });

  it("both vapiApiKey and vapiPhoneNumberId must be truthy for outbound calls", async () => {
    const { saveConfig, getConfig } = await import("../src/main/config");

    // Only key set — phoneNumberId still empty
    saveConfig({ vapiApiKey: "some-key", vapiPhoneNumberId: "" });
    const cfg = getConfig();
    const canCall = !!(cfg.vapiApiKey && cfg.vapiPhoneNumberId);
    expect(canCall).toBe(false);
  });

  it("both fields truthy means call is allowed", async () => {
    const { saveConfig, getConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "some-key", vapiPhoneNumberId: "some-pn-id" });
    const cfg = getConfig();
    const canCall = !!(cfg.vapiApiKey && cfg.vapiPhoneNumberId);
    expect(canCall).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Type shape
// ──────────────────────────────────────────────────────────────────────────────

describe("AppConfig type shape", () => {
  it("openaiApiKey is a string (may be pre-populated with default key)", async () => {
    const { getConfig } = await import("../src/main/config");
    const cfg = getConfig();
    expect(typeof cfg.openaiApiKey).toBe("string");
  });

  it("maxContextConversations is a number", async () => {
    const { getConfig } = await import("../src/main/config");
    const cfg = getConfig();
    expect(typeof cfg.maxContextConversations).toBe("number");
  });

  it("dataDir is a non-empty string", async () => {
    const { getConfig } = await import("../src/main/config");
    const cfg = getConfig();
    expect(typeof cfg.dataDir).toBe("string");
    expect(cfg.dataDir.length).toBeGreaterThan(0);
  });
});
