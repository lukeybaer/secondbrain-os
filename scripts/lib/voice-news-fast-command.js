'use strict';

// The owner skip-family endpoint rule and its classifier. Dependency-free on
// purpose: voice-release-proof.js ships beside claude-proxy.js in the public
// mirror and holds the news proof to the fast ceiling, while the news reader
// itself stays private. voice-news-server-turn.js derives this same list from
// its command table and a test keeps the two in step.
//
// The rule only shortens the end-of-turn wait; it never chooses a navigation
// action. Smart endpointing waited about three seconds after a bare "Skip",
// while the eventual server turn took single-digit milliseconds. Voice provider tests the
// rule against the transcript so far, so generic openers (stop, pause, next,
// repeat, save, back) stay out: a 0.3s breath after "Stop" in "Stop by the
// store later" would end that turn early. Rule type `customer` is the value
// Voice provider accepts; `user` is refused.
const FAST_NEWS_COMMAND_PHRASES = Object.freeze([
  'skip', 'skip it', 'skip this', 'skip that', 'skip this one', 'skip that one',
  'skip article', 'skip story', 'skip the article', 'skip this article',
  'skip section', 'skip category', 'skip the section', 'skip this section', 'skip that section', 'skip the category',
  'next article', 'next story', 'next one', 'next section', 'next category',
  'previous article', 'previous story', 'go back', 'go back one',
]);

function newsCommandEndpointingRule(timeoutSeconds = 0.3) {
  const phrases = FAST_NEWS_COMMAND_PHRASES
    .map((phrase) => phrase.replace(/ /g, '[\\s,]+'))
    .sort((a, b) => b.length - a.length);
  return {
    type: 'customer',
    regex: `^\\s*(?:amy[\\s,]+)?(?:${phrases.join('|')})(?:[\\s,]+please)?[.!?]?\\s*$`,
    regexOptions: [{ type: 'ignore-case', enabled: true }],
    timeoutSeconds,
  };
}

// Whether a spoken command ends its turn under the rule above. The news scorer
// and the news-scenario proof hold these to the fast ceiling and every other
// command (wrapped skips, stop, save) to the ordinary smart-endpointing ceiling.
let fastCommandRegex = null;
function isFastNewsCommand(text) {
  if (!fastCommandRegex) fastCommandRegex = new RegExp(newsCommandEndpointingRule().regex, 'i');
  return fastCommandRegex.test(String(text || ''));
}

// Emergency rollback of the rule without a deploy. The setting is stamped into
// the news-scenario proof, so flipping it pauses ordinary outbound until a news
// call re-proves the new configuration.
function newsFastEndpointEnabled(env = process.env) {
  return String(env.AMY_VOICE_NEWS_FAST_ENDPOINT || '').trim().toLowerCase() !== 'off';
}

module.exports = {
  FAST_NEWS_COMMAND_PHRASES,
  newsCommandEndpointingRule,
  isFastNewsCommand,
  newsFastEndpointEnabled,
};
