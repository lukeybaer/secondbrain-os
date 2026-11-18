// command-auth.js
//
// Auth gate for the autonomous command-control surface. Before this, /commands*
// and run_claude_code on the public :3001 listener had ZERO auth: anyone on the
// internet could POST /commands and trigger autonomous code execution on EC2.
// Both the fan-out and Codex reviews flagged this as the #1 risk, to land before
// any further autonomy. 2026-06-02.
//
// Model:
//  - The on-box executor (process-dispatches.js) and the backend itself call
//    localhost, so localhost is exempt and keeps working with no token.
//  - Any non-localhost caller (the desktop PC worker over the public IP) must
//    present Authorization: Bearer <SB_COMMAND_TOKEN>.
//  - If no token is configured, external callers are denied (fail closed);
//    localhost still works so the executor never breaks.
//  - run_claude_code (voice-dispatched autonomous code exec) is additionally
//    gated on the caller being an owner phone.

const LOCAL_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

function isLocalRequest(remoteAddr) {
  if (!remoteAddr) return false;
  return LOCAL_ADDRS.has(String(remoteAddr).trim());
}

function bearerToken(authHeader) {
  const m = String(authHeader || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// Decide whether a command-control request is authorized.
// opts: { remoteAddr, authHeader, token }
function isAuthorizedCommandRequest({ remoteAddr, authHeader, token } = {}) {
  if (isLocalRequest(remoteAddr)) return true; // on-box executor / backend
  if (!token) return false; // no token configured: deny all external (fail closed)
  return bearerToken(authHeader) === token;
}

function normalizePhone(p) {
  return String(p || '').replace(/[^0-9]/g, '').replace(/^1(?=\d{10}$)/, '');
}

// Is the caller one of the owner phones? Used to gate voice-dispatched autonomous
// code execution so a random inbound caller cannot trigger run_claude_code.
function isOwnerCaller(number, ownerPhones) {
  const norm = normalizePhone(number);
  if (!norm) return false;
  const list = Array.isArray(ownerPhones)
    ? ownerPhones
    : String(ownerPhones || '').split(',');
  return list.map(normalizePhone).filter(Boolean).some((p) => p === norm);
}

module.exports = { isLocalRequest, bearerToken, isAuthorizedCommandRequest, normalizePhone, isOwnerCaller };
