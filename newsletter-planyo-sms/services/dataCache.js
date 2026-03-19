/**
 * Cache dati Mailchimp e Planyo per query veloci.
 * Aggiornamento manuale tramite pulsante "Aggiorna dati".
 */
const fs = require('fs');
const path = require('path');
const mailchimp = require('./mailchimp');
const planyoReportCsv = require('./planyoReportCsv');
const planyo = require('./planyo');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MAILCHIMP_CACHE_FILE = path.join(DATA_DIR, 'mailchimp-cache.json');
const PLANYO_CACHE_FILE = path.join(DATA_DIR, 'planyo-cache.json');
const NEWSLETTER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOADED_CAMPAIGN_ID = 'uploaded-file';

let weeklyRefreshRunning = false;

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

function normalizeCacheShape(raw) {
  const c = raw || {};
  const engagements = c.campaignEngagements || {};
  const byType = (engagements.open || engagements.click)
    ? engagements
    : { open: {}, click: {} };
  return {
    updatedAt: c.updatedAt || null,
    nextRefreshAt: c.nextRefreshAt || null,
    campaignEngagements: {
      open: byType.open || {},
      click: byType.click || {}
    },
    contacts: c.contacts || {}
  };
}

function computeNextRefreshAt(baseDate = new Date()) {
  return new Date(baseDate.getTime() + NEWSLETTER_CACHE_TTL_MS).toISOString();
}

function shouldRefreshWeekly(cache) {
  const c = normalizeCacheShape(cache);
  if (!c.updatedAt) return true;
  const next = c.nextRefreshAt ? new Date(c.nextRefreshAt).getTime() : (new Date(c.updatedAt).getTime() + NEWSLETTER_CACHE_TTL_MS);
  return Date.now() >= next;
}

/**
 * Salva cache Planyo
 */
function savePlanyoCache(data) {
  ensureDataDir();
  fs.writeFileSync(PLANYO_CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function parseCsvRows(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const src = String(text || '').replace(/\r\n/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',' || ch === ';') {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      if (row.some((x) => x)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field.trim());
    if (row.some((x) => x)) rows.push(row);
  }
  return rows;
}

function findColumn(headers, aliases) {
  const cols = headers.map((x) => String(x || '').toLowerCase().trim());
  for (const alias of aliases) {
    const i = cols.findIndex((h) => h === alias || h.includes(alias));
    if (i >= 0) return i;
  }
  return -1;
}

function normalizeMobilePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  while (digits.startsWith('00')) digits = digits.slice(2);
  while (digits.startsWith('3939')) digits = '39' + digits.slice(4);
  if (/^393\d{9}$/.test(digits)) return digits;
  if (/^3\d{9}$/.test(digits)) return '39' + digits;
  const tail = digits.match(/3\d{9}$/);
  if (tail) return '39' + tail[0];
  return '';
}

function mergeContact(current, incoming) {
  if (!current) return incoming;
  return {
    nome: current.nome || incoming.nome || '',
    cognome: current.cognome || incoming.cognome || '',
    email: current.email || incoming.email || '',
    telefono: current.telefono || incoming.telefono || '',
    cellulare: current.cellulare || incoming.cellulare || ''
  };
}

function importNewsletterCsv(csvText) {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) throw new Error('CSV newsletter vuoto o non valido');

  const headers = rows[0];
  const idxEmail = findColumn(headers, ['email', 'e-mail', 'mail']);
  const idxNome = findColumn(headers, ['nome', 'first name', 'firstname', 'name', 'fname']);
  const idxCognome = findColumn(headers, ['cognome', 'last name', 'lastname', 'surname', 'lname']);
  const idxTelefono = findColumn(headers, ['telefono', 'phone', 'mobile', 'cellulare', 'tel']);
  const idxAltTelefono = findColumn(headers, ['altro tel', 'altro telefono', 'telefono 2', 'phone 2', 'mobile 2']);
  if (idxEmail < 0) throw new Error('Colonna email non trovata nel CSV newsletter');

  const contactsByEmail = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const get = (idx) => (idx >= 0 && row[idx] !== undefined ? String(row[idx] || '').trim() : '');
    const email = get(idxEmail).toLowerCase().trim();
    if (!email || !email.includes('@')) continue;
    const nome = get(idxNome);
    const cognome = get(idxCognome);
    const rawPhone = get(idxTelefono);
    const rawAltPhone = get(idxAltTelefono);
    const telefono = normalizeMobilePhone(rawPhone) || normalizeMobilePhone(rawAltPhone) || normalizeMobilePhone(planyo.normalizePhone(rawPhone)) || '';
    const incoming = { nome, cognome, email, telefono, cellulare: telefono };
    const current = contactsByEmail.get(email);
    contactsByEmail.set(email, mergeContact(current, incoming));
  }

  const contacts = {};
  for (const [email, c] of contactsByEmail.entries()) contacts[email] = c;
  return importNewsletterContacts(Object.values(contacts), { replace: false });
}

