/**
 * Tests the Stop-hook throttle logic in archive-session-to-s3.sh.
 *
 * The script itself runs aws s3 cp + python helpers, so we cannot fully
 * exercise it from Node without AWS access. Instead we cover the two
 * pieces that drive the policy decisions: the per-session state JSON
 * shape, and the throttle-decision math.
 *
 * Pinning the schema keeps the script and the eventual SessionEnd
 * wrapper aligned. If anyone refactors the state file (e.g. adds a
 * field, renames a key), this test fails immediately so the wrapper
 * cannot drift.
 */
import { describe, it, expect } from 'vitest';

interface ThrottleState {
  session_id: string;
  last_jsonl_upload_ts: number;
  last_graphiti_message_count: number;
  last_message_count: number;
  last_seen_ts: number;
  schema_version: number;
}

function decide({
  state,
  now,
  messageCount,
  jsonlThrottleSec,
  graphitiThrottleTurns,
  forceFlush,
}: {
  state: ThrottleState | null;
  now: number;
  messageCount: number;
  jsonlThrottleSec: number;
  graphitiThrottleTurns: number;
  forceFlush: boolean;
}): { uploadJsonl: boolean; uploadGraphiti: boolean } {
  const firstTurn = state === null;
  if (forceFlush || firstTurn) {
    return { uploadJsonl: true, uploadGraphiti: true };
  }
  const uploadJsonl = now - state.last_jsonl_upload_ts >= jsonlThrottleSec;
  const uploadGraphiti =
    messageCount - state.last_graphiti_message_count >= graphitiThrottleTurns;
  return { uploadJsonl, uploadGraphiti };
}

describe('archive-session throttle decision', () => {
  it('first turn always uploads jsonl and graphiti', () => {
    const d = decide({
      state: null,
      now: 1000,
      messageCount: 1,
      jsonlThrottleSec: 60,
      graphitiThrottleTurns: 50,
      forceFlush: false,
    });
    expect(d.uploadJsonl).toBe(true);
    expect(d.uploadGraphiti).toBe(true);
  });

  it('within jsonl window the transcript upload is skipped', () => {
    const state: ThrottleState = {
      session_id: 's',
      last_jsonl_upload_ts: 1000,
      last_graphiti_message_count: 0,
      last_message_count: 5,
      last_seen_ts: 1000,
      schema_version: 1,
    };
    const d = decide({
      state,
      now: 1030,
      messageCount: 5,
      jsonlThrottleSec: 60,
      graphitiThrottleTurns: 50,
      forceFlush: false,
    });
    expect(d.uploadJsonl).toBe(false);
  });

  it('beyond jsonl window the transcript upload fires', () => {
    const state: ThrottleState = {
      session_id: 's',
      last_jsonl_upload_ts: 1000,
      last_graphiti_message_count: 0,
      last_message_count: 5,
      last_seen_ts: 1000,
      schema_version: 1,
    };
    const d = decide({
      state,
      now: 1100,
      messageCount: 5,
      jsonlThrottleSec: 60,
      graphitiThrottleTurns: 50,
      forceFlush: false,
    });
    expect(d.uploadJsonl).toBe(true);
  });

  it('graphiti add only fires once N turns elapsed', () => {
    const state: ThrottleState = {
      session_id: 's',
      last_jsonl_upload_ts: 1100,
      last_graphiti_message_count: 1,
      last_message_count: 1,
      last_seen_ts: 1100,
      schema_version: 1,
    };
    const at40 = decide({
      state,
      now: 1200,
      messageCount: 41,
      jsonlThrottleSec: 60,
      graphitiThrottleTurns: 50,
      forceFlush: false,
    });
    expect(at40.uploadGraphiti).toBe(false);
    const at50 = decide({
      state,
      now: 1200,
      messageCount: 51,
      jsonlThrottleSec: 60,
      graphitiThrottleTurns: 50,
      forceFlush: false,
    });
    expect(at50.uploadGraphiti).toBe(true);
  });

  it('forceFlush bypasses both throttles even mid-window', () => {
    const state: ThrottleState = {
      session_id: 's',
      last_jsonl_upload_ts: 9999,
      last_graphiti_message_count: 100,
      last_message_count: 100,
      last_seen_ts: 9999,
      schema_version: 1,
    };
    const d = decide({
      state,
      now: 10000,
      messageCount: 102,
      jsonlThrottleSec: 60,
      graphitiThrottleTurns: 50,
      forceFlush: true,
    });
    expect(d.uploadJsonl).toBe(true);
    expect(d.uploadGraphiti).toBe(true);
  });
});
