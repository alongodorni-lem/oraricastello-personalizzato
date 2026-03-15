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

function parseTargetResourceIds(targetResourceId) {
  if (targetResourceId == null) return [];
  if (Array.isArray(targetResourceId)) {
    return targetResourceId
      .map((x) => parseInt(String(x).trim(), 10))
      .filter((n) => !isNaN(n) && n > 0);
  }
  const str = String(targetResourceId).trim();
  if (!str) return [];
  return str
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);
}

const RESERVATIONS_CACHE_TTL_MS = 5 * 60 * 1000;
let reservationsCache = null;
let reservationsCacheExpiry = 0;
const RESOURCES_CACHE_TTL_MS = 60 * 60 * 1000;
let resourcesCache = null;
let resourcesCacheExpiry = 0;
const TARGET_SEGMENT_CACHE_TTL_MS = 8 * 60 * 60 * 1000;
const targetSegmentCache = new Map();
let resourcesListCache = null;
let resourcesListCacheExpiry = 0;

/**
 * Carica tutte le prenotazioni CONFERMATE effettuate (data di prenotazione) negli ultimi N mesi.
 * Usa list_by_creation_date=true (data prenotazione) e required_status=4 (confermate).
 * @param {number} monthsLookback
 * @returns {Promise<Map<string, { reservations: Array, phone: string }>>}
 */
async function loadReservationsByEmail(monthsLookback = 18) {
  const cacheKey = String(monthsLookback);
  if (reservationsCache && reservationsCache.key === cacheKey && Date.now() < reservationsCacheExpiry) {
    return reservationsCache.data;
  }

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
      list_by_creation_date: true,
      required_status: 4,
      excluded_status: 8 | 16,
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
        byEmail.set(email, { reservations: [], phone: '', firstName: '', lastName: '' });
      }
      const entry = byEmail.get(email);
      entry.reservations.push({
        resource_id: resourceId,
        start_time: res.start_time,
        resource_name: res.resource_name || res.resource?.name || res.name
      });
      if (phone && !entry.phone) entry.phone = phone;
      if (res.first_name && typeof res.first_name === 'string') entry.firstName = res.first_name.trim();
      if (res.last_name && typeof res.last_name === 'string') entry.lastName = res.last_name.trim();
    }

    hasMore = reservations.length >= PAGE_SIZE;
    page++;
    if (page > 200) break;
  }

  console.log('[Planyo] Prenotazioni confermate (creation_date ultimi', monthsLookback, 'mesi):', byEmail.size, 'email,', [...byEmail.values()].reduce((s, e) => s + (e.reservations?.length || 0), 0), 'prenotazioni');

  reservationsCache = { key: cacheKey, data: byEmail };
  reservationsCacheExpiry = Date.now() + RESERVATIONS_CACHE_TTL_MS;
  return byEmail;
}

/**
 * Classifica un'email in lista A, B o C in base alle prenotazioni (legacy, usare buildListAAndB)
 */
function segmentEmail(reservationsByEmail, email, targetResourceId) {
  const entry = reservationsByEmail.get(email.toLowerCase().trim());
  const phone = entry?.phone || '';
  const firstName = entry?.firstName || '';
  const lastName = entry?.lastName || '';

  if (!entry || !entry.reservations.length) {
    return { segment: 'C', phone, firstName, lastName };
  }

  const resourceIds = entry.reservations.map((r) => Number(r.resource_id)).filter((id) => !isNaN(id));
  const targetIds = parseTargetResourceIds(targetResourceId);
  const hasTarget = targetIds.length > 0 && resourceIds.some((id) => targetIds.includes(id));
  const lastRes = entry.reservations[entry.reservations.length - 1];

  if (hasTarget) {
    return { segment: 'A', phone, lastResource: lastRes?.resource_name, firstName, lastName };
  }
  return { segment: 'B', phone, lastResource: lastRes?.resource_name, firstName, lastName };
}

/**
 * Converte start_time in Unix secondi (API Planyo: secondi o millisecondi).
 */
