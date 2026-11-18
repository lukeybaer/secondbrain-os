#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  buildVoiceNameConflictAudit,
} = require('./lib/voice-name-conflicts');

const ROOT = path.resolve(process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..'));
const DATA_DIR = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(ROOT, 'data'));
const VP_DIR = path.join(DATA_DIR, 'life-archive', 'voiceprints');
const OUT = path.join(VP_DIR, 'voice-name-conflicts-latest.json');
const HISTORY = path.join(VP_DIR, 'voice-name-conflicts-history.jsonl');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function loadNameJudgmentReports(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^name-judge-.*\.json$/i.test(name) && !/progress\.json$/i.test(name))
    .sort()
    .map((name) => readJson(path.join(dir, name), null))
    .filter(Boolean);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function main() {
  const judgeDir = path.join(VP_DIR, 'llm-name-judges');
  const report = buildVoiceNameConflictAudit({
    registry: readJson(
      path.join(DATA_DIR, 'life-archive', 'voice-identity-registry.json'),
      {},
    ),
    recluster: readJson(path.join(VP_DIR, 'recluster-latest.json'), { clusters: [] }),
    sandboxCandidates: readJson(
      process.env.OTTER_SPEAKER_SANDBOX_CANDIDATES_PATH ||
        path.join(VP_DIR, 'speaker-resolver-sandbox-candidates-latest.json'),
      { candidates: [] },
    ),
    nameJudgmentReports: loadNameJudgmentReports(judgeDir),
    ownerCorrections: readJsonl(
      path.join(DATA_DIR, 'life-archive', 'people', 'voice-confirmation-actions.jsonl'),
    ),
  });
  if (process.argv.includes('--write')) {
    saveJson(OUT, report);
    fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
    fs.appendFileSync(HISTORY, `${JSON.stringify(report)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'GREEN' ? 0 : 2;
}

if (require.main === module) main();

module.exports = { main };
