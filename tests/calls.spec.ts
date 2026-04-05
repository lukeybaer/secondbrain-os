/**
 * Regression tests for src/main/calls.ts
 *
 * Strategy:
 *  - Mock `electron` (app.getPath) and `fs` so no real disk I/O occurs
 *  - Mock `fetch` globally so no real HTTP goes out
 *  - Mock `./personas` so persona look-ups are controllable
 *  - Import the module under test AFTER mocks are set up (vi.mock hoists)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import * as fsActual from "fs";

// ---------------------------------------------------------------------------
// vi.hoisted — values that must exist before vi.mock factory runs
// ---------------------------------------------------------------------------

// vi.mock factories are hoisted to the top of the file by Vitest's transform,
// so they execute before any top-level `const` declarations.  Use vi.hoisted
// to declare values that the mock factory needs.  Use require() here because
// ES import bindings are also not yet available when the hoisted block runs.
const { TEST_USER_DATA } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const _os = require("os") as typeof import("os");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const _path = require("path") as typeof import("path");
  return { TEST_USER_DATA: _path.join(_os.tmpdir(), "sb-calls-test-userdata") };
});

// ---------------------------------------------------------------------------
// Constants (derived — safe to declare after vi.hoisted)
// ---------------------------------------------------------------------------

const CALLS_DIR = path.join(TEST_USER_DATA, "data", "calls");

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

// Electron mock — config.ts calls app.getPath("userData") at module evaluation time
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((key: string) => {
      if (key === "userData") return TEST_USER_DATA;
      return os.tmpdir();
    }),
  },
}));

// Personas mock — listPersonas() is called inside calls.ts
vi.mock("../src/main/personas", () => ({
  listPersonas: vi.fn(() => []),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  initiateCall,
  refreshCallStatus,
  hangUpCall,
  markCallCompleted,
  loadCallRecord,
  listCallRecords,
  fetchAndSyncInboundCalls,
  syncCallbackAssistant,
  type CallRecord,
} from "../src/main/calls";
import { listPersonas } from "../src/main/personas";

// ---------------------------------------------------------------------------
// A stable test persona used across tests that need to reach the fetch layer.
// Using a persona takes the early-return path in buildSystemPrompt() and avoids
// the `voicemailSection` reference bug at line 152 of calls.ts.
// ---------------------------------------------------------------------------

const TEST_PERSONA = {
  id: "persona-test",
  name: "Test Agent",
  instructions: "You are a helpful test agent. Be concise.",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Nuke the calls directory so each test starts clean. */
function clearCallsDir() {
  if (fsActual.existsSync(CALLS_DIR)) {
    for (const f of fsActual.readdirSync(CALLS_DIR)) {
      try { fsActual.unlinkSync(path.join(CALLS_DIR, f)); } catch { /* ignore */ }
    }
  }
}

/** Build a minimal fetch Response-like object. */
function makeFetchResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

/** Write a CallRecord directly to disk (bypasses fetch). */
function seedCallRecord(record: CallRecord) {
  fsActual.mkdirSync(CALLS_DIR, { recursive: true });
  fsActual.writeFileSync(
    path.join(CALLS_DIR, `${record.id}.json`),
    JSON.stringify(record),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Global setup/teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Ensure userData directory exists (Electron would normally create this)
  fsActual.mkdirSync(TEST_USER_DATA, { recursive: true });
  clearCallsDir();
  vi.restoreAllMocks();

  // Reset config to a known baseline
  const { saveConfig } = await import("../src/main/config");
  saveConfig({
    vapiApiKey: "",
    vapiPhoneNumberId: "",
    callbackAssistantId: "",
    dataDir: path.join(TEST_USER_DATA, "data"),
  });

  // Default: no personas
  (listPersonas as ReturnType<typeof vi.fn>).mockReturnValue([]);
});

afterEach(() => {
  clearCallsDir();
});

// ──────────────────────────────────────────────────────────────────────────────
// initiateCall — config validation (no fetch needed, no persona needed)
// ──────────────────────────────────────────────────────────────────────────────

