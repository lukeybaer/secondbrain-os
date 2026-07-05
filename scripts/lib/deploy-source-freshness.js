'use strict';

// Deploy-source freshness gate (2026-07-05). The EC2 deploy-drift heal scp's
// the LOCAL working ec2-server.js over the live server. On 2026-07-04/05 a
// stale shared checkout (91 commits behind master, old news-reader design)
// "healed" prod BACK to a broken build every morning at ~5:05am CT, reverting
// the landed fix. A self-heal may only deploy content PROVEN to match
// origin/master; anything unproven defers loudly to a human. Fail closed:
// a fetch/read error means freshness is unproven, so the heal must refuse.

function normalizeSource(text) {
  return String(text || '').replace(/\r/g, '');
}

function assessDeploySourceFreshness({
  localContent = '',
  originContent = '',
  fetchError = '',
  showError = '',
  readError = '',
} = {}) {
  if (fetchError) {
    return { fresh: false, reason: 'git fetch failed: ' + String(fetchError).slice(0, 120) };
  }
  if (showError) {
    return {
      fresh: false,
      reason: 'origin/master:ec2-server.js unreadable: ' + String(showError).slice(0, 120),
    };
  }
  if (readError) {
    return {
      fresh: false,
      reason: 'local ec2-server.js unreadable: ' + String(readError).slice(0, 120),
    };
  }
  if (!normalizeSource(localContent)) {
    return { fresh: false, reason: 'local ec2-server.js is empty' };
  }
  if (normalizeSource(localContent) !== normalizeSource(originContent)) {
    return {
      fresh: false,
      reason:
        'local ec2-server.js does not match origin/master (stale or dirty checkout); refusing to deploy',
    };
  }
  return { fresh: true, reason: '' };
}

module.exports = { assessDeploySourceFreshness, normalizeSource };
