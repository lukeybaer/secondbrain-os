// task-extract.ts
//
// Smart #amy dispatch extraction.
//
// Directives reach the spine as raw chunks scraped near a "#amy" mention in a
// call transcript or email, for example the garbled voice transcription
// "you Hashtag Amy and I approve the second one. Start off pre flights, I I".
// Feeding that raw text to an autonomous executor is unsafe (Codex flagged it).
//
// This module is the safety fix Luke asked for: an LLM reads the raw directive
// plus any surrounding context, works out the actual actionable instruction,
// rewrites it as a clean imperative, and reports whether it is confident
// enough to run unattended. The intake watcher auto-approves a dispatch ONLY
// when extraction is confident; anything garbled or ambiguous becomes a queued
// Task that waits for a human. So the gate is no longer "off vs on", it is
// "auto-run what we clearly understood, hold what we did not".

export interface ExtractedDispatch {
  /** The cleaned, actionable instruction. */
  prompt: string;
  /** True only when the intent is clear and unambiguous enough to auto-run. */
  confident: boolean;
  /** One-line reason, surfaced on the Task so a human knows why it is held. */
  reason: string;
}

// Hard, code-level denylist. LLM confidence is not trusted on its own: even a
// confident extraction is forced to NOT confident (recorded but held for a
// human) if the instruction matches a destructive, costly, or irreversible
// pattern. This is the policy gate Codex required in addition to the prompt.
const DANGEROUS_PATTERNS: RegExp[] = [
  /\bdelete\b/i,
  /\bdrop\b/i,
  /\brm\s+-/i,
  /\btruncate\b/i,
  /\bwipe\b/i,
  /\boverwrite\b/i,
  /\bformat\b/i,
  /\bpay\b/i,
  /\bpayment\b/i,
  /\bwire\b/i,
  /\btransfer\b/i,
  /\bvenmo\b/i,
  /\bzelle\b/i,
  /\bpurchase\b/i,
  /\brefund\b/i,
  /credit card/i,
  /bank account/i,
  /force[- ]?push/i,
  /\bgit push\b/i,
  /\bdeploy\b/i,
  /\bproduction\b/i,
  /\bpublish\b/i,
  /\bbroadcast\b/i,
  /\bpassword\b/i,
  /cancel (the )?(subscription|account|policy)/i,
];

/** Returns the matched dangerous pattern, or null if the instruction is clear. */
export function matchDangerousPattern(text: string): string | null {
  for (const re of DANGEROUS_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

const SYSTEM_PROMPT = [
  'You convert a raw "#amy" directive into a clean instruction for an executive',
  'assistant. The raw text is scraped near a "#amy" mention in a phone-call',
  'transcript or an email and is often a garbled voice transcription.',
  '',
  'Decide what the person is actually asking the assistant to do. Use the',
  'surrounding context to scope it: sometimes the whole message is the request,',
  'sometimes only the item referenced right around the "#amy" mention is.',
  '',
  'Return STRICT JSON: {"instruction": string, "confident": boolean, "reason": string}.',
  '- instruction: the request rewritten as one clear imperative sentence.',
  '- confident: true ONLY if you clearly understand a specific, actionable',
  '  request. false if the text is too garbled, vague, or you cannot tell what',
  '  is being asked, or if it asks for something destructive or irreversible.',
  '- reason: one short sentence explaining the confidence decision.',
].join('\n');

/**
 * Extract a clean dispatch from a raw directive chunk. Never throws. If no LLM
 * key is configured or the call fails, returns the raw text marked NOT
 * confident, so it is recorded but held for a human, never auto-run.
 */
export async function extractDispatch(
  rawComment: string,
  context?: string,
): Promise<ExtractedDispatch> {
  const raw = (rawComment ?? '').trim();
  const fallback: ExtractedDispatch = {
    prompt: raw,
    confident: false,
    reason: 'extraction unavailable, holding for human review',
  };
  if (!raw) return { ...fallback, reason: 'empty directive' };

  // All LLM traffic routes through the owner's Claude Max subscription via the
  // claude CLI subprocess (see claude-runner.ts). No paid host -- this is the
  // Claude-Max-only rule, enforced by llm-routing-guard.test.ts.
  // Lazy import so importing this module (e.g. via task-intake in tests) does
  // not pull in the runner / electron until an extraction actually runs.
  try {
    const { runClaudeCode } = await import('./claude-runner');
    const prompt =
      `${SYSTEM_PROMPT}\n\n` +
      `Raw #amy directive:\n${raw}\n\n` +
      (context ? `Surrounding context:\n${context}\n\n` : '') +
      'Return ONLY the JSON object, nothing else.';
    const res = await runClaudeCode(prompt, { timeoutMs: 60000 });
    if (!res.success || !res.output) return fallback;
    // Claude may wrap the JSON in prose or a fenced block. Pull the first
    // balanced {...} object out of the output.
    const jsonMatch = res.output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;
    const parsed = JSON.parse(jsonMatch[0]);
    const instruction = typeof parsed.instruction === 'string' ? parsed.instruction.trim() : '';
    if (!instruction) return fallback;

    // Hard denylist overrides LLM confidence: a destructive or costly
    // instruction is never auto-approved, no matter how sure the model is.
    const danger = matchDangerousPattern(instruction);
    if (danger) {
      return {
        prompt: instruction,
        confident: false,
        reason: `held: matched destructive-action guard ("${danger}")`,
      };
    }

    return {
      prompt: instruction,
      confident: parsed.confident === true,
      reason: typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim()
        : (parsed.confident === true ? 'clear actionable request' : 'unclear request'),
    };
  } catch {
    return fallback;
  }
}
