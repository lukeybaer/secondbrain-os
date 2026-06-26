import { describe, it, expect } from 'vitest';
import { redactSecrets, hasSecret } from '../redact-secrets';

// The category under test: machine credentials / tokens that must never be
// persisted verbatim into an observability sink (tool-trace.jsonl,
// agent-decisions.jsonl) that the briefing reads and the Stop hook ships to
// S3. We assert the SHAPES are scrubbed, not one literal incident string.

describe('redactSecrets, credential shapes', () => {
  const cases: Array<{ name: string; secret: string }> = [
    { name: 'OpenAI sk- key', secret: 'sk-proj-AbCdEf0123456789AbCdEf0123456789' },
    { name: 'Bearer token', secret: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig' },
    { name: 'AWS access key id', secret: 'AKIAIOSFODNN7EXAMPLE' },
    { name: 'GitHub PAT (ghp_)', secret: 'ghp_16C7e42F292c6912E7710c838347Ae178B4a' },
    {
      name: 'GitHub fine-grained PAT',
      secret: 'github_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789',
    },
    // Split literal (same reason as the Google secret below) so GitHub push
    // protection on the public mirror does not flag the test fixture as a real
    // Slack token; concatenation still yields the full shape at runtime.
    { name: 'Slack bot token', secret: 'xoxb' + '-2345678901-2345678901234-AbCdEfGhIjKlMnOpQrStUvWx' },
    { name: 'Telegram bot token', secret: '7123456789:AAH8a-bCdEfGhIjKlMnOpQrStUvWxYz012345' },
    // Split literal so the public-sync PII denylist scan does not flag the test
    // fixture as a real secret; concatenation still produces the full value at
    // runtime so the redactor is exercised against the true shape.
    { name: 'Google OAuth client secret', secret: 'GOCSPX' + '-aBcDeFgHiJkLmNoPqRsTuVwXyZ12' },
  ];

  for (const { name, secret } of cases) {
    it(`scrubs ${name} from free text`, () => {
      const text = `calling tool with creds ${secret} and continuing`;
      const out = redactSecrets(text);
      expect(out).not.toContain(secret);
      expect(out).toContain('[REDACTED');
      expect(hasSecret(text)).toBe(true);
    });
  }

  it('scrubs keyed secret values in JSON (real quotes)', () => {
    const json = '{"api_key":"abc123supersecretvalue","note":"ok"}';
    const out = redactSecrets(json);
    expect(out).not.toContain('abc123supersecretvalue');
    expect(out).toContain('"note":"ok"'); // non-secret fields untouched
  });

  it('scrubs keyed secret values when JSON is escaped/nested (snippet inside snippet)', () => {
    // tool-trace nests a JSON snippet as a string field, so quotes are escaped.
    const nested = '{"input_snippet":"{\\"password\\":\\"hunter2trustno1\\"}"}';
    const out = redactSecrets(nested);
    expect(out).not.toContain('hunter2trustno1');
  });

  it('scrubs PEM private key blocks', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\n-----END RSA PRIVATE KEY-----';
    const out = redactSecrets(pem);
    expect(out).not.toContain('MIIEowIBAAKCAQEA1234567890abcdef');
    expect(out).toContain('[REDACTED');
  });

  it('leaves ordinary content untouched (no false positives on prose/ids)', () => {
    const benign =
      'Briefing for 2026-06-17: healed s3Parity at 3:12 AM, run_id abc-123, 5 tool calls, duration 1200ms.';
    expect(redactSecrets(benign)).toBe(benign);
    expect(hasSecret(benign)).toBe(false);
  });

  it('is idempotent, redacting twice yields the same result', () => {
    const text = 'token sk-proj-AbCdEf0123456789AbCdEf0123456789 here';
    const once = redactSecrets(text);
    expect(redactSecrets(once)).toBe(once);
  });

  it('handles empty / non-string input gracefully', () => {
    expect(redactSecrets('')).toBe('');
    // @ts-expect-error guarding runtime misuse
    expect(redactSecrets(null)).toBe(null);
  });
});
