/**
 * Destinatari di controllo amministratore: sempre in copia su ogni invio email/SMS.
 * Non rispettano audience, gia-inviato, spam-guard o blocco giornaliero.
 */
const config = require('../config/segments');

const ADMIN_EMAIL = String(config.adminEmail || 'alongodorni@gmail.com').toLowerCase().trim();
const ADMIN_PHONE_RAW = String(config.adminPhone || '+393394773418').trim();

function getAdminEmail() {
  return ADMIN_EMAIL;
}

function getAdminPhoneRaw() {
  return ADMIN_PHONE_RAW;
}

function isAdminEmail(email) {
  return String(email || '').toLowerCase().trim() === ADMIN_EMAIL;
}

function buildAdminEmailRow() {
  return {
    nome: 'Admin',
    first_name: 'Admin',
    cognome: '',
    last_name: '',
    email: ADMIN_EMAIL,
    telefono: ADMIN_PHONE_RAW,
    phone: ADMIN_PHONE_RAW,
    city: '',
    citta: '',
    eventoPrenotato: '',
    evento: '',
    name: '',
    start_date: '',
    status: '',
    segment: 'ADMIN',
    resourceIds: [],
    isAdminControl: true
  };
}

function ensureAdminControlEmail(rows) {
  const list = Array.isArray(rows) ? rows.filter((row) => !isAdminEmail(row?.email)) : [];
  return [buildAdminEmailRow(), ...list];
}

module.exports = {
  getAdminEmail,
  getAdminPhoneRaw,
  isAdminEmail,
  buildAdminEmailRow,
  ensureAdminControlEmail
};
