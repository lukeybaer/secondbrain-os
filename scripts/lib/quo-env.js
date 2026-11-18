'use strict';
const fs = require('node:fs');
const DEFAULT_QUO_ENV_FILE = '/opt/secondbrain-durable/.env';
function loadQuoEnv(env = process.env, file = env.QUO_ENV_FILE || DEFAULT_QUO_ENV_FILE) {
  if (!fs.existsSync(file)) return { loaded: false, file };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/); if (!match || env[match[1]] != null) continue;
    let value = match[2].trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[match[1]] = value;
  }
  return { loaded: true, file };
}
module.exports = { DEFAULT_QUO_ENV_FILE, loadQuoEnv };
