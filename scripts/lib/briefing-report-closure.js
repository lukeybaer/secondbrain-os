'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  readStatePackage,
  statePackagePath,
} = require('./briefing-report-state-package.js');

const SCHEMA = 'briefing_report_closure.v1';

function dayKey(value) {
  const date = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('briefing report closure requires YYYY-MM-DD date');
  return date;
}

function reportClosurePath(dataDir, date) {
  return path.join(
    path.resolve(dataDir),
    'agent',
    'briefing-overnight-watch',
    `${dayKey(date)}-report-closure.json`,
  );
}

function watchReportPath(dataDir, date) {
  return path.join(path.resolve(dataDir), 'briefings', `watch-report-${dayKey(date)}.html`);
}

function morningReportPath(dataDir, date) {
  return path.join(
    path.resolve(dataDir),
    'agent',
    'briefing-overnight-watch',
    `${dayKey(date)}-morning-report.html`,
  );
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// A deterministic finalize (2026-09-01 amendment, dev-plans/core/briefing.md)
// closes only when it also carries the visible unavailable label; the mode
// meta tag alone is not proof the report actually rendered the honest notice.
const DETERMINISTIC_SYNTHESIS_LABEL_RE = /Strategic synthesis unavailable tonight/;

function watchReportShape(html) {
  const source = String(html || '');
  const finalized = /<meta\s+name=["']watch-report-finalized["']\s+content=["']true["']/i.test(source);
  const analysisMode = source.match(
    /<meta\s+name=["']watch-report-analysis["']\s+content=["']([^"']+)["']/i,
  )?.[1] || null;
  const modelBacked = analysisMode === 'llm';
  const deterministicFinalized =
    analysisMode === 'deterministic' && DETERMINISTIC_SYNTHESIS_LABEL_RE.test(source);
  const tokenStatus = source.match(/data-exact-overnight-token-status=["']([^"']+)["']/i)?.[1] || 'not-present';
  const statePackageSha256 = source.match(
    /<meta\s+name=["']watch-report-state-package-sha256["']\s+content=["']([a-f0-9]{64})["']/i,
  )?.[1] || null;
  return { finalized, modelBacked, deterministicFinalized, analysisMode, tokenStatus, statePackageSha256 };
}

function statePackageEvidence(
  dataDir,
  date,
  expectedSha256 = null,
  required = Boolean(expectedSha256),
) {
  const file = statePackagePath(dataDir, date);
  try {
    const loaded = readStatePackage({ dataDir, date, expectedSha256 });
    const parsed = loaded?.parsed || null;
    return {
      required: Boolean(required),
      valid: Boolean(parsed) && (!required || Boolean(expectedSha256)),
      path: path.relative(path.resolve(dataDir), file).replace(/\\/g, '/'),
      sha256: parsed?.sha256 || null,
      cutoff_at: parsed?.cutoffAt || null,
    };
  } catch {
    return {
      required: Boolean(required),
      valid: false,
      path: path.relative(path.resolve(dataDir), file).replace(/\\/g, '/'),
      sha256: null,
      cutoff_at: null,
    };
  }
}

function fileEvidence(file) {
  if (!fs.existsSync(file)) return { exists: false, bytes: 0, sha256: null };
  const bytes = fs.readFileSync(file);
  return { exists: true, bytes: bytes.length, sha256: sha256(bytes) };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Successful rename removes the temporary file.
    }
  }
}

function buildReportClosure({ dataDir, date, phase = 'prep', now = new Date() } = {}) {
  const briefingDate = dayKey(date);
  if (!['prep', 'handoff'].includes(phase)) throw new Error('report closure phase must be prep or handoff');
  const watchFile = watchReportPath(dataDir, briefingDate);
  if (!fs.existsSync(watchFile)) throw new Error(`same-date watch report is missing: ${watchFile}`);
  const watchBytes = fs.readFileSync(watchFile);
  const shape = watchReportShape(watchBytes.toString('utf8'));
  if (!shape.finalized || (!shape.modelBacked && !shape.deterministicFinalized)) {
    throw new Error(
      'same-date watch report is not finalized model-backed or deterministic-finalized output',
    );
  }
  const exactTokenRequired = phase === 'handoff';
  const exactTokenValid = shape.tokenStatus === 'measured';
  const statePackage = statePackageEvidence(
    dataDir,
    briefingDate,
    shape.statePackageSha256,
    exactTokenRequired || Boolean(shape.statePackageSha256) || shape.deterministicFinalized,
  );
  const blockedReason = exactTokenRequired && !exactTokenValid
    ? `exact 11:00 PM-5:30 AM CT token receipt is ${shape.tokenStatus}`
    : statePackage.required && !statePackage.valid
      ? shape.deterministicFinalized
        ? 'deterministic-finalized watch report evidence-package hash does not bind to a valid same-date state package'
        : 'same-date report state package is missing, changed, or invalid'
      : null;
  const morningFile = morningReportPath(dataDir, briefingDate);
  const root = path.resolve(dataDir);
  return {
    schema: SCHEMA,
    closure_id: `BRIEFING-REPORT-CLOSURE-${briefingDate}`,
    briefing_date: briefingDate,
    generated_at: new Date(now).toISOString(),
    phase,
    status: blockedReason ? 'blocked' : 'closed',
    blocked_reason: blockedReason,
    watch_report: {
      path: path.relative(root, watchFile).replace(/\\/g, '/'),
      bytes: watchBytes.length,
      sha256: sha256(watchBytes),
      finalized: true,
      analysis: shape.deterministicFinalized ? 'deterministic' : 'llm',
    },
    morning_report: {
      path: path.relative(root, morningFile).replace(/\\/g, '/'),
      ...fileEvidence(morningFile),
    },
    state_package: statePackage,
    exact_token_cut: {
      required: exactTokenRequired,
      status: shape.tokenStatus,
      valid: exactTokenValid,
    },
  };
}

function verifyReportClosureObject(
  receipt,
  { dataDir, date, watchReportHtml = null, skipMorningReportFileCheck = false } = {},
) {
  const problems = [];
  let briefingDate;
  try {
    briefingDate = dayKey(date);
  } catch (error) {
    return { ok: false, status: 'invalid', problems: [error.message], receipt: null };
  }
  if (!receipt || receipt.schema !== SCHEMA) problems.push('missing or invalid closure schema');
  if (String(receipt?.briefing_date || '') !== briefingDate) problems.push('wrong briefing date');
  if (receipt?.status !== 'closed') problems.push(receipt?.blocked_reason || 'closure is not closed');

  let reportBytes = null;
  if (watchReportHtml != null) {
    reportBytes = Buffer.from(String(watchReportHtml), 'utf8');
  } else {
    const file = watchReportPath(dataDir, briefingDate);
    if (fs.existsSync(file)) reportBytes = fs.readFileSync(file);
  }
  if (!reportBytes) {
    problems.push('same-date watch report is missing');
  } else {
    const shape = watchReportShape(reportBytes.toString('utf8'));
    if (!shape.finalized || (!shape.modelBacked && !shape.deterministicFinalized)) {
      problems.push('watch report is not finalized model-backed or deterministic-finalized output');
    }
    if (shape.deterministicFinalized && receipt?.state_package?.required !== true) {
      problems.push('deterministic-finalized watch report requires a bound evidence-package hash');
    }
    if (sha256(reportBytes) !== receipt?.watch_report?.sha256) problems.push('watch report hash does not match closure');
    if (Number(receipt?.watch_report?.bytes) !== reportBytes.length) problems.push('watch report byte count does not match closure');
    if (receipt?.phase === 'handoff' && shape.tokenStatus !== 'measured') {
      problems.push('handoff lacks the exact measured overnight token cut');
    }
    if (shape.statePackageSha256 !== (receipt?.state_package?.required ? receipt?.state_package?.sha256 : null)) {
      problems.push('watch report state package hash does not match closure');
    }
  }


  if (receipt?.state_package?.required) {
    if (!receipt.state_package.sha256) {
      problems.push('required report state-package binding is missing');
    }
    const actualStatePackage = statePackageEvidence(
      dataDir,
      briefingDate,
      receipt.state_package.sha256,
      true,
    );
    if (!actualStatePackage.valid) problems.push('same-date report state package changed or is invalid');
    if (actualStatePackage.cutoff_at !== receipt.state_package.cutoff_at) {
      problems.push('same-date report state package cutoff changed after closure');
    }
  }

  if (!skipMorningReportFileCheck) {
    const actual = fileEvidence(morningReportPath(dataDir, briefingDate));
    const expected = receipt?.morning_report || {};
    if (Boolean(actual.exists) !== Boolean(expected.exists)) problems.push('morning report existence changed after closure');
    if (actual.exists && (actual.sha256 !== expected.sha256 || actual.bytes !== Number(expected.bytes))) {
      problems.push('morning report bytes do not match closure');
    }
  }
  return {
    ok: problems.length === 0,
    status: problems.length === 0 ? 'closed' : 'invalid',
    problems,
    receipt,
  };
}

function writeReportClosure(options = {}) {
  const receipt = buildReportClosure(options);
  const file = reportClosurePath(options.dataDir, options.date);
  try {
    const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      prior?.state_package?.required === true &&
      prior.state_package.valid === true &&
      receipt.state_package?.required !== true
    ) {
      throw new Error('report closure refuses to drop an existing state-package binding');
    }
    if (
      prior?.state_package?.required === true &&
      prior.state_package.valid === true &&
      receipt.state_package?.required === true &&
      prior.state_package.sha256 !== receipt.state_package.sha256
    ) {
      throw new Error('report closure refuses to replace an existing state-package binding');
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  writeJsonAtomic(file, receipt);
  const verification = verifyReportClosureObject(receipt, options);
  return { ...verification, path: file };
}

function verifyReportClosure({ dataDir, date } = {}) {
  const file = reportClosurePath(dataDir, date);
  let receipt = null;
  try {
    receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, status: 'missing', problems: ['same-date report closure receipt is missing'], receipt: null, path: file };
  }
  return { ...verifyReportClosureObject(receipt, { dataDir, date }), path: file };
}

module.exports = {
  SCHEMA,
  buildReportClosure,
  morningReportPath,
  reportClosurePath,
  statePackagePath,
  statePackageEvidence,
  verifyReportClosure,
  verifyReportClosureObject,
  watchReportPath,
  watchReportShape,
  writeReportClosure,
};
