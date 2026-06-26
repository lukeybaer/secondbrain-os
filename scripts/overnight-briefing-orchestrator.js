#!/usr/bin/env node
/**
 * overnight-briefing-orchestrator.js
 *
 * The SINGLE overnight convergence state machine. It mechanically drives the
 * daily briefing to validator-clean, then (and only then) publishes. This is
 * the only publish path in the system: nothing else scp's the briefing to EC2
 * after this change, and publish fires exactly once, exactly when the
 * validator returns zero failures.
 *
 * Consensus contract (Codex adversarial review):
 *   - P0#2: ONLY the orchestrator publishes, and ONLY after validator ok:true.
 *   - P2#5: one state machine, bounded retries, evidence-based progress, final
 *     ok:false on ANY unresolved validator failure, no independent publish
 *     paths. The orchestrator must NEVER return ok:true while a validator
 *     failure or a genuine-ExampleCo-wall is still open.
 *
 * Each convergence pass does, in order:
 *   a. TESTS    - if data/agent/tests-blocked.json shows failures, run the LLM
 *                 heal ladder (scripts/heal-tests-by-file.js). After it verifies
 *                 files green, commit the specific verified files with an
 *                 explicit-paths commit so the fix persists across the night.
 *   b. CONTENT  - require('./content-heal.js').runContentHeal({date}) to bring
 *                 viral/mortgage/news cards to threshold or a genuine wall.
 *   c. REGEN    - run scripts/refresh-briefing-generated-sections.js --date <date>
 *                 --no-publish so System Health + BLOCKERS (incl. Life:* rows)
 *                 are re-derived from current state WITHOUT publishing.
 *   d. VALIDATE - run scripts/validate-briefing-quality.js --date <date> --json
 *                 and parse ok/failures.
 *   e. CONVERGE - failures.length === 0 -> PUBLISH (SOLE publish) and break
 *                 status=clean. Else classify each failure, route the still-
 *                 failing card to its owner repair, and loop. A genuine
 *                 ExampleCo-wall (credential/decision) is recorded and stops being
 *                 retried, but the rest keep healing.
 *   f. EXHAUST  - loop exhaustion / deadline with remaining failures -> return
 *                 status NOT-clean with the honest list; NEVER publish a fake-clean.
 *                 The morning briefing then shows real blockers.
 *
 * The loop is dependency-injectable (runConvergeLoop accepts injected
 * { healTests, contentHeal, regenerate, validate, publish, now }) so tests can
 * drive the full state machine without spawning real CLIs or touching the
 * network. main() wires the real implementations.
 *
 * Locked by scripts/__tests__/overnight-converge-loop.test.js.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// QC-at-output building blocks (landed PR1/PR2). The orchestrator REUSES these,
// it never reimplements them: cardOutputQc is the per-card gate, decideHeal +
// healCard are the bounded heal cycle, buildBlockedCardOutput is the honest
// hard-block at true exhaustion.
const { cardOutputQc, safeBuildBlockedCardOutput } = require('./lib/briefing-clean-contract.js');
const { decideHeal } = require('./self-heal/heal-decision.js');
const { healCard } = require('./self-heal/heal-loop.js');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const LOG_DIR = path.join(REPO, 'data', 'agent');
const LOG_PATH = path.join(LOG_DIR, 'overnight-briefing-orchestrator.jsonl');
const DEFAULT_DEADLINE_CT = '05:15';
const DEFAULT_MAX_LOOPS = 6;
// Absolute upper bound on heal cycles per card at finalization, independent of the
// ladder length. The 5:30am build runs this; an unbounded QC-heal-reQC loop would
// break the whole briefing (worse than the current partial-red state), so the gate
// can never run more than this many apply/deploy/verify cycles for one card.
const DEFAULT_MAX_HEAL_CYCLES = 8;

function todayCt() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : null;
}

function log(row) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
  } catch {
    /* logging is best-effort, never fatal */
  }
}

