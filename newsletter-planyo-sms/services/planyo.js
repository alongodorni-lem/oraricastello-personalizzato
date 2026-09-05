/**
 * Planyo API client - prenotazioni per segmentazione
 * https://www.planyo.com/rest/
 */
const axios = require('axios');

const PLANYO_API_URL = 'https://www.planyo.com/rest/';

async function callPlanyoAPI(method, params = {}, options = {}) {
  const apiKey = process.env.PLANYO_API_KEY;
  if (!apiKey) throw new Error('PLANYO_API_KEY non configurata');

  const requestParams = { method, api_key: apiKey, ...params };
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 60000);

  const response = await axios.get(PLANYO_API_URL, {
    params: requestParams,
    timeout: timeoutMs
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

function extractCity(res) {
  const direct = (res.city || res.town || res.user_city || '').toString().trim();
  if (direct) return direct;
  const props = res.properties || res.custom_properties;
  if (!props || typeof props !== 'object') return '';
  const cityLike = /(city|town|citta|città|comune)/i;
  const toStr = (v) => {
    const x = (v && typeof v === 'object') ? (v.value ?? v.text ?? '') : v;
    return (x || '').toString().trim();
  };
  if (Array.isArray(props)) {
    for (const item of props) {
      if (item && cityLike.test(String(item.name || item.key || ''))) {
        const val = toStr(item.value ?? item.text);
        if (val) return val;
      }
    }
  } else {
    for (const k of Object.keys(props)) {
      if (!cityLike.test(k)) continue;
      const val = toStr(props[k]);
      if (val) return val;
    }
  }
  return '';
}

function normalizePhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  while (digits.startsWith('00')) digits = digits.slice(2);
  while (digits.startsWith('3939')) digits = '39' + digits.slice(4);
  if (!digits) return '';

  if (/^393\d{9}$/.test(digits)) return digits;
  if (/^3\d{9}$/.test(digits)) return '39' + digits;
  const tail = digits.match(/3\d{9}$/);
  return tail ? ('39' + tail[0]) : '';
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

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

function extractPlanyoCollection(payload, ...keys) {
  if (!payload) return [];
  const nodes = [payload, payload.data];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    for (const key of keys) {
      if (Array.isArray(node[key])) return node[key];
    }
  }
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

function phonesLikelyMatch(a, b) {
  const left = normalizePhone(a) || String(a || '').replace(/\D/g, '');
  const right = normalizePhone(b) || String(b || '').replace(/\D/g, '');
  if (!left || !right) return false;
  if (left === right) return true;
  return left.slice(-9) === right.slice(-9);
}

function nationalMobileFromPhone(phone) {
  const normalized = normalizePhone(phone);
  if (/^393\d{9}$/.test(normalized)) return normalized.slice(2);
  const digits = String(phone || '').replace(/\D/g, '');
  if (/^3\d{9}$/.test(digits)) return digits;
  const tail = digits.match(/3\d{9}$/);
  return tail ? tail[0] : '';
}

function uniqueEmails(values) {
  const out = [];
  for (const value of values || []) {
    const email = normalizeEmail(value);
    if (email && email.includes('@') && !out.includes(email)) out.push(email);
  }
  return out;
}

function uniquePositiveIds(values) {
  const out = [];
  for (const value of values || []) {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

function userRecordPhoneMatches(user, phone) {
  if (!user || typeof user !== 'object') return false;
  const candidates = [
    user.mobile_number,
    user.phone_number,
    user.phone,
    user.mobile
  ];
  if (user.mobile_country_code && user.mobile_number) {
    candidates.push(String(user.mobile_country_code) + String(user.mobile_number));
  }
  if (user.phone_country_code && user.phone_number) {
    candidates.push(String(user.phone_country_code) + String(user.phone_number));
  }
  return candidates.some((value) => value && phonesLikelyMatch(value, phone));
}

function isTransientLookupError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    msg.includes('network')
  );
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
      const city = extractCity(res);
      const resourceId = res.resource_id || res.resource?.id;

      if (!byEmail.has(email)) {
        byEmail.set(email, { reservations: [], phone: '', firstName: '', lastName: '', city: '' });
      }
      const entry = byEmail.get(email);
      entry.reservations.push({
        reservation_id: res.reservation_id || res.id || null,
        user_id: res.user_id != null ? Number(res.user_id) : null,
        resource_id: resourceId,
        start_time: res.start_time,
        resource_name: res.resource_name || res.resource?.name || res.name,
        status: res.status ?? 4,
        city: city || ''
      });
      if (phone && !entry.phone) entry.phone = phone;
      if (res.first_name && typeof res.first_name === 'string') entry.firstName = res.first_name.trim();
      if (res.last_name && typeof res.last_name === 'string') entry.lastName = res.last_name.trim();
      if (city && !entry.city) entry.city = city;
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
  const first = await callPlanyoAPI('list_resources', { site_id: siteId, detail_level: 2, page: 1 });
  const idsSet = collectResourceIds(first, new Set());
  const maxPageRaw = Number(first?.data?.max_page || first?.max_page || 1);
  const maxPage = Number.isFinite(maxPageRaw) && maxPageRaw > 1 ? Math.min(maxPageRaw, 20) : 1;
  for (let page = 2; page <= maxPage; page++) {
    const next = await callPlanyoAPI('list_resources', { site_id: siteId, detail_level: 2, page });
    collectResourceIds(next, idsSet);
  }
  const ids = [...idsSet];
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
  const pickFlag = (keys) => {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        return parseBoolLike(obj[k]);
      }
    }
    return null;
  };

  // Fonte primaria: usare solo il flag "published" quando presente.
  const publishedRawKeys = ['published', 'is_published', 'isPublished'];
  const hasPublishedField = publishedRawKeys.some((k) => Object.prototype.hasOwnProperty.call(obj, k));
  if (hasPublishedField) {
    return pickFlag(publishedRawKeys) === true;
  }

  // Fallback: is_listed solo se published non è presente.
  const listedFlag = pickFlag(['is_listed', 'listed']);
  if (listedFlag !== null) {
    return listedFlag;
  }

  const visibilityFlag = pickFlag(['active', 'enabled', 'visible']);
  if (visibilityFlag !== null) {
    return visibilityFlag;
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

function cleanResourceName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim();
}

function looksLikeRealResourceName(name) {
  const n = cleanResourceName(name);
  if (!n) return false;
  // Esclude stringhe che sembrano solo slot orari separati da virgole.
  const noSpaces = n.replace(/\s+/g, '');
  if (/^(\d{1,2}:\d{2},?)+$/.test(noSpaces)) return false;
  return true;
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

async function fetchPublishedResourcesFromPublicPage(siteId) {
  const endpoint = 'https://www.planyo.com/rest/ulap-jsonp.php';
  const language = (process.env.PLANYO_LANGUAGE || 'IT').toUpperCase();
  const { data } = await axios.get(endpoint, {
    params: {
      ulap_url: 'https://www.planyo.com/rest/planyo-reservations.php',
      mode: 'display_resource_list_code',
      site_id: siteId,
      language,
      sort: 'name',
      tz_offset: 0,
      html_mode: 1,
      modver: '2.7'
    },
    responseType: 'text',
    timeout: 30000
  });

  const raw = String(data || '').trim();
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return [];

  let payload = null;
  try {
    payload = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
  } catch (_) {
    return [];
  }

  const html = String(payload?.html || '');
  if (!html) return [];

  const out = [];
  const seen = new Set();
  const re = /about-resource\.php\?[^"'<>]*resource_id=(\d+)[^"'<>]*">([^<]+)</gi;
  let m = null;
  while ((m = re.exec(html))) {
    const id = Number(m[1]);
    const name = cleanResourceName(decodeHtmlEntities(m[2]));
    if (!Number.isInteger(id) || id <= 0) continue;
    if (!looksLikeRealResourceName(name)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
}

function extractResourcesMap(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const fromData = payload?.data?.resources;
  if (fromData && typeof fromData === 'object') return fromData;
  const direct = payload?.resources;
  if (direct && typeof direct === 'object') return direct;
  return {};
}

function normalizeResourcesFromMap(resourcesMap) {
  const out = [];
  for (const [idKey, raw] of Object.entries(resourcesMap || {})) {
    if (!raw || typeof raw !== 'object') continue;
    const id = parseInt(String(raw.id ?? idKey).trim(), 10);
    const name = cleanResourceName(raw.name ?? raw.resource_name ?? raw.title ?? raw.label ?? '');
    if (!Number.isInteger(id) || id <= 0) continue;
    if (!looksLikeRealResourceName(name)) continue;
    out.push({
      id,
      name,
      published: inferPublishedFlag(raw)
    });
  }
  return out;
}

async function fetchResourcesFromApi(siteId) {
  const first = await callPlanyoAPI('list_resources', { site_id: siteId, detail_level: 2, page: 1 });
  const firstMap = extractResourcesMap(first);
  const all = normalizeResourcesFromMap(firstMap);

  const maxPageRaw = Number(first?.data?.max_page || first?.max_page || 1);
  const maxPage = Number.isFinite(maxPageRaw) && maxPageRaw > 1 ? Math.min(maxPageRaw, 20) : 1;

  for (let page = 2; page <= maxPage; page++) {
    const next = await callPlanyoAPI('list_resources', { site_id: siteId, detail_level: 2, page });
    const nextMap = extractResourcesMap(next);
    all.push(...normalizeResourcesFromMap(nextMap));
  }
  return all;
}

async function getPublishedResources() {
  if (resourcesListCache && Date.now() < resourcesListCacheExpiry) {
    return resourcesListCache;
  }
  const siteId = process.env.PLANYO_SITE_ID || '8895';
  try {
    const publishedFromPage = await fetchPublishedResourcesFromPublicPage(siteId);
    if (publishedFromPage.length > 0) {
      resourcesListCache = publishedFromPage;
      resourcesListCacheExpiry = Date.now() + RESOURCES_CACHE_TTL_MS;
      return publishedFromPage;
    }
  } catch (_) {
    // Fallback sotto: list_resources API.
  }

  const entries = await fetchResourcesFromApi(siteId);
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
    .map((r) => ({ id: r.id, name: cleanResourceName(r.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));

  resourcesListCache = resources.filter((r) => looksLikeRealResourceName(r.name));
  // Evita di "congelare" una lista vuota per un'ora quando Planyo cambia struttura/stati.
  resourcesListCacheExpiry = Date.now() + (resourcesListCache.length > 0 ? RESOURCES_CACHE_TTL_MS : 60 * 1000);
  return resourcesListCache;
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

async function findContactByEmail(email, monthsLookback = 18) {
  const normEmail = normalizeEmail(email);
  if (!normEmail || !normEmail.includes('@')) return { source: 'planyo', status: 'not_found', found: false };
  const siteId = process.env.PLANYO_SITE_ID || '8895';

  // 1) Fast path: cache prenotazioni usata dal modulo (ultimi 18 mesi, confermate)
  const byEmail = await loadReservationsByEmail(monthsLookback);
  const entry = byEmail.get(normEmail);
  if (entry) {
    return {
      source: 'planyo',
      status: 'found',
      found: true,
      email: normEmail,
      foundVia: 'reservations_lookback',
      reservations: entry.reservations || []
    };
  }

  // 2) Lookup diretto storico prenotazioni per email (anche passate/cancellate/deleted)
  // list_reservations restituisce al massimo 500 risultati per pagina: paginiamo tutte le pagine.
  try {
    const startTime = Math.floor(new Date('2000-01-01T00:00:00Z').getTime() / 1000);
    const endTime = Math.floor(new Date('2100-01-01T00:00:00Z').getTime() / 1000);
    const rows = [];
    const maxPages = 50;
    for (let page = 0; page < maxPages; page++) {
      const historical = await callPlanyoAPI('list_reservations', {
        site_id: siteId,
        start_time: startTime,
        end_time: endTime,
        user_email: normEmail,
        detail_level: 1,
        page,
        include_deleted: true
      }, { timeoutMs: 90000 });
      const chunk = Array.isArray(historical?.results)
        ? historical.results
        : (Array.isArray(historical?.data?.results) ? historical.data.results : []);
      rows.push(...chunk);
      if (chunk.length < 500) break;
    }
    if (rows.length > 0) {
      return {
        source: 'planyo',
        status: 'found',
        found: true,
        email: normEmail,
        foundVia: 'list_reservations_user_email',
        reservations: rows.map((r) => ({
          reservation_id: r.reservation_id || r.id || null,
          user_id: r.user_id != null ? Number(r.user_id) : null,
          resource_id: r.resource_id || r.resource?.id || null,
          start_time: r.start_time || null,
          status: r.status != null ? r.status : null,
          resource_name: r.resource_name || r.name || r.resource?.name || ''
        }))
      };
    }
  } catch (_) {
    // fallback sotto: list_users
  }

  // 3) Privacy lookup globale utenti Planyo (menu "Clienti")
  // list_users permette filtro email e include anche casi non coperti dal lookback.
  try {
    const queryCandidates = [normEmail, `${normEmail}*`];
    const listUsersModes = [
      // Default: utenti con almeno una prenotazione (caso più comune)
      { list_unconfirmed: true },
      // Modalità alternativa: utenti creati da admin/API
      { list_unconfirmed: true, list_created_by_admin: true }
    ];
    for (const queryEmail of queryCandidates) {
      for (const mode of listUsersModes) {
        let data = null;
        let lastErr = null;
        const startedAt = Date.now();
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            data = await callPlanyoAPI('list_users', {
              site_id: siteId,
              email: queryEmail,
              detail_level: 1,
              page: 0,
              page_size: 1000,
              ...mode
            }, { timeoutMs: 90000 });
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            if (attempt >= 2 || !isTransientLookupError(err)) break;
            await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
          }
        }
        if (lastErr) throw lastErr;
        const users = extractPlanyoCollection(data, 'users', 'results');
        const elapsed = Date.now() - startedAt;
        const modeLabel = mode.list_created_by_admin ? 'admin_users' : 'reservation_users';
        console.log('[Planyo][Privacy] list_users lookup', queryEmail === normEmail ? 'exact' : 'wildcard', modeLabel, 'users:', users.length, 'elapsed_ms:', elapsed);
        if (users.length > 0) {
          const u0 = users[0];
          const rawUid = u0 && typeof u0 === 'object' && !Array.isArray(u0)
            ? (u0.id ?? u0.user_id)
            : null;
          const planyoUserId = Number(rawUid);
          return {
            source: 'planyo',
            status: 'found',
            found: true,
            email: normEmail,
            foundVia: `${queryEmail === normEmail ? 'list_users_exact' : 'list_users_wildcard'}_${modeLabel}`,
            planyoUserId: Number.isInteger(planyoUserId) && planyoUserId > 0 ? planyoUserId : undefined,
            reservations: []
          };
        }
      }
    }
  } catch (_) {
    // fallback sotto: not_found
  }

  return { source: 'planyo', status: 'not_found', found: false };
}

function mapReservationSearchRow(row) {
  return {
    reservation_id: row?.rental_id || row?.reservation_id || row?.id || null,
    user_id: row?.user_id != null ? Number(row.user_id) : null,
    resource_id: row?.resource_id || row?.resource?.id || null,
    start_time: row?.start_time || null,
    status: row?.status != null ? row.status : null,
    resource_name: row?.name || row?.resource_name || row?.resource?.name || '',
    email: normalizeEmail(row?.email),
    phone: extractPhone(row) || normalizePhone(row?.mobile_number || row?.phone || '')
  };
}

function buildPhoneMatchResult(phone, matches, foundVia) {
  const national = nationalMobileFromPhone(phone);
  const emails = uniqueEmails(matches.map((m) => m.email));
  const userIds = uniquePositiveIds(matches.map((m) => m.planyoUserId || m.user_id));
  const reservations = matches.flatMap((m) => m.reservations || []);
  const sorted = matches.slice().sort((a, b) => (
    String(b.lastReservation || b.start_time || '').localeCompare(String(a.lastReservation || a.start_time || ''))
  ));
  const primary = sorted[0] || {};
  return {
    source: 'planyo',
    status: 'found',
    found: true,
    email: primary.email || emails[0] || '',
    emails,
    phone: normalizePhone(primary.phone || phone) || national,
    foundVia,
    planyoUserId: primary.planyoUserId || userIds[0],
    planyoUserIds: userIds,
    reservations,
    reason: 'Trovato per cellulare' + (national ? (' (' + national + ')') : '') + (emails.length > 1 ? (' - ' + emails.length + ' anagrafiche') : '')
  };
}

async function findUsersByMobile(siteId, national) {
  const filters = [
    { mobile_number: national },
    { mobile_number: national, mobile_country_code: '39' },
    { phone_number: national },
    { phone_number: national, phone_country_code: '39' }
  ];
  const modes = [
    { list_unconfirmed: true },
    { list_unconfirmed: true, list_created_by_admin: true }
  ];
  const matches = [];
  const seen = new Set();
  for (const filter of filters) {
    for (const mode of modes) {
      try {
        const data = await callPlanyoAPI('list_users', {
          site_id: siteId,
          detail_level: 1,
          page: 0,
          page_size: 1000,
          ...filter,
          ...mode
        }, { timeoutMs: 60000 });
        const users = extractPlanyoCollection(data, 'users', 'results');
        for (const user of users) {
          if (!userRecordPhoneMatches(user, national) && users.length > 8) continue;
          if (!userRecordPhoneMatches(user, national) && (user.mobile_number || user.phone_number)) continue;
          const email = normalizeEmail(user.email);
          const userId = Number(user.id ?? user.user_id);
          const key = String(userId || email);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          matches.push({
            email,
            planyoUserId: Number.isInteger(userId) && userId > 0 ? userId : undefined,
            phone: normalizePhone(user.mobile_number || user.phone_number || ''),
            lastReservation: user.last_reservation || '',
            reservations: []
          });
        }
        if (matches.length) return matches;
      } catch (_) {}
    }
  }
  return matches;
}

async function findContactByPhone(phone, monthsLookback = 18) {
  const national = nationalMobileFromPhone(phone);
  const normalized = normalizePhone(phone);
  if (!national && !normalized) {
    return { source: 'planyo', status: 'not_found', found: false, reason: 'Cellulare non valido' };
  }
  const siteId = process.env.PLANYO_SITE_ID || '8895';
  void monthsLookback;

  if (reservationsCache?.data) {
    const cacheMatches = [];
    for (const [email, entry] of reservationsCache.data.entries()) {
      if (!phonesLikelyMatch(entry?.phone, phone)) continue;
      cacheMatches.push({
        email,
        phone: entry.phone,
        planyoUserId: uniquePositiveIds((entry.reservations || []).map((r) => r.user_id))[0],
        reservations: entry.reservations || [],
        lastReservation: (entry.reservations || []).map((r) => r.start_time || '').sort().slice(-1)[0] || ''
      });
    }
    if (cacheMatches.length) return buildPhoneMatchResult(phone, cacheMatches, 'reservations_lookback');
  }

  const users = await findUsersByMobile(siteId, national || normalized);
  if (users.length) {
    console.log('[Planyo][Privacy] list_users cellulare users:', users.length);
    return buildPhoneMatchResult(phone, users, 'list_users_mobile');
  }

  try {
    const queries = [];
    if (national) queries.push(national, '+39' + national, '39' + national);
    if (normalized && !queries.includes(normalized)) queries.push(normalized);
    for (const query of queries) {
      const data = await callPlanyoAPI('reservation_search', {
        site_id: siteId,
        query
      }, { timeoutMs: 60000 });
      const rows = extractPlanyoCollection(data, 'results').filter((row) => (
        phonesLikelyMatch(row?.mobile_number || row?.phone || extractPhone(row), phone)
      ));
      if (!rows.length) continue;
      const grouped = new Map();
      for (const row of rows) {
        const mapped = mapReservationSearchRow(row);
        const key = String(mapped.user_id || mapped.email || mapped.reservation_id);
        if (!grouped.has(key)) {
          grouped.set(key, {
            email: mapped.email,
            planyoUserId: mapped.user_id,
            phone: mapped.phone,
            lastReservation: mapped.start_time || '',
            reservations: []
          });
        }
        grouped.get(key).reservations.push(mapped);
        if (mapped.start_time && mapped.start_time > grouped.get(key).lastReservation) {
          grouped.get(key).lastReservation = mapped.start_time;
        }
      }
      const matches = [...grouped.values()];
      if (matches.length) {
        console.log('[Planyo][Privacy] reservation_search cellulare matches:', matches.length);
        return buildPhoneMatchResult(phone, matches, 'reservation_search');
      }
    }
  } catch (_) {}

  return { source: 'planyo', status: 'not_found', found: false };
}

async function findContactForPrivacy({ email, phone } = {}, monthsLookback = 18) {
  const normEmail = normalizeEmail(email);
  const hasEmail = !!(normEmail && normEmail.includes('@'));
  const hasPhone = !!(normalizePhone(phone) || nationalMobileFromPhone(phone));
  if (!hasEmail && !hasPhone) {
    return { source: 'planyo', status: 'not_found', found: false, reason: 'Email o cellulare richiesti' };
  }
  if (hasEmail) {
    const byEmail = await findContactByEmail(normEmail, monthsLookback);
    if (byEmail.found) return byEmail;
  }
  if (hasPhone) return findContactByPhone(phone, monthsLookback);
  return { source: 'planyo', status: 'not_found', found: false };
}

/**
 * Estrae user_id Planyo dal risultato findContactByEmail (prenotazioni o list_users).
 */
function extractPlanyoUserIdFromFound(found) {
  if (!found || !found.found) return null;
  const direct = Number(found.planyoUserId);
  if (Number.isInteger(direct) && direct > 0) return direct;
  for (const r of found.reservations || []) {
    const uid = Number(r?.user_id);
    if (Number.isInteger(uid) && uid > 0) return uid;
  }
  return null;
}

/**
 * Metodo ufficiale Planyo per eliminare un cliente dall'anagrafica (vedi API remove_user).
 * Consentito solo se non ha prenotazioni attive o solo prenotazioni cancellate sul sito.
 */
async function tryRemovePlanyoUser(siteId, userId) {
  await callPlanyoAPI('remove_user', { site_id: siteId, user_id: userId });
  return true;
}

/**
 * Per richieste privacy: dopo remove_user fallito, si possono eliminare le prenotazioni note
 * e ritentare remove_user. Disabilitabile con PLANYO_PRIVACY_SKIP_RESERVATION_DELETE=true.
 */
function privacyAllowsReservationCascade() {
  return String(process.env.PLANYO_PRIVACY_SKIP_RESERVATION_DELETE || '').toLowerCase() !== 'true';
}

/** Legacy: forzare solo remove_user senza toccare prenotazioni (opzionale) */
function privacyLegacyReservationDeleteFlag() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.PLANYO_PRIVACY_ALLOW_RESERVATION_DELETE || '').toLowerCase());
}

async function deleteContactByEmailForPrivacy(email, monthsLookback = 18) {
  if (!process.env.PLANYO_API_KEY) return { source: 'planyo', status: 'error', reason: 'PLANYO_API_KEY non configurata' };
  const found = await findContactByEmail(email, monthsLookback);
  if (!found.found) return { source: 'planyo', status: 'not_found' };

  const siteId = process.env.PLANYO_SITE_ID || '8895';
  const normEmail = normalizeEmail(email);
  const userId = extractPlanyoUserIdFromFound(found);

  // Tentativi legacy / non documentati (alcuni siti potrebbero avere estensioni)
  const customerDeleteMethods = ['delete_customer_data', 'delete_customer'];
  for (const method of customerDeleteMethods) {
    try {
      await callPlanyoAPI(method, { site_id: siteId, email: normEmail });
      return { source: 'planyo', status: 'deleted', method };
    } catch (_) {}
  }

  // Metodo ufficiale documentato: remove_user (richiede user_id)
  if (userId) {
    try {
      await tryRemovePlanyoUser(siteId, userId);
      return { source: 'planyo', status: 'deleted', method: 'remove_user', userId };
    } catch (err) {
      console.warn('[Planyo][Privacy] remove_user fallito (user_id=' + userId + '):', err.message);
    }
  }

  const reservationIds = [...new Set((found.reservations || [])
    .map((r) => Number(r?.reservation_id || 0))
    .filter((n) => Number.isInteger(n) && n > 0))];

  const allowCascade = privacyAllowsReservationCascade() || privacyLegacyReservationDeleteFlag();

  if (!allowCascade) {
    const hint = userId
      ? 'Planyo: remove_user non riuscito (es. prenotazioni attive). Imposta PLANYO_PRIVACY_SKIP_RESERVATION_DELETE=false (default) per eliminare prenotazioni note e ritentare, oppure PLANYO_PRIVACY_ALLOW_RESERVATION_DELETE=true.'
      : 'Planyo: nessun user_id disponibile per remove_user; verifica che le prenotazioni restituiscano user_id.';
    return {
      source: 'planyo',
      status: 'found_not_deleted',
      reason: hint
    };
  }

  if (reservationIds.length === 0) {
    return {
      source: 'planyo',
      status: 'found_not_deleted',
      reason: userId
        ? 'remove_user non riuscito e nessun reservation_id da elaborare'
        : 'Nessun user_id né reservation_id disponibili per la cancellazione Planyo'
    };
  }

  /**
   * remove_user richiede che le prenotazioni risultino "cancellate" (non basta un metodo inesistente cancel_reservation).
   * API ufficiale: do_reservation_action con action=Cancel (admin).
   */
  let cancelledOk = 0;
  let cancelledFail = 0;
  for (const reservationId of reservationIds) {
    try {
      await callPlanyoAPI(
        'do_reservation_action',
        {
          site_id: siteId,
          reservation_id: reservationId,
          action: 'Cancel',
          is_quiet: true
        },
        { timeoutMs: 60000 }
      );
      cancelledOk++;
    } catch (_) {
      cancelledFail++;
    }
  }

  if (userId) {
    try {
      await tryRemovePlanyoUser(siteId, userId);
      return {
        source: 'planyo',
        status: 'deleted',
        method: 'remove_user_after_cancel',
        userId,
        cancelledReservations: cancelledOk,
        failedCancelReservations: cancelledFail
      };
    } catch (err) {
      console.warn('[Planyo][Privacy] remove_user dopo Cancel fallito:', err.message);
    }
  }

  // Fallback: eliminazione definitiva prenotazioni (documentata), poi ritenta remove_user
  let deleted = 0;
  let failed = 0;
  for (const reservationId of reservationIds) {
    try {
      await callPlanyoAPI('delete_reservation', { site_id: siteId, reservation_id: reservationId }, { timeoutMs: 60000 });
      deleted++;
    } catch (_) {
      failed++;
    }
  }

  if (userId) {
    try {
      await tryRemovePlanyoUser(siteId, userId);
      return {
        source: 'planyo',
        status: 'deleted',
        method: 'remove_user_after_delete_reservation',
        userId,
        cancelledReservations: cancelledOk,
        deletedReservations: deleted,
        failedDeleteReservations: failed
      };
    } catch (err) {
      console.warn('[Planyo][Privacy] remove_user dopo delete_reservation fallito:', err.message);
      const parts = [
        `Cancel admin: ${cancelledOk} ok, ${cancelledFail} no`,
        `delete_reservation: ${deleted} ok, ${failed} no`
      ].join(' | ');
      return {
        source: 'planyo',
        status: 'found_not_deleted',
        reason: `${parts}. remove_user: ${err.message}`,
        cancelledReservations: cancelledOk,
        deletedReservations: deleted,
        failedCancelReservations: cancelledFail,
        failedDeleteReservations: failed
      };
    }
  }

  if (deleted > 0 && failed === 0) {
    return { source: 'planyo', status: 'deleted', deletedReservations: deleted, method: 'delete_reservation_only' };
  }
  if (deleted > 0) {
    return { source: 'planyo', status: 'found_not_deleted', reason: `delete_reservation: ${deleted} ok, ${failed} no (nessun user_id per remove_user)` };
  }
  return {
    source: 'planyo',
    status: 'found_not_deleted',
    reason: `Impossibile elaborare prenotazioni (Cancel: ${cancelledOk}/${cancelledFail + cancelledOk}, delete: fallito)`
  };
}

async function deleteContactForPrivacy({ email, phone } = {}, monthsLookback = 18) {
  if (!process.env.PLANYO_API_KEY) return { source: 'planyo', status: 'error', reason: 'PLANYO_API_KEY non configurata' };
  const found = await findContactForPrivacy({ email, phone }, monthsLookback);
  if (!found.found) return { source: 'planyo', status: 'not_found' };

  const emails = uniqueEmails([found.email, ...(found.emails || []), email]);
  let lastFail = '';
  if (emails.length) {
    let deleted = 0;
    let foundNotDeleted = 0;
    let lastDeleted = null;
    for (const itemEmail of emails) {
      const out = await deleteContactByEmailForPrivacy(itemEmail, monthsLookback);
      if (out.status === 'deleted') {
        deleted += 1;
        lastDeleted = out;
      } else if (out.status === 'found_not_deleted') {
        foundNotDeleted += 1;
        lastFail = out.reason || lastFail;
      }
    }
    if (deleted > 0 && foundNotDeleted === 0) {
      return lastDeleted || { source: 'planyo', status: 'deleted' };
    }
    if (deleted > 0) {
      return {
        source: 'planyo',
        status: 'found_not_deleted',
        reason: `Cancellazione parziale Planyo (${deleted}/${emails.length})` + (lastFail ? (': ' + lastFail) : '')
      };
    }
    if (foundNotDeleted > 0) {
      return { source: 'planyo', status: 'found_not_deleted', reason: lastFail || 'Contatto trovato ma non cancellato' };
    }
  }

  const userIds = uniquePositiveIds([found.planyoUserId, ...(found.planyoUserIds || [])]);
  const siteId = process.env.PLANYO_SITE_ID || '8895';
  for (const userId of userIds) {
    try {
      await tryRemovePlanyoUser(siteId, userId);
      return { source: 'planyo', status: 'deleted', method: 'remove_user', userId };
    } catch (err) {
      lastFail = err.message;
    }
  }
  return {
    source: 'planyo',
    status: 'found_not_deleted',
    reason: lastFail || 'Contatto trovato in Planyo ma delete non confermato'
  };
}

module.exports = {
  callPlanyoAPI,
  loadReservationsByEmail,
  segmentEmail,
  buildListAAndB,
  validateTargetResourceIds,
  getPublishedResources,
  getCachedListAAndB,
  findContactByEmail,
  findContactByPhone,
  findContactForPrivacy,
  deleteContactByEmailForPrivacy,
  deleteContactForPrivacy,
  extractPhone,
  normalizePhone
};
