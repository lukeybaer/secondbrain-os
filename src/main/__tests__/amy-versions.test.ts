/**
 * Tests for Amy versioning system — version CRUD, skill catalog,
 * prompt building, tool generation, and data snapshots.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Mock Electron's app module ───────────────────────────────────────────────

let testRoot: string;

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return testRoot;
      return testRoot;
    },
  },
}));

// Mock agent-memory to avoid file system dependencies
vi.mock("../agent-memory", () => ({
  getAgentMemory: () => ({
    buildSystemPrompt: async (base: string) => base + "\n[EA MEMORY INJECTED]",
  }),
}));

// Mock personas
vi.mock("../personas", () => ({
  listPersonas: () => [
    { id: "p1", name: "Test Persona", instructions: "You are a test persona." },
  ],
}));

// Mock projects
vi.mock("../projects", () => ({
  listProjects: () => [
    {
      id: "proj1",
      name: "Test Project",
      status: "in-progress",
      tasks: [
        { id: "t1", title: "Task 1", status: "done" },
        { id: "t2", title: "Task 2", status: "todo" },
        { id: "t3", title: "Task 3", status: "needs-follow-up" },
      ],
    },
  ],
}));

// Mock todos
vi.mock("../todos", () => ({
  listTodos: () => [
    { id: "td1", title: "Buy groceries", status: "pending", priority: "high", assignee: "Luke" },
    { id: "td2", title: "Deploy v2", status: "pending", priority: "medium", assignee: "Amy" },
    { id: "td3", title: "Old task", status: "done", priority: "low" },
  ],
}));

// Mock calls
vi.mock("../calls", () => ({
  listCallRecords: () => [
    { id: "c1", phoneNumber: "+15551234567", instructions: "Call dentist", status: "ended", completed: true, createdAt: "2025-04-01T00:00:00Z" },
  ],
}));

// Mock config
vi.mock("../config", () => ({
  getConfig: () => ({
    dataDir: path.join(testRoot, "data"),
    ec2BaseUrl: "https://ea.pixseat.com",
    vapiApiKey: "test-key",
    vapiPhoneNumberId: "test-phone",
    amyVersion: 2,
  }),
  loadConfig: () => ({}),
  saveConfig: () => ({}),
}));

import {
  listAmyVersions,
  getAmyVersion,
  getActiveAmyVersion,
  saveAmyVersion,
  buildVersionedSystemPrompt,
  getToolsForVersion,
  getLlmConfigForVersion,
  buildVapiAssistantConfig,
  buildDataSnapshot,
} from "../amy-versions";

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amy-test-"));
  fs.mkdirSync(path.join(testRoot, "data"), { recursive: true });
});

afterAll(() => {
  // Cleanup happens naturally via OS temp cleanup
});

describe("Amy Versions", () => {
  describe("listAmyVersions", () => {
    it("returns built-in versions (v1, v2, v3)", () => {
      const versions = listAmyVersions();
      expect(versions.length).toBeGreaterThanOrEqual(3);
      expect(versions[0].version).toBe(1);
      expect(versions[1].version).toBe(2);
      expect(versions[2].version).toBe(3);
    });

    it("v1 is Classic, v2 is Skill-Aware, v3 is Claude-Powered", () => {
      const versions = listAmyVersions();
      expect(versions[0].name).toContain("Classic");
      expect(versions[1].name).toContain("Skill-Aware");
      expect(versions[2].name).toContain("Claude-Powered");
    });
  });

  describe("getAmyVersion", () => {
    it("returns correct version by number", () => {
      const v2 = getAmyVersion(2);
      expect(v2).not.toBeNull();
      expect(v2!.version).toBe(2);
      expect(v2!.name).toContain("Skill-Aware");
    });

    it("returns null for nonexistent version", () => {
      expect(getAmyVersion(99)).toBeNull();
    });
  });

  describe("getActiveAmyVersion", () => {
    it("returns v2 by default", () => {
      const active = getActiveAmyVersion();
      expect(active.version).toBe(2);
    });
  });

  describe("saveAmyVersion", () => {
    it("persists a custom version to disk", () => {
      const custom = {
        ...getAmyVersion(2)!,
        version: 4,
        name: "Amy v4 — Custom",
        description: "Custom test version",
      };
      saveAmyVersion(custom);

      const versions = listAmyVersions();
      const v4 = versions.find(v => v.version === 4);
      expect(v4).toBeDefined();
      expect(v4!.name).toBe("Amy v4 — Custom");
    });
  });

  describe("Skill Catalog", () => {
    it("v1 has limited skills", () => {
      const v1 = getAmyVersion(1)!;
      expect(v1.skills.length).toBeLessThan(10);
      expect(v1.skills.some(s => s.name === "Search Knowledge")).toBe(true);
      expect(v1.skills.some(s => s.name === "Check Project Status")).toBe(false);
    });

    it("v2 has full skill catalog including project/todo queries", () => {
      const v2 = getAmyVersion(2)!;
      expect(v2.skills.some(s => s.name === "Check Project Status")).toBe(true);
      expect(v2.skills.some(s => s.name === "Check Todos")).toBe(true);
      expect(v2.skills.some(s => s.name === "Manage Tasks")).toBe(true);
      expect(v2.skills.some(s => s.name === "Answer Questions")).toBe(true);
    });

    it("skills have proper availability flags", () => {
      const v2 = getAmyVersion(2)!;
      const ready = v2.skills.filter(s => s.availability === "ready");
      const coming = v2.skills.filter(s => s.availability === "coming_soon");
      expect(ready.length).toBeGreaterThan(5);
      expect(coming.length).toBeGreaterThan(0);
      expect(coming.some(s => s.name === "Check Calendar")).toBe(true);
    });
  });

  describe("Tool Generation", () => {
    it("v1 has basic tools (dtmf + 5 functions)", () => {
      const v1 = getAmyVersion(1)!;
      const tools = getToolsForVersion(v1);
      const funcTools = tools.filter((t: any) => t.type === "function");
      expect(tools.some((t: any) => t.type === "dtmf")).toBe(true);
      expect(funcTools.length).toBe(5); // run_claude_code, query_knowledge, request_approval, flag_reputation_risk, bridge_in_luke
    });

    it("v2 has expanded tools including project/todo queries", () => {
      const v2 = getAmyVersion(2)!;
      const tools = getToolsForVersion(v2);
      const funcNames = tools
        .filter((t: any) => t.type === "function")
        .map((t: any) => t.function.name);
      expect(funcNames).toContain("check_project_status");
      expect(funcNames).toContain("check_todos");
      expect(funcNames).toContain("manage_task");
      expect(funcNames).toContain("send_message");
    });
  });

  describe("LLM Config", () => {
    it("v1 and v2 use OpenAI gpt-4o", () => {
      const v1Config = getLlmConfigForVersion(getAmyVersion(1)!);
      const v2Config = getLlmConfigForVersion(getAmyVersion(2)!);
      expect(v1Config.provider).toBe("openai");
      expect(v1Config.model).toBe("gpt-4o");
      expect(v2Config.provider).toBe("openai");
    });

    it("v3 uses custom-llm with Claude model (falls back to openai if no endpoint)", () => {
      const v3 = getAmyVersion(3)!;
      const config = getLlmConfigForVersion(v3);
      // v3 has custom-llm but no endpoint set → falls back to openai provider
      expect(config.model).toContain("claude");
    });
  });

  describe("Prompt Building", () => {
    it("includes skill catalog in v2 prompt", async () => {
      const v2 = getAmyVersion(2)!;
      const prompt = await buildVersionedSystemPrompt(v2, {
        instructions: "Check project status",
        callDirection: "inbound",
      });
      expect(prompt).toContain("Your Capabilities");
      expect(prompt).toContain("Check Project Status");
      expect(prompt).toContain("Check Todos");
      expect(prompt).toContain("Answer Questions");
    });

    it("includes Amy identity in v2 prompt", async () => {
      const v2 = getAmyVersion(2)!;
      const prompt = await buildVersionedSystemPrompt(v2, {
        callDirection: "outbound",
      });
      expect(prompt).toContain("Amy");
      expect(prompt).toContain("executive assistant");
    });

    it("includes integrity rules", async () => {
      const v2 = getAmyVersion(2)!;
      const prompt = await buildVersionedSystemPrompt(v2, {
        callDirection: "outbound",
      });
      expect(prompt).toContain("NEVER fabricate");
      expect(prompt).toContain("NEVER guess at numbers");
    });

    it("includes proactive update rules", async () => {
      const v2 = getAmyVersion(2)!;
      const prompt = await buildVersionedSystemPrompt(v2, {
        callDirection: "outbound",
      });
      expect(prompt).toContain("Proactive Updates");
      expect(prompt).toContain("ONLY when he explicitly asks");
    });

    it("uses persona instructions when provided", async () => {
      const v2 = getAmyVersion(2)!;
      const prompt = await buildVersionedSystemPrompt(v2, {
        personaInstructions: "You are Dr. Smith's office calling.",
        callDirection: "outbound",
        instructions: "Schedule appointment",
      });
      expect(prompt).toContain("Dr. Smith");
      expect(prompt).toContain("Schedule appointment");
    });

    it("injects EA memory", async () => {
      const v2 = getAmyVersion(2)!;
      const prompt = await buildVersionedSystemPrompt(v2, {
        callDirection: "outbound",
      });
      expect(prompt).toContain("[EA MEMORY INJECTED]");
    });
  });

  describe("Vapi Assistant Config", () => {
    it("builds complete outbound config with serverUrl", async () => {
      const v2 = getAmyVersion(2)!;
      const config = await buildVapiAssistantConfig(v2, {
        instructions: "Call about appointment",
        personalContext: "Prefers morning slots",
        callDirection: "outbound",
        leaveVoicemail: false,
      });
      expect(config.model).toBeDefined();
      expect(config.voice).toBeDefined();
      expect(config.tools).toBeDefined();
      expect(config.endCallPhrases).toContain("goodbye");
      expect(config.serverUrl).toContain("pixseat.com");
    });

    it("builds inbound config", async () => {
      const v2 = getAmyVersion(2)!;
      const config = await buildVapiAssistantConfig(v2, {
        callDirection: "inbound",
        callerPhone: "+15551234567",
      });
      expect(config.firstMessage).toContain("thanks for calling");
      expect(config.tools.length).toBeGreaterThan(5);
    });
  });

  describe("Data Snapshot", () => {
    it("includes projects, todos, and recent calls", async () => {
      const snapshot = await buildDataSnapshot();
      expect(snapshot.projects).toHaveLength(1);
      expect(snapshot.projects[0].name).toBe("Test Project");
      expect(snapshot.todos).toHaveLength(3);
      expect(snapshot.recentCalls).toHaveLength(1);
      expect(snapshot.amyVersion).toBe(2);
      expect(snapshot.timestamp).toBeDefined();
    });

    it("strips unnecessary call data from snapshot", async () => {
      const snapshot = await buildDataSnapshot();
      const call = snapshot.recentCalls[0];
      expect(call.id).toBe("c1");
      expect(call.instructions).toBe("Call dentist");
      // Should not include full transcript or personalContext
      expect(call).not.toHaveProperty("transcript");
      expect(call).not.toHaveProperty("personalContext");
    });
  });

  describe("Proactive Config", () => {
    it("v1 has proactive disabled", () => {
      const v1 = getAmyVersion(1)!;
      expect(v1.proactive.enabled).toBe(false);
    });

    it("v2+ has proactive enabled but only when explicitly asked", () => {
      const v2 = getAmyVersion(2)!;
      expect(v2.proactive.enabled).toBe(true);
      expect(v2.proactive.onlyWhenExplicitlyAsked).toBe(true);
      expect(v2.proactive.channels).toContain("telegram");
    });
  });
});
