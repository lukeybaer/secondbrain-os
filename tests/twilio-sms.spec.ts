/**
 * Unit tests for src/main/twilio-sms.ts
 *
 * Strategy:
 *  - Mock `electron` (app.getPath) and `fs` so no real disk I/O occurs
 *  - Mock `fetch` globally so no real HTTP goes out
 *  - Mock `./config` to control Twilio credentials
 *  - Import the module under test AFTER mocks are set up
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";

const { TEST_USER_DATA } = vi.hoisted(() => {
  const _os = require("os") as typeof import("os");
  const _path = require("path") as typeof import("path");
  return { TEST_USER_DATA: _path.join(_os.tmpdir(), "sb-sms-test-userdata") };
});

const SMS_DIR = path.join(TEST_USER_DATA, "data", "sms");

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("electron", () => ({
  app: { getPath: (key: string) => (key === "userData" ? TEST_USER_DATA : TEST_USER_DATA) },
}));

const mockConfig = {
  twilioAccountSid: "ACtest123",
  twilioAuthToken: "authtoken456",
  twilioPhoneNumber: "+15551234567",
  dataDir: path.join(TEST_USER_DATA, "data"),
};

vi.mock("../src/main/config", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
}));

// Mock storage to capture saved messages
const savedMessages: any[] = [];
vi.mock("../src/main/storage", () => ({
  saveSmsMessage: (msg: any) => { savedMessages.push(msg); },
  listSmsMessages: () => savedMessages,
  searchSmsMessages: (q: string) => savedMessages.filter(m => m.body?.toLowerCase().includes(q.toLowerCase())),
  ensureDataDirs: () => {},
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Import under test ───────────────────────────────────────────────────────

import { sendSms, parseTwilioWebhook, ingestSmsWebhook } from "../src/main/twilio-sms";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("twilio-sms", () => {
  beforeEach(() => {
    savedMessages.length = 0;
    mockFetch.mockReset();
  });

  describe("sendSms", () => {
    it("sends with correct Basic Auth and form body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sid: "SM_test_123" }),
      });

      const result = await sendSms("+15559876543", "Hello test");

      expect(result.success).toBe(true);
      expect(result.messageId).toBe("SM_test_123");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("ACtest123/Messages.json");
      expect(opts.headers.Authorization).toMatch(/^Basic /);
      expect(opts.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

      // Decode Basic Auth
      const decoded = Buffer.from(opts.headers.Authorization.replace("Basic ", ""), "base64").toString();
      expect(decoded).toBe("ACtest123:authtoken456");

      // Check form body
      const params = new URLSearchParams(opts.body);
      expect(params.get("To")).toBe("+15559876543");
      expect(params.get("From")).toBe("+15551234567");
      expect(params.get("Body")).toBe("Hello test");
    });

    it("saves outbound message on success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sid: "SM_save_test" }),
      });

      await sendSms("5559876543", "Save this");

      expect(savedMessages).toHaveLength(1);
      expect(savedMessages[0].source).toBe("outbound");
      expect(savedMessages[0].body).toBe("Save this");
      expect(savedMessages[0].messageId).toBe("SM_save_test");
    });

    it("returns error when config is missing", async () => {
      const origSid = mockConfig.twilioAccountSid;
      mockConfig.twilioAccountSid = "";

      const result = await sendSms("+15559876543", "Should fail");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Twilio Account SID");
      expect(mockFetch).not.toHaveBeenCalled();

      mockConfig.twilioAccountSid = origSid;
    });

    it("returns error on API failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ message: "Invalid phone number" }),
      });

      const result = await sendSms("+15559876543", "Fail");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid phone number");
    });

    it("normalizes phone number (strips non-digits)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sid: "SM_normalized" }),
      });

      await sendSms("(555) 987-6543", "Normalize test");

      const params = new URLSearchParams(mockFetch.mock.calls[0][1].body);
      expect(params.get("To")).toBe("+5559876543");
    });
  });

  describe("parseTwilioWebhook", () => {
    it("parses a text-only inbound message", () => {
      const fields = {
        MessageSid: "SM_inbound_1",
        From: "+15551112222",
        To: "+15551234567",
        Body: "Hey there",
        NumMedia: "0",
      };

      const msg = parseTwilioWebhook(fields);

      expect(msg).not.toBeNull();
      expect(msg!.messageId).toBe("SM_inbound_1");
      expect(msg!.source).toBe("inbound");
      expect(msg!.from).toBe("+15551112222");
      expect(msg!.body).toBe("Hey there");
    });

    it("parses MMS with media attachments", () => {
      const fields = {
        MessageSid: "SM_mms_1",
        From: "+15551112222",
        To: "+15551234567",
        Body: "Check this out",
        NumMedia: "2",
        MediaUrl0: "https://api.twilio.com/media/img1.jpg",
        MediaContentType0: "image/jpeg",
        MediaUrl1: "https://api.twilio.com/media/vid1.mp4",
        MediaContentType1: "video/mp4",
      };

      const msg = parseTwilioWebhook(fields);

      expect(msg).not.toBeNull();
      expect(msg!.mediaUrls).toHaveLength(2);
      expect(msg!.mediaTypes).toEqual(["image/jpeg", "video/mp4"]);
    });

    it("returns null for malformed input (no MessageSid)", () => {
      const msg = parseTwilioWebhook({ From: "+1555", Body: "bad" });
      expect(msg).toBeNull();
    });

    it("includes city/state as contactName when available", () => {
      const fields = {
        MessageSid: "SM_city",
        From: "+15551112222",
        To: "+15551234567",
        Body: "Hi",
        NumMedia: "0",
        FromCity: "McKinney",
        FromState: "TX",
      };

      const msg = parseTwilioWebhook(fields);
      expect(msg!.contactName).toBe("McKinney, TX");
    });
  });

  describe("ingestSmsWebhook", () => {
    it("saves parsed message and returns count 1", async () => {
      const fields = {
        MessageSid: "SM_ingest_1",
        From: "+15551112222",
        To: "+15551234567",
        Body: "Ingest me",
        NumMedia: "0",
      };

      const result = await ingestSmsWebhook(fields);

      expect(result.count).toBe(1);
      expect(result.message).not.toBeNull();
      expect(savedMessages).toHaveLength(1);
      expect(savedMessages[0].body).toBe("Ingest me");
    });

    it("returns count 0 for malformed input", async () => {
      const result = await ingestSmsWebhook({ bogus: "data" });
      expect(result.count).toBe(0);
      expect(result.message).toBeNull();
    });
  });
});