function importNewsletterContacts(items, options = {}) {
  const { replace = false } = options;
  const list = Array.isArray(items) ? items : [];
  const previous = normalizeCacheShape(loadMailchimpCache());
  const baseContacts = replace ? {} : { ...(previous.contacts || {}) };
  const contactsByEmail = new Map();
  for (const item of list) {
    const email = String(item?.email || '').toLowerCase().trim();
    if (!email || !email.includes('@')) continue;
    const nome = String(item?.nome || '').trim();
    const cognome = String(item?.cognome || '').trim();
    const telefono = normalizeMobilePhone(item?.telefono || item?.cellulare || '');
    const incoming = { nome, cognome, email, telefono, cellulare: telefono };
    const current = contactsByEmail.get(email);
    contactsByEmail.set(email, mergeContact(current, incoming));
  }

  for (const [email, c] of contactsByEmail.entries()) {
    baseContacts[email] = mergeContact(baseContacts[email], c);
  }

  const uniqueEmails = Object.keys(baseContacts);
  const now = new Date();
  saveMailchimpCache({
    updatedAt: now.toISOString(),
    nextRefreshAt: computeNextRefreshAt(now),
    campaignEngagements: {
      open: { ...(previous.campaignEngagements.open || {}), [UPLOADED_CAMPAIGN_ID]: uniqueEmails },
      click: { ...(previous.campaignEngagements.click || {}), [UPLOADED_CAMPAIGN_ID]: uniqueEmails }
    },
    contacts: baseContacts
  });

  return { success: true, uploadedContacts: uniqueEmails.length, updatedAt: now.toISOString() };
}

/**
 * Aggiorna solo cache Mailchimp (ultime 2 newsletter)
 * @param {'open'|'click'} engagementType
 * @returns {{ success: boolean, updatedAt?: string, mailchimpContacts?: number, error?: string }}
 */