function toStartTimestamp(val) {
  if (val == null) return null;
  if (typeof val === 'number') return val > 1e12 ? Math.floor(val / 1000) : val;
  if (typeof val === 'string') {
    const ms = new Date(val).getTime();
    return isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  return null;
}

/**
 * Costruisce Lista A (prenotati evento target con data futura) e Lista B (altri eventi 18 mesi, esclusi A).
 * Lista A = chi ha prenotato evento target con start_date > oggi (escludiamo da promozione: hanno già prenotato).
 * Lista B = prenotazioni ultimi 18 mesi, esclusi chi è in Lista A.
 * @param {Map} reservationsByEmail - output loadReservationsByEmail(18)
 * @param {number|string|Array<number|string>|null} targetResourceId
 * @returns {{ listA: Array<{email, phone}>, listB: Array<{email, phone}>, emailsInA: Set<string> }}
 */
function buildListAAndB(reservationsByEmail, targetResourceId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStartTimestamp = Math.floor(today.getTime() / 1000);
  const targetIds = parseTargetResourceIds(targetResourceId);
  const hasTargetFilter = targetIds.length > 0;
  const listA = [];
  const listB = [];
  const emailsInA = new Set();

  for (const [email, entry] of reservationsByEmail) {
    const phone = entry?.phone || '';
    const reservations = entry?.reservations || [];

    const hasTargetFuture = hasTargetFilter && reservations.some((r) => {
      const resourceId = Number(r.resource_id);
      if (isNaN(resourceId) || !targetIds.includes(resourceId)) return false;
      const startSec = toStartTimestamp(r.start_time);
      return startSec != null && startSec >= todayStartTimestamp;
    });

    if (hasTargetFuture) {
      listA.push({ email, phone });
      emailsInA.add(email.toLowerCase());
    } else if (reservations.length > 0) {
      listB.push({ email, phone });
    }
  }

  return { listA, listB, emailsInA };
}

function collectResourceIds(value, out = new Set(), depth = 0) {
  if (!value || depth > 6) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectResourceIds(item, out, depth + 1);
    return out;
  }
  if (typeof value !== 'object') return out;

  const direct = [value.id, value.resource_id, value.resourceId, value.resourceid];
  for (const v of direct) {
    const n = parseInt(String(v || '').trim(), 10);
    if (!isNaN(n) && n > 0) out.add(n);
  }
  for (const k of Object.keys(value)) {
    // Alcune risposte Planyo usano l'ID risorsa come chiave oggetto.
    const keyNum = parseInt(String(k || '').trim(), 10);
    if (!isNaN(keyNum) && keyNum > 0) out.add(keyNum);
    collectResourceIds(value[k], out, depth + 1);
  }
  return out;
}

async function getPlanyoResourceIds() {
  if (resourcesCache && Date.now() < resourcesCacheExpiry) return resourcesCache;
  const siteId = process.env.PLANYO_SITE_ID || '8895';
  const data = await callPlanyoAPI('list_resources', { site_id: siteId, detail_level: 2 });
  const ids = [...collectResourceIds(data)];
  resourcesCache = ids;
  resourcesCacheExpiry = Date.now() + RESOURCES_CACHE_TTL_MS;
  return ids;
}

function parseBoolLike(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0 || v == null) return false;
  const s = String(v).trim().toLowerCase();
  if (!s) return false;
  if (['1', 'true', 'yes', 'y', 'si', 's'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return false;
}

function inferPublishedFlag(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const boolKeys = ['published', 'is_published', 'isPublished', 'active', 'enabled', 'visible'];
  for (const k of boolKeys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      return parseBoolLike(obj[k]);
    }
  }
  const status = String(obj.status || obj.resource_status || '').trim().toLowerCase();
  if (status) {
    if (['inactive', 'disabled', 'hidden', 'deleted', 'archived', 'draft'].includes(status)) return false;
    return true;
  }
  // Se il flag non esiste, assumiamo che l'elemento sia pubblicato
  // solo quando è una risorsa valida (id+nome) e arriva dal list_resources.
  return true;
}

function readResourceObject(obj, hintedId = null) {
  if (!obj || typeof obj !== 'object') return null;
  const idDirect = parseInt(String(obj.id ?? obj.resource_id ?? obj.resourceId ?? '').trim(), 10);
  const idHint = Number.isInteger(hintedId) && hintedId > 0 ? hintedId : NaN;
  const id = !isNaN(idDirect) && idDirect > 0 ? idDirect : idHint;
  const name = String(obj.name ?? obj.resource_name ?? obj.title ?? obj.label ?? '').trim();
  if (!id || !name) return null;
  return { id, name, published: inferPublishedFlag(obj) };
}

