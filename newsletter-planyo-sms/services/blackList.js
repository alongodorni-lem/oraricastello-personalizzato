/**
 * Black list permanente dei contatti cancellati dal tab PRIVACY.
 * File: data/black_list.json
 * Un contatto e' bloccato se matcha l'email oppure le ultime 9 cifre del cellulare.
 */
const fs = require('fs');
const path = require('path');
const adminControl = require('./adminControl');
const { dataFile } = require('./dataDir');

const BLACK_LIST_FILE = dataFile('black_list.json');

function ensureDir() {
  const dir = path.dirname(BLACK_LIST_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeEmail(email) {
  const value = String(email || '').toLowerCase().trim();
  return value.includes('@') ? value : '';
}

function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 9) return '';
  return digits.slice(-9);
}

function adminPhoneKey() {
  return phoneKey(adminControl.getAdminPhoneRaw());
}

function isAdminContact(email, phone) {
  if (adminControl.isAdminEmail(email)) return true;
  const key = phoneKey(phone);
  const adminKey = adminPhoneKey();
  return !!(key && adminKey && key === adminKey);
}

function emptyStore() {
  return { updatedAt: null, contacts: [] };
}

function loadStore() {
  try {
    const raw = fs.readFileSync(BLACK_LIST_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const contacts = Array.isArray(parsed?.contacts) ? parsed.contacts : [];
    return { updatedAt: parsed?.updatedAt || null, contacts };
  } catch {
    return emptyStore();
  }
}

function saveStore(store) {
  ensureDir();
  const payload = {
    updatedAt: new Date().toISOString(),
    contacts: Array.isArray(store?.contacts) ? store.contacts : []
  };
  fs.writeFileSync(BLACK_LIST_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function indexStore(store) {
  const emails = new Set();
  const phones = new Set();
  for (const row of store.contacts || []) {
    const email = normalizeEmail(row?.email);
    const phone = phoneKey(row?.phone);
    if (email) emails.add(email);
    if (phone) phones.add(phone);
  }
  return { emails, phones };
}

function isListed(email, phone) {
  if (isAdminContact(email, phone)) return false;
  const store = loadStore();
  const idx = indexStore(store);
  const em = normalizeEmail(email);
  const ph = phoneKey(phone);
  if (em && idx.emails.has(em)) return true;
  if (ph && idx.phones.has(ph)) return true;
  return false;
}

function splitRows(rows, pickers = {}) {
  const getEmail = typeof pickers.email === 'function'
    ? pickers.email
    : (row) => row?.email;
  const getPhone = typeof pickers.phone === 'function'
    ? pickers.phone
    : (row) => row?.telefono || row?.phone || row?.cellulare;
  const kept = [];
  const blocked = [];
  for (const row of rows || []) {
    if (isListed(getEmail(row), getPhone(row))) blocked.push(row);
    else kept.push(row);
  }
  return { kept, blocked, blockedCount: blocked.length };
}

function uniqueSources(values) {
  const out = [];
  for (const value of values || []) {
    const key = String(value || '').trim().toLowerCase();
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * Aggiunge (o aggiorna) un contatto dopo una cancellazione privacy.
 * Unisce record se email o telefono coincidono gia' in lista.
 */
function addFromPrivacy({ email, phone, sources, via } = {}) {
  const em = normalizeEmail(email);
  const ph = phoneKey(phone);
  const rawPhone = String(phone || '').replace(/\D/g, '');
  if (!em && !ph) return { added: false, contact: null, total: loadStore().contacts.length };
  if (isAdminContact(em, rawPhone || ph)) {
    return { added: false, contact: null, total: loadStore().contacts.length, skippedAdmin: true };
  }

  const store = loadStore();
  const now = new Date().toISOString();
  const src = uniqueSources(sources);
  let existing = store.contacts.find((row) => {
    const rowEmail = normalizeEmail(row?.email);
    const rowPhone = phoneKey(row?.phone);
    return (em && rowEmail === em) || (ph && rowPhone === ph);
  });

  if (!existing) {
    existing = {
      email: em,
      phone: rawPhone || ph,
      deletedAt: now,
      sources: src.length ? src : ['manual'],
      via: via || 'privacy'
    };
    store.contacts.push(existing);
  } else {
    if (em && !normalizeEmail(existing.email)) existing.email = em;
    if ((rawPhone || ph) && !phoneKey(existing.phone)) existing.phone = rawPhone || ph;
    existing.sources = uniqueSources([...(existing.sources || []), ...src]);
    existing.via = existing.via || via || 'privacy';
    existing.updatedAt = now;
  }

  saveStore(store);
  return { added: true, contact: existing, total: store.contacts.length };
}

const SEEDED_CONTACTS = [
  { phone: '+393929832919', sources: ['manual'], via: 'manual' },
  { email: 'eannalisa.saetta@email.it', sources: ['manual'], via: 'manual' },
  { email: 'etendeka@gmail.com', sources: ['manual'], via: 'manual' },
  { email: 'marko.mz@libero.it', sources: ['manual'], via: 'manual' },
  { email: 'claudiu76@gmail.com', sources: ['manual'], via: 'manual' },
  { email: 'lindabellunato@yahoo.it', sources: ['manual'], via: 'manual' },
  { email: 'kia.rampin@gmail.com', sources: ['manual'], via: 'manual' },
  { email: 'l.rubi@tiscali.it', sources: ['manual'], via: 'manual' },
  { email: 'teomocchi@gmail.com', sources: ['manual'], via: 'manual' },
  { email: 's1976@libero.it', sources: ['manual'], via: 'manual' },
  { email: 'manuel.marcato@gmail.com', sources: ['manual'], via: 'manual' },
  { email: 'ilariaferraris75@gmail.com', sources: ['manual'], via: 'manual' },
  { email: 'karenmicra@live.it', sources: ['manual'], via: 'manual' },
  { email: 'm.colombi@tiscali.it', sources: ['manual'], via: 'manual' },
  { email: 'cristiana.morosini@uninsubria.it', sources: ['manual'], via: 'manual' },
  { email: 'miky.bosani@yahoo.it', sources: ['manual'], via: 'manual' }
];

function ensureSeeded() {
  const added = [];
  for (const item of SEEDED_CONTACTS) {
    if (isListed(item.email, item.phone)) continue;
    const out = addFromPrivacy(item);
    if (out.added) added.push(out.contact);
  }
  return added;
}

function listContacts() {
  return loadStore();
}

module.exports = {
  BLACK_LIST_FILE,
  isListed,
  splitRows,
  addFromPrivacy,
  ensureSeeded,
  listContacts,
  normalizeEmail,
  phoneKey
};
