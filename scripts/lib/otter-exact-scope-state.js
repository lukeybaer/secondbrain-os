#!/usr/bin/env node
'use strict';

// Stage-chaining state for an exact Otter scope (2026-09-24). The healer runner
// keeps dispatching an exact scope while some call is still open and the last
// dispatch moved some stage; this module reports both facts from the ledger.

const fs = require('fs');

function exactScopeState(ledger, ids) {
  const byId = new Map((ledger?.calls || []).map((call) => [call.otid, call]));
  const scope = ids.map((id) => String(id || '').trim()).filter(Boolean);
  const open = scope.filter((id) => byId.get(id) && byId.get(id).closed !== true);
  const signature = scope
    .map((id) => {
      const call = byId.get(id);
      return `${id}:${call?.closed === true ? 'closed' : call?.repair_stage || '?'}`;
    })
    .join(',');
  return { open, signature };
}

// Chain again only while something is open and the previous dispatch changed
// the scope's stages; an unchanged signature means the calls are waiting on
// something a re-dispatch cannot fix.
function shouldChain(previous, next) {
  return next.open.length > 0 && next.signature !== previous.signature;
}

if (require.main === module) {
  const [file, csv = ''] = process.argv.slice(2);
  let ledger = null;
  try {
    ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    ledger = null;
  }
  const state = exactScopeState(ledger, csv.split(','));
  process.stdout.write(`${state.open.join(',')}|${state.signature}`);
}

module.exports = { exactScopeState, shouldChain };
