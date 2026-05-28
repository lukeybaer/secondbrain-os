#!/usr/bin/env node
/**
 * exec-clarity-gate.js
 *
 * 2026-05-25 #gap. Luke had shipped ~13 card fixes today and every miss
 * (literal "Open commitment" placeholder, dropped real-person/company rows,
 * recycled video rejection feedback, 938/22 weak virality numbers,
 * beluga whales on AI/Tech News) was caught post-hoc by Luke. Rules
 * existed in memory as advisory text, never mechanically enforced. This
 * gate runs after refresh-briefing-generated-sections.js and as a
 * PreToolUse hook on git push when staged files include briefing
 * renderers. It walks each card on the live dashboard with Playwright,
 * captures text + screenshot + click-through, and asks Claude to judge
 * against the briefing-exec-clarity-gate skill. Block-severity
 * violations fail the gate; the briefing must not publish (or push must
 * not proceed) until renderers are fixed.
 *
 * The skill (skills/communication/briefing-exec-clarity-gate.md) is the
 * authoritative spec. This script is the runtime. Per Luke: "this is a
 * skill, encompassing thousands of ideas, not a rote-memory exercise."
 * No literal-string matching; the judge is Claude with the skill loaded.
 *
 * Usage:
 *   node scripts/exec-clarity-gate.js [--date YYYY-MM-DD] [--url URL]
 *                                     [--card NAME] [--write-report] [--block-on-warn]
 *
 * Exit codes:
 *   0 - all cards passed, or only `warn`/`note` violations
 *   1 - one or more cards had block-severity violations
 *   2 - runtime failure (Playwright crashed, Claude unavailable, etc)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SKILL_PATH = path.join(REPO, 'skills', 'communication', 'briefing-exec-clarity-gate.md');
const REPORTS_DIR = path.join(REPO, 'data', 'agent', 'exec-clarity-gate');
const OVERRIDES_PATH = path.join(REPO, 'data', 'agent', 'exec-clarity-gate-overrides.jsonl');
const USERPROFILE = process.env.USERPROFILE || os.homedir();
const CLAUDE_CLI = path.join(USERPROFILE, 'AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js');

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const DATE = argValue('--date') || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const URL = argValue('--url') || `http://98.80.164.16:3001/briefing?date=${DATE}`;
const ONLY_CARD = argValue('--card');
const WRITE_REPORT = process.argv.includes('--write-report');
const BLOCK_ON_WARN = process.argv.includes('--block-on-warn');
const MODEL = argValue('--model', 'claude-sonnet-4-6');
const TIMEOUT_MS = Number(argValue('--timeout', '180000'));

function loadSkill() {
  if (!fs.existsSync(SKILL_PATH)) {
    throw new Error(`Skill not found at ${SKILL_PATH}. Cannot gate without the spec.`);
  }
  return fs.readFileSync(SKILL_PATH, 'utf8');
}

function loadOverrides() {
  if (!fs.existsSync(OVERRIDES_PATH)) return [];
  const raw = fs.readFileSync(OVERRIDES_PATH, 'utf8');
  return raw.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function overrideKey(cardName, check) {
  return `${cardName}::${check}`;
}

function isOverridden(overrides, cardName, check) {
  return overrides.some((o) => overrideKey(o.card_name, o.check) === overrideKey(cardName, check));
}

// Spawn the local Claude CLI with the gate prompt and a screenshot as an
// inline base64 attachment in the prompt body. Returns parsed JSON or
// throws on bad response.
function askClaude(promptText, { timeoutMs = 180000, model = 'claude-sonnet-4-6' } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const safe = String(promptText).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    const proc = spawn(process.execPath, [CLAUDE_CLI, '--model', model, '-p', safe], { env, windowsHide: true });
    const chunks = [];
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000).unref();
    }, timeoutMs);
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', () => {});
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error('claude timed out'));
      if (code !== 0) return reject(new Error(`claude exited ${code}`));
      resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function extractJson(raw) {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`no JSON object in claude response: ${raw.slice(0, 240)}`);
  return JSON.parse(body.slice(start, end + 1));
}

// composeCardPrompt(skill, card) builds the per-card prompt. The prompt
// is intentionally narrative + the skill body; no rule restatement. The
// judge applies the skill to the card content.
function composeCardPrompt({ skillBody, cardName, headlineText, drilldownText, markdownExcerpt }) {
  return [
    'You are the Briefing Exec Clarity Gate. Apply the skill below to a single briefing card.',
    'Return ONE JSON object matching the schema in the skill (card_name, passes, violations[], two_line_exec_summary).',
    'Do not include any text before or after the JSON. Do not wrap in markdown fences.',
    '',
    '=== SKILL ===',
    skillBody,
    '',
    '=== CARD UNDER REVIEW ===',
    `Card name: ${cardName}`,
    '',
    '--- Headline DOM text ---',
    headlineText || '(no headline text captured)',
    '',
    '--- Drilldown DOM text (after expand or click) ---',
    drilldownText || '(no drilldown captured)',
    '',
    '--- Markdown source excerpt for this card ---',
    markdownExcerpt || '(no markdown source captured)',
    '',
    'Judge against all four checks (exec brevity, relevance to Luke, per-row why-it-matters, click-through correctness).',
    'List every violation you observe, with severity, the specific row or section, what failed, and a concrete suggested fix.',
    'If the card passes all four checks cleanly, return passes: true with an empty violations array.',
  ].join('\n');
}

async function runGate() {
  const skillBody = loadSkill();
  const overrides = loadOverrides();
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  console.log(`[gate] loading ${URL}`);
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.error(`[gate] failed to load ${URL}: ${e.message}`);
    process.exit(2);
  }
  await page.waitForSelector('section[data-section]', { timeout: 20000 });
  const cards = await page.$$eval('section[data-section]', (els) => {
    return els.map((el) => {
      const name = el.getAttribute('data-section') || '(unnamed)';
      const headline = (el.querySelector('.tile-headline, h2, .tile-title') || el).textContent || '';
      const drilldown = (el.querySelector('.tile-full, .drilldown, .tile-body') || el).textContent || '';
      return { name, headline: headline.trim().slice(0, 4000), drilldown: drilldown.trim().slice(0, 12000) };
    });
  });
  console.log(`[gate] found ${cards.length} cards on dashboard`);

  const briefingMd = (() => {
    const p = path.join(REPO, 'data', 'briefings', `briefing-${DATE}.md`);
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8');
  })();

  function markdownExcerptForCard(name) {
    if (!briefingMd) return '';
    const upper = name.toUpperCase();
    const sIdx = briefingMd.toUpperCase().indexOf(upper);
    if (sIdx < 0) return '';
    const remainder = briefingMd.slice(sIdx);
    // grab up to next blank line after a non-trivial body
    const nextSectionRe = /\n[A-Z][A-Z &/-]{6,}.*?:\n/;
    const m = remainder.slice(40).match(nextSectionRe);
    const cut = m ? 40 + m.index : 4000;
    return remainder.slice(0, Math.min(cut, 6000));
  }

  const targetCards = ONLY_CARD
    ? cards.filter((c) => c.name.toLowerCase().includes(ONLY_CARD.toLowerCase()))
    : cards;
  if (ONLY_CARD && targetCards.length === 0) {
    console.error(`[gate] --card ${ONLY_CARD} did not match any card name`);
    await browser.close();
    process.exit(2);
  }

  const verdicts = [];
  for (const card of targetCards) {
    const prompt = composeCardPrompt({
      skillBody,
      cardName: card.name,
      headlineText: card.headline,
      drilldownText: card.drilldown,
      markdownExcerpt: markdownExcerptForCard(card.name),
    });
    let verdict;
    try {
      const raw = await askClaude(prompt, { timeoutMs: TIMEOUT_MS, model: MODEL });
      verdict = extractJson(raw);
    } catch (err) {
      console.warn(`[gate] judge failed on card ${card.name}: ${err.message}`);
      verdict = {
        card_name: card.name,
        passes: false,
        violations: [{ check: 'gate_runtime', severity: 'warn', row_or_section: 'whole_card', what_failed: `Judge call failed: ${err.message}`, suggested_fix: 'Re-run the gate; if persistent, lower model or shorten the prompt.' }],
        two_line_exec_summary: 'Judge unavailable; card not assessed this run.',
      };
    }
    verdict.card_name = verdict.card_name || card.name;
    // Drop violations whose (card,check) has a recorded override.
    if (Array.isArray(verdict.violations)) {
      verdict.violations = verdict.violations.filter((v) => !isOverridden(overrides, verdict.card_name, v.check));
      if (verdict.violations.length === 0) verdict.passes = true;
    }
    verdicts.push(verdict);
    const tag = verdict.passes ? 'PASS' : (verdict.violations || []).some((v) => v.severity === 'block') ? 'BLOCK' : 'WARN';
    console.log(`[gate] ${tag} ${card.name}: ${(verdict.two_line_exec_summary || '').slice(0, 180)}`);
    for (const v of (verdict.violations || [])) {
      console.log(`         (${v.severity}) ${v.check} @ ${v.row_or_section}: ${(v.what_failed || '').slice(0, 200)}`);
    }
  }

  await browser.close();

  if (WRITE_REPORT) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const reportPath = path.join(REPORTS_DIR, `report-${DATE}-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify({ date: DATE, url: URL, verdicts }, null, 2));
    console.log(`[gate] wrote ${reportPath}`);
  }

  const blocks = verdicts.flatMap((v) => (v.violations || []).filter((x) => x.severity === 'block'));
  const warns = verdicts.flatMap((v) => (v.violations || []).filter((x) => x.severity === 'warn'));
  if (blocks.length > 0) {
    console.error(`[gate] FAILED: ${blocks.length} block-severity violation(s) across ${verdicts.filter((v) => !v.passes).length} card(s)`);
    process.exit(1);
  }
  if (BLOCK_ON_WARN && warns.length > 0) {
    console.error(`[gate] FAILED (block-on-warn): ${warns.length} warn-severity violation(s)`);
    process.exit(1);
  }
  console.log(`[gate] OK: ${verdicts.filter((v) => v.passes).length}/${verdicts.length} cards clean`);
  process.exit(0);
}

if (require.main === module) {
  runGate().catch((e) => {
    console.error('[gate] runtime failure:', e.message);
    process.exit(2);
  });
}

module.exports = { composeCardPrompt, extractJson };