function collectResourceEntries(value, out = [], depth = 0) {
  if (!value || depth > 5) return out;
  if (Array.isArray(value)) {
    value.forEach((x) => collectResourceEntries(x, out, depth + 1));
    return out;
  }
  if (typeof value !== 'object') return out;

  const direct = readResourceObject(value);
  if (direct) out.push(direct);

  for (const k of Object.keys(value)) {
    const child = value[k];
    const keyNum = parseInt(String(k || '').trim(), 10);
    if (!isNaN(keyNum) && keyNum > 0 && child && typeof child === 'object' && !Array.isArray(child)) {
      const byKey = readResourceObject(child, keyNum);
      if (byKey) out.push(byKey);
    }
    // Visita solo sotto-oggetti/array, evitando stringhe annidate (orari/date).
    if (child && (Array.isArray(child) || typeof child === 'object')) {
      collectResourceEntries(child, out, depth + 1);
    }
  }
  return out;
}

async function getPublishedResources() {
  if (resourcesListCache && Date.now() < resourcesListCacheExpiry) {
    return resourcesListCache;
  }
  const siteId = process.env.PLANYO_SITE_ID || '8895';
  const data = await callPlanyoAPI('list_resources', { site_id: siteId, detail_level: 2 });
  const entries = collectResourceEntries(data);
  const byId = new Map();
  for (const r of entries) {
    const prev = byId.get(r.id);
    if (!prev) {
      byId.set(r.id, r);
      continue;
    }
    // Prefer record marked as published and with longer descriptive name.
    const better =
      (r.published && !prev.published) ||
      (r.published === prev.published && String(r.name || '').length > String(prev.name || '').length);
    if (better) byId.set(r.id, r);
  }
  const resources = [...byId.values()]
    .filter((r) => r.published)
    .map((r) => ({ id: r.id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
  resourcesListCache = resources;
  resourcesListCacheExpiry = Date.now() + RESOURCES_CACHE_TTL_MS;
  return resources;
}

async function validateTargetResourceIds(targetResourceId) {
  const ids = parseTargetResourceIds(targetResourceId);
  if (ids.length === 0) return { ok: false, missing: [], all: [] };
  let existing = new Set();
  try {
    existing = new Set(await getPlanyoResourceIds());
  } catch (_) {
    // fallback gestito sotto su prenotazioni cache/API
  }

  // Fallback robusto: se list_resources non restituisce gli ID attesi,
  // verifica anche gli ID risorsa presenti nelle prenotazioni confermate recenti.
  let reservationIds = new Set();
  try {
    const byEmail = await loadReservationsByEmail(18);
    for (const entry of byEmail.values()) {
      for (const r of (entry?.reservations || [])) {
        const n = Number(r.resource_id);
        if (!isNaN(n) && n > 0) reservationIds.add(n);
      }
    }
  } catch (_) {}

  const missing = ids.filter((id) => !existing.has(id) && !reservationIds.has(id));
  return { ok: missing.length === 0, missing, all: ids };
}

function getTargetSegmentCacheKey(targetResourceId, monthsLookback = 18) {
  const ids = parseTargetResourceIds(targetResourceId).sort((a, b) => a - b);
  return String(monthsLookback) + '|' + ids.join(',');
}

/**
 * Cache temporanea Lista A/B per sessione server.
 * Evita chiamate ripetute a API Planyo durante la stessa sessione di lavoro.
 */
async function getCachedListAAndB(targetResourceId, monthsLookback = 18) {
  const key = getTargetSegmentCacheKey(targetResourceId, monthsLookback);
  const now = Date.now();
  const cached = targetSegmentCache.get(key);
  if (cached && cached.expiresAt > now) {
    return {
      listA: [...cached.listA],
      listB: [...cached.listB],
      emailsInA: new Set(cached.emailsInA)
    };
  }
  const reservationsByEmail = await loadReservationsByEmail(monthsLookback);
  const { listA, listB, emailsInA } = buildListAAndB(reservationsByEmail, targetResourceId);
  targetSegmentCache.set(key, {
    expiresAt: now + TARGET_SEGMENT_CACHE_TTL_MS,
    listA: [...listA],
    listB: [...listB],
    emailsInA: [...emailsInA]
  });
  return { listA, listB, emailsInA };
}

module.exports = {
  callPlanyoAPI,
  loadReservationsByEmail,
  segmentEmail,
  buildListAAndB,
  validateTargetResourceIds,
  getPublishedResources,
  getCachedListAAndB,
  extractPhone,
  normalizePhone
};