function runStep(name, cmd, args, options = {}) {
  const started = Date.now();
  log({ event: 'step-start', name, cmd, args });
  const result = spawnSync(cmd, args, {
    cwd: options.cwd || REPO,
    encoding: 'utf8',
    timeout: options.timeoutMs || 15 * 60 * 1000,
    windowsHide: true,
    env: { ...process.env, ...(options.env || {}) },
  });
  const durationMs = Date.now() - started;
  const ok = result.status === 0;
  log({
    event: 'step-finish',
    name,
    ok,
    status: result.status,
    durationMs,
    stdout: String(result.stdout || '').slice(-4000),
    stderr: String(result.stderr || '').slice(-4000),
  });
  return {
    name,
    ok,
    status: result.status,
    durationMs,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// ---------------------------------------------------------------------------
// Failure classification + owner routing
// ---------------------------------------------------------------------------

// Each validator failure string is mapped to the card/subsystem that owns the
// repair. The category, not the literal trigger, drives routing.
function classifyFailure(failure) {
  const s = String(failure || '').toLowerCase();
  if (s.includes('tests') || s.includes('system health')) return 'tests';
  if (s.includes('viral')) return 'content';
  if (s.includes('mortgage')) return 'content';
  if (s.includes('covid')) return 'content';
  if (s.includes('us news')) return 'content';
  if (s.includes('world news')) return 'content';
  if (s.includes('ai & tech') || s.includes('aitech')) return 'content';
  if (s.includes('immigration news')) return 'content';
  if (s.includes('shorts')) return 'content';
  if (s.includes('token')) return 'consistency';
  if (s.includes('linkedin')) return 'consistency';
  if (s.includes('action') || s.includes('gmail')) return 'consistency';
  return 'consistency';
}

function uniqueOwners(failures) {
  return Array.from(new Set((failures || []).map(classifyFailure)));
}

// A genuine ExampleCo-wall: the failure names a credential, decision, or external
// action that Amy cannot clear by writing code. These get recorded once and
// stop being retried (Codex P2#5: "do not retry forever"), while the rest of
// the cards keep healing.
const ExampleCo_WALL_RE =
  /\b(credential|password|api[\s-]?key|2fa|mfa|approve|approval|decide|decision|choose|external|wire transfer|payment|legal|insurance|sign|signature|consent|interview|in[\s-]?person|notar|awaiting ExampleCo|need(?:s)? ExampleCo|owner=ExampleCo)\b/i;
const WALL_NEGATION_RE = /\b(not a ExampleCo|nothing|amy owns|amy-owned|hard blocker, not)\b/i;

function isExampleCoWall(failure) {
  const s = String(failure || '');
  if (WALL_NEGATION_RE.test(s)) return false;
  return ExampleCo_WALL_RE.test(s);
}

// ---------------------------------------------------------------------------
// The convergence state machine (pure + injectable)
// ---------------------------------------------------------------------------

/**
 * Run the bounded convergence loop. Fully dependency-injectable so tests can
 * drive every branch without spawning a CLI or touching the network.
 *
 * deps:
 *   healTests(ctx)   -> { ran, cleared, committed, ... }   (step a)
 *   contentHeal(ctx) -> { ran, ... }                       (step b)
 *   regenerate(ctx)  -> { ok, ... }                        (step c, --no-publish)
 *   validate(ctx)    -> { ok, failures: string[], cards }  (step d)
 *   publish(ctx)     -> { ok, ... }                        (step e, card-level publish)
 *   now()            -> epoch ms                            (deadline clock)
 *
 * Card-level publish (Codex #4): the loop regenerates the whole HONEST markdown
 * every pass (each card at its real current state) and PUBLISHES it whenever the
 * pass completes, NOT only on a global-clean pass. So a clean card goes live the
 * moment it is clean instead of waiting for every other card. A still-broken
 * card renders its real state in the same markdown (the renderer + the
 * validator's per-card honest-state check guarantee a broken card can never
 * render fake-clean). Healing of the remaining cards continues across passes.
 * The loop ends when ALL cards are clean OR the deadline / budget is reached.
 * Publish fires EXACTLY ONCE per pass.
 *
 * Returns:
 *   {
 *     ok,            // true ONLY when the final validation had zero failures
 *     status,        // 'clean' | 'not-clean'
 *     published,     // true when at least one honest publish fired
 *     publishCount,  // number of publishes (one per pass; equals loops executed)
 *     loops,         // passes executed
 *     failures,      // remaining validator failures (empty when clean)
 *     cards,         // last per-card status map { section: { ok, failures } }
 *     walls,         // genuine ExampleCo-walls recorded (not retried)
 *     escalated,     // true when any wall or unresolved failure remains
 *   }
 */
async function runConvergeLoop(opts = {}) {
  const date = opts.date;
  const mode = opts.mode || 'overnight';
  const maxLoops = Number.isFinite(opts.maxLoops) ? opts.maxLoops : DEFAULT_MAX_LOOPS;
  const deadlineMs = Number.isFinite(opts.deadlineMs) ? opts.deadlineMs : Infinity;
  const now = opts.now || (() => Date.now());
  const deps = opts.deps || {};
  const healTests = deps.healTests || (async () => ({ ran: false }));
  const contentHeal = deps.contentHeal || (async () => ({ ran: false }));
  const regenerate = deps.regenerate || (async () => ({ ok: true }));
  const validate = deps.validate || (async () => ({ ok: true, failures: [] }));
  const publish = deps.publish || (async () => ({ ok: true }));
  // The QC -> heal -> re-QC card finalization gate (PR3). Defaults to the real
  // finalizeCard; the live finalize side-effects (observe/applyFix/deploy/verify/
  // reRender) come from deps.finalizeDeps. A caller that supplies no per-card
  // cardOutput in validation gets a no-op gate (the markdown-only path is unchanged).
  const finalize = deps.finalize === null ? null : deps.finalize || finalizeCard;
  const finalizeDeps = deps.finalizeDeps || {};

  // Walls are recorded once and never retried; they remain "unresolved" so the
  // final ok stays false, but they do not consume convergence budget.
  const walls = new Set();
  let publishCount = 0;
  let published = false;
  let lastFailures = [];
  let lastCards = {};
  let loops = 0;
  let cleanThisPass = false;

  for (let loop = 1; loop <= maxLoops; loop += 1) {
    loops = loop;
    if (now() >= deadlineMs) {
      log({ event: 'converge-deadline', loop, date, deadlineMs });
      loops = loop - 1; // this pass never executed
      break;
    }

    // (a) TESTS: heal red tests through the LLM ladder, then persist the fix.
    let healResult = null;
    try {
      healResult = await healTests({ date, mode, loop });
    } catch (e) {
      healResult = { ran: false, error: String(e && e.message ? e.message : e) };
    }

    // (b) CONTENT-HEAL: bring viral/mortgage to threshold or a genuine wall.
    let contentResult = null;
    try {
      contentResult = await contentHeal({ date, mode, loop });
    } catch (e) {
      contentResult = { ran: false, error: String(e && e.message ? e.message : e) };
    }

    // (c) REGENERATE: re-derive the WHOLE honest markdown (every card at its real
    // current state) WITHOUT publishing inside the refresh script.
    let regenResult = null;
    try {
      regenResult = await regenerate({ date, mode, loop });
    } catch (e) {
      regenResult = { ok: false, error: String(e && e.message ? e.message : e) };
    }

    // (d) VALIDATE: the single source of truth for clean vs not-clean, and the
    // per-card honest-state check that prevents a broken card from going out
    // fake-clean.
    const validation = await validate({ date, mode, loop });
    const allFailures = Array.isArray(validation.failures) ? validation.failures : [];
    // Separate genuine ExampleCo-walls from healable failures.
    for (const f of allFailures) {
      if (isExampleCoWall(f)) walls.add(f);
    }
    const healable = allFailures.filter((f) => !walls.has(f));
    lastFailures = allFailures;
    lastCards = cardStatusFromValidation(validation, allFailures);
    cleanThisPass = allFailures.length === 0;

    log({
      event: 'converge-pass',
      loop,
      date,
      healRan: !!(healResult && healResult.ran),
      healCleared: healResult && healResult.cleared,
      healCommitted: healResult && healResult.committed,
      contentRan: !!(contentResult && contentResult.ran),
      regenOk: !!(regenResult && regenResult.ok),
      validatorOk: !!validation.ok,
      failures: allFailures,
      healable,
      cards: lastCards,
      walls: Array.from(walls),
    });

    // (d2) QC -> HEAL -> RE-QC GATE (PR3): before publishing, every card whose
    // validator entry ExampleCos a generated cardOutput is run through finalizeCard.
    // A card output that fails cardOutputQc (self-talk misrepresentation, or an
    // honest-but-premature give-up while the ledger still has an untried option) is
    // routed to a heal attempt and re-QC; it is only finalized when cardOutputQc
    // passes OR it is an honest hard-block at true exhaustion. This is also where the
    // self-feed is broken: a card's failing/self-talk output is REPLACED with the
    // healed or hard-blocked output, so prior self-talk can never become published
    // content. The gate is a no-op when no card ExampleCos a cardOutput (so the
    // markdown-only path is unaffected).
    if (finalize) {
      const finalized = {};
      for (const [section, entry] of Object.entries(lastCards)) {
        if (!entry || !entry.cardOutput) continue;
        let res;
        try {
          res = await finalize(section, entry.cardOutput, finalizeDeps, {
            ...opts,
            // The durable attempt ledger lives in the data dir; thread it from the
            // injected finalizeDeps so tests isolate it and the live run uses the
            // EC2-first default in attempt-ledger.js.
            dataDir: finalizeDeps.dataDir || opts.dataDir,
            maxHealCycles: opts.maxHealCycles,
            healRecord: entry.healRecord || { target: section, detail: section + ' failed QC' },
          });
        } catch (e) {
          // finalizeCard never throws, but belt-and-suspenders: a throw here must not
          // abort the whole build AND must not republish the original failing output
          // (that would re-serve the card's own self-talk, the self-feed bug). Emit a
          // guaranteed-valid honest block so the card is honestly blocked, never the
          // failing input.
          const block = safeBuildBlockedCardOutput(
            entry.healRecord || { target: section, detail: section + ' failed QC' },
          );
          res = { status: 'blocked', cardOutput: block, qc: cardOutputQc(block) };
          log({ event: 'finalize-card-gate-error', section, error: errMsg(e) });
        }
        // Replace the published output with the QC-clean (healed or hard-block) one.
        entry.cardOutput = res.cardOutput;
        entry.finalizeStatus = res.status;
        // A card is "ok" for publish only when its finalized output passes QC AND it
        // was not a hard-block (a hard-block is honest but the card is still red).
        entry.ok = res.status === 'pass' || res.status === 'healed';
        finalized[section] = res.status;
      }
      if (Object.keys(finalized).length) {
        log({ event: 'converge-finalize-cards', loop, date, finalized });
      }
    }

    // (e) CARD-LEVEL PUBLISH: publish the current HONEST markdown this pass so
    // every clean card goes live immediately instead of waiting on a broken one.
    // The published markdown shows each broken card at its real state; it can
    // never be fake-clean because the validator's per-card honest-state check
    // already ran above and the renderer wrote the real state. Exactly one
    // publish per pass.
    const pub = await publish({ date, mode, loop });
    publishCount += 1;
    if (pub && pub.ok) published = true;
    const cleanSections = Object.entries(lastCards)
      .filter(([, c]) => c && c.ok)
      .map(([s]) => s);
    const brokenSections = Object.entries(lastCards)
      .filter(([, c]) => c && !c.ok)
      .map(([s]) => s);
    log({
      event: 'converge-publish',
      loop,
      date,
      published: !!(pub && pub.ok),
      cleanThisPass,
      cleanSections,
      brokenSections,
      publishResult: pub,
    });

    // (f) CONVERGE: all cards clean -> done. We already published this pass.
    if (cleanThisPass) {
      log({ event: 'converge-clean', loop, date, publishCount });
      break;
    }

    // Still-failing cards that are NOT walls keep healing on the next pass.
    const owners = uniqueOwners(healable);
    log({
      event: 'converge-route',
      loop,
      date,
      owners,
      healableCount: healable.length,
      wallCount: walls.size,
    });

    // If the ONLY remaining failures are walls, no amount of looping clears
    // them. Stop retrying (Codex P2#5: do not retry a genuine wall forever). We
    // have already published the honest state this pass.
    if (healable.length === 0) {
      log({ event: 'converge-walls-only', loop, date, walls: Array.from(walls) });
      break;
    }
  }

  // Final status. ok:true ONLY when the last validation had zero failures AND
  // at least one publish actually landed. We published the honest markdown each
  // pass regardless, so clean cards never waited on a broken one, and a
  // never-clean run still surfaces the real state.
  //
  // 2026-06-11: three consecutive real runs (06-08, 06-09, 06-11) reported
  // ok:true "CLEAN (published once)" while published:false, every publish step
  // had timed out and the public dashboard served a stale day. The published
  // dashboard is the deliverable (feedback_briefing_clean_or_blocked_contract);
  // a clean validator pass that never reached the dashboard exits loud, not 0.
  const validatorClean = cleanThisPass && lastFailures.length === 0;
  const ok = validatorClean && published;
  log({
    event: ok ? 'converge-final-clean' : 'converge-final-not-clean',
    date,
    loops,
    failures: lastFailures,
    walls: Array.from(walls),
    publishCount,
    published,
  });
  return {
    ok,
    status: ok ? 'clean' : validatorClean ? 'clean-unpublished' : 'not-clean',
    published,
    publishCount,
    loops,
    failures: lastFailures,
    cards: lastCards,
    walls: Array.from(walls),
    escalated: !ok,
  };
}

// Per-card status map. Prefer the validator's own `cards` map (added by the
// validator agent's buildCardStatusMap) when present; otherwise derive an
// equivalent map locally by attributing each failure to its card. A card with
// zero attributed failures is ok:true, so a clean card publishes immediately
// while a card carrying a failure is ok:false and renders its real state.
function cardStatusFromValidation(validation, failures) {
  if (validation && validation.cards && typeof validation.cards === 'object') {
    return validation.cards;
  }
  const cards = {};
  for (const f of failures || []) {
    const section = classifyFailure(f);
    if (!cards[section]) cards[section] = { ok: false, failures: [] };
    cards[section].failures.push(f);
  }
  for (const s of Object.keys(cards)) cards[s].ok = cards[s].failures.length === 0;
  return cards;
}

// ---------------------------------------------------------------------------
// QC -> heal -> re-QC card finalization gate (PR3)
// ---------------------------------------------------------------------------

/**
 * Finalize ONE card's generated output: the QC-at-output gate ExampleCo locked. The
 * STATE of the final card IS the output; a card is only finalized/published when
 * its output passes cardOutputQc OR it is an honest hard-block at TRUE exhaustion.
 *
 * Flow (reusing the landed building blocks, never reimplementing them):
 *   1. cardOutputQc(cardOutput) passes        -> emit it unchanged ({status:'pass'}).
 *   2. cardOutputQc fails (either failure mode: self-talk misrepresentation, OR an
 *      honest-but-premature give-up while the ledger still has an untried option)
 *      -> run the bounded heal cycle. Each cycle:
 *        a. decideHeal -> if 'blocked' (true exhaustion) emit the honest hard-block
 *           (buildBlockedCardOutput, which passes cardOutputQc by construction).
 *        b. otherwise healCard runs the full apply/deploy/verify cycle (recording
 *           each attempt in the durable ledger), then reRender() re-derives the
 *           card output and we re-QC it. Pass -> emit ({status:'healed'}).
 *   3. The loop is HARD-BOUNDED by maxHealCycles (an absolute cap, independent of
 *      ladder length) so it can never spin and break the 5:30am build, and EVERY
 *      failure path (a thrown dep, a heal timeout, a reRender that still fails QC)
 *      falls through to an honest hard-block card, never an uncaught exception.
 *
 * The self-feed is broken here: a card whose generated output failed QC is NEVER
 * emitted as that failing output. It is either replaced by a healed, re-QC-passed
 * output or by a freshly GENERATED honest hard-block, so prior self-talk can never
 * become the published card.
 *
 * deps: { observe, applyFix, deploy, verify, reRender } -- all injected so this is
 * unit-testable with mocks and never hits EC2 or a real LLM. reRender(cardId) must
 * return the card's freshly generated output object for re-QC after a heal.
 *
 * Returns { status: 'pass'|'healed'|'blocked', cardOutput, qc, attempts? }.
 */
async function finalizeCard(cardId, cardOutput, deps = {}, opts = {}) {
  const reRender = deps.reRender || (async () => cardOutput);
  const maxHealCycles = Number.isFinite(opts.maxHealCycles)
    ? opts.maxHealCycles
    : DEFAULT_MAX_HEAL_CYCLES;

  // 1. Output already honest + on-ladder: nothing to heal, emit unchanged.
  const firstQc = cardOutputQc(cardOutput);
  if (firstQc.ok) {
    log({ event: 'finalize-card-pass', cardId });
    return { status: 'pass', cardOutput, qc: firstQc };
  }

  log({ event: 'finalize-card-qc-fail', cardId, failures: firstQc.failures });

  // 2. QC failed -> bounded QC-heal-reQC loop. Every path is wrapped so a thrown
  // dep can never abort the whole build; it falls through to an honest hard-block.
  let lastBlock = null;
  try {
    for (let cycle = 1; cycle <= maxHealCycles; cycle += 1) {
      let observed = {};
      try {
        observed = (await deps.observe(cardId)) || {};
      } catch (e) {
        // Cannot even observe the card (e.g. EC2 unreachable): we cannot heal it,
        // so stop and emit the honest hard-block below.
        log({ event: 'finalize-card-observe-error', cardId, cycle, error: errMsg(e) });
        break;
      }

      const decision = decideHeal(cardId, observed, opts.healRecord, opts);
      if (decision.action === 'pass') {
        // Underlying state already meets the contract; re-render and re-QC so the
        // emitted OUTPUT (not just the state) is honest.
        const rendered = await safeReRender(reRender, cardId, cardOutput);
        const qc = cardOutputQc(rendered);
        if (qc.ok) {
          log({ event: 'finalize-card-healed', cardId, cycle, via: 'pass' });
          return { status: 'healed', cardOutput: rendered, qc };
        }
        // State passes but the rendered output still fails QC (a render bug). The
        // ledger has no defect to heal; emit the honest hard-block.
        break;
      }
      if (decision.action === 'blocked') {
        lastBlock = decision.honestBlock;
        break;
      }

      // decision.action === 'heal': run the full deploy+verify heal cycle. Bound it
      // to a single applied option per finalize cycle so the ABSOLUTE cap on apply
      // cycles is maxHealCycles, not the ladder length (the 5:30am safety bound).
      let heal;
      try {
        heal = await healCard(cardId, deps, { ...opts, maxApplied: 1 });
      } catch (e) {
        log({ event: 'finalize-card-heal-error', cardId, cycle, error: errMsg(e) });
        break;
      }

      if (heal.status === 'healed') {
        const rendered = await safeReRender(reRender, cardId, cardOutput);
        const qc = cardOutputQc(rendered);
        if (qc.ok) {
          log({ event: 'finalize-card-healed', cardId, cycle, commit: heal.commit });
          return { status: 'healed', cardOutput: rendered, qc };
        }
        // Healed in prod but the rendered output still fails QC: loop to re-decide.
        continue;
      }
      if (heal.status === 'blocked') {
        lastBlock = heal.honestBlock;
        break;
      }
      if (heal.status === 'capped') {
        // The per-cycle apply cap fired: one option was applied + recorded but did not
        // verify clean. Re-decide on the NEXT outer cycle (the next untried option),
        // which is itself bounded by maxHealCycles. This is how the absolute apply cap
        // = maxHealCycles is enforced regardless of ladder length.
        log({ event: 'finalize-card-heal-capped', cardId, cycle });
        continue;
      }
      // heal.status === 'timeout': budget hit inside the cycle. Stop and hard-block.
      log({ event: 'finalize-card-heal-timeout', cardId, cycle });
      break;
    }
  } catch (e) {
    // Belt-and-suspenders: no matter what threw, fall through to an honest block.
    log({ event: 'finalize-card-unexpected-error', cardId, error: errMsg(e) });
  }

  // 3. True exhaustion (or any non-heal terminal): emit the honest hard-block. It is
  // GENERATED from the heal record / attempt history. Both the ledger-sourced block
  // (lastBlock) and a freshly built one can carry banned self-narration the source
  // scrub does not fully strip, so EITHER could fail its own QC (PR3b Q5). Guard every
  // path: if the candidate block fails cardOutputQc, fall back to the guaranteed-minimal
  // honest block that passes by construction. The gate can never emit a block that fails
  // its own QC, so the published card is honest, never the original failing output and
  // never an invalid block.
  let block =
    lastBlock ||
    safeBuildBlockedCardOutput(
      opts.healRecord || {
        target: cardId,
        detail: `${cardId} failed QC and self-heal is exhausted`,
      },
    );
  let qc = cardOutputQc(block);
  if (!qc.ok) {
    // lastBlock (or a degenerate build) failed QC: emit the guaranteed-valid block,
    // preserving any captured attempt history for the morning audit.
    const attempts = block && block.attempts;
    block = safeBuildBlockedCardOutput(
      opts.healRecord || {
        target: cardId,
        detail: `${cardId} failed QC and self-heal is exhausted`,
      },
    );
    if (attempts) block.attempts = attempts;
    qc = cardOutputQc(block);
    log({ event: 'finalize-card-block-requalified', cardId, rung: block.rung, qcOk: qc.ok });
  }
  log({ event: 'finalize-card-blocked', cardId, rung: block.rung, qcOk: qc.ok });
  return { status: 'blocked', cardOutput: block, qc, attempts: block.attempts || null };
}

function errMsg(e) {
  return String((e && e.message) || e).slice(0, 240);
}

async function safeReRender(reRender, cardId, fallback) {
  try {
    const r = await reRender(cardId);
    return r || fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Real dependency implementations (wired by main(), not used by tests)
// ---------------------------------------------------------------------------

// (a) TESTS: run the LLM heal ladder, then commit verified-green files with an
// explicit-paths commit so the fix persists across the night (closes the
// no-commit gap). Only the files heal-tests-by-file verified green are
// committed, by explicit path, never `git add -A`.
function realHealTests({ date }) {
  const blockedPath = path.join(REPO, 'data', 'agent', 'tests-blocked.json');
  // Self-contained probe refresh: the converge loop cannot assume the 02:45
  // pre-briefing-diagnostic already ran (it runs AFTER this), so refresh the
  // failing-test set ourselves. heal-tests.js runs the full suite once and
  // writes both tests-blocked.json (the System Health + decision source) and
  // its vitest JSON; mirror that JSON to vitest-probe-output.json so the
  // heal-tests-by-file ladder heals against CURRENT failures, not a stale probe.
  runStep('refresh-tests-blocked', process.execPath, ['scripts/heal-tests.js'], {
    timeoutMs: 20 * 60 * 1000,
  });
  try {
    const healOut = path.join(REPO, 'data', 'agent', 'vitest-heal-output.json');
    const probeOut = path.join(REPO, 'data', 'agent', 'vitest-probe-output.json');
    if (fs.existsSync(healOut)) fs.copyFileSync(healOut, probeOut);
  } catch (e) {
    log({ event: 'probe-mirror-failed', error: String((e && e.message) || e) });
  }
  let blocked = null;
  try {
    blocked = JSON.parse(fs.readFileSync(blockedPath, 'utf8'));
  } catch {
    blocked = null;
  }
  const failingCount = blocked && Array.isArray(blocked.items) ? blocked.items.length : 0;
  if (!blocked || failingCount === 0) {
    return { ran: false, cleared: true, committed: false, reason: 'no failing tests recorded' };
  }
  // Snapshot which test files were failing before the heal so we can commit
  // exactly those (and only those) once they verify green.
  const beforeFiles = Array.from(
    new Set(
      (blocked.items || []).map((it) => (it && (it.file || it.relPath)) || '').filter(Boolean),
    ),
  );

  const heal = runStep(
    'heal-tests-by-file',
    process.execPath,
    ['scripts/heal-tests-by-file.js', '--deadline-ct', '05:10'],
    { timeoutMs: 90 * 60 * 1000 },
  );

  // Re-read tests-blocked.json to learn what is still failing after the ladder.
  let after = null;
  try {
    after = JSON.parse(fs.readFileSync(blockedPath, 'utf8'));
  } catch {
    after = null;
  }
  const stillFailing = new Set(
    (after && Array.isArray(after.items) ? after.items : [])
      .map((it) => (it && (it.file || it.relPath)) || '')
      .filter(Boolean),
  );
  const verifiedGreen = beforeFiles.filter((f) => !stillFailing.has(f));

  let committed = false;
  if (verifiedGreen.length > 0) {
    committed = commitVerifiedFiles(verifiedGreen, date);
  }
  return {
    ran: true,
    cleared: heal.ok && verifiedGreen.length === beforeFiles.length,
    committed,
    verifiedGreen,
    stillFailing: Array.from(stillFailing),
  };
}

// Explicit-paths commit of verified-green test/source files. Never `git add -A`
// in this shared working tree (feedback_git_commit_explicit_paths_in_shared_tree).
function commitVerifiedFiles(files, date) {
  const existing = files.filter((f) => {
    try {
      return fs.existsSync(path.join(REPO, f));
    } catch {
      return false;
    }
  });
  if (existing.length === 0) return false;
  const add = runStep('git-add-verified', 'git', ['add', '--', ...existing], {
    timeoutMs: 60 * 1000,
  });
  if (!add.ok) {
    log({ event: 'commit-skip', reason: 'git add failed', stderr: add.stderr.slice(-400) });
    return false;
  }
  // Nothing staged means the heal did not actually change these files.
  const staged = runStep('git-diff-staged', 'git', ['diff', '--cached', '--name-only'], {
    timeoutMs: 30 * 1000,
  });
  if (!staged.stdout.trim()) {
    log({ event: 'commit-skip', reason: 'nothing staged after add' });
    return false;
  }
  const msg =
    `fix(overnight-heal): persist verified-green tests for ${date}\n\n` +
    `Verified green by scripts/heal-tests-by-file.js during the overnight\n` +
    `converge loop. Explicit-paths commit so the fix survives the night.\n\n` +
    `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;
  const commit = runStep('git-commit-verified', 'git', ['commit', '-m', msg, '--', ...existing], {
    timeoutMs: 60 * 1000,
  });
  if (!commit.ok) {
    log({ event: 'commit-skip', reason: 'git commit failed', stderr: commit.stderr.slice(-400) });
    return false;
  }
  log({ event: 'commit-ok', files: existing });
  return true;
}

// (b) CONTENT-HEAL: bring viral/mortgage/news cards to threshold or a genuine wall. The
// module is owned by another agent and may not exist yet; require defensively.
async function realContentHeal({ date }) {
  let mod = null;
  try {
    mod = require('./content-heal.js');
  } catch {
    mod = null;
  }
  if (!mod || typeof mod.runContentHeal !== 'function') {
    log({ event: 'content-heal-skip', reason: 'content-heal.js not available' });
    return { ran: false, reason: 'content-heal.js not available' };
  }
  try {
    // runContentHeal is async: it re-runs content generators with widened
    // sources, then writes the
    // content-heal-<date>.json evidence file the regenerate step reads. It MUST be
    // awaited (Codex #5) -- the prior version returned the unresolved Promise, so
    // the regenerate step ran before the new content existed and the cards stayed
    // under threshold.
    const r = await mod.runContentHeal({ date });
    const viral = r && r.cards && r.cards.viral;
    const mortgage = r && r.cards && r.cards.mortgage;
    const newsCounts = {};
    for (const name of ['covid', 'us', 'world', 'aitech', 'immigration']) {
      const c = r && r.cards && r.cards[name];
      if (c) newsCounts[name] = { count: c.count, target: c.target, wall: !!c.wall };
    }
    return {
      ran: true,
      result: r,
      viralCount: viral && viral.count,
      mortgageCount: mortgage && mortgage.count,
      newsCounts,
      viralWall: !!(viral && viral.wall),
      mortgageWall: !!(mortgage && mortgage.wall),
    };
  } catch (e) {
    log({
      event: 'content-heal-error',
      error: String(e && e.message ? e.message : e).slice(0, 240),
    });
    return { ran: false, error: String(e && e.message ? e.message : e) };
  }
}

// (c) REGENERATE: re-derive generated sections WITHOUT publishing. --no-publish
// is passed explicitly so this step can never publish, regardless of the
// refresh script's default.
function realRegenerate({ date, mode }) {
  const r = runStep(
    'regenerate-no-publish',
    process.execPath,
    [
      'scripts/refresh-briefing-generated-sections.js',
      '--date',
      date,
      '--mode',
      mode || 'overnight',
      '--no-publish',
    ],
    { timeoutMs: 20 * 60 * 1000, env: { SKIP_EC2_PUBLISH: '1' } },
  );
  return { ok: r.ok, status: r.status };
}

// (d) VALIDATE: parse validate-briefing-quality.js --json.
function realValidate({ date }) {
  const r = runStep(
    'validate',
    process.execPath,
    ['scripts/validate-briefing-quality.js', '--date', date, '--json'],
    { timeoutMs: 8 * 60 * 1000 },
  );
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = null;
  }
  const failures = parsed && Array.isArray(parsed.failures) ? parsed.failures : [];
  // A parse failure is NOT clean: treat an unparseable validator as a failure
  // so we never publish on a broken gate.
  if (!parsed) {
    return { ok: false, failures: ['validator output unparseable; treating as not-clean'] };
  }
  // ACTIVATION (PR3b): surface a per-card cardOutput for the cards that FAILED so the
  // finalize gate receives them. A card with no failures gets NO cardOutput, so the gate
  // iterates past it byte-for-byte unchanged.
  return surfaceFailingCardOutputs({
    ok: failures.length === 0,
    failures,
    cards: parsed.cards || {},
  });
}

// ACTIVATION of the finalize gate (PR3b). The validator emits a per-card status map
// { SECTION: { ok, failures } } but no per-card cardOutput, which is why the gate was
// inert. This attaches a cardOutput ONLY to cards that FAILED validation, built as a
// guaranteed-QC-clean honest block from that card's own failures (never self-talk, never
// fabricated). A passing card (ok:true / no failures) is left exactly as-is with NO
// cardOutput, so the orchestrator's finalize loop (which only iterates entries carrying
// cardOutput) skips it and leaves it byte-for-byte unchanged. This is the activation that
// makes the gate fire on FAILING cards only.
function surfaceFailingCardOutputs(validation) {
  const v = validation || {};
  const cards = v.cards && typeof v.cards === 'object' ? v.cards : {};
  const out = {};
  for (const [section, entry] of Object.entries(cards)) {
    if (!entry || typeof entry !== 'object') {
      out[section] = entry;
      continue;
    }
    const failed =
      entry.ok === false || (Array.isArray(entry.failures) && entry.failures.length > 0);
    if (!failed) {
      // Passing card: leave it untouched, carry NO cardOutput so the gate skips it.
      out[section] = entry;
      continue;
    }
    // Failing card: attach an honest, QC-clean cardOutput derived from its own failures.
    const detail =
      Array.isArray(entry.failures) && entry.failures.length
        ? entry.failures.join('; ')
        : `${section} failed validation`;
    const healRecord = { target: section, detail };
    out[section] = {
      ...entry,
      healRecord,
      cardOutput: safeBuildBlockedCardOutput(healRecord),
    };
  }
  return { ...v, cards: out };
}

// Conservative LIVE finalize deps for the 5:30am build (PR3b activation). The briefing
// build must NEVER apply code or deploy to EC2 (that is the overnight heal loop's job,
// not the render path), so applyFix is a hard no-op that records "no in-process code
// fix" and advances; deploy/verify are never reached. observe reports the card is still
// red (so the gate does not falsely heal), and reRender returns the same honest block.
// Net effect: a failing card's output is finalized to a guaranteed-QC-clean honest block
// (replacing any self-talk), and NO live mutation can happen during the briefing build.
// The worst outcome under every failure mode is an honest-block card, never a deploy.
const realFinalizeDeps = {
  observe: async () => ({}),
  applyFix: async () => ({
    ok: false,
    reason:
      'in-process briefing build does not apply code fixes; the overnight heal loop owns repairs',
  }),
  deploy: async () => ({ ok: false, reason: 'no deploy during briefing build' }),
  verify: async () => ({ ok: false, reason: 'not verified; briefing build does not deploy' }),
  reRender: null,
};

// (e) PUBLISH: the overnight publish path. Runs the refresh script WITH
// --publish (and without SKIP_EC2_PUBLISH) so publishBriefingToEc2() actually
// scp's to EC2. shouldPublishToEc2() is OPT-IN (returns false unless --publish
// is present), so omitting the flag silently no-ops the publish -- that was the
// 2026-06-08 dead-publisher bug. Called only after the validator returned zero
// failures.
function realPublish({ date, mode }) {
  const env = { ...process.env };
  delete env.SKIP_EC2_PUBLISH;
  const r = runStep(
    'publish-briefing',
    process.execPath,
    [
      'scripts/refresh-briefing-generated-sections.js',
      '--date',
      date,
      '--mode',
      mode || 'overnight',
      '--publish',
    ],
    { timeoutMs: 20 * 60 * 1000, env },
  );
  // PUBLISH-THEN-LABEL render-QC (dev-plans/core/briefing-qc.md). This is a publish
  // path, so it runs the ONE render-QC (verify-dashboard-cards-live.js) against the
  // live published product and records its result. It NEVER blocks the publish that
  // already landed; a defect is logged loud and labeled (exit 1), unreachable is a
  // retry (exit 2). Keeping the reference here is also what the drift-lint requires:
  // the render-QC must be wired into BOTH publish paths, never just one.
  const qc = runRenderQc(date);
  return { ok: r.ok, status: r.status, renderQc: qc };
}

// Run the single render-QC CLI against the live dashboard for `date`. Returns a
// structured, non-throwing result so a publish is never aborted by the QC.
function runRenderQc(date) {
  const r = runStep(
    'render-qc',
    process.execPath,
    ['scripts/verify-dashboard-cards-live.js', '--date', date],
    { timeoutMs: 90 * 1000 },
  );
  if (r.status === 0) return { ran: true, ok: true };
  if (r.status === 2) return { ran: false, retry: true };
  // The render-QC prints its defect bullets to STDERR (process.exit(EXIT_DEFECT)
  // path in verify-dashboard-cards-live.js). The old `r.stdout || '' + r.stderr`
  // parsed as `r.stdout || ('' + r.stderr)`, so whenever stdout was non-empty
  // stderr was DROPPED and the orchestrator recorded a red QC with an EMPTY
  // defects list. Concatenate BOTH streams with correct precedence so a defect on
  // either stream is captured.
  const defects = String((r.stdout || '') + '\n' + (r.stderr || ''))
    .split('\n')
    .filter((l) => /^\s*-\s/.test(l))
    .map((l) => l.replace(/^\s*-\s/, '').trim());
  return { ran: true, ok: false, defects };
}

async function main() {
  const date = argValue('--date') || todayCt();
  // 2026-06-10 incident (feedback_codex_orphan_leak_thrashes_briefing.md): a run
  // got stuck on a STALE date (2026-06-01) and looped 14,079 times, spawning
  // codex/claude heal workers on every pass until the box was thrashed. A
  // briefing must build for today; refuse any date more than a day off so the
  // runaway cannot grind (and cannot leak processes) on a dead date. Override
  // with BRIEFING_ALLOW_STALE_DATE=1 for a deliberate backfill.
  const today = todayCt();
  const ageDays = (Date.parse(today) - Date.parse(date)) / 86400000;
  if (!process.env.BRIEFING_ALLOW_STALE_DATE && Number.isFinite(ageDays) && Math.abs(ageDays) > 1) {
    log({ event: 'stale-date-refused', date, today, ageDays });
    console.error(
      `[orchestrator] REFUSING stale date ${date} (today ${today}, ${Math.round(ageDays)}d off). ` +
        'A briefing builds for today, not a dead date. Set BRIEFING_ALLOW_STALE_DATE=1 to backfill.',
    );
    process.exit(2);
  }
  const mode = String(argValue('--mode') || process.env.BRIEFING_MODE || 'overnight').toLowerCase();
  const maxLoops = Number(
    argValue('--max-loops') || process.env.BRIEFING_QC_MAX_LOOPS || DEFAULT_MAX_LOOPS,
  );
  const deadlineCt = argValue('--deadline') || DEFAULT_DEADLINE_CT;
  const deadlineMs = parseDeadlineToTodayCt(deadlineCt);
  const started = Date.now();
  log({
    event: 'orchestrator-start',
    date,
    mode,
    maxLoops,
    deadlineCt,
    method:
      'single convergence state machine: heal-tests -> content-heal -> regenerate(no-publish) -> validate -> publish(only on ok)',
  });

  const result = await runConvergeLoop({
    date,
    mode,
    maxLoops,
    deadlineMs,
    deps: {
      healTests: realHealTests,
      contentHeal: realContentHeal,
      regenerate: realRegenerate,
      validate: realValidate,
      publish: realPublish,
      // ACTIVATION (PR3b): wire the conservative live finalize deps. realValidate now
      // surfaces a per-card cardOutput for FAILING cards, so the finalize gate fires on
      // those and replaces any self-talk with a healed or honest-block output. These deps
      // never apply code or deploy during the briefing build, so the worst outcome is an
      // honest-block card, never a live mutation or an aborted build.
      finalizeDeps: realFinalizeDeps,
    },
  });

  const durationMs = Date.now() - started;
  log({ event: 'orchestrator-finish', date, ...result, durationMs });

  if (result.ok) {
    console.log(
      `[overnight-briefing-orchestrator] CLEAN ${date} in ${Math.round(durationMs / 1000)}s (published once)`,
    );
    process.exit(0);
  }
  if (result.status === 'clean-unpublished') {
    console.error(
      `[overnight-briefing-orchestrator] CLEAN-UNPUBLISHED ${date}: validator passed but no publish landed ` +
        `(${result.publishCount} attempt(s), all failed). The dashboard is NOT serving today's briefing.`,
    );
    process.exit(1);
  }
  console.error(
    `[overnight-briefing-orchestrator] NOT-CLEAN ${date}: ${result.failures.length} validator failure(s), ${result.walls.length} ExampleCo-wall(s) after ${Math.round(durationMs / 1000)}s`,
  );
  for (const f of result.failures) console.error('- ' + f);
  for (const w of result.walls) console.error('- (ExampleCo wall) ' + w);
  process.exit(1);
}

// Parse "HH:MM" CT deadline into an absolute epoch ms (next occurrence).
function parseDeadlineToTodayCt(spec) {
  const m = String(spec || DEFAULT_DEADLINE_CT).match(/^([0-2]?\d):([0-5]\d)$/);
  if (!m) return Infinity;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const now = new Date();
  const dl = new Date(now);
  dl.setHours(hh, mm, 0, 0);
  if (dl.getTime() < now.getTime()) dl.setDate(dl.getDate() + 1);
  return dl.getTime();
}

if (require.main === module) {
  main().catch((error) => {
    log({ event: 'orchestrator-crash', error: error && error.stack ? error.stack : String(error) });
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = {
  runConvergeLoop,
  finalizeCard,
  classifyFailure,
  uniqueOwners,
  isExampleCoWall,
  parseDeadlineToTodayCt,
  DEFAULT_MAX_HEAL_CYCLES,
  // real deps exported for the main thread / integration callers
  realHealTests,
  realContentHeal,
  realRegenerate,
  realValidate,
  realPublish,
  commitVerifiedFiles,
  // gate activation (PR3b)
  surfaceFailingCardOutputs,
  realFinalizeDeps,
};
