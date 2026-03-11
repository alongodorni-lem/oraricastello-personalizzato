/**
 * Planyo API client - prenotazioni per segmentazione
 * https://www.planyo.com/rest/
 */
const axios = require('axios');

const PLANYO_API_URL = 'https://www.planyo.com/rest/';

async function callPlanyoAPI(method, params = {}) {
  const apiKey = process.env.PLANYO_API_KEY;
  if (!apiKey) throw new Error('PLANYO_API_KEY non configurata');

  const requestParams = { method, api_key: apiKey, ...params };

  const response = await axios.get(PLANYO_API_URL, {
    params: requestParams,
    timeout: 60000
  });

  if (response.data.response_code !== 0) {
    const msg = response.data.response_message || response.data.user_text || 'Planyo API error';
    const err = new Error(typeof msg === 'string' ? msg : 'Planyo API error');
    err.planyoCode = response.data.response_code;
    throw err;
  }

  return response.data;
}

/**
 * Estrae telefono da prenotazione Planyo
 */
function extractPhone(res) {
  const top = (res.mobile_number || res.phone_number || res.user_mobile || res.phone || res.mobile || '').toString().trim();
  if (top) return normalizePhone(top);

  const props = res.properties || res.custom_properties;
  if (!props || typeof props !== 'object') return '';

  const toStr = (v) => {
    const x = (v && typeof v === 'object') ? (v.value ?? v.text ?? v.phone ?? '') : v;
    return (x || '').toString().trim();
  };
  const phoneLike = /(mobile|phone|telefono|cellulare|tel|num)/i;
  if (Array.isArray(props)) {
    for (const item of props) {
      if (item && phoneLike.test(String(item.name || item.key || ''))) {
        const found = toStr(item.value ?? item.text);
        if (found && /[\d\s\+\-\(\)]{6,}/.test(found)) return normalizePhone(found);
      }
    }
  } else {
    for (const k of Object.keys(props)) {
      if (phoneLike.test(k)) {
        const found = toStr(props[k]);
        if (found && /[\d\s\+\-\(\)]{6,}/.test(found)) return normalizePhone(found);
      }
    }
  }
  return '';
}

function normalizePhone(phone) {
  let p = (phone || '').replace(/\s/g, '');
  if (p.startsWith('+39')) p = '39' + p.slice(3);
  else if (p.startsWith('39') && p.length >= 11) p = p;
  else if (p.startsWith('0') && p.length >= 10) p = '39' + p;
  else if (p.length >= 9 && !p.startsWith('39')) p = '39' + p;
  return p.replace(/\D/g, '').length >= 9 ? p : '';
}

/**
 * Carica tutte le prenotazioni negli ultimi N mesi e le indicizza per email
 * @param {number} monthsLookback
 * @returns {Promise<Map<string, { reservations: Array, phone: string }>>}
 */
async function loadReservationsByEmail(monthsLookback = 18) {
  const siteId = process.env.PLANYO_SITE_ID || '8895';
  const now = new Date();
  const startDate = new Date(now);
  startDate.setMonth(startDate.getMonth() - monthsLookback);

  const startTime = Math.floor(startDate.getTime() / 1000);
  const endTime = Math.floor(now.getTime() / 1000);

  const byEmail = new Map();
  const PAGE_SIZE = 500;
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await callPlanyoAPI('list_reservations', {
      site_id: siteId,
      start_time: startTime,
      end_time: endTime,
      detail_level: 4,
      include_deleted: false,
      limit: PAGE_SIZE,
      page
    });

    const reservations = data.results || data.data?.results || data.data?.reservations || [];
    for (const res of reservations) {
      const email = (res.email || res.user_email || '').toLowerCase().trim();
      if (!email) continue;

      const phone = extractPhone(res);
      const resourceId = res.resource_id || res.resource?.id;

      if (!byEmail.has(email)) {
        byEmail.set(email, { reservations: [], phone: '' });
      }
      const entry = byEmail.get(email);
      entry.reservations.push({
        resource_id: resourceId,
        start_time: res.start_time,
        resource_name: res.resource_name || res.resource?.name
      });
      if (phone && !entry.phone) entry.phone = phone;
    }

    hasMore = reservations.length >= PAGE_SIZE;
    page++;
    if (page > 200) break;
  }

  return byEmail;
}

/**
 * Classifica un'email in lista A, B o C in base alle prenotazioni
 * @param {Map} reservationsByEmail - output di loadReservationsByEmail
 * @param {string} email
 * @param {number} targetResourceId
 * @returns {{ segment: 'A'|'B'|'C', phone: string, lastResource?: string }}
 */
function segmentEmail(reservationsByEmail, email, targetResourceId) {
  const entry = reservationsByEmail.get(email.toLowerCase().trim());
  const phone = entry?.phone || '';

  if (!entry || !entry.reservations.length) {
    return { segment: 'C', phone };
  }

  const resourceIds = entry.reservations.map((r) => r.resource_id).filter(Boolean);
  const hasTarget = resourceIds.includes(Number(targetResourceId)) || resourceIds.includes(String(targetResourceId));
  const lastRes = entry.reservations[entry.reservations.length - 1];

  if (hasTarget) {
    return { segment: 'A', phone, lastResource: lastRes?.resource_name };
  }
  return { segment: 'B', phone, lastResource: lastRes?.resource_name };
}

module.exports = {
  callPlanyoAPI,
  loadReservationsByEmail,
  segmentEmail,
  extractPhone,
  normalizePhone
};
