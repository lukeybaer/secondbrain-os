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
//
// 2026-08-02: that header is only stamped on mail arriving through Gmail's
// inbound MX. Owner-to-owner mail never leaves the account and carries none, so
// the fail-closed rule rejected every one of ExampleCo's own #Amy dispatches for
// seven weeks. Gmail's \Sent label is accepted as the equivalent origin proof
// for that case: only the authenticated account can put a message in its own
// Sent folder, so it is strictly narrower than the spoofable substring check
// this file replaced. External mail is unaffected and still needs DMARC.

const DEFAULT_OWNER = 'ExampleCo@gmail.com';

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
 * Tokenize an IMAP X-GM-LABELS list, honoring quoting.
 *
 * Returns [{ value, quoted }]. Quoting is load-bearing, not cosmetic: a
 * user-created label containing a space arrives QUOTED ("Sent Project"), and a
 * naive whitespace split would mint a bare `Sent` token out of it. Codex
 * adversarial review 2026-08-02 confirmed that exact forgery, so the quoted
 * flag travels with every token and only unquoted atoms can be system flags.
 * A quoted label may itself contain a ')', so the list terminator only counts
 * outside quotes.
 */
function tokenizeImapLabels(raw) {
  const s = String(raw == null ? '' : raw);
  const tokens = [];
  let i = 0;
  if (s[i] === '(') i++;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === ')') break;
    if (c === '"') {
      i++;
      let buf = '';
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          buf += s[i + 1];
          i += 2;
          continue;
        }
        buf += s[i++];
      }
      i++;
      tokens.push({ value: buf, quoted: true });
      continue;
    }
    let buf = '';
    while (i < s.length && c !== ')' && !' \t)'.includes(s[i])) buf += s[i++];
    if (buf) tokens.push({ value: buf, quoted: false });
  }
  return tokens;
}

/**
 * Normalize X-GM-LABELS into tokens. An array element is already one discrete
 * label, so it is never re-split; only the raw IMAP string needs tokenizing.
 */
function parseGmailLabels(labels) {
  if (!labels) return [];
  if (Array.isArray(labels)) {
    return labels
      .map((label) => ({ value: String(label == null ? '' : label).trim(), quoted: false }))
      .filter((t) => t.value);
  }
  return tokenizeImapLabels(labels);
}

/**
 * True when Gmail itself marked this message sent by the account.
 *
 * ONLY the unquoted system atom `\Sent` counts. Gmail forbids a backslash in a
 * user label name, so the leading backslash on an unquoted atom is what makes
 * this unforgeable. A bare `sent` is deliberately NOT accepted here: it is a
 * legal user label name.
 */
function hasSentLabel(labels) {
  return parseGmailLabels(labels).some(
    (token) => !token.quoted && token.value.toLowerCase() === '\\sent',
  );
}

/**
 * The Gmail REST API reports system labels as bare uppercase ids. User labels
 * get opaque `Label_<n>` ids there, so an exact `SENT` is unambiguous. Kept
 * separate from the IMAP path so the two grammars can never blur together.
 */
function hasSentLabelId(labelIds) {
  if (!Array.isArray(labelIds)) return false;
  return labelIds.some((id) => String(id == null ? '' : id).trim() === 'SENT');
}

/**
 * Decide whether mail from one exact sender to one exact recipient is
 * authentic. External senders require aligned DKIM/SPF proof. The Gmail Sent
 * label is accepted only when explicitly enabled by the owner-to-owner
 * wrapper below; it must never authenticate an external principal.
 */
function isAuthenticSenderEmail(
  { fromHeader, toHeader, authenticationResults, gmailLabels, gmailApiLabelIds } = {},
  senderEmail,
  recipientEmail,
  { allowSentLabel = false } = {},
) {
  const sender = String(senderEmail || '')
    .trim()
    .toLowerCase();
  const recipient = String(recipientEmail || '')
    .trim()
    .toLowerCase();
  if (!sender) return { ok: false, reason: 'no sender email configured' };
  if (!recipient) return { ok: false, reason: 'no recipient email configured' };

  const fromAddr = parseSingleAddress(fromHeader);
  if (!fromAddr) {
    return { ok: false, reason: 'from header does not parse to a single address' };
  }
  if (fromAddr !== sender) {
    return { ok: false, reason: `from address "${fromAddr}" is not exactly the sender` };
  }

  const recipients = parseRecipientAddresses(toHeader);
  if (!recipients.includes(recipient)) {
    return { ok: false, reason: 'recipient address is not among parsed To recipients' };
  }

  // A stated DMARC failure disqualifies the message no matter which proof it
  // carries, so evaluate it before the self-sent path.
  const auth = parseAuthenticationResults(authenticationResults);
  if (auth.dmarc && auth.dmarc !== 'pass') {
    return { ok: false, reason: `dmarc=${auth.dmarc} (must be pass when present)` };
  }

  if (allowSentLabel && (hasSentLabel(gmailLabels) || hasSentLabelId(gmailApiLabelIds))) {
    return { ok: true, reason: 'owner self-sent (gmail \\Sent label)' };
  }

  if (!authenticationResults || !String(authenticationResults).trim()) {
    return {
      ok: false,
      reason: allowSentLabel
        ? 'missing Authentication-Results header and no gmail \\Sent label'
        : 'missing Authentication-Results header for external sender',
    };
  }

  const fromDomain = domainOf(sender);
  if (auth.dkimPassDomains.some((d) => isAligned(d, fromDomain))) {
    return { ok: true, reason: 'dkim=pass aligned with from domain' };
  }
  if (auth.spfPass && isAligned(auth.spfMailfromDomain, fromDomain)) {
    return { ok: true, reason: 'spf=pass with aligned smtp.mailfrom' };
  }
  return { ok: false, reason: 'no dkim or spf pass aligned with the from domain' };
}

/** Owner-to-owner compatibility wrapper. Gmail Sent is valid proof here. */
function isAuthenticOwnerEmail(message = {}, ownerEmail = DEFAULT_OWNER) {
  return isAuthenticSenderEmail(message, ownerEmail, ownerEmail, { allowSentLabel: true });
}

module.exports = {
  isAuthenticSenderEmail,
  isAuthenticOwnerEmail,
  parseSingleAddress,
  parseRecipientAddresses,
  parseAuthenticationResults,
  parseGmailLabels,
  tokenizeImapLabels,
  hasSentLabel,
  hasSentLabelId,
};
