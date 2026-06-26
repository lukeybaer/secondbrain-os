// email-auth-check.js
//
// DMARC-aligned authenticity check for owner (#Amy) emails.
//
// Replaces the old substring check (from.includes(owner) && to.includes(owner))
// which accepted spoofed senders, display-name tricks, and +alias variants.
// Codex adversarial review (2026-06-11) mandated: exact parsed-address match
// on From, owner among parsed To recipients, and an Authentication-Results
// header showing dkim=pass aligned to the From domain (or spf=pass with an
// aligned smtp.mailfrom), with dmarc=pass required whenever dmarc appears.
// Fail closed: missing or unparseable evidence means NOT authentic.

const DEFAULT_OWNER = 'ExampleCo.d.ExampleCo@gmail.com';

/**
 * Parse the single RFC-5322 address out of a From-style header. Angle-bracket
 * address wins over display text ("Evil <real@x>" parses to real@x). Returns
 * null when zero or more than one address is found (fail closed).
 */
function parseSingleAddress(header) {
  if (!header || typeof header !== 'string') return null;
  const angles = [...header.matchAll(/<([^<>]+)>/g)]
    .map((m) => m[1].trim().toLowerCase())
    .filter((a) => a.includes('@'));
  if (angles.length === 1) return angles[0];
  if (angles.length > 1) return null;
  const bare = header.match(/[^\s,;"'<>]+@[^\s,;"'<>]+/g) || [];
  if (bare.length === 1) return bare[0].toLowerCase();
  return null;
}

/**
 * Parse every recipient address out of a To-style header (display names,
 * angle brackets, comma-separated lists). Quoted display names are stripped
 * before scanning for bare addresses so "a@b" <c@d> yields only c@d.
 */
function parseRecipientAddresses(header) {
  if (!header || typeof header !== 'string') return [];
  const angles = [...header.matchAll(/<([^<>]+)>/g)]
    .map((m) => m[1].trim().toLowerCase())
    .filter((a) => a.includes('@'));
  const rest = header.replace(/"[^"]*"/g, ' ').replace(/<[^<>]*>/g, ' ');
  const bare = (rest.match(/[^\s,;"'<>]+@[^\s,;"'<>]+/g) || []).map((a) => a.toLowerCase());
  return [...new Set([...angles, ...bare])];
}

/** Domain part of an address, or the value itself when it is already a domain. */
function domainOf(addrOrDomain) {
  if (!addrOrDomain) return '';
  const s = String(addrOrDomain)
    .trim()
    .toLowerCase()
    .replace(/[>;,)\s]+$/g, '');
  const at = s.lastIndexOf('@');
  return at >= 0 ? s.slice(at + 1) : s;
}

/** Relaxed DMARC-style alignment: equal, or one is a subdomain of the other. */
function isAligned(domain, fromDomain) {
  if (!domain || !fromDomain) return false;
  return (
    domain === fromDomain || domain.endsWith('.' + fromDomain) || fromDomain.endsWith('.' + domain)
  );
}

/**
 * Parse the Gmail Authentication-Results header string into the bits the
 * decision needs. Tolerates Gmail's parenthetical commentary.
 */
function parseAuthenticationResults(authHeader) {
  const s = String(authHeader || '');
  const out = { dkimPassDomains: [], spfPass: false, spfMailfromDomain: '', dmarc: null };
  for (const m of s.matchAll(/dkim=([a-z]+)([^;]*)/gi)) {
    if (m[1].toLowerCase() !== 'pass') continue;
    const seg = m[2] || '';
    const dm =
      seg.match(/header\.d=([^\s;]+)/i) ||
      seg.match(/header\.i=@?([^\s;]+)/i) ||
      seg.match(/\bd=([^\s;]+)/i);
    if (dm) out.dkimPassDomains.push(domainOf(dm[1]));
  }
  const spf = s.match(/spf=([a-z]+)([^;]*)/i);
  if (spf && spf[1].toLowerCase() === 'pass') {
    out.spfPass = true;
    const mf = (spf[2] || '').match(/smtp\.mailfrom=([^\s;]+)/i);
    if (mf) out.spfMailfromDomain = domainOf(mf[1]);
  }
  const dmarc = s.match(/dmarc=([a-z]+)/i);
  if (dmarc) out.dmarc = dmarc[1].toLowerCase();
  return out;
}

/**
 * Decide whether an email is an authentic owner-to-owner message.
 * Returns { ok, reason }. ok=true requires ALL of:
 *   1. From parses to EXACTLY the owner address (case-insensitive, no
 *      +alias, no substring acceptance).
 *   2. The owner address appears among the parsed To recipients.
 *   3. Authentication-Results shows dkim=pass with d= aligned to the From
 *      domain, OR spf=pass with smtp.mailfrom aligned to the From domain.
 *   4. If dmarc= appears at all it must be dmarc=pass.
 */
function isAuthenticOwnerEmail(
  { fromHeader, toHeader, authenticationResults } = {},
  ownerEmail = DEFAULT_OWNER,
) {
  const owner = String(ownerEmail || '')
    .trim()
    .toLowerCase();
  if (!owner) return { ok: false, reason: 'no owner email configured' };

  const fromAddr = parseSingleAddress(fromHeader);
  if (!fromAddr) {
    return { ok: false, reason: 'from header does not parse to a single address' };
  }
  if (fromAddr !== owner) {
    return { ok: false, reason: `from address "${fromAddr}" is not exactly the owner` };
  }

  const recipients = parseRecipientAddresses(toHeader);
  if (!recipients.includes(owner)) {
    return { ok: false, reason: 'owner address is not among parsed To recipients' };
  }

  if (!authenticationResults || !String(authenticationResults).trim()) {
    return { ok: false, reason: 'missing Authentication-Results header' };
  }

  const auth = parseAuthenticationResults(authenticationResults);
  if (auth.dmarc && auth.dmarc !== 'pass') {
    return { ok: false, reason: `dmarc=${auth.dmarc} (must be pass when present)` };
  }

  const fromDomain = domainOf(owner);
  if (auth.dkimPassDomains.some((d) => isAligned(d, fromDomain))) {
    return { ok: true, reason: 'dkim=pass aligned with from domain' };
  }
  if (auth.spfPass && isAligned(auth.spfMailfromDomain, fromDomain)) {
    return { ok: true, reason: 'spf=pass with aligned smtp.mailfrom' };
  }
  return { ok: false, reason: 'no dkim or spf pass aligned with the from domain' };
}

module.exports = {
  isAuthenticOwnerEmail,
  parseSingleAddress,
  parseRecipientAddresses,
  parseAuthenticationResults,
};
