'use strict';

// S-15: the broad category run, once per batch before production. land.js used
// to run it for every change; ship.js now runs it once against the exact commit
// it deploys, over the files changed from the live release to that commit, so
// every category a land used to cover is still covered before the deploy that
// carries it. A failure listed in config/known-master-failures.json is reported
// and does not block; any other failure refuses the deploy.

const categoryTests = require('./land-category-tests.js');
const known = require('./known-master-failures.js');

/**
 * @param {object} args
 * @param {string} args.root checkout at the commit being deployed
 * @param {string[]} args.files files changed from the live release to that commit
 * @param {(files: string[], cwd: string) => {failedFiles: string[], timedOut: boolean, crashed: boolean}} args.runVitest
 * @param {(file: string) => string} args.categoryOf
 * @param {(category: string) => string[]} args.listCategoryFiles
 * @param {(files: string[]) => string[]} args.listReaderTests
 * @param {(line: string) => void} [args.log]
 */
// runAtRelease(failed) -> { failedFiles } | null: the failed files rerun alone in a
// detached checkout of the live release, same dependencies. A failure the live
// release also has (a worktree environment gap, an older red) is pre-existing,
// like the per-land master comparison this run replaced. null = could not check.
function runBroadSuite({ root, files, runVitest, categoryOf, listCategoryFiles, listReaderTests, runAtRelease = null, log = () => {} }) {
  const list = known.loadKnownFailures(root);
  const gate = categoryTests.runCategoryGate({
    changedFiles: files,
    categoryOf,
    listCategoryFiles,
    listReaderTests,
    runVitest: (batch) => runVitest(batch, root),
    // Pre-existing = listed in config/known-master-failures.json, or also red at
    // the live release. If the release cannot be checked, only the list counts.
    runAtBase: (failed) => {
      const listed = failed.filter((f) => list.files.has(f));
      const rest = failed.filter((f) => !list.files.has(f));
      if (!rest.length || typeof runAtRelease !== 'function') return { failedFiles: listed };
      const atRelease = runAtRelease(rest);
      if (!atRelease) log('could not check the live release; only listed known failures are pre-existing.');
      return { failedFiles: [...listed, ...((atRelease && atRelease.failedFiles) || [])] };
    },
    log,
  });
  const failed = [...(gate.newFailures || []), ...(gate.preexisting || [])];
  const classified = known.classifyFailures({ failed, ran: gate.files || [], known: list });
  known.reportKnownFailures(log, list, classified);
  const qualitySuites = {};
  for (const category of gate.categories || []) {
    const inCategory = new Set(listCategoryFiles(category));
    const bad = (gate.newFailures || []).filter((f) => inCategory.has(f)).length;
    const pre = (gate.preexisting || []).filter((f) => inCategory.has(f)).length;
    qualitySuites[`category-${category}`] = {
      status: bad ? 'red' : 'green',
      passed: Math.max(0, inCategory.size - bad - pre),
      failed: bad + pre,
      total: inCategory.size,
      unit: 'files',
      note: pre ? `${pre} known master failure(s), not blocking` : '',
    };
  }
  return { ...gate, qualitySuites, knownFailing: classified.knownFailing, nowPassing: classified.nowPassing };
}

module.exports = { runBroadSuite };
