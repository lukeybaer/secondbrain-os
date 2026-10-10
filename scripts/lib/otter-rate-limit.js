'use strict';

// Otter answers a burst of logins with 429 and a retry_after in seconds. Ten
// parallel voice jobs that start together all log in at once; on 2026-09-24
// five of ten failed their first step with "Otter 429 /login ... retry_after
// 50". Retrying after Otter's own delay, plus jitter so the retries spread,
// turns that into a short wait instead of a failed job.
function otterRetryAfterMs(error) {
  const text = String(error?.message || error || '');
  if (Number(error?.status) !== 429 && !/\bOtter 429\b/.test(text)) return null;
  const seconds = Number(text.match(/"retry_after"\s*:\s*(\d+(?:\.\d+)?)/)?.[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30 * 1000;
}

function positiveOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

// Jitter spans the whole retry window so a burst that failed together spreads
// its retries over twice Otter's delay instead of retrying as a second burst.
async function withOtterRateLimitRetry(
  run,
  {
    maxAttempts = positiveOr(process.env.OTTER_429_MAX_ATTEMPTS, 4),
    maxTotalWaitMs = positiveOr(process.env.OTTER_429_MAX_WAIT_MS, 4 * 60 * 1000),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
  } = {},
) {
  let waited = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const retryAfter = otterRetryAfterMs(error);
      if (retryAfter === null || attempt >= maxAttempts) throw error;
      const delay = retryAfter + Math.floor(random() * retryAfter);
      if (waited + delay > maxTotalWaitMs) throw error;
      waited += delay;
      process.stderr.write(`[otter-rate-limit] 429, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1})\n`);
      await sleep(delay);
    }
  }
}

module.exports = { otterRetryAfterMs, withOtterRateLimitRetry };