describe("initiateCall — config validation", () => {
  it("returns error when vapiApiKey is missing", async () => {
    const result = await initiateCall("+15551234567", "Book an appointment", "");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Vapi API key/i);
  });

  it("returns error message mentioning Phone Number ID", async () => {
    const result = await initiateCall("+15551234567", "Book an appointment", "");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Phone Number ID");
  });

  it("does not call fetch when config is incomplete", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    await initiateCall("+15551234567", "Reschedule meeting", "");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// initiateCall — successful outbound call (all use a persona to avoid the
// voicemailSection bug in the no-persona code path of buildSystemPrompt)
// ──────────────────────────────────────────────────────────────────────────────

describe("initiateCall — successful outbound call (with persona)", () => {
  beforeEach(async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key", vapiPhoneNumberId: "pn-test-id" });
    (listPersonas as ReturnType<typeof vi.fn>).mockReturnValue([TEST_PERSONA]);
  });

  it("calls the Vapi phone endpoint and returns callId + listenUrl", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse({
        id: "call-abc-123",
        status: "queued",
        monitor: { listenUrl: "wss://listen.vapi.ai/call-abc-123" },
      }) as any,
    );

    const result = await initiateCall(
      "+15551234567",
      "Reschedule the dentist",
      "My name is Luke",
      TEST_PERSONA.id,
    );
    expect(result.success).toBe(true);
    expect(result.callId).toBe("call-abc-123");
    expect(result.listenUrl).toBe("wss://listen.vapi.ai/call-abc-123");
  });

  it("normalizes phone numbers without leading + before sending to Vapi", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ id: "call-norm-456", status: "queued", monitor: {} }) as any,
    );

    await initiateCall("15559876543", "Test call", "", TEST_PERSONA.id);

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.customer.number).toBe("+15559876543");
  });

  it("persists a CallRecord to disk after a successful call", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ id: "call-persist-789", status: "queued", monitor: {} }) as any,
    );

    await initiateCall("+15550001111", "Follow up on invoice", "Company: Acme", TEST_PERSONA.id);

    const record = loadCallRecord("call-persist-789");
    expect(record).not.toBeNull();
    expect(record!.phoneNumber).toBe("+15550001111");
    expect(record!.instructions).toBe("Follow up on invoice");
    expect(record!.isCallback).toBeFalsy();
  });

  it("stores the personaId on the call record", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ id: "call-persona-store", status: "queued", monitor: {} }) as any,
    );

    await initiateCall("+15550001112", "Make a reservation", "", TEST_PERSONA.id);

    const record = loadCallRecord("call-persona-store");
    expect(record!.personaId).toBe(TEST_PERSONA.id);
  });

  it("stores leaveVoicemail flag on the call record", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ id: "call-voicemail-store", status: "queued", monitor: {} }) as any,
    );

    await initiateCall("+15550001113", "Check on order", "", TEST_PERSONA.id, true);

    const record = loadCallRecord("call-voicemail-store");
    expect(record!.leaveVoicemail).toBe(true);
  });

  it("returns network error when fetch throws", async () => {
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await initiateCall("+15551234567", "Test", "", TEST_PERSONA.id);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/network error/i);
  });

  it("returns Vapi error message on non-ok HTTP response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ message: "Invalid phone number format" }, false, 422) as any,
    );

    const result = await initiateCall("+15551234567", "Test", "", TEST_PERSONA.id);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid phone number format");
  });

  it("uses empty firstMessage when a persona is provided (persona owns the opener)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ id: "call-persona-001", status: "queued", monitor: {} }) as any,
    );

    await initiateCall("+15551234567", "Book a cleaning appointment", "", TEST_PERSONA.id);

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.assistant.firstMessage).toBe("");
  });

  it("uses the persona's instructions in the system prompt", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ id: "call-persona-sys", status: "queued", monitor: {} }) as any,
    );

    await initiateCall("+15551234567", "Request a refund", "", TEST_PERSONA.id);

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    const systemContent: string = body.assistant.model.messages[0].content;
    expect(systemContent).toContain(TEST_PERSONA.instructions.substring(0, 20));
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// initiateCall — no-persona path documents the known bug
// ──────────────────────────────────────────────────────────────────────────────

describe("initiateCall — no-persona path", () => {
  it("succeeds without a persona set", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key", vapiPhoneNumberId: "pn-test-id" });
    (listPersonas as ReturnType<typeof vi.fn>).mockReturnValue([]);

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ id: "call-no-persona", status: "queued", monitor: {} }) as any,
    );

    const result = await initiateCall("+15551234567", "Test no-persona path", "");
    expect(result.success).toBe(true);
    expect(result.callId).toBe("call-no-persona");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// refreshCallStatus
