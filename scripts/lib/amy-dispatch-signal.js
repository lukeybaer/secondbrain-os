/**
 * Canonical #Amy / spoken "hashtag Amy" command-position parser.
 *
 * A marker is runnable only when it starts a sentence/line after harmless
 * speech fillers. This deliberately rejects metalinguistic mentions such as
 * "send it with the hashtag Amy email".
 *
 * The directive may follow the marker on the same line OR on the next line.
 * ExampleCo's dominant iPhone format puts the marker alone on line 1 and the
 * instruction on line 2; requiring both in one unit silently downgraded those
 * dispatches to bare tags (2026-08-02 audit). A marker with no instruction at
 * all is still reported, flagged `bare`, so a caller holding an attachment
 * payload can treat the attachment as the request while a text-only caller
 * correctly sees nothing runnable.
 */

const FILLERS = '(?:(?:ok(?:ay)?|hey|so|please|alright|well|um|uh)\\b[\\s,]*)*';
const MARKER = '(#amy\\b|hashtag\\s+amy\\b)';

const AMY_DIRECTIVE_RE = new RegExp(
  `^${FILLERS}${MARKER}(?:\\s*[,;:-]\\s*|\\s+)(\\S[\\s\\S]*)$`,
  'i',
);
const AMY_MARKER_RE = new RegExp(`^${FILLERS}${MARKER}\\s*(?:[,;:-]\\s*)?([\\s\\S]*)$`, 'i');

// Email signature furniture. These follow a bare marker often enough that
// treating one as the instruction would dispatch "Thanks," as a command.
const SIGNATURE_RE =
  /^(?:--+|__+|thanks[,.!]?|thank you[,.!]?|best[,.!]?|regards[,.!]?|cheers[,.!]?|sent from my \w+.*|PRIVATE_NAME|linkedin|\+?[\d()\s.-]{7,}|<?https?:\/\/\S+>?)$/i;

// Where quoted or forwarded content begins. Everything from here down was
// written by someone else, even when the owner sent the wrapper.
const QUOTED_CONTENT_RE = [
  /^>/,
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^-{3,}\s*forwarded message\s*-{3,}$/i,
  /^_{10,}$/,
  /^begin forwarded message:/i,
  /^on\b.*\bwrote:\s*$/i,
  /^from:\s*(?:"|<|\S+@)/i,
  /^sent:\s+\w/i,
];

/**
 * The part of a message the owner actually typed.
 *
 * Forwarding an attacker's email would otherwise hand them a command channel:
 * Gmail's \Sent label proves the owner sent the wrapper, never that he authored
 * every quoted line. Codex adversarial review 2026-08-02 confirmed a marker
 * buried in forwarded text was runnable. A marker the owner puts ABOVE the
 * quoted block still authorizes acting on what is quoted below it.
 */
function ownerAuthoredRegion(text) {
  const lines = String(text || '').split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (QUOTED_CONTENT_RE.some((re) => re.test(trimmed))) break;
    kept.push(line);
  }
  return kept.join('\n');
}

function splitDirectiveUnits(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function nextInstructionIndex(units, from) {
  for (let i = from; i < units.length; i++) {
    if (SIGNATURE_RE.test(units[i])) continue;
    if (AMY_MARKER_RE.test(units[i])) break;
    return i;
  }
  return -1;
}

function findAmyDirectives(text) {
  const units = splitDirectiveUnits(text);
  const matches = [];
  for (let index = 0; index < units.length; index++) {
    const sameUnit = units[index].match(AMY_DIRECTIVE_RE);
    if (sameUnit) {
      matches.push({
        index,
        ordinal: matches.length,
        sentence: units[index],
        context: units.slice(index, Math.min(index + 3, units.length)).join(' '),
        marker: sameUnit[1],
        directive: sameUnit[2].trim(),
        continuation: false,
        bare: false,
      });
      continue;
    }
    const markerOnly = units[index].match(AMY_MARKER_RE);
    if (!markerOnly || markerOnly[2].trim()) continue;
    const nextIndex = nextInstructionIndex(units, index + 1);
    const directive = nextIndex === -1 ? '' : units[nextIndex];
    matches.push({
      index,
      ordinal: matches.length,
      sentence: units[index],
      context: units.slice(index, Math.min(index + 3, units.length)).join(' '),
      marker: markerOnly[1],
      directive,
      continuation: directive !== '',
      bare: directive === '',
    });
  }
  return matches;
}

/** True when a command-position marker carries an actual instruction. */
function hasAmyDirective(text) {
  return findAmyDirectives(text).some((match) => match.directive !== '');
}

/**
 * True when a command-position marker is present at all, including a bare tag
 * whose payload is an attachment rather than text. Callers that can see the
 * payload (the Gmail scanner) pair this with an attachment check; text-only
 * callers must keep using hasAmyDirective.
 */
function hasAmyMarker(text) {
  return findAmyDirectives(text).length > 0;
}

module.exports = {
  AMY_DIRECTIVE_RE,
  AMY_MARKER_RE,
  findAmyDirectives,
  hasAmyDirective,
  hasAmyMarker,
  ownerAuthoredRegion,
  splitDirectiveUnits,
};
