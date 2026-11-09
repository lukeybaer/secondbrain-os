'use strict';

const DEFAULT_STRATEGIC_CONTACTS = Object.freeze([]);

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function filterStrategicLinkedInEvents(events, contacts = DEFAULT_STRATEGIC_CONTACTS) {
  const accepted = new Set(
    contacts.flatMap((contact) => contact.aliases || [contact.name]).map(normalizeName),
  );
  return (Array.isArray(events) ? events : []).filter((event) =>
    accepted.has(normalizeName(event && event.contactName)),
  );
}

module.exports = { DEFAULT_STRATEGIC_CONTACTS, normalizeName, filterStrategicLinkedInEvents };
