/**
 * Job: da report Mailchimp (open/click) → segmenta per prenotazioni Planyo → dati per Newsletter EMAIL
 * Esportazione CSV, filtro evento, invio email
 */
const mailchimp = require('../services/mailchimp');
const planyo = require('../services/planyo');
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

  const emails = await mailchimp.getCampaignEngagedEmails(campaignId);
  if (emails.length === 0) return [];

  const listId = await mailchimp.getCampaignListId(campaignId);
  const emailsSet = new Set(emails.map((e) => e.toLowerCase()));

  const [reservationsByEmail, memberDetails] = await Promise.all([
    planyo.loadReservationsByEmail(months),
    listId ? mailchimp.getMemberDetailsForEmails(listId, emailsSet) : Promise.resolve(new Map())
  ]);

  const result = [];
  for (const email of emails) {
    const key = email.toLowerCase().trim();
    const { segment, phone, lastResource, firstName: planyoFirst, lastName: planyoLast } = planyo.segmentEmail(reservationsByEmail, email, targetResourceId);
    const mc = memberDetails.get(key);

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
      segment
    });
  }

  return result;
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
  filterByEvent,
  takeBlock
};
