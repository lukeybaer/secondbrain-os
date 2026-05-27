/**
 * Locks the rule from memory/feedback_always_have_reduction_suggestion.md.
 * The token-usage card must NEVER render "no suggestion available" or
 * any "we're perfect / nothing to do" placeholder.
 *
 * Triggered by Luke 2026-04-29 #learn C: "'no reduction suggestions
 * available' - there should always be something we can do to make
 * token usage more efficient. If you need more logs to be able to
 * analyze that, then make them. (add tests so we don't say 'we're
 * perfect' ever again)."
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SERVER = path.join(__dirname, '..', 'ec2-server.js');
const src = fs.readFileSync(SERVER, 'utf8');

describe("Token usage always emits a reduction suggestion (Luke 2026-04-29 #learn C)", () => {
  it("renderTileContent for tokenUsage no longer renders 'No reduction suggestion available.'", () => {
    // The old fallback string is gone.
    const tokenBlock = src.slice(
      src.indexOf("if (d.kind === 'tokenUsage')"),
      src.indexOf("if (d.kind === 'peopleFilesChange')")
    );
    expect(tokenBlock).not.toMatch(/'No reduction suggestion available/);
    expect(tokenBlock).not.toMatch(/'no suggestion available'/i);
  });

  it("computes a fallback diagnostic chain when the suggester returns empty", () => {
    const tokenBlock = src.slice(
      src.indexOf("if (d.kind === 'tokenUsage')"),
      src.indexOf("if (d.kind === 'peopleFilesChange')")
    );
    expect(tokenBlock).toMatch(/computeFallbackSuggestion|fallback.*suggestion/i);
    // The fallback uses the data we DO have: top app, model mix,
    // cache hit rate.
    expect(tokenBlock).toMatch(/Opus.*Haiku|model.*mix|route.*Haiku/i);
    expect(tokenBlock).toMatch(/cache hit rate|Cache hit/);
  });

  it("if no diagnostic levers exist, suggests adding instrumentation (never silent)", () => {
    const tokenBlock = src.slice(
      src.indexOf("if (d.kind === 'tokenUsage')"),
      src.indexOf("if (d.kind === 'peopleFilesChange')")
    );
    // The "add instrumentation" branch must mention what to log.
    expect(tokenBlock).toMatch(/instrumentation|token-events\.jsonl|log.*\{.*project.*model/i);
  });
});
