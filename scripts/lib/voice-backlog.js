/**
 * voice-backlog.js -- pure backlog computation shared between the health probe
 * and (the now-archived) PC sweep + the Fargate cron repair mode.
 *
 * A raw transcript is in the backlog when its bare otid has no enriched file and
 * it has not exhausted its retry budget in the skip ledger. Exhausted otids are
 * retried once the retry TTL elapses (so a transient environment failure, e.g.
 * ECAPA down for a day, self-heals instead of burying the transcript forever).
 *
 * Kept in lib/ so the health probe does not depend on the archived PC runtime.
 */

const MAX_ATTEMPTS = Number(process.env.VOICE_SWEEP_MAX_ATTEMPTS || '3') || 3;
const SKIP_RETRY_TTL_MS = Number(process.env.VOICE_SWEEP_SKIP_RETRY_TTL_MS || String(24 * 60 * 60 * 1000)) || 24 * 60 * 60 * 1000;

function computeBacklog({ rawFiles, enrichedOtids, skipLedger = {}, maxAttempts = MAX_ATTEMPTS, now = '', retryTtlMs = SKIP_RETRY_TTL_MS, nowMs = null }) {
  const enriched = new Set(enrichedOtids);
  const backlog = [];
  const skippedExhausted = [];
  const seen = new Set();
  const clock = Number.isFinite(nowMs) ? nowMs : (now ? Date.parse(now) : NaN);
  for (const entry of rawFiles) {
    const otid = entry.otid;
    if (!otid || seen.has(otid)) continue;
    seen.add(otid);
    if (/^chat_/i.test(otid)) continue;
    if (enriched.has(otid)) continue;
    const ledger = skipLedger[otid];
    if (ledger && Number(ledger.attempts || 0) >= maxAttempts) {
      const lastMs = ledger.last_attempt ? Date.parse(ledger.last_attempt) : NaN;
      const ttlElapsed = retryTtlMs > 0 && Number.isFinite(clock) && Number.isFinite(lastMs) && (clock - lastMs) >= retryTtlMs;
      if (!ttlElapsed) {
        skippedExhausted.push(otid);
        continue;
      }
    }
    backlog.push(otid);
  }
  return { backlog, skippedExhausted, now };
}

module.exports = { computeBacklog, MAX_ATTEMPTS, SKIP_RETRY_TTL_MS };