// ──────────────────────────────────────────────────────────────────────────────

describe("refreshCallStatus", () => {
  it("returns error when vapiApiKey is not configured", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "" });

    const result = await refreshCallStatus("call-xyz");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Vapi API key/i);
  });

  it("returns error when call record does not exist locally", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key" });

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ id: "call-missing", status: "ended" }) as any,
    );

    const result = await refreshCallStatus("call-missing");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it("updates the status field in the persisted record", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key", vapiPhoneNumberId: "pn-test-id" });

    // Seed record directly to avoid the voicemailSection bug
    seedCallRecord({
      id: "call-status-upd",
      createdAt: new Date().toISOString(),
      phoneNumber: "+15550002222",
      instructions: "Seed call",
      personalContext: "",
      status: "queued",
    });

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ id: "call-status-upd", status: "in-progress" }) as any,
    );

    const result = await refreshCallStatus("call-status-upd");
    expect(result.success).toBe(true);
    expect(result.record?.status).toBe("in-progress");

    const persisted = loadCallRecord("call-status-upd");
    expect(persisted?.status).toBe("in-progress");
  });

  it("clears listenUrl when call status becomes ended", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key", vapiPhoneNumberId: "pn-test-id" });

    seedCallRecord({
      id: "call-ended-clear",
      createdAt: new Date().toISOString(),
      phoneNumber: "+15550003333",
      instructions: "Test ended clear",
      personalContext: "",
      status: "in-progress",
      listenUrl: "wss://listen.vapi.ai/call-ended-clear",
    });

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse({
        id: "call-ended-clear",
        status: "ended",
        endedReason: "customer-ended-call",
      }) as any,
    );

    const result = await refreshCallStatus("call-ended-clear");
    expect(result.success).toBe(true);
    expect(result.record?.listenUrl).toBeUndefined();
  });

  it("calculates durationSeconds from startedAt / endedAt", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key", vapiPhoneNumberId: "pn-test-id" });

    seedCallRecord({
      id: "call-duration",
      createdAt: new Date().toISOString(),
      phoneNumber: "+15550004444",
      instructions: "Duration test",
      personalContext: "",
      status: "queued",
    });

    const startedAt = "2024-06-01T10:00:00.000Z";
    const endedAt = "2024-06-01T10:01:45.000Z"; // 105 seconds

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ id: "call-duration", status: "ended", startedAt, endedAt }) as any,
    );

    const result = await refreshCallStatus("call-duration");
    expect(result.success).toBe(true);
    expect(result.record?.durationSeconds).toBe(105);
  });

  it("preserves existing transcript when Vapi response has no transcript", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key" });

    seedCallRecord({
      id: "call-transcript-preserve",
      createdAt: new Date().toISOString(),
      phoneNumber: "+15550005050",
      instructions: "Transcript test",
      personalContext: "",
      status: "in-progress",
      transcript: "Original transcript text",
    });

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse({ id: "call-transcript-preserve", status: "in-progress" }) as any,
    );

    const result = await refreshCallStatus("call-transcript-preserve");
    expect(result.record?.transcript).toBe("Original transcript text");
  });

  it("returns network error when fetch throws", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key" });

    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("timeout"));

    const result = await refreshCallStatus("call-net-err");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/network error/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// hangUpCall
// ──────────────────────────────────────────────────────────────────────────────

describe("hangUpCall", () => {
  it("returns error when vapiApiKey is missing", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "" });

    const result = await hangUpCall("call-hangup-test");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Vapi API key/i);
  });

  it("sends DELETE to the Vapi call endpoint", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key" });

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({ ok: true } as any);

    const result = await hangUpCall("call-hangup-123");
    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.vapi.ai/call/call-hangup-123",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("returns success: false when network throws", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key" });

    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("timeout"));

    const result = await hangUpCall("call-hangup-err");
    expect(result.success).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// markCallCompleted
// ──────────────────────────────────────────────────────────────────────────────

