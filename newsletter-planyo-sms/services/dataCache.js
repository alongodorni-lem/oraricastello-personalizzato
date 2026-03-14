/**
 * Cache dati Mailchimp e Planyo per query veloci.
 * Aggiornamento manuale tramite pulsante "Aggiorna dati".
 */
const fs = require('fs');
const path = require('path');
const mailchimp = require('./mailchimp');
const planyoReportCsv = require('./planyoReportCsv');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MAILCHIMP_CACHE_FILE = path.join(DATA_DIR, 'mailchimp-cache.json');
const PLANYO_CACHE_FILE = path.join(DATA_DIR, 'planyo-cache.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Carica cache Mailchimp
 * @returns {{ updatedAt?: string, campaignEngagements?: Record<string, string[]>|{open?: Record<string, string[]>, click?: Record<string, string[]>}, contacts?: Record<string, { nome: string, cognome: string, cellulare: string }> } | null}
 */
function loadMailchimpCache() {
  try {
    if (fs.existsSync(MAILCHIMP_CACHE_FILE)) {
      const raw = fs.readFileSync(MAILCHIMP_CACHE_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (_) {}
  return null;
}

/**
 * Carica cache Planyo CSV
 * @returns {{ updatedAt?: string, contacts?: Array<{ nome, cognome, email, telefono, eventoPrenotato, stato, creazione }> } | null}
 */
function loadPlanyoCache() {
  try {
    if (fs.existsSync(PLANYO_CACHE_FILE)) {
      const raw = fs.readFileSync(PLANYO_CACHE_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (_) {}
  return null;
}

/**
 * Salva cache Mailchimp
 */
function saveMailchimpCache(data) {
  ensureDataDir();
  fs.writeFileSync(MAILCHIMP_CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Salva cache Planyo
 */
function savePlanyoCache(data) {
  ensureDataDir();
  fs.writeFileSync(PLANYO_CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Aggiorna solo cache Mailchimp (ultime 2 newsletter)
 * @returns {{ success: boolean, updatedAt?: string, mailchimpContacts?: number, error?: string }}
 */
async function runUpdateNewsletter() {
  const now = new Date().toISOString();
  const result = { success: false, updatedAt: now };

  try {
    const campaigns = await mailchimp.getLastSentCampaigns(2);
    const campaignEngagements = { open: {}, click: {} };
    const contactsMap = new Map();

    // Esegui le 2 campagne in parallelo
    await Promise.all(campaigns.map(async (c) => {
      const [openEmails, clickEmails, listId] = await Promise.all([
        mailchimp.getCampaignEngagedEmails(c.id, 'open'),
        mailchimp.getCampaignEngagedEmails(c.id, 'click'),
        mailchimp.getCampaignListId(c.id)
      ]);
      const open = openEmails.map((e) => e.toLowerCase().trim());
      const click = clickEmails.map((e) => e.toLowerCase().trim());
      campaignEngagements.open[c.id] = [...new Set(open)];
      campaignEngagements.click[c.id] = [...new Set(click)];
      const emails = [...new Set([...open, ...click])];

      if (listId && emails.length > 0) {
        const details = await mailchimp.getMemberDetailsForEmails(listId, new Set(emails.map((e) => e.toLowerCase())));
        for (const [email, d] of details) {
          if (!contactsMap.has(email)) {
            contactsMap.set(email, {
              nome: (d.firstName || '').trim(),
              cognome: (d.lastName || '').trim(),
              cellulare: (d.phone || '').trim()
            });
          }
        }
      }
    }));

    const contacts = {};
    for (const [email, d] of contactsMap) contacts[email] = d;

    saveMailchimpCache({ updatedAt: now, campaignEngagements, contacts });
    result.mailchimpContacts = Object.keys(contacts).length;
    result.success = true;
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

/**
 * Aggiorna solo cache Planyo CSV (scarica e salva tutto)
 * @returns {{ success: boolean, updatedAt?: string, planyoContacts?: number, error?: string }}
 */
async function runUpdatePrenotazioni() {
  const now = new Date().toISOString();
  const result = { success: false, updatedAt: now };

  try {
    const csvUrl = process.env.PLANYO_LISTD_CSV_URL;
    if (!csvUrl || !csvUrl.startsWith('http')) {
      result.error = 'PLANYO_LISTD_CSV_URL non configurato';
      return result;
    }

    const raw = await planyoReportCsv.fetchAndParseCsv(csvUrl);
    savePlanyoCache({ updatedAt: now, contacts: raw });
    result.planyoContacts = raw.length;
    result.success = true;
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

/**
 * Verifica se entrambe le cache sono aggiornate (necessario per procedere)
 */
function isReadyForOperations() {
  const mc = loadMailchimpCache();
  const pc = loadPlanyoCache();
  return !!(mc?.updatedAt && pc?.updatedAt);
}

/**
 * Stato cache (per UI)
 */
function getCacheStatus() {
  const mc = loadMailchimpCache();
  const pc = loadPlanyoCache();
  const campaignsCount = (() => {
    if (!mc?.campaignEngagements) return 0;
    if (mc.campaignEngagements.open || mc.campaignEngagements.click) {
      const openCount = Object.keys(mc.campaignEngagements.open || {}).length;
      const clickCount = Object.keys(mc.campaignEngagements.click || {}).length;
      return Math.max(openCount, clickCount);
    }
    return Object.keys(mc.campaignEngagements).length;
  })();
  return {
    mailchimpUpdatedAt: mc?.updatedAt || null,
    planyoUpdatedAt: pc?.updatedAt || null,
    mailchimpCampaigns: campaignsCount,
    mailchimpContacts: mc?.contacts ? Object.keys(mc.contacts).length : 0,
    planyoContacts: pc?.contacts?.length || 0
  };
}

module.exports = {
  loadMailchimpCache,
  loadPlanyoCache,
  saveMailchimpCache,
  savePlanyoCache,
  runUpdateNewsletter,
  runUpdatePrenotazioni,
  isReadyForOperations,
  getCacheStatus,
  MAILCHIMP_CACHE_FILE,
  PLANYO_CACHE_FILE
};
