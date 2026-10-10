'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEV_PLAN_HTML_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/;

function resolveBriefingDevPlan(fileName, { repoRoot, fsApi = fs } = {}) {
  const name = String(fileName || '').trim();
  if (!DEV_PLAN_HTML_NAME_RE.test(name) || name.includes('..')) {
    return { ok: false, status: 400, reason: 'Bad file' };
  }
  const root = path.resolve(String(repoRoot || path.join(__dirname, '..', '..')));
  const plansRoot = path.join(root, 'dev-plans');
  const file = path.join(plansRoot, name);
  try {
    if (!fsApi.statSync(file).isFile()) throw new Error('not a file');
    const realPlansRoot = fsApi.realpathSync(plansRoot);
    const realFile = fsApi.realpathSync(file);
    const relative = path.relative(realPlansRoot, realFile);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ok: false, status: 400, reason: 'Bad file' };
    }
    return { ok: true, status: 200, file: realFile, name };
  } catch {
    return { ok: false, status: 404, reason: 'No dev plan' };
  }
}

module.exports = { DEV_PLAN_HTML_NAME_RE, resolveBriefingDevPlan };
