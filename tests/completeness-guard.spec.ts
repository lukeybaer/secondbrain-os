/**
 * TDD — completeness guard test (rewritten 2026-04-21).
 *
 * The guard is STRUCTURAL, not phrase-matching. It verifies:
 *
 *   1. The canonical "implement to completion" rule lives in MEMORY.md
 *   2. The canonical "no permission stalling" + "own CI/CD" live in
 *      CLAUDE.global.md
 *   3. The Stop hook exists and is structural (not a trail-off-phrase grep)
 *   4. The memory operational-doc lists the acceptable-blocker categories
 *      (credential / binary-decision / CI-repeat-reject / rule-violation)
 *   5. The memory operational-doc enumerates NOT-acceptable excuses
 *      ("lot of work" / "context full" / "late")
 *
 * If any of these canonical signals drift out, vitest fails before the
 * next push. This is the drift-guard — not a phrase-police.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = join(__dirname, '..');
const MEMORY_TIER1 = join(REPO, 'memory', 'MEMORY.md');
const CLAUDE_GLOBAL = join(REPO, 'claude-config', 'CLAUDE.global.md');
const HOOK = join(REPO, 'scripts', 'claude-hooks', 'completeness-check.sh');
const FEEDBACK = join(REPO, 'memory', 'feedback_never_chunk_with_wrap_up.md');
const CODEX_PROTOCOL = join(
  REPO,
  'memory',
  'feedback_codex_must_apply_secondbrain_protocols_without_hooks.md',
);
const CODEX_GOAL = join(REPO, 'memory', 'feedback_codex_own_the_goal_not_the_bug.md');
const SURGICAL_CHANGES = join(REPO, 'memory', 'feedback_surgical_minimal_changes.md');
const PEER_REVIEW_FRESH_EYES = join(REPO, 'memory', 'feedback_peer_review_fresh_eyes_per_peer.md');
const RAW_ARCHIVAL = join(REPO, 'memory', 'feedback_raw_archival_principle.md');
const SPINE_FRAME = join(REPO, 'memory', 'feedback_spine_central_execution_frame.md');
const RESCUE_SNAPSHOTS = join(REPO, 'memory', 'feedback_rescue_snapshots_are_immutable.md');
const GIT_STORAGE_POLICY = join(REPO, 'memory', 'reference_git_storage_ownership_policy.md');
const STATE_LOCATIONS = join(REPO, 'memory', 'reference_amy_state_locations.md');
const CODEX_INSTRUCTIONS = join(REPO, '.codex', 'instructions.md');

describe('completeness guard — canonical rule drift protection', () => {
  it('MEMORY.md contains the canonical "implement to completion" rule', () => {
    const text = readFileSync(MEMORY_TIER1, 'utf8');
    expect(text).toMatch(/implement\s+(it\s+)?to\s+completion.*without\s+stopping/i);
  });

  it('MEMORY.md says Codex desktop/API sessions are the same Amy and must read memory manually if needed', () => {
    const text = readFileSync(MEMORY_TIER1, 'utf8');
    // 2026-07-05: the opening ExampleCoraph was condensed ("MEMORY.md index is the
    // skill router" pass). "Codex desktop/API sessions are Amy too" became
    // "Codex sessions are Amy too" (desktop/API named earlier in the same
    // sentence instead); "read it manually and apply it anyway" became "read
    // this file manually"; "No split-brain behavior" became "If anything
    // drifts from this file, this file wins" -- same single-source-of-truth
    // rule, condensed wording. Assert the surviving current phrasing.
    expect(text).toMatch(/Codex sessions are Amy too/i);
    expect(text).toMatch(/read this file manually/i);
    expect(text).toMatch(/If anything drifts from this file, this file wins/i);
  });

  it('Codex direct-work memory requires Claude Code review and goal-level scoping', () => {
    const memory = readFileSync(MEMORY_TIER1, 'utf8');
    const goal = readFileSync(CODEX_GOAL, 'utf8');
    const instructions = readFileSync(CODEX_INSTRUCTIONS, 'utf8');

    expect(memory).toMatch(/feedback_codex_own_the_goal_not_the_bug\.md/i);
    expect(goal).toMatch(/consult Claude Code/i);
    expect(goal).toMatch(/actual goal/i);
    expect(goal).toMatch(/same class of failure/i);
    expect(goal).toMatch(/acceptance test proves the goal works end to end/i);
    expect(instructions).toMatch(/consult Claude Code/i);
    expect(instructions).toMatch(/What is ExampleCo's actual goal/i);
    expect(instructions).toMatch(/Fix the class of problem, not only the reported instance/i);
  });

  it('MEMORY.md requires surgical, simple, minimal changes by default', () => {
    const memory = readFileSync(MEMORY_TIER1, 'utf8');
    const rule = readFileSync(SURGICAL_CHANGES, 'utf8');

    expect(memory).toMatch(/feedback_surgical_minimal_changes\.md/i);
    expect(rule).toMatch(/fewer lines of code/i);
    expect(rule).toMatch(/simplicity where practical/i);
    expect(rule).toMatch(/change only what is necessary/i);
    expect(rule).toMatch(/do not improve things that are not broken/i);
  });

  it('meaningful changes require four independent full-scope plans', () => {
    const memory = readFileSync(MEMORY_TIER1, 'utf8');
    const rule = readFileSync(PEER_REVIEW_FRESH_EYES, 'utf8');

    expect(memory).toMatch(/feedback_peer_review_fresh_eyes_per_peer\.md/i);
    expect(rule).toMatch(/four full-scope plans method/i);
    expect(rule).toMatch(/independently be capable of producing the right output/i);
    expect(rule).toMatch(/Amy plan/i);
    expect(rule).toMatch(/Claude Code plan/i);
    expect(rule).toMatch(/Amy fresh-eyes plan/i);
    expect(rule).toMatch(/Claude Code fresh-eyes plan/i);
    expect(rule).toMatch(/not.*rubber stamp/i);
    expect(rule).toMatch(/security/i);
    expect(rule).toMatch(/robustness/i);
    expect(rule).toMatch(/scalability/i);
    expect(rule).toMatch(/simplicity/i);
    expect(rule).toMatch(/Should the scope change, shrink, or be split/i);
  });

  it('raw archival memory is cloud-first for bulk/raw/generated data', () => {
    const rule = readFileSync(RAW_ARCHIVAL, 'utf8');

    expect(rule).toMatch(/Cloud-first storage rule/i);
    expect(rule).toMatch(/PC and the repo are not the durable home/i);
    expect(rule).toMatch(/S3/i);
    expect(rule).toMatch(/bucket, key, bytes, hash, and upload time/i);
    expect(rule).toMatch(
      /Git stores source, tests, memory, schemas, and small manifests\/receipts/i,
    );
  });

  it('Tier 1 memory points to the central Task Spine execution frame', () => {
    const memory = readFileSync(MEMORY_TIER1, 'utf8');
    const rule = readFileSync(SPINE_FRAME, 'utf8');

    expect(memory).toMatch(/feedback_spine_central_execution_frame\.md/i);
    expect(rule).toMatch(/spine/i);
    expect(rule).toMatch(/durable Task/i);
    expect(rule).toMatch(/execution/i);
  });

  it('rescue snapshots are immutable and cleanup happens on a triage branch', () => {
    const memory = readFileSync(MEMORY_TIER1, 'utf8');
    const rule = readFileSync(RESCUE_SNAPSHOTS, 'utf8');

    expect(memory).toMatch(/feedback_rescue_snapshots_are_immutable\.md/i);
    expect(rule).toMatch(/rescue snapshot is evidence/i);
    expect(rule).toMatch(/do not keep committing to it/i);
    expect(rule).toMatch(/separate triage branch/i);
  });

  it('git storage policy separates source of truth from runtime/generated records', () => {
    const memory = readFileSync(MEMORY_TIER1, 'utf8');
    const policy = readFileSync(GIT_STORAGE_POLICY, 'utf8');
    const stateLocations = readFileSync(STATE_LOCATIONS, 'utf8');
    const gitignore = readFileSync(join(REPO, '.gitignore'), 'utf8');

    expect(memory).toMatch(/reference_git_storage_ownership_policy\.md/i);
    expect(policy).toMatch(/Git stores intentional source of truth/i);
    expect(policy).toMatch(
      /S3\/runtime storage stores operational records and generated artifacts/i,
    );
    expect(policy).toMatch(/secondbrain-backups/i);
    expect(policy).toMatch(/data-lake\/secondbrain/i);
    expect(policy).toMatch(/data\/cloud-manifests/i);
    expect(policy).toMatch(/data\/agent.*mixed/i);
    expect(policy).toMatch(/Historical generated briefings/i);
    expect(policy).toMatch(/Content-review runtime state/i);
    expect(policy).toMatch(/Raw\/bulk ingest payloads/i);
    expect(policy).toMatch(/nightly-enhancements\.jsonl/i);
    expect(policy).toMatch(/gmail-amy-seen\.json/i);
    expect(policy).toMatch(/gmail-scan-heartbeat\.jsonl/i);
    expect(policy).toMatch(/Electron local logs/i);
    expect(policy).toMatch(/%APPDATA%\\secondbrain/i);
    expect(policy).toMatch(/do not disable local app logging/i);
    expect(stateLocations).toMatch(/S3 runtime\/generated archive prefix/i);
    expect(stateLocations).toMatch(/Electron local logs and runtime state/i);
    expect(stateLocations).toMatch(/error\.log/i);
    expect(stateLocations).toMatch(/startup-warnings\.log/i);
    expect(stateLocations).toMatch(/audio-diag\.log/i);
    expect(stateLocations).toMatch(/rotate or archive/i);
    expect(gitignore).toMatch(/data\/agent\/gmail-amy-seen\.json/i);
    expect(gitignore).toMatch(/data\/agent\/gmail-scan-heartbeat\.jsonl/i);
    expect(policy).toMatch(/git rm --cached/i);
  });

  it('git does not track runtime/generated storage classes', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
    const forbidden = [
      /^content-review\/pending\/.*\.(ass|json|jpg|mp3|mp4|png|srt)$/i,
      /^content-review\/published\/(manifest\.json|.*\.(jpg|mp4))$/i,
      /^content-review\/(rejections\.jsonl|upload-queue\.json)$/i,
      /^content-review\/social-posts\/queue\.json$/i,
      /^data\/agent\/(amy-dispatch-log|briefing-actions|dispatch-queue|dispatch-processed|dispatch-resolutions|graphiti-health|heal-tests-runs|health-heal|memory-cleanup-log|nightly-enhancements|otter-ingest-heartbeat|rubric-feedback-loop|rubric-expansion-queue)\.jsonl$/i,
      /^data\/agent\/(briefing-dismissed|gmail-scan-watermark|known-people|memory-delta-snapshot|news-summarizer-health|otter-ingest-seen|people-files-snapshot|rejection-processed|tests-blocked|youtube-oauth-alert)\.json$/i,
      /^data\/agent\/(aws-costs|pre-briefing-diagnostic|token-reduction-suggestion|token-usage)-\d{4}-\d{2}-\d{2}\.(json|md)$/i,
      /^data\/agent\/(linkedin-viral-scripts)-\d{4}-\d{2}-\d{2}\.json$/i,
      /^data\/agent\/mortgage-rates\/(history\.jsonl|\d{4}-\d{2}-\d{2}\.json)$/i,
      /^data\/agent\/shorts-proposals\/\d{4}-\d{2}-\d{2}\.json$/i,
      /^data\/agent\/viral-tech-clips\/\d{4}-\d{2}-\d{2}\.json$/i,
      /^data\/briefings\/briefing-\d{4}-\d{2}-\d{2}\.(md|docx)$/i,
      /^data\/briefing-action-items\.json$/i,
      /^data\/(gmail|otter|vapi|whatsapp)\/raw\/.+\.json$/i,
      /^data\/outbound\/.*\/\.sent\/.+\.json$/i,
    ];
    const offenders = tracked.filter((file) => forbidden.some((pattern) => pattern.test(file)));
    expect(offenders).toEqual([]);
  });

  it('MEMORY.md contains the "own the CI/CD pipeline" rule', () => {
    const text = readFileSync(MEMORY_TIER1, 'utf8');
    expect(text).toMatch(/own the ci\/?cd|monitor\s+(the\s+)?(ci|pipeline)\s+until\s+green/i);
  });

  it('CLAUDE.global.md contains the "no permission stalling" rule', () => {
    const text = readFileSync(CLAUDE_GLOBAL, 'utf8');
    expect(text).toMatch(/no permission stalling|don'?t\s+ask\s+for\s+access/i);
  });

  it('CLAUDE.global.md contains the "own the CI/CD pipeline" rule', () => {
    const text = readFileSync(CLAUDE_GLOBAL, 'utf8');
    expect(text).toMatch(/own the ci\/?cd|keep iterating until green/i);
  });

  it('Stop hook exists (bash wrapper + node module)', () => {
    expect(existsSync(HOOK), 'completeness-check.sh must exist').toBe(true);
    const hookMjs = join(REPO, 'scripts', 'claude-hooks', 'completeness-check.mjs');
    expect(existsSync(hookMjs), 'completeness-check.mjs must exist').toBe(true);
    const mjs = readFileSync(hookMjs, 'utf8');
    // The hook must parse requirements and check keyword coverage
    expect(mjs).toMatch(/parseRequirements|reqs/);
    expect(mjs).toMatch(/keyword|overlap|coverage|hits|addressed/);
    expect(mjs).toMatch(/transcript|messages/);
    expect(mjs).toMatch(/process\.exit\(2\)/);
    // Sanity: should NOT be a thin grep-for-phrases wrapper
    expect(mjs).not.toMatch(/^\s*grep\s+-qiE\s+"\(still on my list.*\)"\s*$/m);
  });

  it('feedback file lists acceptable blockers', () => {
    const text = readFileSync(FEEDBACK, 'utf8');
    expect(text).toMatch(/credential(\s+wall)?/i);
    expect(text).toMatch(/binary\s+(ExampleCo\s+)?decision/i);
    expect(text).toMatch(/ci\s+(repeat-?reject|repeated\s+rejection)/i);
    expect(text).toMatch(/explicit\s+(ExampleCo\s+)?rule\s+violation|canonical\s+rule/i);
  });

  it('feedback file lists NOT-acceptable excuses', () => {
    const text = readFileSync(FEEDBACK, 'utf8');
    expect(text).toMatch(/(lot\s+of\s+work|this\s+is\s+a\s+lot)/i);
    expect(text).toMatch(/context\s+(is\s+)?(getting\s+)?full/i);
    expect(text).toMatch(/it'?s\s+late/i);
  });

  it('feedback file references the canonical MEMORY.md rule (not a new invented rule)', () => {
    const text = readFileSync(FEEDBACK, 'utf8');
    expect(text).toMatch(/memory\/memory\.md|MEMORY\.md/i);
    expect(text).toMatch(/already[-\s]canonical|existing\s+canonical|operationaliz/i);
  });
});

// Functional tests against the real hook module — these are the tests that
// prove the structural check actually works on realistic inputs.
describe('completeness hook — functional behavior', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let mod: any;
  it('loads the hook module', async () => {
    mod = await import('../scripts/claude-hooks/completeness-check.mjs');
    expect(mod.parseRequirements).toBeTypeOf('function');
    expect(mod.unfinishedItems).toBeTypeOf('function');
  });

  it('parses inline numbered lists ("1. a 2. b 3. c")', async () => {
    const reqs = mod.parseRequirements(
      'Please do three things: 1. add a dashboard tile. 2. fix the scraper. 3. deploy to ec2',
    );
    expect(reqs.length).toBeGreaterThanOrEqual(3);
    expect(reqs.join(' ').toLowerCase()).toContain('dashboard tile');
    expect(reqs.join(' ').toLowerCase()).toContain('scraper');
    expect(reqs.join(' ').toLowerCase()).toContain('deploy');
  });

  it('parses newline-separated numbered lists', async () => {
    const reqs = mod.parseRequirements(
      'Do these:\n1. First thing\n2. Second thing\n3. Third thing',
    );
    expect(reqs.length).toBeGreaterThanOrEqual(3);
  });

  it('parses bulleted lists', async () => {
    const reqs = mod.parseRequirements('Do these:\n- first\n- second\n* third\n• fourth');
    expect(reqs.length).toBeGreaterThanOrEqual(4);
  });

  it('does not parse conversational turns as requirements', async () => {
    const reqs = mod.parseRequirements('what time is it?');
    expect(reqs).toEqual([]);
  });

  it('unfinishedItems flags items whose keywords are missing from response', async () => {
    const reqs = ['add a dashboard tile', 'fix the scraper', 'deploy to ec2 instance'];
    const assistantText = 'I added the dashboard tile with proper styling.';
    const unfinished = mod.unfinishedItems(reqs, assistantText);
    expect(unfinished.length).toBe(2);
    expect(unfinished.map((u: any) => u.text.toLowerCase()).join(' ')).toMatch(/scraper/);
    expect(unfinished.map((u: any) => u.text.toLowerCase()).join(' ')).toMatch(/deploy/);
  });

  it('unfinishedItems returns empty when all keywords are in response', async () => {
    const reqs = ['add a dashboard tile', 'fix the scraper', 'deploy to ec2'];
    const assistantText = 'Added dashboard tile, fixed scraper parser, deployed to ec2.';
    const unfinished = mod.unfinishedItems(reqs, assistantText);
    expect(unfinished).toEqual([]);
  });

  it('extracts structured requirements from prose complaints, not only lists', async () => {
    const reqs = mod.parseRequirements(
      'why would you fire off the exact phrasing - you need a structured checklist for every prompt, then tests failing for those, then tests passing for those. What is this about checking if you said deferred. Give me the real #gap response. Now you owe me two: a #gap like I asked for, and a #gap for why you regressed on your reply language.',
    );
    const joined = reqs.join(' ').toLowerCase();
    expect(joined).toContain('structured checklist');
    expect(joined).toContain('tests failing');
    expect(joined).toContain('tests passing');
    expect(joined).toContain('real #gap response');
    expect(joined).toContain('reply language');
  });

  it('requires checklist evidence and red-green verification for #gap/test prompts', async () => {
    const reqs = mod.parseRequirements(
      'you need a structured checklist for every prompt, then tests failing for those, then tests passing for those. Give me the real #gap response.',
    );

    const weak = mod.completionContractIssues({
      userText:
        'you need a structured checklist for every prompt, then tests failing for those, then tests passing for those. Give me the real #gap response.',
      assistantText: 'Fixed. I checked whether the response was deferred and updated the hook.',
      reqs,
    });
    expect(weak.some((issue: string) => /checklist/i.test(issue))).toBe(true);
    expect(weak.some((issue: string) => /failing test/i.test(issue))).toBe(true);
    expect(weak.some((issue: string) => /passing test/i.test(issue))).toBe(true);

    const strong = mod.completionContractIssues({
      userText:
        'you need a structured checklist for every prompt, then tests failing for those, then tests passing for those. Give me the real #gap response.',
      assistantText: `
        Prompt checklist:
        - [x] structured checklist for every prompt: implemented in completeness-check.mjs.
        - [x] tests failing for those: npx vitest run tests/completeness-guard.spec.ts failed before the hook change.
        - [x] tests passing for those: npx vitest run tests/completeness-guard.spec.ts passed after the hook change.
        - [x] real #gap response: final response uses the 8-step protocol.

        Verification:
        - Failing test before fix: npx vitest run tests/completeness-guard.spec.ts
        - Passing test after fix: npx vitest run tests/completeness-guard.spec.ts
      `,
      reqs,
    });
    expect(strong).toEqual([]);
  });

  // 2026-04-26 ExampleCo #gap: keyword overlap is not enough. The chunking
  // pattern cheats it -- the "Still queued for next session" list mentions
  // every item by name so keyword overlap passes, but the items are
  // explicitly being deferred. The phrase guard catches this.
  it('hasDeferralLanguage flags "DEFERRED next session" wording', async () => {
    expect(
      mod.hasDeferralLanguage('DEFERRED next session: rewrite the dispatcher').length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      mod.hasDeferralLanguage('I will tackle that next session').length,
    ).toBeGreaterThanOrEqual(1);
    expect(mod.hasDeferralLanguage('still queued for next round').length).toBeGreaterThanOrEqual(1);
    expect(mod.hasDeferralLanguage("I'll get to those tomorrow").length).toBeGreaterThanOrEqual(1);
  });

  it('hasDeferralLanguage returns empty when response just describes work done', async () => {
    expect(mod.hasDeferralLanguage('Added the tile, fixed the scraper, deployed to ec2.')).toEqual(
      [],
    );
    expect(mod.hasDeferralLanguage('All 17 items shipped. PR pushed.')).toEqual([]);
  });

  it('hasDeferralLanguage exposes the matching phrase for the hook message', async () => {
    const matches = mod.hasDeferralLanguage(
      'Locked in this session... DEFERRED next session: dispatch processor rewrite',
    );
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.join(' ').toLowerCase()).toMatch(/deferred|next session/);
  });
});

// 2026-04-26 meta-#gap: the gap-guard.sh UserPromptSubmit hook injects the
// 8-step workflow as a systemMessage but doesn't enforce that the assistant
// USED it. gap-workflow-enforcer is a Stop hook that requires at least 6 of
// the 8 markers when the user's most recent message starts with #gap.
describe('gap-workflow-enforcer Stop hook — 8-step workflow enforcement', () => {
  let gap: any;
  beforeAll(async () => {
    /* loaded eagerly below */
  });

  beforeEach(async () => {
    gap = await import('../scripts/claude-hooks/gap-workflow-enforcer.mjs');
  });

  it('userMentionsGap detects #gap anywhere in the message (start, mid, end)', () => {
    expect(gap.userMentionsGap('#gap the briefing broke again')).toBe(true);
    expect(gap.userMentionsGap('#GAP why did this regress?')).toBe(true);
    expect(gap.userMentionsGap('# gap with a space')).toBe(true);
    // 2026-04-26 ExampleCo correction: match anywhere, not just at start.
    expect(
      gap.userMentionsGap(
        'Today I went to the store. Yesterday I exercised. The third ExampleCoraph mentions #gap somewhere far away from the start.',
      ),
    ).toBe(true);
    expect(gap.userMentionsGap('that is a #gap right there at the end')).toBe(true);
  });

  it('userMentionsGap detects "hashtag gap" voice-transcript form', () => {
    expect(gap.userMentionsGap('hashtag gap the otter probe is wrong')).toBe(true);
    expect(gap.userMentionsGap('Hashtag Gap, this regressed')).toBe(true);
    expect(gap.userMentionsGap('what is happening here, hashtag gap')).toBe(true);
  });

  it('userMentionsGap returns false on conversational turns', () => {
    expect(gap.userMentionsGap('what is the weather?')).toBe(false);
    expect(gap.userMentionsGap('')).toBe(false);
    // "gap" in regular prose without # or hashtag prefix should NOT trigger.
    expect(gap.userMentionsGap('there is a small gap between the boards')).toBe(false);
    expect(gap.userMentionsGap('hashtag amy fix this')).toBe(false);
  });

  it('countMarkersHit returns 8 on a fully-formatted #gap response', () => {
    const fullGapResponse = `
      ACKNOWLEDGE the prior feedback: feedback file says X.
      CONFIRM it was supposed to be fixed by hook Y.
      EXPLAIN architecturally what went wrong: the hook used keyword matching.
      WHY it happened again: keywords beat the structural check.
      SELF-REFLECTION on my behavior: I treated checklist work as professional chunking.
      THE FIX uses the prevention hierarchy: hook + test.
      CANNOT RECUR because the guard fires on deferral language.
      EXEC SUMMARY: files changed are mjs and spec.
    `;
    expect(gap.countMarkersHit(fullGapResponse)).toBeGreaterThanOrEqual(gap.MIN_MARKERS);
  });

  it('countMarkersHit fails a 1-sentence "I acknowledge" reply', () => {
    expect(gap.countMarkersHit("You're right. Acknowledging and grinding through.")).toBeLessThan(
      gap.MIN_MARKERS,
    );
  });

  it('requires all 8 #gap workflow markers, not a near miss', () => {
    expect(gap.MIN_MARKERS).toBe(8);
    const sevenMarkerReply = `
      ACKNOWLEDGE the prior feedback.
      CONFIRM it was supposed to be fixed.
      EXPLAIN architecturally what went wrong.
      WHY it happened again.
      SELF-REFLECTION on my behavior.
      THE FIX uses a hook.
      CANNOT RECUR because the guard fires.
    `;
    expect(gap.countMarkersHit(sevenMarkerReply)).toBeLessThan(gap.MIN_MARKERS);
  });

  it('Codex protocol memory requires the full #gap workflow despite missing Claude hooks', () => {
    const text = readFileSync(CODEX_PROTOCOL, 'utf8');
    expect(text).toMatch(/one Amy, one memory/i);
    expect(text).toMatch(/Codex is not a separate assistant/i);
    expect(text).toMatch(
      /If this surface does not auto-inject `memory\/MEMORY\.md`, Codex must manually read and apply it/i,
    );
    expect(text).toMatch(
      /ACKNOWLEDGE[\s\S]*CONFIRM[\s\S]*EXPLAIN[\s\S]*WHY[\s\S]*SELF-REFLECTION[\s\S]*THE FIX[\s\S]*CANNOT RECUR[\s\S]*EXEC SUMMARY/i,
    );
  });
});
