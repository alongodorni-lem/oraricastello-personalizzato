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
      const resourceId = res.resource_id || res.resource?.id;

      if (!byEmail.has(email)) {
        byEmail.set(email, { reservations: [], phone: '', firstName: '', lastName: '' });
      }
      const entry = byEmail.get(email);
      entry.reservations.push({
        reservation_id: res.reservation_id || res.id || null,
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
    .map((r) => ({ id: r.id, name: cleanResourceName(r.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));

  resourcesListCache = resources.filter((r) => looksLikeRealResourceName(r.name));
  resourcesListCacheExpiry = Date.now() + RESOURCES_CACHE_TTL_MS;
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

  // 2) Privacy lookup globale utenti Planyo (menu "Clienti")
  // list_users permette filtro email e include anche casi non coperti dal lookback.
  try {
    const siteId = process.env.PLANYO_SITE_ID || '8895';
    const queryCandidates = [normEmail, `${normEmail}*`];
    for (const queryEmail of queryCandidates) {
      let data = null;
      let lastErr = null;
      const startedAt = Date.now();
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          data = await callPlanyoAPI('list_users', {
            site_id: siteId,
            email: queryEmail,
            list_unconfirmed: true,
            list_created_by_admin: true,
            detail_level: 1,
            page: 0,
            page_size: 1000
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
      const users = Array.isArray(data?.users) ? data.users : (Array.isArray(data?.results) ? data.results : []);
      const elapsed = Date.now() - startedAt;
      console.log('[Planyo][Privacy] list_users lookup', queryEmail === normEmail ? 'exact' : 'wildcard', 'users:', users.length, 'elapsed_ms:', elapsed);
      if (users.length > 0) {
        return {
          source: 'planyo',
          status: 'found',
          found: true,
          email: normEmail,
          foundVia: queryEmail === normEmail ? 'list_users_exact' : 'list_users_wildcard',
          reservations: []
        };
      }
    }
  } catch (_) {
    // fallback sotto: not_found
  }

  return { source: 'planyo', status: 'not_found', found: false };
}

async function deleteContactByEmailForPrivacy(email, monthsLookback = 18) {
  if (!process.env.PLANYO_API_KEY) return { source: 'planyo', status: 'error', reason: 'PLANYO_API_KEY non configurata' };
  const found = await findContactByEmail(email, monthsLookback);
  if (!found.found) return { source: 'planyo', status: 'not_found' };

  const siteId = process.env.PLANYO_SITE_ID || '8895';
  const normEmail = normalizeEmail(email);
  const customerDeleteMethods = ['delete_customer_data', 'delete_customer'];
  for (const method of customerDeleteMethods) {
    try {
      await callPlanyoAPI(method, { site_id: siteId, email: normEmail });
      return { source: 'planyo', status: 'deleted', method };
    } catch (_) {}
  }

  const allowReservationDelete = String(process.env.PLANYO_PRIVACY_ALLOW_RESERVATION_DELETE || '').toLowerCase();
  if (!['1', 'true', 'yes', 'on'].includes(allowReservationDelete)) {
    return {
      source: 'planyo',
      status: 'found_not_deleted',
      reason: 'Contatto trovato su Planyo ma delete diretto non supportato dal metodo configurato'
    };
  }

  const reservationIds = [...new Set((found.reservations || [])
    .map((r) => Number(r?.reservation_id || 0))
    .filter((n) => Number.isInteger(n) && n > 0))];
  if (reservationIds.length === 0) {
    return { source: 'planyo', status: 'found_not_deleted', reason: 'Nessun reservation_id disponibile per cancellazione' };
  }

  let deleted = 0;
  let failed = 0;
  for (const reservationId of reservationIds) {
    let ok = false;
    for (const method of ['delete_reservation', 'cancel_reservation']) {
      try {
        await callPlanyoAPI(method, { site_id: siteId, reservation_id: reservationId });
        ok = true;
        break;
      } catch (_) {}
    }
    if (ok) deleted++;
    else failed++;
  }

  if (deleted > 0 && failed === 0) return { source: 'planyo', status: 'deleted', deletedReservations: deleted };
  if (deleted > 0) return { source: 'planyo', status: 'found_not_deleted', reason: `Cancellate ${deleted}, non cancellate ${failed}` };
  return { source: 'planyo', status: 'found_not_deleted', reason: 'Metodo delete non riuscito su Planyo' };
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
  deleteContactByEmailForPrivacy,
  extractPhone,
  normalizePhone
};