async function runUpdateNewsletter(engagementType = 'open', options = {}) {
  const mode = String(engagementType || 'open').toLowerCase() === 'click' ? 'click' : 'open';
  const { force = false } = options;
  const now = new Date().toISOString();
  const result = { success: false, updatedAt: now };

  try {
    const campaigns = await mailchimp.getLastSentCampaigns(2);
    const previous = normalizeCacheShape(loadMailchimpCache());
    const campaignEngagements = force
      ? { open: {}, click: {} }
      : {
          open: { ...(previous.campaignEngagements.open || {}) },
          click: { ...(previous.campaignEngagements.click || {}) }
        };
    const contactsMap = new Map();

    // Esegui le 2 campagne in parallelo
    await Promise.all(campaigns.map(async (c) => {
      const [engagedEmails, listId] = await Promise.all([
        mailchimp.getCampaignEngagedEmails(c.id, mode),
        mailchimp.getCampaignListId(c.id)
      ]);
      const emails = [...new Set(engagedEmails.map((e) => e.toLowerCase().trim()))];
      campaignEngagements[mode][c.id] = emails;

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
    for (const [email, d] of contactsMap) {
      contacts[email] = { nome: d.nome, cognome: d.cognome, email, telefono: d.cellulare, cellulare: d.cellulare };
    }

    const mergedContacts = force ? contacts : { ...(previous.contacts || {}), ...contacts };
    saveMailchimpCache({
      updatedAt: now,
      nextRefreshAt: computeNextRefreshAt(new Date(now)),
      campaignEngagements,
      contacts: mergedContacts
    });
    result.mailchimpContacts = Object.keys(contacts).length;
    result.mailchimpEngagementType = mode;
    result.nextRefreshAt = computeNextRefreshAt(new Date(now));
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
    const uniqueEmails = new Set(raw.map((r) => String(r?.email || '').toLowerCase().trim()).filter(Boolean));
    result.planyoContacts = uniqueEmails.size;
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

function startWeeklyNewsletterRefresh(engagementType = 'open') {
  const mode = String(engagementType || 'open').toLowerCase() === 'click' ? 'click' : 'open';
  if (weeklyRefreshRunning) return { started: false, reason: 'already_running' };
  const cache = normalizeCacheShape(loadMailchimpCache());
  if (!shouldRefreshWeekly(cache)) return { started: false, reason: 'not_due', nextRefreshAt: cache.nextRefreshAt };

  weeklyRefreshRunning = true;
  setImmediate(async () => {
    try {
      // Pre-carica entrambe le modalità in ciclo settimanale.
      await runUpdateNewsletter('open');
      await runUpdateNewsletter('click');
      // Allinea timestamp di refresh alla fine dell'aggiornamento.
      const current = normalizeCacheShape(loadMailchimpCache());
      saveMailchimpCache({
        ...current,
        updatedAt: new Date().toISOString(),
        nextRefreshAt: computeNextRefreshAt(new Date())
      });
    } catch (_) {
      // no-op: errori visibili tramite comandi manuali
    } finally {
      weeklyRefreshRunning = false;
    }
  });
  return { started: true, mode };
}

async function runForceRebuildNewsletterCache() {
  const first = await runUpdateNewsletter('open', { force: true });
  const second = await runUpdateNewsletter('click');
  const now = new Date();
  const cache = normalizeCacheShape(loadMailchimpCache());
  saveMailchimpCache({
    ...cache,
    updatedAt: now.toISOString(),
    nextRefreshAt: computeNextRefreshAt(now)
  });
  return {
    success: !!(first.success && second.success),
    updatedAt: now.toISOString(),
    nextRefreshAt: computeNextRefreshAt(now),
    open: first,
    click: second,
    error: first.success && second.success ? undefined : (first.error || second.error || 'Errore rebuild cache')
  };
}

/**
 * Stato cache (per UI)
 */
function getCacheStatus() {
  const mc = normalizeCacheShape(loadMailchimpCache());
  const pc = loadPlanyoCache();
  const campaignsCount = (() => {
    const openCount = Object.keys(mc.campaignEngagements.open || {}).length;
    const clickCount = Object.keys(mc.campaignEngagements.click || {}).length;
    return Math.max(openCount, clickCount);
  })();
  const planyoUniqueEmails = (() => {
    const rows = Array.isArray(pc?.contacts) ? pc.contacts : [];
    const set = new Set();
    for (const r of rows) {
      const email = String(r?.email || '').toLowerCase().trim();
      if (email) set.add(email);
    }
    return set.size;
  })();
  return {
    mailchimpUpdatedAt: mc.updatedAt || null,
    mailchimpNextRefreshAt: mc.nextRefreshAt || null,
    planyoUpdatedAt: pc?.updatedAt || null,
    mailchimpCampaigns: campaignsCount,
    mailchimpContacts: mc.contacts ? Object.keys(mc.contacts).length : 0,
    planyoContacts: planyoUniqueEmails
  };
}

function removeContactFromCaches(email, phone = '') {
  const normEmail = String(email || '').toLowerCase().trim();
  const normPhone = normalizeMobilePhone(phone) || String(phone || '').replace(/\D/g, '');
  const result = {
    source: 'cache',
    mailchimp: { deleted: false, removedCampaignRefs: 0 },
    planyo: { deleted: false, removedRows: 0 }
  };

  try {
    const mc = normalizeCacheShape(loadMailchimpCache());
    let changed = false;
    if (normEmail && mc.contacts && mc.contacts[normEmail]) {
      delete mc.contacts[normEmail];
      result.mailchimp.deleted = true;
      changed = true;
    }
    let removedRefs = 0;
    for (const type of ['open', 'click']) {
      const byCampaign = mc.campaignEngagements?.[type] || {};
      for (const campaignId of Object.keys(byCampaign)) {
        const arr = Array.isArray(byCampaign[campaignId]) ? byCampaign[campaignId] : [];
        const filtered = arr.filter((e) => String(e || '').toLowerCase().trim() !== normEmail);
        if (filtered.length !== arr.length) {
          byCampaign[campaignId] = filtered;
          removedRefs += (arr.length - filtered.length);
          changed = true;
        }
      }
    }
    result.mailchimp.removedCampaignRefs = removedRefs;
    if (changed) saveMailchimpCache(mc);
  } catch (_) {}

  try {
    const pc = loadPlanyoCache();
    const rows = Array.isArray(pc?.contacts) ? pc.contacts : null;
    if (rows) {
      const before = rows.length;
      const filtered = rows.filter((r) => {
        const rowEmail = String(r?.email || '').toLowerCase().trim();
        const rowPhone = String(r?.telefono || '').replace(/\D/g, '');
        const matchEmail = normEmail && rowEmail === normEmail;
        const matchPhone = normPhone && rowPhone && (rowPhone === normPhone || rowPhone.endsWith(normPhone.slice(-9)));
        return !(matchEmail || matchPhone);
      });
      if (filtered.length !== before) {
        result.planyo.deleted = true;
        result.planyo.removedRows = before - filtered.length;
        savePlanyoCache({ ...(pc || {}), updatedAt: new Date().toISOString(), contacts: filtered });
      }
    }
  } catch (_) {}

  return result;
}

module.exports = {
  loadMailchimpCache,
  loadPlanyoCache,
  saveMailchimpCache,
  savePlanyoCache,
  runUpdateNewsletter,
  runForceRebuildNewsletterCache,
  startWeeklyNewsletterRefresh,
  shouldRefreshWeekly,
  runUpdatePrenotazioni,
  isReadyForOperations,
  getCacheStatus,
  removeContactFromCaches,
  importNewsletterCsv,
  importNewsletterContacts,
  UPLOADED_CAMPAIGN_ID,
  MAILCHIMP_CACHE_FILE,
  PLANYO_CACHE_FILE
};
