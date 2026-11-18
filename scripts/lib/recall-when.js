'use strict';

// Reads the time, channel and "latest" words out of a recall question, so the
// engine filters on the archive's tags instead of searching for the word
// "yesterday". Pure: no I/O, and the clock is passed in. Every day boundary is
// Central time (America/Chicago).
//
// The words still decide: the engine returns a match outside the filter,
// marked as such, when nothing inside it holds the words. A phrase read here
// as a date by mistake ("Friday" in a title) therefore costs a note, never a
// record.

const { CT_TIME_ZONE } = require('./ct-face-time.js');

const HOUR_MS = 3600000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_SHORT = { jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const COUNTS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, few: 3, couple: 2,
};
// Words that carry no search meaning once the date and channel are read. A
// question made only of these asks "what is there", not "find this".
const FILLER = new Set((
  'a all also am amy an and any anything are at be been bring by came can catch check come could day did'
  + ' discuss discussed do does doing done every everything find for from get give go going got had happen'
  + ' happened happening has have hear heard hey hi i in is it just know like list look me my new of ok on'
  + ' or out over please pull reach reached reaching read recap received review said say search see send sent'
  + ' show so some stuff summarize summary talk talked tell that the there thing things to today up update'
  + ' updates us was we'
  + ' went were what whats when which who whom with would you'
  // Contraction tails ("what's", "didn't", "we're") and a few asking words.
  + ' s t ll re ve d m about remind yet else'
).split(' '));

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: CT_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

function ctParts(ms) {
  const out = {};
  for (const part of partsFormat.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

/** A calendar day; day overflow rolls into the next month, as Date does. */
function day(year, month, dayOfMonth) {
  const at = new Date(Date.UTC(year, month - 1, dayOfMonth));
  return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate(), dow: at.getUTCDay() };
}

function plus(date, days) {
  return day(date.y, date.m, date.d + days);
}

/** The instant a Central calendar day starts, in milliseconds. */
function startOf(date) {
  const utc = Date.UTC(date.y, date.m - 1, date.d);
  // Six hours after UTC midnight is 00:00 standard or 01:00 daylight time the
  // same day: the offset in force when that day began.
  const probe = utc + 6 * HOUR_MS;
  const p = ctParts(probe);
  return utc - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - probe);
}

function dayLabel(date, today) {
  return new Date(Date.UTC(date.y, date.m - 1, date.d, 12)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(today && today.y === date.y ? {} : { year: 'numeric' }),
  });
}

