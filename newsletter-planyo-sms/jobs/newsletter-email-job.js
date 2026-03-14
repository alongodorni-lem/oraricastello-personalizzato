/**
 * Job: da report Mailchimp (open/click) → segmenta per prenotazioni Planyo → dati per Newsletter EMAIL
 * Esportazione CSV, filtro evento, invio email
 */
const mailchimp = require('../services/mailchimp');
const planyo = require('../services/planyo');
const planyoReportCsv = require('../services/planyoReportCsv');
const config = require('../config/segments');

function looksLikeNumericResource(value) {
  const s = String(value || '').trim();
  return !!s && /^\d+$/.test(s);
}

function pickEventNameFromReservations(entry) {
  const reservations = entry?.reservations || [];
  if (!reservations.length) return '';

  const sorted = [...reservations].sort((a, b) => {
    const at = Number(a?.start_time || 0);
    const bt = Number(b?.start_time || 0);
    return bt - at;
  });

  // Priorita alla prenotazione piu recente con nome testuale.
  for (const r of sorted) {
    const name = String(r?.resource_name || '').trim();
    if (name && !looksLikeNumericResource(name)) return name;
  }
  return '';
}

/**
 * Costruisce l'array di dati per Newsletter EMAIL (nome, cognome, email, telefono, evento, segment)
 * @param {string} campaignId
 * @param {{ targetResourceId?: number, monthsLookback?: number }} options
 * @returns {Promise<Array<{ nome: string, cognome: string, email: string, telefono: string, eventoPrenotato: string, segment: string }>>}
 */
async function buildEmailListData(campaignId, options = {}) {
  const { targetResourceId: overrideId, monthsLookback, engagementType = 'open' } = options;
  const targetResourceId = overrideId != null ? overrideId : config.targetResourceId;
  const months = monthsLookback ?? config.monthsLookback;

  const emails = await mailchimp.getCampaignEngagedEmailsWithCache(campaignId, engagementType);
  if (emails.length === 0) return [];

  const emailsSet = new Set(emails.map((e) => e.toLowerCase()));

  const [reservationsByEmail, memberDetails] = await Promise.all([
    planyo.loadReservationsByEmail(months),
    mailchimp.getMemberDetailsForEmailsWithCache(emailsSet, null)
  ]);
  const { emailsInA } = planyo.buildListAAndB(reservationsByEmail, targetResourceId);

  const result = [];
  for (const email of emails) {
    const key = email.toLowerCase().trim();
    const entry = reservationsByEmail.get(key);
    const mc = memberDetails.get(key);

    const resourceIds = (entry?.reservations || []).map((r) => r.resource_id).filter((id) => id != null).map(Number);

    const planyoPhone = entry?.phone || '';
    const planyoFirst = entry?.firstName || '';
    const planyoLast = entry?.lastName || '';
    const nome = (planyoFirst || mc?.firstName || '').trim();
    const cognome = (planyoLast || mc?.lastName || '').trim();
    const telefono = planyo.normalizePhone(planyoPhone || mc?.phone) || (planyoPhone || mc?.phone || '').trim();

    const hasReservations18m = !!(entry?.reservations?.length);
    const segmentUpper = emailsInA.has(key) ? 'A' : (hasReservations18m ? 'B' : 'C');
    let eventoPrenotato = '';
    if (segmentUpper === 'A' || segmentUpper === 'B') {
      const fromSegment = String((entry?.reservations || [])[((entry?.reservations || []).length - 1)]?.resource_name || '').trim();
      eventoPrenotato = !looksLikeNumericResource(fromSegment) ? fromSegment : pickEventNameFromReservations(entry);
    }

    result.push({
      nome,
      cognome,
      email: key,
      telefono,
      eventoPrenotato,
      segment: segmentUpper,
      resourceIds
    });
  }

  return result;
}

/**
 * Filtra i dati per ID evento Planyo (vuoto = tutte le prenotazioni)
 * @param {Array} data - output di buildEmailListData
 * @param {number[]|null} eventIds - es. [236955] o [236955, 243693] (vuoto = nessun filtro)
 */
