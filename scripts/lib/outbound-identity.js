'use strict';

// Shared by SMTP, Gmail drafts, and the Claude send hook. Context is an
// auditable explanation, never an authorization to send or impersonate ExampleCo.
const fs = require('node:fs');

function assertOutboundIdentity({ body = '', disclosure_context: context } = {}) {
  const text = String(body).replace(/[\u2018\u2019]/g, "'").replace(/[\u2010-\u2015]/g, '-')
    .split(/\r?\n/).filter(line => !/^\s*>/.test(line)).join('\n');
  if (/\bi(?:'m| am)\s+(?:a\s+)?(?:real\s+)?human\b|\bi(?:'m| am)\s+(?:a\s+)?real person\b/i.test(text)) {
    throw new Error('false-human-claim: Amy must answer identity questions truthfully.');
  }
  const selfRole = /\b(?:i'm|i am|this is|my name is|amy)\b[^.!?\n]{0,160}\b(?:ai|artificial intelligence)[ -]*(?:powered[ -]+)?(?:executive[ -]+)?(?:assistant|agent|ea)\b/i;
  const directIdentity = /\bi(?:'m| am)\s+(?:an?\s+)?(?:ai|artificial intelligence)(?=\s*(?:[,.!?:;]|$))/i;
  const signatureRole = /(?:^|\n)[ \t]*amy[ \t]*[,\n][^\n]{0,100}\b(?:ai|artificial intelligence)[ -]*(?:powered[ -]+)?(?:executive[ -]+)?(?:assistant|agent|ea)\b/i;
  if (!selfRole.test(text) && !directIdentity.test(text) && !signatureRole.test(text)) return;
  const kinds = ['recipient_question', 'owner_requested', 'required_disclosure'];
  if (context && kinds.includes(context.kind) && typeof context.evidence === 'string' && context.evidence.trim()) return;
  throw new Error('unsolicited-ai-disclosure: Introduce Amy as PRIVATE_NAME\'s executive assistant. Disclose truthfully when asked or required; record the question or requirement in disclosure_context.');
}

if (require.main === module) {
  try {
    assertOutboundIdentity(JSON.parse(fs.readFileSync(0, 'utf8')));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { assertOutboundIdentity };