describe("markCallCompleted", () => {
  it("returns null when call record does not exist", () => {
    const result = markCallCompleted("nonexistent-id", true);
    expect(result).toBeNull();
  });

  it("persists completed=true on an existing record", () => {
    seedCallRecord({
      id: "call-mark-done",
      createdAt: new Date().toISOString(),
      phoneNumber: "+15550005555",
      instructions: "Close the deal",
      personalContext: "",
      status: "ended",
    });

    const updated = markCallCompleted("call-mark-done", true);
    expect(updated).not.toBeNull();
    expect(updated!.completed).toBe(true);

    const persisted = loadCallRecord("call-mark-done");
    expect(persisted?.completed).toBe(true);
  });

  it("persists completed=false on an existing record", () => {
    seedCallRecord({
      id: "call-mark-incomplete",
      createdAt: new Date().toISOString(),
      phoneNumber: "+15550006666",
      instructions: "Schedule follow-up",
      personalContext: "",
      status: "ended",
    });

    const updated = markCallCompleted("call-mark-incomplete", false);
    expect(updated!.completed).toBe(false);

    const persisted = loadCallRecord("call-mark-incomplete");
    expect(persisted?.completed).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// listCallRecords
// ──────────────────────────────────────────────────────────────────────────────

describe("listCallRecords", () => {
  it("returns empty array when no records exist", () => {
    const records = listCallRecords();
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBe(0);
  });

  it("returns records sorted newest first by createdAt", () => {
    const older: CallRecord = {
      id: "call-older",
      createdAt: "2024-01-01T00:00:00.000Z",
      phoneNumber: "+15550001000",
      instructions: "Call A",
      personalContext: "",
      status: "ended",
    };
    const newer: CallRecord = {
      id: "call-newer",
      createdAt: "2024-06-01T00:00:00.000Z",
      phoneNumber: "+15550002000",
      instructions: "Call B",
      personalContext: "",
      status: "ended",
    };
    seedCallRecord(older);
    seedCallRecord(newer);

    const records = listCallRecords();
    expect(records.length).toBe(2);
    expect(records[0].id).toBe("call-newer");
    expect(records[1].id).toBe("call-older");
  });

  it("skips corrupted JSON files gracefully", () => {
    fsActual.mkdirSync(CALLS_DIR, { recursive: true });
    fsActual.writeFileSync(path.join(CALLS_DIR, "bad-record.json"), "{ not valid json", "utf-8");

    const records = listCallRecords();
    expect(records.length).toBe(0);
  });

  it("returns all records regardless of status", () => {
    seedCallRecord({ id: "r1", createdAt: "2024-01-01T00:00:00.000Z", phoneNumber: "+1555", instructions: "", personalContext: "", status: "queued" });
    seedCallRecord({ id: "r2", createdAt: "2024-01-02T00:00:00.000Z", phoneNumber: "+1556", instructions: "", personalContext: "", status: "ended" });
    seedCallRecord({ id: "r3", createdAt: "2024-01-03T00:00:00.000Z", phoneNumber: "+1557", instructions: "", personalContext: "", status: "in-progress" });

    const records = listCallRecords();
    expect(records.length).toBe(3);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// fetchAndSyncInboundCalls — inbound callback detection
// ──────────────────────────────────────────────────────────────────────────────

describe("fetchAndSyncInboundCalls", () => {
  it("does nothing when vapiApiKey or vapiPhoneNumberId is missing", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "", vapiPhoneNumberId: "" });

    const fetchSpy = vi.spyOn(global, "fetch");
    await fetchAndSyncInboundCalls();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("queries Vapi with phoneNumberId and limit=20", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key", vapiPhoneNumberId: "pn-test-id" });

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse([]) as any,
    );

    await fetchAndSyncInboundCalls();

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.vapi.ai/call?phoneNumberId=pn-test-id&limit=20",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer vapi-test-key" }) }),
    );
  });

  it("skips calls that are already tracked locally", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key", vapiPhoneNumberId: "pn-test-id" });

    seedCallRecord({
      id: "call-already-tracked",
      createdAt: "2024-06-01T00:00:00.000Z",
      phoneNumber: "+15550007777",
      instructions: "Already here",
      personalContext: "",
      status: "ended",
      isCallback: true,
    });

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse([
        { id: "call-already-tracked", type: "inboundPhoneCall", customer: { number: "+15550007777" }, status: "ended" },
        { id: "call-brand-new-inbound", type: "inboundPhoneCall", customer: { number: "+15550008888" }, status: "ended" },
      ]) as any,
    );

    await fetchAndSyncInboundCalls();

    // Already-tracked record should be unchanged (still 1 file)
    const unchanged = loadCallRecord("call-already-tracked");
    expect(unchanged!.id).toBe("call-already-tracked");

    // New inbound should now exist
    const newRecord = loadCallRecord("call-brand-new-inbound");
    expect(newRecord).not.toBeNull();
    expect(newRecord!.isCallback).toBe(true);
  });

  it("skips outboundPhoneCall entries (we create those ourselves)", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key", vapiPhoneNumberId: "pn-test-id" });

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse([
        { id: "call-outbound-skip", type: "outboundPhoneCall", customer: { number: "+15550009999" }, status: "ended" },
      ]) as any,
    );

    await fetchAndSyncInboundCalls();

    expect(loadCallRecord("call-outbound-skip")).toBeNull();
  });

  it("marks inbound record isCallback=true", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key", vapiPhoneNumberId: "pn-test-id" });

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse([
        {
          id: "call-inbound-flag",
          type: "inboundPhoneCall",
          customer: { number: "+15550010101" },
          status: "ended",
          createdAt: "2024-06-01T12:00:00.000Z",
        },
      ]) as any,
    );

    await fetchAndSyncInboundCalls();

    const record = loadCallRecord("call-inbound-flag");
    expect(record).not.toBeNull();
    expect(record!.isCallback).toBe(true);
  });

  it("inherits instructions from the most recent incomplete outbound call to the same number", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key", vapiPhoneNumberId: "pn-test-id" });

    seedCallRecord({
      id: "call-prior-outbound",
      createdAt: "2024-06-01T09:00:00.000Z",
      phoneNumber: "+15550011111",
      instructions: "Reschedule the dentist appointment",
      personalContext: "",
      status: "ended",
      completed: false,
    });

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse([
        {
          id: "call-callback-inherit",
          type: "inboundPhoneCall",
          customer: { number: "+15550011111" },
          status: "ended",
          createdAt: "2024-06-01T10:00:00.000Z",
        },
      ]) as any,
    );

    await fetchAndSyncInboundCalls();

    const callback = loadCallRecord("call-callback-inherit");
    expect(callback).not.toBeNull();
    expect(callback!.instructions).toBe("Reschedule the dentist appointment");
  });

  it("uses 'Inbound callback' as instructions when no prior outbound call exists", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key", vapiPhoneNumberId: "pn-test-id" });

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse([
        {
          id: "call-no-history",
          type: "inboundPhoneCall",
          customer: { number: "+15550099999" },
          status: "ended",
          createdAt: "2024-06-01T10:00:00.000Z",
        },
      ]) as any,
    );

    await fetchAndSyncInboundCalls();

    const record = loadCallRecord("call-no-history");
    expect(record).not.toBeNull();
    expect(record!.instructions).toBe("Inbound callback");
  });

  it("calculates durationSeconds correctly from startedAt/endedAt", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key", vapiPhoneNumberId: "pn-test-id" });

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse([
        {
          id: "call-inbound-dur",
          type: "inboundPhoneCall",
          customer: { number: "+15550012121" },
          status: "ended",
          startedAt: "2024-06-01T10:00:00.000Z",
          endedAt: "2024-06-01T10:02:30.000Z",  // 150 seconds
          createdAt: "2024-06-01T10:00:00.000Z",
        },
      ]) as any,
    );

    await fetchAndSyncInboundCalls();

    const record = loadCallRecord("call-inbound-dur");
    expect(record!.durationSeconds).toBe(150);
  });

  it("handles Vapi returning a paginated results wrapper { results: [] }", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key", vapiPhoneNumberId: "pn-test-id" });

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse({
        results: [
          {
            id: "call-wrapped-result",
            type: "inboundPhoneCall",
            customer: { number: "+15550013131" },
            status: "ended",
            createdAt: "2024-06-01T10:00:00.000Z",
          },
        ],
      }) as any,
    );

    await fetchAndSyncInboundCalls();

    const record = loadCallRecord("call-wrapped-result");
    expect(record).not.toBeNull();
    expect(record!.isCallback).toBe(true);
  });

  it("does nothing when fetch fails", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key", vapiPhoneNumberId: "pn-test-id" });

    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("network error"));

    // Should not throw
    await expect(fetchAndSyncInboundCalls()).resolves.toBeUndefined();
  });

  it("uses 'unknown' as phoneNumber when customer.number is absent", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key", vapiPhoneNumberId: "pn-test-id" });

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeFetchResponse([
        {
          id: "call-no-number",
          type: "inboundPhoneCall",
          customer: {},
          status: "ended",
          createdAt: "2024-06-01T10:00:00.000Z",
        },
      ]) as any,
    );

    await fetchAndSyncInboundCalls();

    const record = loadCallRecord("call-no-number");
    expect(record!.phoneNumber).toBe("unknown");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// syncCallbackAssistant
