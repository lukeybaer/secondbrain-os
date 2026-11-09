'use strict';

// Amy's Python version pin (Owner decision: "make them match").
//
// .python-version at the repo root names the one major.minor every Amy script
// runs on, on the PC and on EC2. Before the pin, EC2 ran `python3` as the
// Amazon Linux system 3.9 while the PC ran 3.14, so a test could pass on one
// and fail on the other. EC2 keeps its system python3 (dnf, mount.efs and the
// aws CLI need it); scripts/install-ec2-python-pin.sh points Amy's
// /usr/local/bin/python3 at the pinned interpreter, and the deploy refuses
// when the PC interpreter differs from the pin.

const fs = require('fs');
const { watchedLimitMs } = require('./watched-work-limit');
const path = require('path');
const { spawnSync } = require('child_process');

const PIN_FILE = '.python-version';
const PIN_RE = /^3\.\d+$/;
const DEFAULT_ROOT = path.join(__dirname, '..', '..');

function readPythonPin(root = DEFAULT_ROOT) {
  const raw = fs.readFileSync(path.join(root, PIN_FILE), 'utf8').trim();
  if (!PIN_RE.test(raw)) {
    throw new Error(`${PIN_FILE} must hold a major.minor such as 3.14, found "${raw}"`);
  }
  return raw;
}

// "Python 3.14.6" -> "3.14"
function majorMinorOf(text) {
  const match = String(text || '').match(/Python\s+(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : null;
}

// The versioned command name for the pin, e.g. "python3.14".
function pinnedPythonBin(root = DEFAULT_ROOT) {
  return `python${readPythonPin(root)}`;
}

// Probe order for scripts that look for an explicit interpreter (the yt-dlp
// clip builders): the pinned version first, then the older fallbacks. A
// missing or malformed pin file keeps the fallbacks rather than crashing.
function pythonProbeOrder(root = DEFAULT_ROOT) {
  const fallbacks = ['python3.12', 'python3.11', 'python3', 'python'];
  try {
    return [...new Set([pinnedPythonBin(root), ...fallbacks])];
  } catch {
    return fallbacks;
  }
}

// What Amy's scripts and tests launch: `python` on the PC (PYTHON_EXE
// overrides), `python3` everywhere else.
function defaultInterpreters(platform = process.platform, env = process.env) {
  if (platform === 'win32') return [env.PYTHON_EXE || 'python'];
  return ['python3'];
}

function interpreterVersion(bin, spawn = spawnSync) {
  const result = spawn(bin, ['--version'], { encoding: 'utf8', timeout: watchedLimitMs(15000), windowsHide: true });
  if (!result || result.error || result.status !== 0) {
    const reason = result && result.error ? result.error.message : `exit ${result ? result.status : 'unknown'}`;
    return { bin, version: null, error: reason };
  }
  return { bin, version: majorMinorOf(`${result.stdout || ''} ${result.stderr || ''}`) };
}

function checkPythonPin({ root = DEFAULT_ROOT, interpreters, spawn = spawnSync } = {}) {
  const pin = readPythonPin(root);
  const bins = interpreters && interpreters.length ? interpreters : defaultInterpreters();
  const found = bins.map((bin) => interpreterVersion(bin, spawn));
  const mismatches = found.filter((row) => row.version !== pin);
  return { ok: mismatches.length === 0, pin, found, mismatches };
}

function describe(row) {
  return `${row.bin}=${row.version || `unavailable (${row.error || 'no version'})`}`;
}

function main(argv = process.argv.slice(2)) {
  const interpreters = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--python' && argv[index + 1]) interpreters.push(argv[(index += 1)]);
  }
  const result = checkPythonPin({ interpreters });
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.ok) {
    console.log(`[python-pin] PASS: pin ${result.pin}; ${result.found.map(describe).join(', ')}`);
    return 0;
  }
  console.error(
    `[python-pin] REFUSED: ${PIN_FILE} pins ${result.pin} but ${result.mismatches.map(describe).join(', ')}. ` +
      `Put this machine back on Python ${result.pin}, or change ${PIN_FILE} so EC2 follows (the deploy then installs that version there).`,
  );
  return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  PIN_FILE,
  readPythonPin,
  majorMinorOf,
  pinnedPythonBin,
  pythonProbeOrder,
  defaultInterpreters,
  interpreterVersion,
  checkPythonPin,
  main,
};
