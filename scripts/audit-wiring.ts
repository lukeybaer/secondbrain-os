/**
 * audit-wiring.ts
 *
 * On-demand CLI view of the module-wiring ratchet. `npm run audit:wiring`
 * prints the executive headline, the full orphan list (tested-but-unwired
 * first, biggest dead weight first), and the ratchet verdict, then exits 1 if
 * the live count regressed above WIRING_BASELINE.
 *
 * The vitest gate (module-wiring-ratchet.test.ts) is the enforcement that runs
 * on every push; this script is the human/CI diagnostic for "what exactly is
 * orphaned and how do I wire it down." Both reuse the same pure helpers in
 * src/main/module-wiring-audit.ts - no logic is duplicated here.
 *
 * Run: npx tsx scripts/audit-wiring.ts   (or: npm run audit:wiring)
 */

import * as path from 'path';
import {
  buildWiringDigest,
  checkWiringRatchet,
  renderWiringHeadline,
} from '../src/main/module-wiring-audit';

const SRC_MAIN = path.resolve(__dirname, '..', 'src', 'main');

function main(): void {
  const audit = buildWiringDigest(SRC_MAIN);
  const verdict = checkWiringRatchet(audit);

  console.log(renderWiringHeadline(audit));
  console.log(
    `wired=${audit.wiredModules} orphans=${audit.orphanModules} ` +
      `entrypoints=${audit.entrypointModules} deadWeightLines=${audit.deadWeightLines} ` +
      `(baseline ${verdict.baselineOrphans}/${verdict.baselineLines})`,
  );

  if (audit.orphans.length > 0) {
    console.log('\nOrphans (T = tested-but-unwired, the higher-signal kind):');
    for (const o of audit.orphans) {
      const tag = o.status === 'orphan-tested' ? 'T' : ' ';
      console.log(`  ${tag} ${o.name.padEnd(42)} lines=${o.lineCount}`);
    }
  }

  console.log(`\n${verdict.message}`);

  if (!verdict.ok) {
    process.exitCode = 1;
  }
}

main();
