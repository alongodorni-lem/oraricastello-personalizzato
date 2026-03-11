/**
 * Smshosting API - invio SMS
 * https://help.smshosting.it/article/316-sms-http-api
 * https://api.smshosting.it/rest/api/sms/send
 */
const axios = require('axios');

const BASE_URL = 'https://api.smshosting.it/rest/api';

/**
 * Normalizza numero per SMS (Italia: 39xxxxxxxxxx)
 */
function normalizePhone(phone) {
  let p = (phone || '').replace(/\s/g, '');
  if (p.startsWith('+39')) p = '39' + p.slice(3);
  else if (p.startsWith('39') && p.length >= 11) p = p;
  else if (p.startsWith('0') && p.length >= 10) p = '39' + p;
  else if (p.length >= 9 && !p.startsWith('39')) p = '39' + p;
  return p.replace(/\D/g, '');
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
  if (phone.length < 10) {
    return { success: false, error: 'Numero telefono non valido' };
  }

  const bodyParams = new URLSearchParams({ to: phone, text: (text || '').slice(0, 480) });
  // Mittente: usa alias solo se SMSHOSTING_USE_ALIAS=true, altrimenti mittente numerico (default)
  const useAlias = process.env.SMSHOSTING_USE_ALIAS === 'true' || process.env.SMSHOSTING_USE_ALIAS === '1';
  const from = (options && (options.from === '' || options.from === false)) ? '' : (useAlias ? (options?.from || process.env.SMSHOSTING_FROM) : '');
  if (from) bodyParams.set('from', String(from).slice(0, 11));

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
      isDuplicate
    };
  } catch (err) {
    const msg = err.response?.data?.errorMsg || err.response?.data?.message || err.message;
    return { success: false, error: msg, isDuplicate: false };
  }
}

module.exports = { sendSms, normalizePhone };
