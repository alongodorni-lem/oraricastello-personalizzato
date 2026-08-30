/**
 * Smshosting API - invio SMS
 * https://help.smshosting.it/article/316-sms-http-api
 * https://api.smshosting.it/rest/api/sms/send
 */
const axios = require('axios');

const BASE_URL = 'https://api.smshosting.it/rest/api';
const GSM7_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ`¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "^{}\\[~]|€";

/**
 * Normalizza numero per SMS (Italia: 39xxxxxxxxxx)
 */
function normalizePhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  while (digits.startsWith('00')) digits = digits.slice(2);
  while (digits.startsWith('3939')) digits = '39' + digits.slice(4);
  if (!digits) return '';

  // Gia corretto: 39 + mobile(10 cifre)
  if (/^393\d{9}$/.test(digits)) return digits;
  // Mobile nazionale senza prefisso internazionale
  if (/^3\d{9}$/.test(digits)) return '39' + digits;
  // Ripulisce casi sporchi tipo "(39) 393..." o "39.393..."
  const tail = digits.match(/3\d{9}$/);
  if (tail) return '39' + tail[0];
  return '';
}

function normalizeSmsText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2013|\u2014/g, '-')
    .replace(/\u2026/g, '...')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getGsm7Units(text) {
  let units = 0;
  for (const ch of String(text || '')) {
    if (GSM7_BASIC.includes(ch)) units += 1;
    else if (GSM7_EXT.includes(ch)) units += 2;
    else return -1;
  }
  return units;
}

function prepareSingleSmsText(text) {
  const raw = normalizeSmsText(text);
  const gsmUnits = getGsm7Units(raw);
  if (gsmUnits >= 0) {
    // Single-part GSM-7: max 160 units
    let out = '';
    let used = 0;
    for (const ch of raw) {
      const u = GSM7_EXT.includes(ch) ? 2 : 1;
      if (used + u > 160) break;
      out += ch;
      used += u;
    }
    return { text: out, encoding: 'GSM-7', truncated: out !== raw };
  }

  // Single-part UCS-2: max 70 chars
  const out = [...raw].slice(0, 70).join('');
  return { text: out, encoding: 'UCS-2', truncated: out !== raw };
}

/**
 * Invia SMS tramite Smshosting
 * @param {string} to - numero (con prefisso 39 per Italia)
 * @param {string} text - messaggio (max 160 caratteri per SMS singolo)
 * @param {{ from?: string }} options - from = mittente alfanumerico (es. "Castello") - max 11 caratteri
 * @returns {Promise<{ success: boolean, smsInserted?: number, smsNotInserted?: number, error?: string }>}
 */
async function sendSms(to, text, options = {}) {
  const authKey = process.env.SMSHOSTING_AUTH_KEY;
  const authSecret = process.env.SMSHOSTING_AUTH_SECRET;

  if (!authKey || !authSecret) {
    throw new Error('SMSHOSTING_AUTH_KEY e SMSHOSTING_AUTH_SECRET richiesti');
  }

  if (!to || String(to).includes('@')) {
    return { success: false, error: 'NO_VALID_RECIPIENT (valore non è un numero)' };
  }
  const phone = normalizePhone(to);
  if (!/^393\d{9}$/.test(phone)) {
    return { success: false, error: 'Numero telefono non valido' };
  }

  const prepared = prepareSingleSmsText(text || '');
  const bodyParams = new URLSearchParams({ to: phone, text: prepared.text });
  // Mittente: usa alias solo se SMSHOSTING_USE_ALIAS=true, altrimenti mittente numerico (default)
  const useAlias = process.env.SMSHOSTING_USE_ALIAS === 'true' || process.env.SMSHOSTING_USE_ALIAS === '1';
  const from = (options && (options.from === '' || options.from === false)) ? '' : (useAlias ? (options?.from || process.env.SMSHOSTING_FROM) : '');
  if (from) bodyParams.set('from', String(from).slice(0, 11));

  // Debug: verifica che alias sia inviato (controlla log su Render)
  if (process.env.NODE_ENV !== 'test') {
    console.log('[Smshosting] useAlias=', useAlias, '| from=', from || '(numerico)', '| SMSHOSTING_USE_ALIAS=', process.env.SMSHOSTING_USE_ALIAS, '| SMSHOSTING_FROM=', process.env.SMSHOSTING_FROM ? '***' : '(vuoto)');
  }

  const url = `${BASE_URL}/sms/send`;

  try {
    const res = await axios.post(url, bodyParams.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      auth: { username: authKey, password: authSecret },
      timeout: 15000
    });

    const data = res.data || {};
    // Supporta valori numerici, stringa "1", boolean; API può restituire struttura annidata
    const rawInserted = data.smsInserted ?? data.data?.smsInserted;
    const rawNotInserted = data.smsNotInserted ?? data.data?.smsNotInserted;
    const inserted = Number(rawInserted) === 1 || rawInserted === true;
    const notInserted = Number(rawNotInserted) >= 1 || rawNotInserted === true;

    const success = inserted && !notInserted;
    const error = notInserted ? (data.errorMsg || data.message || data.statusDetail || 'SMS non inserito') : undefined;
    // DUPLICATESMS può essere in statusDetail, error, o in smsList[].statusDetail
    let isDuplicate = notInserted && /DUPLICATE/i.test(String(error || ''));
    if (!isDuplicate && data.smsList && Array.isArray(data.smsList)) {
      isDuplicate = data.smsList.some((s) => /DUPLICATE/i.test(String(s.statusDetail || s.status || '')));
    }

    return {
      success,
      smsInserted: rawInserted,
      smsNotInserted: rawNotInserted,
      error,
      isDuplicate,
      encoding: prepared.encoding,
      truncated: prepared.truncated
    };
  } catch (err) {
    const msg = err.response?.data?.errorMsg || err.response?.data?.message || err.message;
    return { success: false, error: msg, isDuplicate: false };
  }
}

function boolLike(v) {
  const s = String(v ?? '').toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'yes' || s === 'ok' || s === 'deleted' || s === 'success';
}

function looksLikeNotFoundPayload(data) {
  const raw = String(data?.message || data?.errorMsg || data?.statusDetail || data?.error || '').toLowerCase();
  return raw.includes('not found') || raw.includes('not_exist') || raw.includes('inesistente') || raw.includes('missing');
}

async function tryDeleteWithEndpoint(url, auth, phone) {
  const payloads = [
    new URLSearchParams({ phone }).toString(),
    new URLSearchParams({ msisdn: phone }).toString(),
    new URLSearchParams({ recipient: phone }).toString()
  ];
  for (const body of payloads) {
    const res = await axios.post(url, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      auth,
      timeout: 20000,
      validateStatus: (s) => s < 500
    });
    const data = res.data || {};
    if (res.status === 404 || looksLikeNotFoundPayload(data)) return { status: 'not_found' };
    if (res.status >= 400) continue;
    if (boolLike(data.success) || boolLike(data.deleted) || Number(data.deleted) > 0 || Number(data.removed) > 0) {
      return { status: 'deleted' };
    }
    // HTTP OK ma nessun indicatore affidabile: consideriamo trovato ma non cancellato
    return { status: 'found_not_deleted', reason: data.message || data.errorMsg || 'Delete non confermato dal provider' };
  }
  return { status: 'found_not_deleted', reason: 'Delete endpoint non ha confermato la cancellazione' };
}

function nationalMobileFromNormalized(normalized) {
  const digits = String(normalized || '').replace(/\D/g, '');
  if (/^393\d{9}$/.test(digits)) return digits.slice(2);
  if (/^3\d{9}$/.test(digits)) return digits;
  return '';
}

function phonebookMsisdnCandidates(phone) {
  const normalized = normalizePhone(phone);
  const national = nationalMobileFromNormalized(normalized) || nationalMobileFromNormalized(String(phone || '').replace(/\D/g, ''));
  const out = [];
  const push = (value) => {
    const v = String(value || '').trim();
    if (v && !out.includes(v)) out.push(v);
  };
  push(normalized);
  if (national) {
    push(national);
    push('39' + national);
    push('+39' + national);
  }
  return out;
}

function phonesLikelyMatch(a, b) {
  const left = normalizePhone(a) || String(a || '').replace(/\D/g, '');
  const right = normalizePhone(b) || String(b || '').replace(/\D/g, '');
  if (!left || !right) return false;
  if (left === right) return true;
  return left.slice(-9) === right.slice(-9);
}

function extractSmsContacts(data) {
  if (!data) return [];
  const payload = data.contacts ? data : (data.contactSearchResult || data.data || data);
  const rows = Array.isArray(payload?.contacts)
    ? payload.contacts
    : (Array.isArray(payload?.contactList)
      ? payload.contactList
      : (Array.isArray(payload)
        ? payload
        : (Array.isArray(data?.results) ? data.results : (data.id || data.msisdn || data.email ? [data] : []))));
  return rows
    .map((row) => ({
      id: String(row?.id || row?.contactId || row?.uuid || '').trim(),
      email: String(row?.email || '').toLowerCase().trim(),
      msisdn: normalizePhone(row?.msisdn || row?.phone || row?.mobile || row?.to || ''),
      rawMsisdn: String(row?.msisdn || row?.phone || row?.mobile || '').trim(),
      name: String(row?.name || '').trim(),
      lastname: String(row?.lastname || '').trim()
    }))
    .filter((row) => row.id || row.email || row.msisdn || row.rawMsisdn);
}

async function requestPhonebookSearch(auth, params) {
  const res = await axios.get(`${BASE_URL}/phonebook/contact/search`, {
    params,
    auth,
    headers: { Accept: 'application/json' },
    timeout: 20000,
    validateStatus: (s) => s < 500
  });
  return res;
}

async function searchSmsHostingContacts(auth, { email, phone }) {
  const queries = [];
  for (const msisdn of phonebookMsisdnCandidates(phone)) {
    queries.push({ msisdn });
  }
  if (email && String(email).includes('@')) {
    queries.push({ email: String(email).toLowerCase().trim() });
  }
  if (!queries.length) {
    return { status: 'not_found', contacts: [], reason: 'Email o cellulare richiesti' };
  }

  let lastError = '';
  for (const params of queries) {
    try {
      console.log('[Smshosting][Privacy] cerca rubrica', params.msisdn ? ('msisdn=' + params.msisdn) : ('email=' + params.email));
      const res = await requestPhonebookSearch(auth, { ...params, limit: 50, offset: 0 });
      if (res.status === 401) {
        return { status: 'error', contacts: [], reason: 'Credenziali SMS Hosting non valide' };
      }
      if (res.status === 404) {
        lastError = 'HTTP 404';
        continue;
      }
      if (res.status >= 400) {
        lastError = res.data?.errorMsg || `HTTP ${res.status}`;
        continue;
      }
      let contacts = extractSmsContacts(res.data);
      if (params.msisdn) {
        contacts = contacts.filter((c) => phonesLikelyMatch(c.msisdn || c.rawMsisdn, params.msisdn));
      }
      if (params.email) {
        contacts = contacts.filter((c) => String(c.email || '').toLowerCase() === params.email);
      }
      if (contacts.length) return { status: 'found', contacts, query: params };
    } catch (err) {
      lastError = err.response?.data?.errorMsg || err.message;
    }
  }
  return {
    status: lastError && /401|credenziali|BAD_CREDENTIALS/i.test(lastError) ? 'error' : 'not_found',
    contacts: [],
    reason: lastError && /401|credenziali|BAD_CREDENTIALS/i.test(lastError) ? lastError : ''
  };
}

async function findContactForPrivacy({ email, phone } = {}) {
  const authKey = process.env.SMSHOSTING_AUTH_KEY;
  const authSecret = process.env.SMSHOSTING_AUTH_SECRET;
  if (!authKey || !authSecret) {
    return { source: 'smshosting', status: 'error', found: false, reason: 'SMSHOSTING_AUTH_KEY/SMSHOSTING_AUTH_SECRET non configurate' };
  }
  const normalizedPhone = normalizePhone(phone);
  const normalizedEmail = String(email || '').toLowerCase().trim();
  if (!normalizedPhone && !(normalizedEmail && normalizedEmail.includes('@'))) {
    return { source: 'smshosting', status: 'not_found', found: false, reason: 'Email o cellulare richiesti' };
  }

  const auth = { username: authKey, password: authSecret };
  const lookup = await searchSmsHostingContacts(auth, {
    email: normalizedEmail.includes('@') ? normalizedEmail : '',
    phone: phone || normalizedPhone
  });
  if (lookup.status === 'error') {
    return { source: 'smshosting', status: 'error', found: false, reason: lookup.reason };
  }
  if (lookup.status === 'found') {
    const first = lookup.contacts[0] || {};
    return {
      source: 'smshosting',
      status: 'found',
      found: true,
      contacts: lookup.contacts,
      email: first.email || normalizedEmail,
      phone: first.msisdn || normalizedPhone,
      reason: 'Trovato in rubrica' + (lookup.query?.msisdn ? (' (msisdn ' + lookup.query.msisdn + ')') : '')
    };
  }
  return { source: 'smshosting', status: 'not_found', found: false };
}

async function deletePhonebookContactById(auth, id) {
  const res = await axios.delete(`${BASE_URL}/phonebook/contact/${encodeURIComponent(id)}`, {
    auth,
    headers: { Accept: 'application/json' },
    timeout: 20000,
    validateStatus: (s) => s < 500
  });
  if (res.status === 200 || res.status === 204) return { status: 'deleted' };
  if (res.status === 404 || looksLikeNotFoundPayload(res.data || {})) return { status: 'not_found' };
  return { status: 'found_not_deleted', reason: res.data?.errorMsg || `HTTP ${res.status}` };
}

async function deleteContactByPhoneForPrivacy(phone, email) {
  const authKey = process.env.SMSHOSTING_AUTH_KEY;
  const authSecret = process.env.SMSHOSTING_AUTH_SECRET;
  if (!authKey || !authSecret) {
    return { source: 'smshosting', status: 'error', reason: 'SMSHOSTING_AUTH_KEY/SMSHOSTING_AUTH_SECRET non configurate' };
  }
  const normalized = normalizePhone(phone);
  const auth = { username: authKey, password: authSecret };
  const found = await findContactForPrivacy({ email, phone: phone || normalized });
  if (found.status === 'error') return found;
  if (!found.found) return { source: 'smshosting', status: 'not_found', phone: normalized };

  const contacts = Array.isArray(found.contacts) ? found.contacts : [];
  let deletedCount = 0;
  let failReasons = [];
  for (const c of contacts) {
    if (!c.id) continue;
    try {
      const out = await deletePhonebookContactById(auth, c.id);
      if (out.status === 'deleted') deletedCount += 1;
      else failReasons.push(out.reason || 'Delete non confermato');
    } catch (err) {
      failReasons.push(err.message);
    }
  }
  if (deletedCount > 0 && failReasons.length === 0) {
    return { source: 'smshosting', status: 'deleted', phone: normalized || found.phone, deletedContacts: deletedCount };
  }
  if (deletedCount > 0) {
    return {
      source: 'smshosting',
      status: 'found_not_deleted',
      phone: normalized || found.phone,
      reason: `Cancellazione parziale (${deletedCount}/${contacts.length})`
    };
  }

  const configuredDeleteUrl = String(process.env.SMSHOSTING_LIST_DELETE_URL || '').trim();
  const candidates = [];
  if (configuredDeleteUrl) candidates.push(configuredDeleteUrl);
  candidates.push(
    `${BASE_URL}/phonebook/contact/delete`,
    `${BASE_URL}/contacts/delete`,
    `${BASE_URL}/contact/delete`
  );
  for (const url of candidates) {
    try {
      const out = await tryDeleteWithEndpoint(url, auth, normalized || found.phone);
      if (out.status === 'deleted') return { source: 'smshosting', status: 'deleted', phone: normalized || found.phone };
    } catch (_) {}
  }

  return {
    source: 'smshosting',
    status: 'found_not_deleted',
    phone: normalized || found.phone,
    reason: failReasons[0] || 'Contatto trovato in rubrica ma delete non confermato'
  };
}

// Log configurazione alias all'avvio (visibile nei log Render)
if (process.env.NODE_ENV !== 'test') {
  const useAlias = process.env.SMSHOSTING_USE_ALIAS === 'true' || process.env.SMSHOSTING_USE_ALIAS === '1';
  const from = process.env.SMSHOSTING_FROM;
  console.log('[Smshosting] Mittente:', useAlias && from ? `alfanumerico (${from})` : 'numerico', '| USE_ALIAS=', process.env.SMSHOSTING_USE_ALIAS || '(vuoto)', '| FROM=', from ? 'impostato' : '(vuoto)');
}

module.exports = {
  sendSms,
  normalizePhone,
  phonebookMsisdnCandidates,
  findContactForPrivacy,
  deleteContactByPhoneForPrivacy
};
