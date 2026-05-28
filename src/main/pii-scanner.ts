// pii-scanner.ts
// Scans text for PII (SSN, credit cards, phone numbers, email, addresses).
// Sends an immediate Telegram alert when PII is detected in incoming data.

import { sendMessage } from './telegram';
import { getConfig } from './config';

// ── Patterns ──────────────────────────────────────────────────────────────────

const PII_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'SSN', regex: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/ },
  {
    name: 'Credit Card',
    regex:
      /\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|3(?:0[0-5]|[68]\d)\d{11}|6(?:011|5\d{2})\d{12}|(?:2131|1800|35\d{3})\d{11})\b/,
  },
  { name: 'Email', regex: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/ },
  { name: 'Phone (US)', regex: /\b(?:\+1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/ },
  { name: 'Passport', regex: /\b[A-Z]{1,2}\d{6,9}\b/ },
  { name: 'Driver License', regex: /\b[A-Z]{1,2}\d{5,8}\b/ },
  { name: 'Bank Account', regex: /\b(?:account|acct)[\s#:]*\d{8,17}\b/i },
  { name: 'Routing Number', regex: /\b(?:routing|aba)[\s#:]*\d{9}\b/i },
  { name: 'IP Address', regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  {
    name: 'Date of Birth',
    regex: /\b(?:dob|date of birth|born)[\s:]+\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/i,
  },
];

// ── False positive filters ────────────────────────────────────────────────────

// Common known-safe patterns to ignore (e.g., API keys, IDs that aren't PII)
const SAFE_PATTERNS: RegExp[] = [
  /\b127\.0\.0\.1\b/, // localhost
  /\b192\.168\.\d+\.\d+\b/, // private IP
  /\b10\.\d+\.\d+\.\d+\b/, // private IP
  /\b(98|52|54|34|18|3|13|35|44|52)\.[\d.]+\b/, // common AWS IP ranges
];

function isSafeMatch(text: string, match: string): boolean {
  return SAFE_PATTERNS.some((p) => p.test(match));
}

// ── Vault storage ─────────────────────────────────────────────────────────────

export interface PiiEvent {
  id: string;
  detectedAt: string;
  source: string;
  piiType: string;
  snippet: string; // redacted context around the match
  alertSent: boolean;
}

const _piiLog: PiiEvent[] = [];

function redact(text: string, match: string): string {
  const idx = text.indexOf(match);
  if (idx < 0) return match;
  const start = Math.max(0, idx - 20);
  const end = Math.min(text.length, idx + match.length + 20);
  const before = text.slice(start, idx).replace(/./g, (c) => (/\s/.test(c) ? c : '·'));
  const after = text.slice(idx + match.length, end).replace(/./g, (c) => (/\s/.test(c) ? c : '·'));
  const redactedMatch = match[0] + '***' + match[match.length - 1];
  return `…${before}[${redactedMatch}]${after}…`;
}

// ── Scanner ───────────────────────────────────────────────────────────────────

export interface PiiDetection {
  piiType: string;
  snippet: string;
}

export function scanForPii(text: string): PiiDetection[] {
  if (!text || text.length === 0) return [];
  const detections: PiiDetection[] = [];

  for (const { name, regex } of PII_PATTERNS) {
    const match = regex.exec(text);
    if (match && !isSafeMatch(text, match[0])) {
      detections.push({
        piiType: name,
        snippet: redact(text, match[0]),
      });
    }
  }

  return detections;
}

// ── Alert + log ───────────────────────────────────────────────────────────────

export async function scanAndAlert(text: string, source: string): Promise<PiiDetection[]> {
  const detections = scanForPii(text);
  if (detections.length === 0) return [];

  const cfg = getConfig();

  for (const d of detections) {
    const event: PiiEvent = {
      id: `pii_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      detectedAt: new Date().toISOString(),
      source,
      piiType: d.piiType,
      snippet: d.snippet,
      alertSent: false,
    };

    _piiLog.push(event);
    console.warn(`[pii-scanner] DETECTED ${d.piiType} in ${source}: ${d.snippet}`);

    // Security alert — PII detection always goes to Telegram immediately
    if (cfg.telegramChatId && cfg.telegramBotToken) {
      try {
        await sendMessage(
          cfg.telegramChatId,
          `⚠️ <b>PII DETECTED</b>\n\n` +
            `<b>Type:</b> ${d.piiType}\n` +
            `<b>Source:</b> ${source}\n` +
            `<b>Context:</b> <code>${d.snippet}</code>\n\n` +
            `Review and redact immediately if sensitive.`,
        );
        event.alertSent = true;
      } catch (err) {
        console.error('[pii-scanner] Telegram alert failed:', (err as Error).message);
      }
    }
  }

  return detections;
}

export function getPiiLog(): PiiEvent[] {
  return [..._piiLog];
}
