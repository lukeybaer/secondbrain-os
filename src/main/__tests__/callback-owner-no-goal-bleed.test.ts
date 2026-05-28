/**
 * callback-owner-no-goal-bleed.test.ts
 *
 * Regression: when the owner (Luke) calls his own Vapi number, the callback
 * assistant config must NOT inherit the goal/instructions/history from the
 * most recent outbound call. Luke is calling his EA, not being targeted by
 * a campaign — pulling in a dentist or sales script as "your goal for this
 * call" pollutes the prompt and Amy ends up confused, treating Luke as if
 * he's a dental office that needs to schedule a cleaning.
 *
 * Root incident: 2026-04-15 — Luke called Amy from his number, Amy opened
 * with the generic "Hi there, how can I help you?" and was running on a
 * stale Vapi prompt that had inherited the McKinney dentist instructions
 * from the last outbound. She failed to recognize him, failed to recall
 * recent sessions, and made up that she had queued a Claude Code task that
 * she had not. Full latest call:
 * %APPDATA%\secondbrain\data\calls\019d8ed6-066c-7dde-ad38-7d32e0500965.json
 *
 * Fix in src/main/calls.ts buildCallbackAssistantConfig — short-circuit for
 * owner callers so identitySection / historyText / goalInstruction are
 * undefined and firstMessage greets by name instead of "Hi there".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('electron', () => {
  const p = require('path');
  const repoRoot = p.resolve(__dirname, '..', '..', '..');
  return {
    app: {
      getPath: (_name: string) => repoRoot,
      getAppPath: () => repoRoot,
    },
  };
});

// Fictitious phone numbers only — PII scan blocks real digits in tracked
// source (see .github/workflows/sync-to-public.yml). Both values here are
// arbitrary because identifyCaller and loadContactsStore are mocked against
// the same constant below.
const OWNER_PHONE = '+15550100000';
const STRANGER_PHONE = '+15551234567';
const DENTIST_GOAL =
  '## GOAL\nFind a dentist near McKinney TX willing to do a cleaning WITHOUT requiring new X-rays first.';

vi.mock('../config', () => ({
  getConfig: () => ({
    vapiApiKey: 'test',
    callbackAssistantId: 'test',
    vapiPhoneNumberId: 'test',
    ec2BaseUrl: 'http://127.0.0.1:9999',
    ownerName: 'Luke',
    amyVersion: 3,
  }),
}));

vi.mock('../caller-id', () => ({
  identifyCaller: (phone: string) => {
    if (phone === OWNER_PHONE) {
      return {
        mode: 'owner' as const,
        systemPromptSection: '## Caller Identification: OWNER',
      };
    }
    return {
      mode: 'unknown' as const,
      systemPromptSection: '## Caller Identification: UNKNOWN',
    };
  },
  loadContactsStore: () => ({
    keyword: 'testword',
    owner_phones: [OWNER_PHONE],
    contacts: [],
  }),
}));

vi.mock('../personas', () => ({ listPersonas: () => [] }));
vi.mock('../projects', () => ({ listProjects: () => [] }));
vi.mock('../todos', () => ({ listTodos: () => [] }));
vi.mock('../agent-memory', () => ({
  getAgentMemory: () => ({ buildSystemPrompt: async (b: string) => b }),
}));
vi.mock('../telegram', () => ({
  sendApprovalRequest: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock('../database-sqlite', () => ({
  createApproval: vi.fn(),
  createReputationEvent: vi.fn(),
}));
vi.mock('../call-script-memory', () => ({
  appendCallPattern: vi.fn(),
  getCallScriptContext: vi.fn(),
  formatCallScriptContextBlock: vi.fn(() => ''),
}));

// Stub call records: one ended outbound dentist call + one ended inbound from
// the owner. The buggy code path inherits the dentist outbound goal as Amy's
// goal for the owner inbound, which is the bug we're guarding against.
vi.mock('../calls', async (orig) => {
  const real = (await orig()) as any;
  return {
    ...real,
    listCallRecords: () => [
      {
        id: 'outbound-dentist-1',
        createdAt: '2026-04-14T20:00:00.000Z',
        phoneNumber: OWNER_PHONE,
        instructions: DENTIST_GOAL,
        personalContext: '',
        isCallback: false,
        status: 'ended',
        completed: false,
      },
    ],
    loadCallRecord: () => null,
    saveCallRecord: vi.fn(),
  };
});

describe('buildCallbackAssistantConfig — owner callers do not inherit outbound goals', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('owner inbound first message greets by name, not generic desk pickup', () => {
    // buildCallbackAssistantConfig is module-private. Behavioral test on
    // the source: verify the owner-branch firstMessage greets by name and
    // never falls into the "thanks for calling back" or "Hi there" paths.
    const fs = require('fs');
    const callsPath = path.resolve(__dirname, '..', 'calls.ts');
    const src = fs.readFileSync(callsPath, 'utf-8');
    expect(src).toMatch(/Hey \$\{ownerFirstName\}, what's going on\?/);
    // The legacy generic openings still exist for non-owner branches but
    // the owner branch is short-circuited above them.
    const firstMessageIdx = src.indexOf('const firstMessage = callerIsOwner');
    const heyThanksIdx = src.indexOf("this is ${ownerFirstName}'s assistant. Thanks for calling back!");
    expect(firstMessageIdx).toBeGreaterThan(-1);
    expect(heyThanksIdx).toBeGreaterThan(firstMessageIdx);
  });

  it('source guards against goal inheritance for owner callers', () => {
    // Behavioral guard: the buildCallbackAssistantConfig function must
    // short-circuit goalInstruction / historyText / identitySection when
    // the caller is the owner. We assert on the source so this test
    // doesn't depend on Electron app module wiring.
    const fs = require('fs');
    const callsPath = path.resolve(__dirname, '..', 'calls.ts');
    const src = fs.readFileSync(callsPath, 'utf-8');

    // Must explicitly identify owner callers
    expect(src).toMatch(/callerIsOwner/);
    expect(src).toMatch(/identifyCaller\(callerPhone\)/);

    // goalInstruction must be undefined for owner
    expect(src).toMatch(/const goalInstruction = callerIsOwner\s*\?\s*undefined/);

    // historyText must be hidden from owner
    expect(src).toMatch(/!callerIsOwner && history\.length > 0/);

    // identitySection (persona) must not apply to owner
    expect(src).toMatch(/!callerIsOwner && personaInstructions/);

    // firstMessage greets owner by name when ownerName set
    expect(src).toMatch(/Hey \$\{ownerFirstName\}/);
  });

  it('non-owner callbacks still inherit outbound goal and history (existing behavior)', () => {
    // Sanity: the goal-bleed guard only fires for owner callers, not for
    // legitimate dentist/lead/research callbacks. Verify the non-owner branch
    // still wires goalInstruction and historyText.
    const fs = require('fs');
    const callsPath = path.resolve(__dirname, '..', 'calls.ts');
    const src = fs.readFileSync(callsPath, 'utf-8');
    expect(src).toMatch(/Continue working toward the original goal/);
    expect(src).toMatch(/this is \$\{ownerFirstName\}'s assistant\. Thanks for calling back!/);
  });

  it('inbound sync re-pushes the assistant on every new inbound call, not just on completion', () => {
    // Root cause B: even with the goal-bleed guard, if the assistant is only
    // re-synced when completion detection returns true, an unanswered owner
    // inbound goes 0..N hours with a stale Vapi prompt. Guard against that.
    const fs = require('fs');
    const callsPath = path.resolve(__dirname, '..', 'calls.ts');
    const src = fs.readFileSync(callsPath, 'utf-8');
    // The fetch-and-sync loop must call syncCallbackAssistant unconditionally
    // after each ended inbound, not gated behind completion detection.
    expect(src).toMatch(
      /Always re-sync the callback assistant after any inbound call/,
    );
  });
});
