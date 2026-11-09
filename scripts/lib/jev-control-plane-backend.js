'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BACKENDS = Object.freeze(['jev', 'off']);

function switchFile(root = path.resolve(__dirname, '..', '..'), env = process.env, platform = process.platform) {
  const runtimeRoot = env.SECONDBRAIN_ROOT || (platform === 'win32' ? path.join(os.homedir(), 'secondbrain') : root);
  const dataDir = env.SECONDBRAIN_DATA_DIR || (platform === 'win32' ? path.join(runtimeRoot, 'data') : '/opt/secondbrain/data');
  return path.join(dataDir, 'agent', 'jev-control-plane-backend.json');
}

function readJevControlPlaneBackend({ env = process.env, file = switchFile(undefined, env) } = {}) {
  const envBackend = String(env.JEV_CONTROL_PLANE_BACKEND || '').trim().toLowerCase();
  const envDisabled = String(env.JEV_CONTROL_PLANE_DISABLED_SURFACES || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  let state = { backend: 'off', disabledSurfaces: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (BACKENDS.includes(String(saved.backend || '').toLowerCase())) state.backend = String(saved.backend).toLowerCase();
    if (Array.isArray(saved.disabledSurfaces)) state.disabledSurfaces = saved.disabledSurfaces.map(String);
  } catch {
    // Deployment is not authorization. A missing switch is fail-closed until
    // an attributed activation is written by the control CLI.
  }
  // Environment state may narrow an attributed durable switch, never widen it.
  if (envBackend === 'off') state.backend = 'off';
  state.disabledSurfaces = [...new Set([...state.disabledSurfaces, ...envDisabled])];
  return state;
}

function controlPlaneSurfaceEnabled(surface, opts = {}) {
  const state = readJevControlPlaneBackend(opts);
  const wanted = String(surface || '');
  const disabled = state.disabledSurfaces.some((held) => wanted === held || wanted.startsWith(`${held}:`));
  return state.backend === 'jev' && !disabled;
}

function writeJevControlPlaneBackend({ backend, disabledSurfaces = [], by, file = switchFile(), now = new Date() }) {
  const wanted = String(backend || '').trim().toLowerCase();
  if (!BACKENDS.includes(wanted)) throw new Error(`unknown Jev control-plane backend "${backend}"`);
  if (!String(by || '').trim()) throw new Error('Jev control-plane backend changes require a nonempty --by actor');
  const state = { backend: wanted, disabledSurfaces: [...new Set(disabledSurfaces.map(String).filter(Boolean))], by: String(by), at: now.toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
  return state;
}

module.exports = { BACKENDS, switchFile, readJevControlPlaneBackend, controlPlaneSurfaceEnabled, writeJevControlPlaneBackend };