/** "Sat, Nov 14, 2026, 9:45 PM CT" for UTC seconds; the day alone when only the day is known. */
function whenLabel(seconds, dayOnly = false) {
  if (!Number.isFinite(Number(seconds))) return '';
  const at = new Date(Number(seconds) * 1000);
  const base = { timeZone: CT_TIME_ZONE, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
  if (dayOnly) return at.toLocaleDateString('en-US', base);
  // Newer ICU puts a narrow no-break space before AM/PM; speech and chat want a plain one.
  return `${at.toLocaleString('en-US', { ...base, hour: 'numeric', minute: '2-digit' }).replace(/[  ]/g, ' ')} CT`;
}

function count(word) {
  const text = String(word || '').toLowerCase().replace(/\s+of$/, '');
  return /^\d+$/.test(text) ? Number(text) : COUNTS[text] || 1;
}

function validDay(year, month, dayOfMonth) {
  const made = day(year, month, dayOfMonth);
  return year >= 1990 && year < 2100 && made.m === month && made.d === dayOfMonth ? made : null;
}

/** The latest month `month` that has started, as its first day. */
function latestMonth(month, today, which) {
  const year = which === 'this' || month <= today.m ? today.y : today.y - 1;
  return day(year, month, 1);
}

const one = (date, label) => ({ start: startOf(date), end: startOf(plus(date, 1)), label });
const span = (from, to, label) => ({ start: startOf(from), end: startOf(to), label });

const LEAD = '(?:\\b(since|after|before|until|till|through|thru|on|in|during|from|over|within)\\s+)?';
const MONTH_WORD = `(${MONTHS.join('|')}|${Object.keys(MONTH_SHORT).join('|')})\\.?`;
const NUMBER_WORD = `(\\d+|${Object.keys(COUNTS).join('|')})(?:\\s+of)?`;
const monthOf = (word) => MONTHS.indexOf(word.toLowerCase()) + 1 || MONTH_SHORT[word.toLowerCase()] || 0;

// Each rule: [pattern, (match, today, now) => { start, end, label } | null].
// Group 1 is always the lead word. The first rule that reads a date wins.
const DATE_RULES = [
  [new RegExp(`${LEAD}\\b(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b`, 'i'), (m, today) => {
    const date = validDay(Number(m[2]), Number(m[3]), Number(m[4]));
    return date && one(date, dayLabel(date, today));
  }],
  [new RegExp(`${LEAD}\\b(\\d{1,2})/(\\d{1,2})/(\\d{4}|\\d{2})\\b`, 'i'), (m, today) => {
    const year = Number(m[4]) < 100 ? 2000 + Number(m[4]) : Number(m[4]);
    const date = validDay(year, Number(m[2]), Number(m[3]));
    return date && one(date, dayLabel(date, today));
  }],
  [/\b(on|since|after|before|until|till|through|thru)\s+(\d{1,2})\/(\d{1,2})\b/i, (m, today) => {
    let date = validDay(today.y, Number(m[2]), Number(m[3]));
    if (date && startOf(date) > startOf(today)) date = validDay(today.y - 1, Number(m[2]), Number(m[3]));
    return date && one(date, dayLabel(date, today));
  }],
  [new RegExp(`${LEAD}\\b${MONTH_WORD}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b(?!\\s*[:%])`, 'i'), (m, today) => {
    const month = monthOf(m[2]);
    let date = validDay(m[4] ? Number(m[4]) : today.y, month, Number(m[3]));
    if (date && !m[4] && startOf(date) > startOf(today)) date = validDay(today.y - 1, month, Number(m[3]));
    return date && one(date, dayLabel(date, today));
  }],
  [new RegExp(`${LEAD}\\b${MONTH_WORD},?\\s+((?:19|20)\\d{2})\\b`, 'i'), (m) => {
    const first = day(Number(m[3]), monthOf(m[2]), 1);
    return span(first, day(first.y, first.m + 1, 1), `${MONTHS[first.m - 1].replace(/^./, (c) => c.toUpperCase())} ${first.y}`);
  }],
  // A bare month name is also a name and a verb; it is a date only after a word that says so.
  [new RegExp(`\\b(in|during|since|last|this|before|after|until|till|through|thru|throughout|early|late|mid)\\s+(${MONTHS.join('|')})\\b`, 'i'), (m, today) => {
    const first = latestMonth(monthOf(m[2]), today, m[1].toLowerCase());
    return span(first, day(first.y, first.m + 1, 1), `${MONTHS[first.m - 1].replace(/^./, (c) => c.toUpperCase())} ${first.y}`);
  }],
  [/\b(in|during|since|before|after|until|till|through|thru|from)\s+((?:19|20)\d{2})\b(?!\s*[-/:])/i, (m) => (
    span(day(Number(m[2]), 1, 1), day(Number(m[2]) + 1, 1, 1), m[2])
  )],
  [new RegExp(`${LEAD}\\b(?:the\\s+)?day\\s+before\\s+yesterday\\b`, 'i'), (m, today) => (
    one(plus(today, -2), `the day before yesterday (${dayLabel(plus(today, -2), today)})`)
  )],
  [new RegExp(`${LEAD}\\byesterday\\b`, 'i'), (m, today) => one(plus(today, -1), `yesterday (${dayLabel(plus(today, -1), today)})`)],
  [new RegExp(`${LEAD}\\blast\\s+night\\b`, 'i'), (m, today) => ({
    start: startOf(plus(today, -1)) + 17 * HOUR_MS, end: startOf(today) + 6 * HOUR_MS, label: 'last night',
  })],
  [new RegExp(`${LEAD}\\bthis\\s+morning\\b`, 'i'), (m, today) => ({
    start: startOf(today), end: startOf(today) + 12 * HOUR_MS, label: 'this morning',
  })],
  [new RegExp(`${LEAD}\\b(?:today|tonight)\\b`, 'i'), (m, today) => one(today, `today (${dayLabel(today, today)})`)],
  [new RegExp(`${LEAD}\\b(this|last)\\s+(week|month|year)\\b`, 'i'), (m, today) => {
    const back = m[2].toLowerCase() === 'last' ? 1 : 0;
    const unit = m[3].toLowerCase();
    if (unit === 'week') {
      const sunday = plus(today, -today.dow - 7 * back);
      const label = back
        ? `last week (${dayLabel(sunday, today)} to ${dayLabel(plus(sunday, 6), today)})`
        : `this week (since ${dayLabel(sunday, today)})`;
      return span(sunday, plus(sunday, 7), label);
    }
    if (unit === 'month') {
      const first = day(today.y, today.m - back, 1);
      return span(first, day(first.y, first.m + 1, 1), `${MONTHS[first.m - 1].replace(/^./, (c) => c.toUpperCase())} ${first.y}`);
    }
    return span(day(today.y - back, 1, 1), day(today.y - back + 1, 1, 1), String(today.y - back));
  }],
  [new RegExp(`${LEAD}\\b(?:(this|last)\\s+|the\\s+)?weekend\\b`, 'i'), (m, today) => {
    // The Saturday of the weekend now under way or just ended.
    let saturday = plus(today, -((today.dow + 1) % 7));
    if (String(m[2] || '').toLowerCase() === 'last' && (today.dow === 6 || today.dow === 0)) saturday = plus(saturday, -7);
    return span(saturday, plus(saturday, 2), `the weekend of ${dayLabel(saturday, today)}`);
  }],
  [new RegExp(`${LEAD}\\b(?:the\\s+)?(?:last|past|previous)\\s+${NUMBER_WORD}\\s+(hour|day|week|month|year)s?\\b`, 'i'), (m, today, now) => {
    const n = count(m[2]);
    const unit = m[3].toLowerCase();
    const label = `the last ${n} ${unit}${n === 1 ? '' : 's'}`;
    if (unit === 'hour') return { start: now - n * HOUR_MS, end: null, label };
    const from = unit === 'day' ? plus(today, -n)
      : unit === 'week' ? plus(today, -7 * n)
        : unit === 'month' ? day(today.y, today.m - n, today.d)
          : day(today.y - n, today.m, today.d);
    return { start: startOf(from), end: null, label };
  }],
  [new RegExp(`${LEAD}\\b(?:the\\s+)?(?:past|previous)\\s+(day|week|month|year)\\b`, 'i'), (m, today) => {
    const unit = m[2].toLowerCase();
    const from = unit === 'day' ? plus(today, -1)
      : unit === 'week' ? plus(today, -7)
        : unit === 'month' ? day(today.y, today.m - 1, today.d)
          : day(today.y - 1, today.m, today.d);
    return { start: startOf(from), end: null, label: `the last ${unit}` };
  }],
  [new RegExp(`${LEAD}\\b${NUMBER_WORD}\\s+(day|week|month|year)s?\\s+ago\\b`, 'i'), (m, today) => {
    const n = count(m[2]);
    const unit = m[3].toLowerCase();
    const label = `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    if (unit === 'day') return one(plus(today, -n), `${label} (${dayLabel(plus(today, -n), today)})`);
    if (unit === 'week') {
      const sunday = plus(today, -today.dow - 7 * n);
      return span(sunday, plus(sunday, 7), `${label} (week of ${dayLabel(sunday, today)})`);
    }
    if (unit === 'month') {
      const first = day(today.y, today.m - n, 1);
      return span(first, day(first.y, first.m + 1, 1), `${MONTHS[first.m - 1].replace(/^./, (c) => c.toUpperCase())} ${first.y}`);
    }
    return span(day(today.y - n, 1, 1), day(today.y - n + 1, 1, 1), String(today.y - n));
  }],
  // A weekday is a date after a word that says so, or as the last word asked.
  [new RegExp(
    `(?:\\b(since|after|before|until|till|through|thru|on|last|this|past)\\s+(${WEEKDAYS.join('|')})\\b`
    + `|(?<!\\b(?:black|good|cyber|palm|easter|ash|fat|super)\\s)\\b()(${WEEKDAYS.join('|')})`
    + '(?=(?:\\s+(?:morning|afternoon|evening|night))?\\s*[?.!]*\\s*$))',
    'i',
  ), (m, today) => {
    const lead = String(m[1] || '').toLowerCase();
    const dow = WEEKDAYS.indexOf(String(m[2] || m[4]).toLowerCase());
    let back = (today.dow - dow + 7) % 7;
    if (back === 0 && (lead === 'last' || lead === 'past')) back = 7;
    const date = plus(today, -back);
    return one(date, `${WEEKDAYS[dow].replace(/^./, (c) => c.toUpperCase())} (${dayLabel(date, today)})`);
  }],
];

const TALK = ['call', 'amy-call', 'signal', 'text', 'whatsapp', 'telegram', 'linkedin'];
const NOT_A_RECORD = '(?!\\s+(?:address|addresses|account|list|server|signature|template|client|provider|settings|password|alias|domain|center|log|back|sign|option|stack|button|number|forwarding|waiting|me|him|her|them|us)\\b)';
const FRAME = '(?:the|an?|my|our|that|this|any|which|what|one|last|latest|newest|recent)\\s+';
const ABOUT = '(?=\\s+(?:from|to|with|about|regarding|re|between)\\b)';

// [pattern, channels, label]. The noun is read as a channel only in a frame
// that makes it a record ("emails", "the call", "email from"), never as a
// search word's neighbour ("email address", "call center").
const CHANNEL_RULES = [
  [/\b(?:e-?mails|inbox|gmail)\b/i, ['email'], 'emails'],
  [new RegExp(`\\be-?mail\\b${ABOUT}|(?<=\\b${FRAME})e-?mail\\b${NOT_A_RECORD}`, 'i'), ['email'], 'emails'],
  [/\b(?:phone\s+calls?|calls|meetings|transcripts|recordings)\b/i, ['call', 'amy-call'], 'calls'],
  [new RegExp(`\\b(?:call|meeting)\\b${ABOUT}|(?<=\\b${FRAME})(?:call|meeting|transcript|recording)\\b${NOT_A_RECORD}`, 'i'), ['call', 'amy-call'], 'calls'],
  [/\b(?:text\s+messages?|texts|sms|imessages?)\b/i, ['text'], 'texts'],
  [/\btext\b(?=\s+(?:from|to)\b)/i, ['text'], 'texts'],
  [/\b(?:on|in|via|over|from)\s+signal\b|\bsignal\s+(?:messages?|chats?|threads?|texts?|groups?)\b/i, ['signal'], 'Signal'],
  [/\b(?:(?:on|in|via|over|from)\s+)?whatsapp(?:\s+(?:messages?|chats?|threads?|groups?))?\b/i, ['whatsapp'], 'WhatsApp'],
  [/\b(?:(?:on|in|via|over|from)\s+)?telegram(?:\s+(?:messages?|chats?|threads?))?\b/i, ['telegram'], 'Chat'],
  [/\b(?:on|in|via|from)\s+linkedin\b|\blinkedin\s+(?:messages?|dms?|inbox|chats?)\b/i, ['linkedin'], 'LinkedIn'],
  [/\b(?:messages|dms|chats)\b/i, ['signal', 'text', 'whatsapp', 'telegram', 'linkedin'], 'messages'],
  [new RegExp(`\\bmessage\\b${ABOUT}|(?<=\\b${FRAME})message\\b${NOT_A_RECORD}`, 'i'), ['signal', 'text', 'whatsapp', 'telegram', 'linkedin'], 'messages'],
  [/\bconversations\b/i, TALK, 'conversations'],
  [new RegExp(`\\bconversation\\b${ABOUT}|(?<=\\b${FRAME})conversation\\b`, 'i'), TALK, 'conversations'],
  // A bare "sessions" is as often a swim or therapy session; only a named kind is a channel.
  [/\b(?:coding|claude|codex|cursor|assistant)\s+sessions?\b/i, ['session'], 'assistant sessions'],
];
// A record word right after "about" is what the question is about, not where
// to look: "emails about the call" searches emails for "call".
const TOPIC = new RegExp(`\\b(?:about|regarding|re|concerning|mentioning|discussing)\\s+(?:${FRAME})?$`, 'i');

const NEWEST_RULES = [
  /\b(?:latest|newest|most\s+recent(?:ly)?|recently|lately|recent)\b/i,
  /\blast\b(?=\s+(?:e-?mail|call|meeting|message|text|conversation|session|chat|transcript|recording)s?\b)/i,
  // "when did I last talk to Sam": the newest record with Sam.
  /\blast\b(?=\s+(?:talk|talked|spoke|spoken|heard|hear|saw|seen|met|meet|called|e-?mailed|texted|messaged|chatted|wrote|write|sent|send|call|e-?mail|text|message|chat|reach|reached)\b)/i,
];

// People: "from Sam", "with Sam Smith", "texts to Pat", "between Sam and Pat",
// "from sam@example.com". The engine resolves each name against the contact
// list and searches a name no contact has as words, so a misread name costs a
// note, never a record. "to" names someone only after a record word or a
// sending or talking verb ("texts to Pat", "talked to Pat"), never in "go to
// Austin"; a possessive names someone else ("from Sam's office").
const PERSON_LEAD = /\b(from|with|by|between|to)\s+/gi;
const PERSON_CAP = 3;
const MARK = '';
const TO_AFTER = new Set((
  'email emails e-mail e-mails emailed mail mailed message messages messaged text texts texted dm dms note notes'
  + ' letter letters reply replies replied respond responded send sends sending sent forward forwarded'
  + ' write writes wrote writing written talk talks talked talking speak speaks spoke speaking spoken'
  + ' say says said saying tell told ask asked chat chatted chatting call called calling mention mentioned'
  + ' introduce introduced'
).split(' '));
const NOT_A_NAME = new Set([
  ...FILLER, ...WEEKDAYS, ...MONTHS, ...Object.keys(MONTH_SHORT),
  ...('his her their its your our these those each no anyone someone everyone everybody somebody anybody'
    + ' nobody people'
    // Record and time words: "with email", "from yesterday's call".
    + ' email emails e-mail e-mails mail inbox gmail call calls meeting meetings transcript transcripts'
    + ' recording recordings text texts sms imessage imessages message messages dm dms chat chats'
    + ' conversation conversations session sessions signal whatsapp chat linkedin phone'
    + ' regarding concerning mentioning discussing yesterday tonight morning afternoon evening night'
    + ' week weekend month year ago last next past recent recently lately latest newest earlier').split(' '),
]);
const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'prof', 'rev', 'fr', 'st']);
const EMAIL_AT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9@])/y;
const PHONE_AT = /\+?\(?\d[\d\s().-]{6,}\d(?!\d)/y;
const TOKEN_AT = /\p{L}[\p{L}'’.-]*/uy;
const SPACE_AT = /[ \t]+/y;
const SEPARATOR_AT = /\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or|&)\s+/iy;

function sticky(pattern, text, at) {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

/** One person at `at`: an email, a phone number, or a name of 1-3 words. */
function readPerson(text, at) {
  const email = sticky(EMAIL_AT, text, at);
  if (email) return { name: email[0], end: at + email[0].length };
  const phone = sticky(PHONE_AT, text, at);
  const digits = phone ? phone[0].replace(/\D/g, '').length : 0;
  if (digits >= 10 && digits <= 15) return { name: phone[0].trim(), end: at + phone[0].length };
  const words = [];
  let pos = at;
  let end = at;
  while (words.length < 3) {
    if (words.length) {
      const gap = sticky(SPACE_AT, text, pos);
      if (!gap) break;
      pos += gap[0].length;
    }
    const token = sticky(TOKEN_AT, text, pos);
    if (!token) break;
    if (/['’]s$/i.test(token[0])) return null;
    const word = token[0].replace(/['’.-]+$/, '');
    if (!word || NOT_A_NAME.has(word.toLowerCase())) break;
    words.push(word);
    pos += token[0].length;
    end = pos;
    // A sentence ends at "Sam."; an initial ("J.") or a title ("Dr.") does not.
    if (token[0].endsWith('.') && word.length > 1 && !TITLES.has(word.toLowerCase())) break;
  }
  return words.length ? { name: words.join(' '), end } : null;
}

/** "to" names someone after a record word or verb, or right after "from <person>" ("from Sam to Pat"). */
function toNamesSomeone(text, index, fromEnd) {
  if (fromEnd >= 0 && !text.slice(fromEnd, index).trim()) return true;
  const words = text.slice(0, index).toLowerCase().match(/[a-z]+(?:-[a-z]+)?/g) || [];
  const last = words[words.length - 1] || '';
  if (last === 'out') return /^reach/.test(words[words.length - 2] || '');
  return TO_AFTER.has(last);
}

/** The people a question names, each replaced by a marker so the channel rules still see "email from". */
function readPeople(text) {
  const spans = [];
  let lastEnd = -1;
  let fromEnd = -1;
  PERSON_LEAD.lastIndex = 0;
  for (let lead = PERSON_LEAD.exec(text); lead && spans.length < PERSON_CAP; lead = PERSON_LEAD.exec(text)) {
    if (lead.index < lastEnd) continue;
    const word = lead[1].toLowerCase();
    if (word === 'to' && !toNamesSomeone(text, lead.index, fromEnd)) continue;
    let pos = lead.index + lead[0].length;
    for (;;) {
      const person = readPerson(text, pos);
      if (!person) break;
      spans.push({ name: person.name, start: pos, end: person.end });
      lastEnd = person.end;
      if (spans.length >= PERSON_CAP) break;
      const separator = sticky(SEPARATOR_AT, text, person.end);
      if (!separator) break;
      pos = person.end + separator[0].length;
    }
    if (lastEnd > lead.index) {
      PERSON_LEAD.lastIndex = lastEnd;
      fromEnd = word === 'from' ? lastEnd : -1;
    }
  }
  let marked = text;
  for (const span of [...spans].reverse()) marked = `${marked.slice(0, span.start)}${MARK}${marked.slice(span.end)}`;
  const names = [];
  for (const { name } of spans) {
    if (!names.some((known) => known.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return { text: marked, names };
}

/** Drops each marker with the word that led to it: "texts from <Sam> and <Pat>" leaves "texts". */
function dropPeople(text) {
  return text
    .replace(new RegExp(`(?:\\s*,\\s*(?:(?:and|or)\\s+)?|\\s+(?:and|or|&)\\s+)${MARK}`, 'gi'), '')
    .replace(new RegExp(`\\b(?:from|with|by|between|to)\\s+${MARK}`, 'gi'), ' ')
    .replace(new RegExp(MARK, 'g'), ' ');
}

function cut(text, match) {
  return `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`;
}

function readDate(text, today, now) {
  for (const [pattern, read] of DATE_RULES) {
    const match = pattern.exec(text);
    const found = match && read(match, today, now);
    if (!found) continue;
    const lead = String(match[1] || '').toLowerCase();
    let { start, end, label } = found;
    if (lead === 'since') [end, label] = [null, `since ${label}`];
    else if (lead === 'after') [start, end, label] = [end == null ? start : end, null, `after ${label}`];
    else if (lead === 'before') [start, end, label] = [null, start, `before ${label}`];
    else if (['until', 'till', 'through', 'thru'].includes(lead)) [start, label] = [null, `through ${label}`];
    return { text: cut(text, match), start, end, label };
  }
  return null;
}

/**
 * What a question asks for besides its words.
 *   { rest, filters, label, scope, browse }
 * rest: the question without the filter words (the whole question when it has
 *   none). filters: { since, until, channels, order, people } with times in
 *   UTC seconds, or null; people are the names, emails or numbers as asked
 *   (the engine resolves them). label: the time and channel filter in words;
 *   scope: the same without the order (the answer names the people it
 *   resolved). browse: nothing is left to search for, so the question asks
 *   what sits inside the filter. parts: { channels, date }, the two halves
 *   of scope, so the answer can put the people between them.
 */
function parseWhen(question, options = {}) {
  const original = String(question || '').trim();
  const now = options.now == null ? Date.now() : Number(options.now);
  const parts = ctParts(now);
  const today = day(parts.year, parts.month, parts.day);
  let text = original;
  const filters = {};
  const labels = [];

  const dated = readDate(text, today, now);
  if (dated) {
    text = dated.text;
    if (dated.start != null) filters.since = Math.floor(dated.start / 1000);
    if (dated.end != null) filters.until = Math.floor(dated.end / 1000);
  }
  for (const pattern of NEWEST_RULES) {
    const match = pattern.exec(text);
    if (match) {
      text = cut(text, match);
      filters.order = 'newest';
    }
  }
  const people = readPeople(text);
  text = people.text;
  if (people.names.length) filters.people = people.names;
  const channels = [];
  for (const [pattern, ids, label] of CHANNEL_RULES) {
    const match = pattern.exec(text);
    if (!match || TOPIC.test(text.slice(0, match.index))) continue;
    text = cut(text, match);
    for (const id of ids) if (!channels.includes(id)) channels.push(id);
    if (!labels.includes(label)) labels.push(label);
  }
  text = dropPeople(text);
  if (channels.length) filters.channels = channels;
  if (!Object.keys(filters).length) {
    return { rest: original, filters: null, label: '', scope: '', browse: false, parts: { channels: '', date: '' } };
  }

  const rest = text.replace(/\s+/g, ' ').replace(/^[\s,.;:?!'"-]+|[\s,.;:?!'"-]+$/g, '');
  const words = rest.toLowerCase().match(/[a-z0-9]+/g) || [];
  const browse = words.every((word) => FILLER.has(word));
  const halves = { channels: labels.join(' and '), date: dated ? dated.label : '' };
  const scope = [halves.channels, halves.date].filter(Boolean).join(', ');
  const label = [scope, filters.order ? 'newest first' : ''].filter(Boolean).join(', ');
  return { rest: browse ? '' : rest, filters, label, scope, browse, parts: halves };
}

module.exports = { parseWhen, whenLabel };
