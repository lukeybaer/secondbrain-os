// Append-only Telegram conversation logger used by ec2-server.js.
// Captures BOTH directions (inbound owner messages + outbound Amy replies)
// at the edges (pollTelegram entry, sendMessage wrapper) so nothing slips
// through. Extracted to its own module so it can be unit-tested without
// booting the full ec2-server.js process.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LOG_PATH = '/opt/secondbrain/data/agent/telegram-conversations.jsonl';

function createLogger({ logPath = DEFAULT_LOG_PATH, now = () => new Date().toISOString(), onError } = {}) {
  function log(row) {
    if (!row || typeof row !== 'object') return false;
    if (row.direction !== 'in' && row.direction !== 'out') {
      if (onError) onError(new Error('logTelegramEvent: direction must be "in" or "out"'));
      return false;
    }
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const safe = { ts: now(), ...row };
      if (typeof safe.text === 'string' && safe.text.length > 4000) {
        safe.text = safe.text.slice(0, 4000);
      }
      fs.appendFileSync(logPath, JSON.stringify(safe) + '\n');
      return true;
    } catch (e) {
      if (onError) onError(e);
      return false;
    }
  }
  return { log, logPath };
}

module.exports = { createLogger, DEFAULT_LOG_PATH };
