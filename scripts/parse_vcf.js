const fs = require('fs');
const path = require('path');

const VCF_PATH = path.join('C:', 'Users', 'luked', 'Downloads', 'Zain Abbas and 807 others.vcf');
const OUT_PARSED = path.join('C:', 'Users', 'luked', 'secondbrain', 'tmp_vcf_parsed.json');
const OUT_REPORT = path.join('C:', 'Users', 'luked', 'secondbrain', 'tmp_vcf_report.json');

const raw = fs.readFileSync(VCF_PATH, 'utf-8');

// Unfold continuation lines (RFC 2425: line starting with space/tab is continuation)
const unfolded = raw.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');

// Split into individual vCards
const cardBlocks = unfolded
  .split(/BEGIN:VCARD/i)
  .slice(1)
  .map((b) => {
    const end = b.indexOf('END:VCARD');
    return end >= 0 ? b.substring(0, end).trim() : b.trim();
  });

function parseLine(line) {
  // Format: [group.]NAME[;params]:value
  const colonIdx = line.indexOf(':');
  if (colonIdx < 0) return null;
  const left = line.substring(0, colonIdx);
  const value = line.substring(colonIdx + 1);

  // Strip item group prefix (e.g., "item1.")
  const stripped = left.replace(/^item\d+\./i, '');

  // Split name and params
  const semiIdx = stripped.indexOf(';');
  let name, params;
  if (semiIdx >= 0) {
    name = stripped.substring(0, semiIdx).toUpperCase();
    params = stripped.substring(semiIdx + 1);
  } else {
    name = stripped.toUpperCase();
    params = '';
  }

  return { name, params, value };
}

function extractType(params) {
  // Extract type= values from params like "type=CELL;type=VOICE;type=pref"
  const types = [];
  for (const part of params.split(';')) {
    const m = part.match(/^type=(.+)$/i);
    if (m) types.push(m[1]);
  }
  return types.filter((t) => t.toLowerCase() !== 'pref').join(', ') || undefined;
}

function parseAddress(value) {
  // ADR: PO Box;Extended;Street;City;Region;Postal;Country
  const parts = value.split(';');
  return {
    po_box: parts[0] || undefined,
    extended: parts[1] || undefined,
    street: parts[2] || undefined,
    city: parts[3] || undefined,
    region: parts[4] || undefined,
    postal_code: parts[5] || undefined,
    country: parts[6] || undefined,
  };
}

function parseStructuredName(value) {
  // N: Last;First;Middle;Prefix;Suffix
  const parts = value.split(';');
  return {
    last: parts[0] || undefined,
    first: parts[1] || undefined,
    middle: parts[2] || undefined,
    prefix: parts[3] || undefined,
    suffix: parts[4] || undefined,
  };
}

const contacts = [];

for (const block of cardBlocks) {
  const lines = block.split(/\r?\n/).filter((l) => l.trim());
  const contact = {
    fn: null,
    n: null,
    phones: [],
    emails: [],
    org: null,
    addresses: [],
    birthday: null,
    note: null,
    title: null,
    urls: [],
    social_profiles: [],
  };

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const { name, params, value } = parsed;

    switch (name) {
      case 'FN':
        contact.fn = value.trim();
        break;
      case 'N':
        contact.n = parseStructuredName(value);
        break;
      case 'TEL':
        contact.phones.push({
          number: value.trim(),
          type: extractType(params),
        });
        break;
      case 'EMAIL':
        contact.emails.push({
          address: value.trim(),
          type: extractType(params),
        });
        break;
      case 'ORG':
        contact.org = value.replace(/;+$/, '').trim() || null;
        break;
      case 'ADR':
        contact.addresses.push({
          ...parseAddress(value),
          type: extractType(params),
        });
        break;
      case 'BDAY':
        contact.birthday = value.trim();
        break;
      case 'NOTE':
        contact.note = value.replace(/\\n/g, '\n').trim();
        break;
      case 'TITLE':
        contact.title = value.trim();
        break;
      case 'URL':
        contact.urls.push(value.trim());
        break;
      case 'X-SOCIALPROFILE': {
        // Extract type and value
        const spType = (params.match(/type=([^;]+)/i) || [])[1] || 'unknown';
        contact.social_profiles.push({ type: spType, value: value.trim() });
        break;
      }
    }
  }

  // Clean up empty arrays/nulls for cleaner output
  if (contact.phones.length === 0) contact.phones = [];
  if (contact.emails.length === 0) contact.emails = [];
  if (contact.addresses.length === 0) contact.addresses = [];
  if (contact.urls.length === 0) contact.urls = [];
  if (contact.social_profiles.length === 0) contact.social_profiles = [];

  contacts.push(contact);
}

