/**
 * Locks the rule from memory/feedback_always_have_reduction_suggestion.md.
 * The token-usage card must NEVER render "no suggestion available" or
 * any "we're perfect / nothing to do" placeholder.
 *
 * Triggered by ExampleCo 2026-04-29 #learn C: "'no reduction suggestions
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

function extractParser() {
  const start = src.indexOf('function parseTokenUsageBody');
  const next = src.indexOf('\nfunction ', start + 10);
  expect(start).toBeGreaterThan(0);
  expect(next).toBeGreaterThan(start);
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(start, next)}\n; return parseTokenUsageBody;`)();
}

describe("Token usage always emits a reduction suggestion (ExampleCo 2026-04-29 #learn C)", () => {
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

  it('keeps stale Claude Max telemetry visible when Codex telemetry is fresh', () => {
    const parseTokenUsageBody = extractParser();
    const parsed = parseTokenUsageBody(
      [
        '  267.72M input-like / 1401K output across 273 sessions',
        '  Cache hit rate: 96.2% (healthy)',
        '  Model mix: Opus 263.2M, Sonnet 3.9M, Haiku 0.7M',
        '  Claude Max: live usage endpoint did not refresh -- last reading 70% is 16.2h stale (from Jun 17, 8:37 AM CT), not current. Run scripts/collect-claude-plan-usage.js to refresh the authoritative percent.',
        '  Codex (pro): 4% of weekly subscription burned (resets 2026-06-21); 5h window 1%. 12.3M billed input + 0.50M output across 8 sessions this week.',
      ].join('\n'),
    );

    expect(parsed.data.claudeMaxStatus).toMatchObject({
      state: 'stale',
      lastPercent: '70%',
      staleAge: '16.2h',
      action: 'scripts/collect-claude-plan-usage.js',
    });
    expect(parsed.data.claudeMaxBurn).toMatchObject({
      stale: true,
      percent: '70%',
    });
    expect(parsed.data.codexBurn).toMatchObject({
      authoritative: true,
      percent: '4%',
    });

    const tokenBlockStart = src.indexOf("if (d.kind === 'tokenUsage')");
    const peopleBlockStart = src.indexOf("if (d.kind === 'peopleFilesChange')");
    expect(tokenBlockStart).toBeGreaterThan(0);
    expect(peopleBlockStart).toBeGreaterThan(tokenBlockStart);
    const tokenBlock = src.slice(tokenBlockStart, peopleBlockStart);
    expect(tokenBlock).toMatch(/Claude Code \(stale\)/);
    expect(src).toMatch(/Claude Code Max live usage is stale/);
  });
});