function filterByEventIds(data, eventIds) {
  if (!eventIds || !Array.isArray(eventIds) || eventIds.length === 0) return data;
  const ids = new Set(eventIds.map((id) => Number(id)).filter((n) => !isNaN(n)));
  if (ids.size === 0) return data;
  return data.filter((r) => {
    const seg = String(r.segment || '').toUpperCase();
    // Lista C deve essere sempre "newsletter - A" (match solo email), indipendente da eventIds.
    if (seg === 'C') return true;
    return (r.resourceIds || []).some((id) => ids.has(Number(id)));
  });
}

/**
 * Filtra i dati per segmento (A, B, C)
 * @param {Array} data - output di buildEmailListData
 * @param {string[]|null} segments - es. ['A','B'] (vuoto/null = tutti)
 */
function filterBySegment(data, segments) {
  if (!segments || !Array.isArray(segments) || segments.length === 0) return data;
  const set = new Set(segments.map((s) => String(s).toUpperCase()));
  const includeA = set.has('A');
  const includeB = set.has('B');
  const includeC = set.has('C');
  const hasAbcSelection = includeA || includeB || includeC;

  // Se e selezionata solo D, la parte API deve risultare vuota:
  // Lista D verra aggiunta successivamente da CSV.
  if (!hasAbcSelection) return [];

  // Regola test richiesta:
  // - C include tutti i contatti newsletter Mailchimp senza esclusioni (A+B+C).
  return data.filter((r) => {
    const seg = String(r.segment || '').toUpperCase();
    const isA = seg === 'A';
    const isB = seg === 'B';
    const isC = seg === 'C';
    if (includeA && isA) return true;
    if (includeB && isB) return true;
    if (includeC && (isA || isB || isC)) return true;
    return false;
  });
}

/**
 * Carica Lista D da CSV e la unisce ai dati (per segmenti che includono D)
 * @param {Array} apiData - dati da API già filtrati per eventIds, eventFilter
 * @param {string[]} segments
 * @param {{ eventNameContains?: string, eventIds?: number[], statuses?: string[] }} listDFilters
 * @param {{ emailsInA?: Set<string> }} excludeListA
 */
async function mergeListDFromCsv(apiData, segments, listDFilters = {}, excludeListA = {}) {
  if (!segments || !segments.map((s) => String(s).toUpperCase()).includes('D')) return apiData;
  if (!process.env.PLANYO_LISTD_CSV_URL) return apiData;

  const segSet = new Set(segments.map((s) => String(s).toUpperCase()));
  const onlyD = segSet.size === 1 && segSet.has('D');
  const baseData = onlyD ? [] : apiData.filter((r) => segSet.has((r.segment || '').toUpperCase()));

  const listD = await planyoReportCsv.loadListDFromCsv(listDFilters, excludeListA);
  const existingEmails = new Set(baseData.map((r) => r.email.toLowerCase()));
  const fromD = listD.filter((r) => !existingEmails.has(r.email.toLowerCase()));
  return [...baseData, ...fromD];
}

/**
 * Filtra i dati per nome evento (case-insensitive, contiene)
 * @param {Array} data - output di buildEmailListData
 * @param {string} eventFilter - stringa da cercare in eventoPrenotato (vuoto = nessun filtro)
 */
function filterByEvent(data, eventFilter) {
  if (!eventFilter || typeof eventFilter !== 'string') return data;
  const q = eventFilter.trim().toLowerCase();
  if (!q) return data;
  return data.filter((r) => (r.eventoPrenotato || '').toLowerCase().includes(q));
}

/**
 * Prende i primi N elementi
 * @param {Array} data
 * @param {number} limit - 100, 200, 300, 400, 500
 */
function takeBlock(data, limit) {
  const n = Math.min(Math.max(0, parseInt(String(limit), 10)), 500);
  if (isNaN(n) || n < 1) return data.slice(0, 100);
  return data.slice(0, n);
}

module.exports = {
  buildEmailListData,
  filterByEventIds,
  filterBySegment,
  filterByEvent,
  takeBlock,
  mergeListDFromCsv
};
