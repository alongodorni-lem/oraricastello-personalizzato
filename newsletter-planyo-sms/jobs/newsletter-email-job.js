/**
 * Job: da report Mailchimp (open/click) → segmenta per prenotazioni Planyo → dati per Newsletter EMAIL
 * Esportazione CSV, filtro evento, invio email
 */
const mailchimp = require('../services/mailchimp');
const planyo = require('../services/planyo');
const planyoReportCsv = require('../services/planyoReportCsv');
const config = require('../config/segments');

/**
 * Costruisce l'array di dati per Newsletter EMAIL (nome, cognome, email, telefono, evento, segment)
 * @param {string} campaignId
 * @param {{ targetResourceId?: number, monthsLookback?: number }} options
 * @returns {Promise<Array<{ nome: string, cognome: string, email: string, telefono: string, eventoPrenotato: string, segment: string }>>}
 */
async function buildEmailListData(campaignId, options = {}) {
  const { targetResourceId: overrideId, monthsLookback } = options;
  const targetResourceId = overrideId != null ? Number(overrideId) : config.targetResourceId;
  const months = monthsLookback ?? config.monthsLookback;

  const emails = await mailchimp.getCampaignEngagedEmailsWithCache(campaignId);
  if (emails.length === 0) return [];

  const listId = await mailchimp.getCampaignListId(campaignId);
  const emailsSet = new Set(emails.map((e) => e.toLowerCase()));

  const [reservationsByEmail, memberDetails] = await Promise.all([
    planyo.loadReservationsByEmail(months),
    mailchimp.getMemberDetailsForEmailsWithCache(emailsSet, listId)
  ]);

  const result = [];
  for (const email of emails) {
    const key = email.toLowerCase().trim();
    const entry = reservationsByEmail.get(key);
    const { segment, phone, lastResource, firstName: planyoFirst, lastName: planyoLast } = planyo.segmentEmail(reservationsByEmail, email, targetResourceId);
    const mc = memberDetails.get(key);

    const resourceIds = (entry?.reservations || []).map((r) => r.resource_id).filter((id) => id != null).map(Number);

    const nome = (planyoFirst || mc?.firstName || '').trim();
    const cognome = (planyoLast || mc?.lastName || '').trim();
    const telefono = planyo.normalizePhone(phone || mc?.phone) || (phone || mc?.phone || '').trim();
    const eventoPrenotato = (lastResource || '').trim();

    result.push({
      nome,
      cognome,
      email: key,
      telefono,
      eventoPrenotato,
      segment,
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
  return data.filter((r) => (r.resourceIds || []).some((id) => ids.has(Number(id))));
}

/**
 * Filtra i dati per segmento (A, B, C)
 * @param {Array} data - output di buildEmailListData
 * @param {string[]|null} segments - es. ['A','B'] (vuoto/null = tutti)
 */
function filterBySegment(data, segments) {
  if (!segments || !Array.isArray(segments) || segments.length === 0) return data;
  const set = new Set(segments.map((s) => String(s).toUpperCase()));
  if (set.has('D')) return data;
  return data.filter((r) => set.has((r.segment || '').toUpperCase()));
}

/**
 * Carica Lista D da CSV e la unisce ai dati (per segmenti che includono D)
 * @param {Array} apiData - dati da API già filtrati per eventIds, eventFilter
 * @param {string[]} segments
 * @param {{ eventNameContains?: string, eventIds?: number[], statuses?: string[] }} listDFilters
 */
async function mergeListDFromCsv(apiData, segments, listDFilters = {}) {
  if (!segments || !segments.map((s) => String(s).toUpperCase()).includes('D')) return apiData;
  if (!process.env.PLANYO_LISTD_CSV_URL) return apiData;

  const segSet = new Set(segments.map((s) => String(s).toUpperCase()));
  const onlyD = segSet.size === 1 && segSet.has('D');
  const baseData = onlyD ? [] : apiData.filter((r) => segSet.has((r.segment || '').toUpperCase()));

  const listD = await planyoReportCsv.loadListDFromCsv(listDFilters);
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
