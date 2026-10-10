'use strict';

const BUILTIN_VERIFICATION_ORIGINS = Object.freeze([
  'http://127.0.0.1:3001',
  'http://localhost:3001',
  'http://[::1]:3001',
  'http://ExampleCo:3001',
]);

function parseSafeVerificationOrigin(value) {
  const parsed = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('unsafe verification origin');
  }
  return parsed.origin;
}

function approvedVerificationOrigin(value, env = process.env) {
  const requested = parseSafeVerificationOrigin(value);
  const configured = [env.EC2_HOST_HTTP, env.BRIEFING_SERVED_URL]
    .concat(String(env.BRIEFING_VERIFICATION_ALLOWED_ORIGINS || '').split(','))
    .filter(Boolean)
    .flatMap((candidate) => {
      try { return [parseSafeVerificationOrigin(candidate)]; } catch { return []; }
    });
  const allowed = new Set([...BUILTIN_VERIFICATION_ORIGINS, ...configured]);
  if (!allowed.has(requested)) throw new Error('unapproved verification origin');
  return requested;
}

module.exports = { approvedVerificationOrigin, BUILTIN_VERIFICATION_ORIGINS, parseSafeVerificationOrigin };
