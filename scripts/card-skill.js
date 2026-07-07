#!/usr/bin/env node
'use strict';
/**
 * card-skill.js -- print a briefing card's skill page: the SKILL.md body
 * (including its Pinned lessons) plus the last 10 LEARNINGS.md entries,
 * newest first. This is THE way any human or agent loads a card's accumulated
 * per-card knowledge before touching it (ExampleCo 2026-07-06).
 *
 * USAGE:
 *   node scripts/card-skill.js <card_id>          human-readable context block
 *   node scripts/card-skill.js <card_id> --json   machine-readable JSON
 *   node scripts/card-skill.js --list             every card id + page status
 *
 * <card_id> is a canonical manifest id (scripts/lib/briefing-card-manifest.js)
 * or the cross-cutting page id `briefing_shell`. The employer-news card's
 * runtime id (…_group_news) resolves to the neutral `employer_group_news`
 * page directory (PII gate -- see scripts/lib/card-skills.js).
 *
 * EXIT CODES: 0 success; 1 ExampleCo card id or unreadable page; 2 usage error.
 */

const {
  SHELL_PAGE_ID,
  pageDirForCardId,
  readCardPage,
  lastLearnings,
  formatCardSkillContext,
  LAST_N_LEARNINGS,
} = require('./lib/card-skills.js');
const { CARDS } = require('./lib/briefing-card-manifest.js');

function knownIds() {
  return [...CARDS.map((c) => c.id), SHELL_PAGE_ID];
}

function runList() {
  const rows = knownIds().map((id) => {
    const page = readCardPage(id);
    const dir = pageDirForCardId(id);
    return `${id}${dir !== id ? ` -> skills/cards/${dir}` : ''}  ${page ? `(page OK, ${page.learnings.length} learning entr${page.learnings.length === 1 ? 'y' : 'ies'})` : '(NO PAGE)'}`;
  });
  console.log(rows.join('\n'));
  return 0;
}

function runPrint(cardId, { json }) {
  if (!knownIds().includes(cardId)) {
    console.error(
      `[card-skill] ExampleCo card id '${cardId}'.\n` +
        `Known ids (manifest + shell):\n  ${knownIds().join('\n  ')}\n` +
        `Run 'node scripts/card-skill.js --list' to see page status for each.`,
    );
    return 1;
  }
  const page = readCardPage(cardId);
  if (!page) {
    console.error(
      `[card-skill] card '${cardId}' has no page at skills/cards/${pageDirForCardId(cardId)}/SKILL.md. ` +
        `Every card must have one (npm run verify:cards-drift enforces this).`,
    );
    return 1;
  }
  if (json) {
    console.log(
      JSON.stringify(
        {
          cardId,
          pageDir: page.pageDir,
          frontmatter: page.frontmatter,
          body: page.body,
          pinned: page.pinned,
          learningsTotal: page.learnings.length,
          lastLearnings: lastLearnings(page.learnings, LAST_N_LEARNINGS),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  console.log(formatCardSkillContext(cardId));
  return 0;
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const list = args.includes('--list');
  const positionals = args.filter((a) => !a.startsWith('--'));
  const badFlags = args.filter((a) => a.startsWith('--') && !['--json', '--list'].includes(a));
  if (badFlags.length) {
    console.error(`[card-skill] ExampleCo flag(s): ${badFlags.join(', ')}`);
    console.error('Usage: node scripts/card-skill.js <card_id> [--json] | --list');
    return 2;
  }
  if (list) return runList();
  if (positionals.length !== 1) {
    console.error('Usage: node scripts/card-skill.js <card_id> [--json] | --list');
    return 2;
  }
  return runPrint(positionals[0], { json });
}

if (require.main === module) process.exit(main(process.argv));

module.exports = { main, knownIds };