// Write parsed contacts
fs.writeFileSync(OUT_PARSED, JSON.stringify(contacts, null, 2), 'utf-8');
console.log(`Wrote ${contacts.length} contacts to ${OUT_PARSED}`);

// Generate report
const total = contacts.length;
const withPhone = contacts.filter((c) => c.phones.length > 0);
const withEmail = contacts.filter((c) => c.emails.length > 0);
const withOrg = contacts.filter((c) => c.org);
const withAddr = contacts.filter((c) => c.addresses.length > 0);
const withBday = contacts.filter((c) => c.birthday);
const withTitle = contacts.filter((c) => c.title);
const withNotes = contacts.filter((c) => c.note);

const unreachable = contacts.filter((c) => c.phones.length === 0 && c.emails.length === 0);

// Find duplicates by normalized FN
const nameMap = {};
for (const c of contacts) {
  const key = (c.fn || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!key) continue;
  if (!nameMap[key]) nameMap[key] = [];
  nameMap[key].push(c);
}
const duplicates = Object.entries(nameMap)
  .filter(([, arr]) => arr.length > 1)
  .map(([name, arr]) => ({
    name: arr[0].fn,
    count: arr.length,
    cards: arr.map((c) => ({
      fn: c.fn,
      phones: c.phones,
      emails: c.emails,
      org: c.org,
    })),
  }));

const pct = (n) => ((n / total) * 100).toFixed(1) + '%';

const report = {
  total_contacts: total,
  contacts_with_phone: { count: withPhone.length, percentage: pct(withPhone.length) },
  contacts_with_email: { count: withEmail.length, percentage: pct(withEmail.length) },
  contacts_with_org: { count: withOrg.length, percentage: pct(withOrg.length) },
  contacts_with_address: { count: withAddr.length, percentage: pct(withAddr.length) },
  contacts_with_birthday: { count: withBday.length, percentage: pct(withBday.length) },
  contacts_with_title: { count: withTitle.length, percentage: pct(withTitle.length) },
  contacts_with_notes: { count: withNotes.length, percentage: pct(withNotes.length) },
  unreachable_contacts: {
    count: unreachable.length,
    contacts: unreachable.map((c) => c.fn || '(no name)'),
  },
  duplicate_names: {
    count: duplicates.length,
    groups: duplicates,
  },
};

fs.writeFileSync(OUT_REPORT, JSON.stringify(report, null, 2), 'utf-8');
console.log(`Wrote report to ${OUT_REPORT}`);

// Print summary to console
console.log('\n=== VCF PARSE REPORT ===');
console.log(`Total contacts: ${total}`);
console.log(`With phone: ${withPhone.length} (${pct(withPhone.length)})`);
console.log(`With email: ${withEmail.length} (${pct(withEmail.length)})`);
console.log(`With org: ${withOrg.length} (${pct(withOrg.length)})`);
console.log(`With address: ${withAddr.length} (${pct(withAddr.length)})`);
console.log(`With birthday: ${withBday.length} (${pct(withBday.length)})`);
console.log(`With title: ${withTitle.length} (${pct(withTitle.length)})`);
console.log(`With notes: ${withNotes.length} (${pct(withNotes.length)})`);
console.log(`Unreachable (no phone, no email): ${unreachable.length}`);
console.log(`Duplicate name groups: ${duplicates.length}`);