// ──────────────────────────────────────────────────────────────────────────────

describe("syncCallbackAssistant", () => {
  it("does nothing when vapiApiKey is missing", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "", callbackAssistantId: "asst-123" });

    const fetchSpy = vi.spyOn(global, "fetch");
    await syncCallbackAssistant("+15551234567");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does nothing when callbackAssistantId is missing", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({ vapiApiKey: "vapi-test-key", callbackAssistantId: "" });

    const fetchSpy = vi.spyOn(global, "fetch");
    await syncCallbackAssistant("+15551234567");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("PATCHes the Vapi assistant endpoint with a model+voice+firstMessage body", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({
      vapiApiKey: "vapi-test-key",
      callbackAssistantId: "asst-abc",
      vapiPhoneNumberId: "pn-test-id",
    });

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({ ok: true } as any);

    await syncCallbackAssistant("+15550014141");

    const patchCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === "string" && (url as string).includes("/assistant/asst-abc"),
    );
    expect(patchCall).toBeDefined();
    const [, init] = patchCall!;
    expect((init as RequestInit).method).toBe("PATCH");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBeDefined();
    expect(body.voice).toBeDefined();
    expect(body.firstMessage).toBeDefined();
    expect(body.model.messages[0].role).toBe("system");
  });

  it("system prompt mentions call history when prior ended calls exist for the number", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({
      vapiApiKey: "vapi-test-key",
      callbackAssistantId: "asst-history",
      vapiPhoneNumberId: "pn-test-id",
    });

    seedCallRecord({
      id: "call-hist-prior",
      createdAt: "2024-06-01T08:00:00.000Z",
      phoneNumber: "+15550015151",
      instructions: "Confirm the meeting time",
      personalContext: "",
      status: "ended",
      completed: false,
      summary: "Left voicemail",
    });

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({ ok: true } as any);

    await syncCallbackAssistant("+15550015151");

    const patchCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === "string" && (url as string).includes("/assistant/asst-history"),
    );
    const body = JSON.parse(((patchCall![1]) as RequestInit).body as string);
    const systemContent: string = body.model.messages[0].content;

    expect(systemContent).toContain("Confirm the meeting time");
    expect(systemContent).toContain("Left voicemail");
  });

  it("sets firstMessage to 'Hey, thanks for calling back!' when there are incomplete calls", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({
      vapiApiKey: "vapi-test-key",
      callbackAssistantId: "asst-firstmsg",
      vapiPhoneNumberId: "pn-test-id",
    });

    seedCallRecord({
      id: "call-incomplete-fm",
      createdAt: "2024-06-01T08:00:00.000Z",
      phoneNumber: "+15550016161",
      instructions: "Book a table for two",
      personalContext: "",
      status: "ended",
      completed: false,
    });

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({ ok: true } as any);

    await syncCallbackAssistant("+15550016161");

    const patchCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === "string" && (url as string).includes("/assistant/asst-firstmsg"),
    );
    const body = JSON.parse(((patchCall![1]) as RequestInit).body as string);
    expect(body.firstMessage).toBe("Hey, thanks for calling back!");
  });

  it("sets firstMessage to 'Hey there! Good to hear from you.' when all calls are completed", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({
      vapiApiKey: "vapi-test-key",
      callbackAssistantId: "asst-completed",
      vapiPhoneNumberId: "pn-test-id",
    });

    seedCallRecord({
      id: "call-completed-fm",
      createdAt: "2024-06-01T08:00:00.000Z",
      phoneNumber: "+15550016162",
      instructions: "Already done",
      personalContext: "",
      status: "ended",
      completed: true,
    });

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({ ok: true } as any);

    await syncCallbackAssistant("+15550016162");

    const patchCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === "string" && (url as string).includes("/assistant/asst-completed"),
    );
    const body = JSON.parse(((patchCall![1]) as RequestInit).body as string);
    expect(body.firstMessage).toBe("Hey there! Good to hear from you.");
  });

  it("sets firstMessage to generic greeting when no prior calls exist", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({
      vapiApiKey: "vapi-test-key",
      callbackAssistantId: "asst-nohist",
      vapiPhoneNumberId: "pn-test-id",
    });

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({ ok: true } as any);

    await syncCallbackAssistant("+15550000000");

    const patchCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === "string" && (url as string).includes("/assistant/asst-nohist"),
    );
    const body = JSON.parse(((patchCall![1]) as RequestInit).body as string);
    expect(body.firstMessage).toBe("Hello, how can I help you today?");
  });

  it("includes persona identity section in system prompt when latest call used a persona", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({
      vapiApiKey: "vapi-test-key",
      callbackAssistantId: "asst-persona",
      vapiPhoneNumberId: "pn-test-id",
    });

    (listPersonas as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: "persona-sarah",
        name: "Sarah",
        instructions: "You are Sarah, a warm and professional virtual assistant.",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    seedCallRecord({
      id: "call-persona-hist",
      createdAt: "2024-06-01T08:00:00.000Z",
      phoneNumber: "+15550017171",
      instructions: "Remind them about the upcoming appointment",
      personalContext: "",
      status: "ended",
      completed: false,
      personaId: "persona-sarah",
    });

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({ ok: true } as any);

    await syncCallbackAssistant("+15550017171");

    const patchCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === "string" && (url as string).includes("/assistant/asst-persona"),
    );
    const body = JSON.parse(((patchCall![1]) as RequestInit).body as string);
    const systemContent: string = body.model.messages[0].content;

    expect(systemContent).toContain("Sarah");
    // Must include the inbound override — agent is RECEIVING, not making the call
    expect(systemContent).toContain("RECEIVING");
  });

  it("also calls linkCallbackAssistantToPhoneNumber (PATCHes phone-number endpoint)", async () => {
    const { saveConfig } = await import("../src/main/config");
    saveConfig({
      vapiApiKey: "vapi-test-key",
      callbackAssistantId: "asst-link",
      vapiPhoneNumberId: "pn-link-id",
    });

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({ ok: true } as any);

    await syncCallbackAssistant("+15550018181");

    const phoneNumberPatch = fetchSpy.mock.calls.find(
      ([url]) => typeof url === "string" && (url as string).includes("/phone-number/pn-link-id"),
    );
    expect(phoneNumberPatch).toBeDefined();
    expect(((phoneNumberPatch![1]) as RequestInit).method).toBe("PATCH");
    const body = JSON.parse(((phoneNumberPatch![1]) as RequestInit).body as string);
    expect(body.assistantId).toBe("asst-link");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// loadCallRecord
// ──────────────────────────────────────────────────────────────────────────────

describe("loadCallRecord", () => {
  it("returns null for a non-existent call ID", () => {
    expect(loadCallRecord("no-such-id")).toBeNull();
  });

  it("returns null for a corrupted JSON file", () => {
    fsActual.mkdirSync(CALLS_DIR, { recursive: true });
    fsActual.writeFileSync(path.join(CALLS_DIR, "corrupt.json"), "NOT JSON", "utf-8");
    expect(loadCallRecord("corrupt")).toBeNull();
  });

  it("round-trips a CallRecord to disk and back", () => {
    const record: CallRecord = {
      id: "call-roundtrip",
      createdAt: "2024-06-01T10:00:00.000Z",
      phoneNumber: "+15550099011",
      instructions: "Round-trip test",
      personalContext: "Some context",
      status: "ended",
      isCallback: false,
    };
    seedCallRecord(record);

    const loaded = loadCallRecord("call-roundtrip");
    expect(loaded).not.toBeNull();
    expect(loaded!.instructions).toBe("Round-trip test");
    expect(loaded!.personalContext).toBe("Some context");
    expect(loaded!.phoneNumber).toBe("+15550099011");
    expect(loaded!.isCallback).toBe(false);
  });
});
