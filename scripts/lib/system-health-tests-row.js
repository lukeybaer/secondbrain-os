const INFORMATIONAL_TESTS_ROW =
  '? Tests: run on the desktop and in CI, not evaluated on the cloud build (informational, not a failure).';

function firstErrorLine(item) {
  return (
    String((item && (item.error || item.errorDetail)) || '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('at ')) || ''
  );
}

function summarizeFailingTests(tests) {
  const failed = Number((tests && tests.failed) || 0);
  const items = Array.isArray(tests && tests.items) ? tests.items : [];
  const names = [];
  const seen = new Set();
  for (const item of items) {
    const name = String((item && (item.name || item.file)) || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name.slice(0, 80));
  }
  const shown = names.slice(0, 3);
  const more = Math.max(0, names.length - shown.length);
  const list = shown.length ? `: ${shown.join('; ')}${more ? `; +${more} more` : ''}` : '';
  return `${failed} failing test${failed === 1 ? '' : 's'}${list}.`;
}

function formatTestsHealthRow(tests) {
  if (!tests || typeof tests !== 'object') return INFORMATIONAL_TESTS_ROW;
  const failed = Number(tests.failed || 0);
  if (failed > 0) return `✗ Tests: ${summarizeFailingTests(tests)}`;
  return `✓ Tests: 0 failed; ${tests.passed || 0} passed, ${tests.skipped || 0} skipped across ${tests.files || 0} files. Full suite command: ${tests.command || 'not recorded'}.`;
}

module.exports = {
  INFORMATIONAL_TESTS_ROW,
  firstErrorLine,
  formatTestsHealthRow,
  summarizeFailingTests,
};
