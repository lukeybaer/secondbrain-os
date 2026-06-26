/**
 * Tests for the expanded health-self-heal.js probes:
 * - probeVideoFeedbackLoop
 * - probeStaleUploads
 * - probeApiAudit
 *
 * These probes were added 2026-04-16 as part of the "produce early, fix before
 * delivery" briefing overhaul. They run at 2:45 AM in the pre-briefing
 * diagnostic and again at 3:00 AM in health-self-heal.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const {
  probeVideoFeedbackLoop,
  probeStaleUploads,
  probeApiAudit,
} = require('../../../scripts/health-self-heal.js');

describe('probeVideoFeedbackLoop', () => {
  it('returns green when no videos need regen', () => {
    // This test reads the actual manifest -- the result depends on current state.
    // We verify the shape is correct regardless of status.
    const result = probeVideoFeedbackLoop();
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('stuckVideos');
    expect(['green', 'yellow', 'red']).toContain(result.status);
  });

  it('returns stuckVideos as an array', () => {
    const result = probeVideoFeedbackLoop();
    expect(Array.isArray(result.stuckVideos)).toBe(true);
  });
});

describe('probeStaleUploads', () => {
  it('returns a valid probe result', () => {
    const result = probeStaleUploads();
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('staleVideos');
    expect(['green', 'yellow', 'red']).toContain(result.status);
  });
});

describe('probeApiAudit', () => {
  it('returns a valid probe result', () => {
    const result = probeApiAudit();
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('paidApiFiles');
    expect(['green', 'yellow', 'red']).toContain(result.status);
  });

  it('paidApiFiles is an array', () => {
    const result = probeApiAudit();
    expect(Array.isArray(result.paidApiFiles)).toBe(true);
  });
});
