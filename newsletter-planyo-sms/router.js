/**
 * Router Express per Newsletter Planyo SMS - montabile in un'app esistente
 * Uso: app.use('/newsletter-sms', require('./newsletter-planyo-sms/router'));
 * URL: https://tuodominio.com/newsletter-sms
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const mailchimp = require('./services/mailchimp');
const smshosting = require('./services/smshosting');
const emailService = require('./services/emailService');
const { runNewsletterSmsJob, checkPhoneInLists, getSmsPreview } = require('./jobs/newsletter-sms-job');
const { buildEmailListData, filterByEventIds, filterBySegment, filterByEvent, takeBlock, mergeListDFromCsv } = require('./jobs/newsletter-email-job');
const planyoReportCsv = require('./services/planyoReportCsv');
const dataCache = require('./services/dataCache');
const config = require('./config/segments');

const PUBLIC_PATH = path.join(__dirname, 'public');
const UI_CONFIG_FILE = path.join(__dirname, 'data', 'ui-config.json');

router.use(express.json({ limit: '30mb' }));

// Basic Auth: se NEWSLETTER_SMS_USER e NEWSLETTER_SMS_PASSWORD sono impostati, richiede login
const authUser = process.env.NEWSLETTER_SMS_USER;
const authPass = process.env.NEWSLETTER_SMS_PASSWORD;
const authRequired = !!(authUser && authPass);

function basicAuthMiddleware(req, res, next) {
  if (!authRequired) return next();
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Newsletter SMS"');
    return res.status(401).json({ error: 'Autenticazione richiesta' });
  }
  try {
    const b64 = auth.slice(6);
    const [user, pass] = Buffer.from(b64, 'base64').toString().split(':');
    if (user === authUser && pass === authPass) return next();
  } catch (_) {}
  res.setHeader('WWW-Authenticate', 'Basic realm="Newsletter SMS"');
  return res.status(401).json({ error: 'Credenziali non valide' });
}

router.use(basicAuthMiddleware);

let runAbortRequested = false;

function loadUiConfig() {
  try {
    const data = fs.readFileSync(UI_CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveUiConfig(obj) {
  const dir = path.dirname(UI_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(UI_CONFIG_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

function getConfiguredTargetResourceId() {
  const cfg = loadUiConfig();
  const cfgValue = formatTargetResourceIds(cfg.targetResourceId ?? '', '');
  const legacyDefault = formatTargetResourceIds(config.targetResourceId ?? '', '');
  if (!cfgValue || (legacyDefault && cfgValue === legacyDefault)) return '';
  return cfgValue;
}

function captureLogs(fn) {
  const logs = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...args) => {
    logs.push({ type: 'log', msg: args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') });
    origLog.apply(console, args);
  };
  console.error = (...args) => {
    logs.push({ type: 'error', msg: args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') });
    origError.apply(console, args);
  };
  console.warn = (...args) => {
    logs.push({ type: 'warn', msg: args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') });
    origWarn.apply(console, args);
  };
  return {
    run: async () => {
      try {
        const result = await fn();
        return { success: true, result, logs };
      } catch (err) {
        logs.push({ type: 'error', msg: err.message });
        return { success: false, error: err.message, logs };
      } finally {
        console.log = origLog;
        console.error = origError;
        console.warn = origWarn;
      }
    }
  };
}

// Pagina principale
router.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_PATH, 'index.html'));
});

// Static files (CSS, etc. se presenti)
router.use(express.static(PUBLIC_PATH));

// Test API Planyo: conta prenotazioni confermate (creation_date) ultimi 18 mesi
router.get('/api/test-planyo', async (req, res) => {
  try {
    const planyo = require('./services/planyo');
    const months = parseInt(req.query.months || '18', 10) || 18;
    const byEmail = await planyo.loadReservationsByEmail(months);
    const totalRes = [...byEmail.values()].reduce((s, e) => s + (e.reservations?.length || 0), 0);
    const { buildListAAndB } = planyo;
    const targetId = getConfiguredTargetResourceId();
    const { listA, listB, emailsInA } = buildListAAndB(byEmail, targetId);
    res.json({
      success: true,
      months,
      totalEmails: byEmail.size,
      totalReservations: totalRes,
      listA_count: listA.length,
      listB_count: listB.length,
      emailsInA_count: emailsInA.size
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Preload Planyo (Lista A) in background - avviato al caricamento pagina per velocizzare Calcola contatti
router.get('/api/preload-planyo', (req, res) => {
  res.json({ success: true, message: 'Preload Lista A avviato' });
  if (process.env.PLANYO_API_KEY) {
    const planyo = require('./services/planyo');
    const config = require('./config/segments');
    planyo.loadReservationsByEmail(config.monthsLookback).catch((err) => {
      console.warn('[Preload] Planyo:', err.message);
    });
  }
});

// API
router.get('/api/config', (req, res) => {
  try {
    const cfg = loadUiConfig();
    const targetResourceId = getConfiguredTargetResourceId();
    const mailchimpEngagementType = parseEngagementType(cfg.mailchimpEngagementType || 'open');
    const emailSubject = typeof cfg.emailSubject === 'string' ? cfg.emailSubject : '';
    const emailBody = typeof cfg.emailBody === 'string' ? cfg.emailBody : '';
    dataCache.startWeeklyNewsletterRefresh(mailchimpEngagementType);
    const cacheStatus = dataCache.getCacheStatus();
    const ready = dataCache.isReadyForOperations();
    res.json({ success: true, targetResourceId, mailchimpEngagementType, emailSubject, emailBody, cacheStatus, ready });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/config', (req, res) => {
  try {
    const body = req.body || {};
    const cfg = loadUiConfig();

    if (Object.prototype.hasOwnProperty.call(body, 'targetResourceId')) {
      const parsedIds = parseTargetResourceIdsParam(body.targetResourceId);
      if (parsedIds === null) {
        return res.status(400).json({ success: false, error: 'Valore evento target non valido' });
      }
      cfg.targetResourceId = parsedIds.length ? parsedIds.join(',') : '';
    }

    if (Object.prototype.hasOwnProperty.call(body, 'mailchimpEngagementType')) {
      cfg.mailchimpEngagementType = parseEngagementType(body.mailchimpEngagementType);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'emailSubject')) {
      cfg.emailSubject = String(body.emailSubject || '').slice(0, 200);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'emailBody')) {
      cfg.emailBody = String(body.emailBody || '').slice(0, 20000);
    }

    saveUiConfig(cfg);
    res.json({
      success: true,
      targetResourceId: getConfiguredTargetResourceId(),
      mailchimpEngagementType: parseEngagementType(cfg.mailchimpEngagementType || 'open'),
      emailSubject: typeof cfg.emailSubject === 'string' ? cfg.emailSubject : '',
      emailBody: typeof cfg.emailBody === 'string' ? cfg.emailBody : ''
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/api/campaigns', async (req, res) => {
  res.json({ success: true, campaigns: [{ id: dataCache.UPLOADED_CAMPAIGN_ID, subject: 'CSV Newsletter caricato', send_time: null }] });
});

const updateJobs = new Map();

router.post('/api/upload-newsletter-csv', (req, res) => {
  try {
    const csvText = String(req.body?.csvText || '');
    if (!csvText.trim()) return res.status(400).json({ success: false, error: 'CSV vuoto' });
    const out = dataCache.importNewsletterCsv(csvText);
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/api/upload-newsletter-contacts', (req, res) => {
  try {
    const contacts = req.body?.contacts;
    if (!Array.isArray(contacts)) {
      return res.status(400).json({ success: false, error: 'Formato contatti non valido' });
    }
    const replace = !!req.body?.replace;
    const out = dataCache.importNewsletterContacts(contacts, { replace });
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/api/update-newsletter', (req, res) => {
  const jobId = 'nu_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  updateJobs.set(jobId, { status: 'pending', createdAt: Date.now() });
  const mode = parseEngagementType(req.body?.engagementType || loadUiConfig().mailchimpEngagementType || 'open');
  setImmediate(async () => {
    try {
      const result = await dataCache.runUpdateNewsletter(mode);
      const job = updateJobs.get(jobId);
      if (job) {
        job.status = 'done';
        job.result = result;
      }
    } catch (err) {
      const job = updateJobs.get(jobId);
      if (job) {
        job.status = 'error';
        job.error = err.message;
      }
    }
  });
  res.json({ success: true, jobId });
});

router.post('/api/update-newsletter/force', (req, res) => {
  const jobId = 'nuf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  updateJobs.set(jobId, { status: 'pending', createdAt: Date.now() });
  setImmediate(async () => {
    try {
      const result = await dataCache.runForceRebuildNewsletterCache();
      const job = updateJobs.get(jobId);
      if (job) {
        job.status = 'done';
        job.result = result;
      }
    } catch (err) {
      const job = updateJobs.get(jobId);
      if (job) {
        job.status = 'error';
        job.error = err.message;
      }
    }
  });
  res.json({ success: true, jobId });
});

router.get('/api/update-newsletter/status/:jobId', (req, res) => {
  const job = updateJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job non trovato o scaduto' });
  if (job.status === 'done') {
    res.json({ success: true, status: 'done', ...job.result });
  } else if (job.status === 'error') {
    res.json({ success: false, status: 'error', error: job.error });
  } else {
    res.json({ success: true, status: 'pending' });
  }
});

router.post('/api/update-prenotazioni', (req, res) => {
  const jobId = 'pr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  updateJobs.set(jobId, { status: 'pending', createdAt: Date.now() });
  setImmediate(async () => {
    try {
      const result = await dataCache.runUpdatePrenotazioni();
      const job = updateJobs.get(jobId);
      if (job) {
        job.status = 'done';
        job.result = result;
      }
    } catch (err) {
      const job = updateJobs.get(jobId);
      if (job) {
        job.status = 'error';
        job.error = err.message;
      }
    }
  });
  res.json({ success: true, jobId });
});

router.post('/api/update-prenotazioni-api', async (req, res) => {
  try {
    const planyo = require('./services/planyo');
    const months = 18;
    const byEmail = await planyo.loadReservationsByEmail(months);
    const totalReservations = [...byEmail.values()].reduce((sum, e) => sum + (e.reservations?.length || 0), 0);
    res.json({
      success: true,
      months,
      updatedAt: new Date().toISOString(),
      contacts: byEmail.size,
      reservations: totalReservations
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/exclude-target/build', async (req, res) => {
  try {
    if (!process.env.PLANYO_API_KEY) {
      return res.status(400).json({ success: false, error: 'PLANYO_API_KEY non configurata' });
    }
    const targetResourceId = parseTargetResourceIdsParam(req.body?.targetResourceId);
    const targetId = targetResourceId ?? getConfiguredTargetResourceId();
    await validateExcludeTargetSetup(true, targetId);
    const planyo = require('./services/planyo');
    const segmented = await planyo.getCachedListAAndB(targetId, config.monthsLookback);
    res.json({
      success: true,
      targetResourceId: formatTargetResourceIds(targetId, ''),
      excludedContacts: segmented.emailsInA.size,
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/api/update-prenotazioni/status/:jobId', (req, res) => {
  const job = updateJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job non trovato o scaduto' });
  if (job.status === 'done') {
    res.json({ success: true, status: 'done', ...job.result });
  } else if (job.status === 'error') {
    res.json({ success: false, status: 'error', error: job.error });
  } else {
    res.json({ success: true, status: 'pending' });
  }
});

router.post('/api/run', async (req, res) => {
  res.setTimeout(30 * 60 * 1000);
  const body_ = req.body || {};
  const { campaignIds, campaignId, lastN = 2, segments = ['A', 'B', 'C'], dryRun = false, prepareOnly = false, targetResourceId, eventIds, smsText, engagementType, excludeTargetBooked } = body_;
  const customSmsText = (typeof smsText === 'string' && smsText.trim()) ? smsText.trim().slice(0, 160) : null;
  if (!customSmsText) {
    return res.status(400).json({ success: false, error: 'Testo SMS obbligatorio' });
  }
  const listDFilters = parseListDFilters(body_);
  const forceReportOnly = !!(listDFilters && listDFilters.eventNameContains);
  const excludeTarget = forceReportOnly ? false : parseBoolParam(excludeTargetBooked);
  const targetId = targetResourceId != null ? targetResourceId : getConfiguredTargetResourceId();
  try {
    await validateExcludeTargetSetup(excludeTarget, targetId);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  const cap = captureLogs(async () => {
    const seg = forceReportOnly ? ['D'] : (Array.isArray(segments) ? segments : [segments]);
    const segFilter = seg.length > 0 ? seg.filter((s) => ['A', 'B', 'C', 'D'].includes(String(s).toUpperCase())) : null;
    const onlyD = segFilter && segFilter.length === 1 && segFilter[0].toUpperCase() === 'D';

    let ids = [];
    if (onlyD && process.env.PLANYO_LISTD_CSV_URL) {
      ids = ['list-d-only'];
    } else if (campaignIds && Array.isArray(campaignIds) && campaignIds.length > 0) {
      ids = campaignIds.slice(0, 2);
    } else if (campaignId) {
      ids = [campaignId];
    } else {
      ids = [dataCache.UPLOADED_CAMPAIGN_ID];
    }
    if (ids.length === 0) throw new Error('Nessuna campagna trovata (o Lista D senza PLANYO_LISTD_CSV_URL)');

    const evIds = parseEventIdsParam(eventIds);

    const mode = parseEngagementType(engagementType || loadUiConfig().mailchimpEngagementType || 'open');
    runAbortRequested = false;
    const abortCheck = () => runAbortRequested;
    let total = { inserted: 0, notInserted: 0, duplicates: 0, skipped: 0 };
    for (const id of ids) {
      if (abortCheck()) break;
      const r = await runNewsletterSmsJob(id, { dryRun, prepareOnly: parseBoolParam(prepareOnly), segments: segFilter, targetResourceId: targetId, eventIds: forceReportOnly ? null : evIds, listDFilters, smsText: customSmsText, abortCheck, engagementType: mode, excludeTargetBooked: excludeTarget });
      total.inserted += r.inserted || 0;
      total.notInserted += r.notInserted || 0;
      total.duplicates += r.duplicates || 0;
      total.skipped += r.skipped || 0;
      if (ids.length > 1) await new Promise((r) => setTimeout(r, 2000));
    }
    return total;
  });

  const out = await cap.run();
  res.json({ ...out, aborted: runAbortRequested });
});

router.post('/api/run/abort', (_req, res) => {
  runAbortRequested = true;
  res.json({ ok: true, message: 'Annullamento richiesto' });
});

router.post('/api/test', async (req, res) => {
  const { phone, smsText: customText } = req.body || {};
  if (!phone || !String(phone).replace(/\D/g, '').length) {
    return res.status(400).json({ success: false, error: 'Numero telefono richiesto' });
  }
  const smsText = (typeof customText === 'string' && customText.trim()) ? customText.trim().slice(0, 160) : '';
  if (!smsText) {
    return res.status(400).json({ success: false, error: 'Testo SMS obbligatorio' });
  }
  try {
    const suffix = ' [' + Date.now().toString(36).slice(-6) + ']';
    const text = smsText.length + suffix.length <= 160 ? smsText + suffix : smsText.slice(0, 160 - suffix.length) + suffix;
    const result = await smshosting.sendSms(phone, text);
    res.json({
      success: result.success,
      error: result.error,
      message: result.success ? 'SMS inviato con successo' : (result.error || 'Invio fallito')
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/check-phone', async (req, res) => {
  if (!requireCacheReady(res)) return;
  const { phone, campaignId, lastN = 2, targetResourceId, engagementType } = req.body || {};
  if (!phone || !String(phone).replace(/\D/g, '').length) {
    return res.status(400).json({ success: false, error: 'Numero telefono richiesto' });
  }
  try {
    let cid = campaignId;
    if (!cid) cid = dataCache.UPLOADED_CAMPAIGN_ID;
    const targetId = targetResourceId != null ? targetResourceId : getConfiguredTargetResourceId();
    const mode = parseEngagementType(engagementType || loadUiConfig().mailchimpEngagementType || 'open');
    const result = await checkPhoneInLists(cid, phone, { targetResourceId: targetId, engagementType: mode });
    res.json({
      success: true,
      found: result.found,
      segment: result.segment,
      email: result.email,
      message: result.found ? `Trovato in Lista ${result.segment} (${result.email})` : 'Numero non trovato in nessuna lista'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Newsletter EMAIL API ---

function escapeCsv(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function toRegistryTimestamp(date = new Date()) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function sanitizeRegistryValue(v) {
  return String(v ?? '').replace(/\r?\n/g, '\n').trim();
}

function normalizeRegistryRows(rows, fallbackSubject = '', fallbackBody = '') {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const raw of rows) {
    const email = String(raw?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) continue;
    out.push({
      nome: sanitizeRegistryValue(raw?.nome),
      cognome: sanitizeRegistryValue(raw?.cognome),
      email,
      telefono: sanitizeRegistryValue(raw?.telefono),
      oggetto_email: sanitizeRegistryValue(raw?.oggetto_email || fallbackSubject),
      contenuto_email: sanitizeRegistryValue(raw?.contenuto_email || fallbackBody),
      data_invio_sms: sanitizeRegistryValue(raw?.data_invio_sms),
      data_invio_email: sanitizeRegistryValue(raw?.data_invio_email),
      stato_invio_email: sanitizeRegistryValue(raw?.stato_invio_email),
      errore_invio_email: sanitizeRegistryValue(raw?.errore_invio_email),
      ultimo_aggiornamento: sanitizeRegistryValue(raw?.ultimo_aggiornamento)
    });
  }
  return out;
}

function buildRegistryRowsFromData(data, subject, body, sentSet = new Set()) {
  const rows = [];
  const seen = new Set();
  for (const r of data || []) {
    const email = String(r?.email || '').trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const alreadySent = sentSet.has(email);
    rows.push({
      nome: sanitizeRegistryValue(r?.nome),
      cognome: sanitizeRegistryValue(r?.cognome),
      email,
      telefono: sanitizeRegistryValue(r?.telefono),
      oggetto_email: sanitizeRegistryValue(subject),
      contenuto_email: sanitizeRegistryValue(body),
      data_invio_sms: sanitizeRegistryValue(r?.data_invio_sms),
      data_invio_email: alreadySent ? sanitizeRegistryValue(r?.data_invio_email) : '',
      stato_invio_email: alreadySent ? 'inviata' : '',
      errore_invio_email: '',
      ultimo_aggiornamento: ''
    });
  }
  return rows;
}

function registryRowsToCsv(rows) {
  const header = 'nome,cognome,email,telefono,oggetto_email,contenuto_email,data_invio_sms,data_invio_email,stato_invio_email,errore_invio_email,ultimo_aggiornamento';
  const lines = (rows || []).map((r) => [
    escapeCsv(r.nome),
    escapeCsv(r.cognome),
    escapeCsv(r.email),
    escapeCsv(r.telefono),
    escapeCsv(r.oggetto_email),
    escapeCsv(r.contenuto_email),
    escapeCsv(r.data_invio_sms),
    escapeCsv(r.data_invio_email),
    escapeCsv(r.stato_invio_email),
    escapeCsv(r.errore_invio_email),
    escapeCsv(r.ultimo_aggiornamento)
  ].join(','));
  return '\uFEFF' + header + '\n' + lines.join('\n');
}

function parseSegmentsParam(val) {
  if (!val) return null;
  const arr = Array.isArray(val) ? val : (typeof val === 'string' ? val.split(',') : []);
  const seg = arr.map((s) => String(s).toUpperCase()).filter((s) => ['A', 'B', 'C', 'D'].includes(s));
  return seg.length > 0 ? seg : null;
}

function parseEventIdsParam(val) {
  if (val === undefined || val === null || val === '') return null;
  const str = String(val).trim();
  if (!str) return null;
  const ids = str.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
  return ids.length > 0 ? ids : null;
}

function parseTargetResourceIdsParam(val) {
  if (val === undefined || val === null) return null;
  const str = String(val).trim();
  if (!str) return [];
  const ids = str.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
  return ids;
}

function formatTargetResourceIds(idsOrValue, fallback = '') {
  if (Array.isArray(idsOrValue)) return idsOrValue.join(',');
  if (idsOrValue == null) return fallback;
  const str = String(idsOrValue).trim();
  return str;
}

function parseEngagementType(val) {
  return String(val || 'open').toLowerCase().trim() === 'click' ? 'click' : 'open';
}

function parseBoolParam(val) {
  return val === true || val === 'true' || val === '1' || val === 1 || val === 'on';
}

async function validateExcludeTargetSetup(excludeTargetBooked, targetResourceId) {
  if (!excludeTargetBooked) return;
  const targetIds = parseTargetResourceIdsParam(targetResourceId);
  if (!targetIds || targetIds.length === 0) {
    throw new Error('ID evento inesistente: inserisci un ID evento Planyo valido.');
  }
  const planyo = require('./services/planyo');
  const check = await planyo.validateTargetResourceIds(targetIds);
  if (!check.ok) {
    const idsText = (check.missing || []).join(', ');
    throw new Error('ID evento inesistente su Planyo: ' + idsText);
  }
}

async function getListAExclusions(targetResourceId) {
  const empty = { emailsInA: new Set() };
  if (!process.env.PLANYO_API_KEY) return empty;
  try {
    const planyo = require('./services/planyo');
    const { emailsInA } = await planyo.getCachedListAAndB(targetResourceId, config.monthsLookback);
    return { emailsInA };
  } catch (err) {
    console.warn('[ListaD] Impossibile calcolare esclusioni Lista A:', err.message);
    return empty;
  }
}

function parseListDFilters(query) {
  const eventNameContains = (query.listDEventNameContains || '').trim() || undefined;
  const eventIds = parseEventIdsParam(query.listDEventIds);
  const statuses = query.listDStatuses ? (Array.isArray(query.listDStatuses) ? query.listDStatuses : String(query.listDStatuses).split(',')).map((s) => s.trim()).filter(Boolean) : undefined;
  return { eventNameContains, eventIds, statuses };
}

function requireCacheReady(res) {
  if (!dataCache.isReadyForOperations()) {
    res.status(400).json({
      success: false,
      error: 'Aggiorna prima Newsletter e Prenotazioni per procedere.',
      code: 'CACHE_NOT_READY'
    });
    return false;
  }
  return true;
}

const previewJobs = new Map();
const JOB_TTL_MS = 15 * 60 * 1000;

function getJobId() {
  return 'j_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}

function cleanupOldJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of previewJobs) {
    if (job.createdAt < cutoff) previewJobs.delete(id);
  }
}

router.post('/api/sms/preview/start', async (req, res) => {
  try {
    const q = req.body || req.query || {};
    const campaignId = q.campaignId;
    const targetResourceId = parseTargetResourceIdsParam(q.targetResourceId);
    const engagementType = parseEngagementType(q.engagementType || loadUiConfig().mailchimpEngagementType || 'open');
    const excludeTargetBooked = parseBoolParam(q.excludeTargetBooked);
    const eventIds = parseEventIdsParam(q.eventIds);
    const segments = parseSegmentsParam(q.segments);
    const listDFilters = parseListDFilters(q);
    const forceReportOnly = !!(listDFilters && listDFilters.eventNameContains);

    const cid = campaignId || dataCache.UPLOADED_CAMPAIGN_ID;

    const targetId = targetResourceId ?? getConfiguredTargetResourceId();
    const effectiveExcludeTarget = forceReportOnly ? false : excludeTargetBooked;
    await validateExcludeTargetSetup(effectiveExcludeTarget, targetId);
    const jobId = getJobId();
    previewJobs.set(jobId, { status: 'pending', createdAt: Date.now() });
    cleanupOldJobs();

    setImmediate(async () => {
      try {
        const result = await getSmsPreview(cid, {
          targetResourceId: targetId,
          eventIds: forceReportOnly ? null : eventIds,
          segments: forceReportOnly ? ['D'] : (segments || ['A', 'B', 'C']),
          listDFilters,
          engagementType,
          excludeTargetBooked: effectiveExcludeTarget
        });
        const job = previewJobs.get(jobId);
        if (job) {
          job.status = 'done';
          job.result = result;
        }
      } catch (err) {
        const job = previewJobs.get(jobId);
        if (job) {
          job.status = 'error';
          job.error = err.message;
        }
      }
    });

    res.json({ success: true, jobId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/api/sms/preview/status/:jobId', (req, res) => {
  const job = previewJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job non trovato o scaduto' });
  if (job.status === 'done') {
    res.json({ success: true, status: 'done', ...job.result });
  } else if (job.status === 'error') {
    res.json({ success: false, status: 'error', error: job.error });
  } else {
    res.json({ success: true, status: 'pending' });
  }
});

router.get('/api/sms/preview', async (req, res) => {
  res.setTimeout(90000);
  try {
    const campaignId = req.query.campaignId;
    const targetResourceId = parseTargetResourceIdsParam(req.query.targetResourceId);
    const engagementType = parseEngagementType(req.query.engagementType || loadUiConfig().mailchimpEngagementType || 'open');
    const excludeTargetBooked = parseBoolParam(req.query.excludeTargetBooked);
    const eventIds = parseEventIdsParam(req.query.eventIds);
    const segments = parseSegmentsParam(req.query.segments);
    const listDFilters = parseListDFilters(req.query);
    const forceReportOnly = !!(listDFilters && listDFilters.eventNameContains);

    const cid = campaignId || dataCache.UPLOADED_CAMPAIGN_ID;

    const targetId = targetResourceId ?? getConfiguredTargetResourceId();
    const effectiveExcludeTarget = forceReportOnly ? false : excludeTargetBooked;
    await validateExcludeTargetSetup(effectiveExcludeTarget, targetId);
    const result = await getSmsPreview(cid, {
      targetResourceId: targetId,
      eventIds: forceReportOnly ? null : eventIds,
      segments: forceReportOnly ? ['D'] : (segments || ['A', 'B', 'C']),
      listDFilters,
      engagementType,
      excludeTargetBooked: effectiveExcludeTarget
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/email/preview/start', (req, res) => {
  try {
    const q = req.body || req.query || {};
    const campaignId = q.campaignId;
    const targetResourceId = parseTargetResourceIdsParam(q.targetResourceId);
    const engagementType = parseEngagementType(q.engagementType || loadUiConfig().mailchimpEngagementType || 'open');
    const eventFilter = (q.eventFilter || '').trim();
    const eventIds = parseEventIdsParam(q.eventIds);
    const segments = parseSegmentsParam(q.segments);
    const listDFilters = parseListDFilters(q);
    const excludeTargetBooked = parseBoolParam(q.excludeTargetBooked);
    const limit = parseInt(q.limit || '100', 10);

    const onlyD = segments && segments.length === 1 && segments[0].toUpperCase() === 'D';
    const cid = campaignId || dataCache.UPLOADED_CAMPAIGN_ID;

    const jobId = getJobId();
    const targetId = targetResourceId ?? getConfiguredTargetResourceId();
    previewJobs.set(jobId, { status: 'pending', createdAt: Date.now() });
    cleanupOldJobs();

    setImmediate(async () => {
      try {
        const excludeListA = excludeTargetBooked ? await getListAExclusions(targetId) : { emailsInA: new Set() };
        let data = onlyD ? [] : await buildEmailListData(cid, { targetResourceId: targetId, engagementType });
        data = filterByEventIds(data, eventIds);
        data = filterBySegment(data, segments);
        data = filterByEvent(data, eventFilter);
        data = await mergeListDFromCsv(data, segments || ['A', 'B', 'C', 'D'], listDFilters, excludeListA);
        const total = data.length;
        const block = takeBlock(data, limit);
        const preview = block.slice(0, 10);
        const limitInfo = emailService.checkDailyLimit();
        const job = previewJobs.get(jobId);
        if (job) {
          job.status = 'done';
          job.result = { total, limit: block.length, preview, dailyLimit: { sent: limitInfo.today, remaining: limitInfo.remaining, max: emailService.DAILY_LIMIT } };
        }
      } catch (err) {
        const job = previewJobs.get(jobId);
        if (job) {
          job.status = 'error';
          job.error = err.message;
        }
      }
    });

    res.json({ success: true, jobId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/api/email/preview/status/:jobId', (req, res) => {
  const job = previewJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job non trovato o scaduto' });
  if (job.status === 'done') {
    res.json({ success: true, status: 'done', ...job.result });
  } else if (job.status === 'error') {
    res.json({ success: false, status: 'error', error: job.error });
  } else {
    res.json({ success: true, status: 'pending' });
  }
});

router.get('/api/email/export', async (req, res) => {
  res.setTimeout(90000);
  try {
    const campaignId = req.query.campaignId;
    const targetResourceId = parseTargetResourceIdsParam(req.query.targetResourceId);
    const engagementType = parseEngagementType(req.query.engagementType || loadUiConfig().mailchimpEngagementType || 'open');
    const eventFilter = (req.query.eventFilter || '').trim();
    const eventIds = parseEventIdsParam(req.query.eventIds);
    const segments = parseSegmentsParam(req.query.segments);
    const listDFilters = parseListDFilters(req.query);
    const excludeTargetBooked = parseBoolParam(req.query.excludeTargetBooked);
    const basicFields = parseBoolParam(req.query.basicFields);
    const cleanFields = parseBoolParam(req.query.cleanFields);
    const registryMode = parseBoolParam(req.query.registry);
    const subject = String(req.query.subject || '').trim();
    const emailBody = String(req.query.body || '').trim();

    const onlyD = segments && segments.length === 1 && segments[0].toUpperCase() === 'D';
    const cid = campaignId || dataCache.UPLOADED_CAMPAIGN_ID;

    const targetId = targetResourceId ?? getConfiguredTargetResourceId();
    const excludeListA = excludeTargetBooked ? await getListAExclusions(targetId) : { emailsInA: new Set() };
    let data = onlyD ? [] : await buildEmailListData(cid, { targetResourceId: targetId, engagementType });
    data = filterByEventIds(data, eventIds);
    data = filterBySegment(data, segments);
    data = filterByEvent(data, eventFilter);
    data = await mergeListDFromCsv(data, segments || ['A', 'B', 'C', 'D'], listDFilters, excludeListA);

    let csv;
    let filename;
    if (registryMode) {
      const registryRows = buildRegistryRowsFromData(data, subject, emailBody, new Set());
      csv = registryRowsToCsv(registryRows);
      filename = 'REGISTRO_INVII_EMAIL_' + new Date().toISOString().slice(0, 10) + '.csv';
    } else if (cleanFields) {
      const header = 'nome,cognome,email,indirizzo';
      const rows = data.map((r) => [escapeCsv(r.nome), escapeCsv(r.cognome), escapeCsv(r.email), escapeCsv(r.email)].join(','));
      csv = '\uFEFF' + header + '\n' + rows.join('\n');
      filename = 'newsletter-contatti.csv';
    } else {
      const header = basicFields ? 'nome,cognome,email,telefono' : 'nome,cognome,email,telefono,evento,segment';
      const rows = data.map((r) => {
        const base = [escapeCsv(r.nome), escapeCsv(r.cognome), escapeCsv(r.email), escapeCsv(r.telefono)];
        if (basicFields) return base.join(',');
        return [...base, escapeCsv(r.eventoPrenotato), escapeCsv(r.segment)].join(',');
      });
      csv = '\uFEFF' + header + '\n' + rows.join('\n');
      filename = 'newsletter-email-export.csv';
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/api/email/preview', async (req, res) => {
  res.setTimeout(90000);
  try {
    const campaignId = req.query.campaignId;
    const targetResourceId = parseTargetResourceIdsParam(req.query.targetResourceId);
    const engagementType = parseEngagementType(req.query.engagementType || loadUiConfig().mailchimpEngagementType || 'open');
    const eventFilter = (req.query.eventFilter || '').trim();
    const eventIds = parseEventIdsParam(req.query.eventIds);
    const segments = parseSegmentsParam(req.query.segments);
    const listDFilters = parseListDFilters(req.query);
    const excludeTargetBooked = parseBoolParam(req.query.excludeTargetBooked);
    const limit = parseInt(req.query.limit || '100', 10);

    const onlyD = segments && segments.length === 1 && segments[0].toUpperCase() === 'D';
    const cid = campaignId || dataCache.UPLOADED_CAMPAIGN_ID;

    const targetId = targetResourceId ?? getConfiguredTargetResourceId();
    const excludeListA = excludeTargetBooked ? await getListAExclusions(targetId) : { emailsInA: new Set() };
    let data = onlyD ? [] : await buildEmailListData(cid, { targetResourceId: targetId, engagementType });
    data = filterByEventIds(data, eventIds);
    data = filterBySegment(data, segments);
    data = filterByEvent(data, eventFilter);
    data = await mergeListDFromCsv(data, segments || ['A', 'B', 'C', 'D'], listDFilters, excludeListA);
    const total = data.length;
    const block = takeBlock(data, limit);
    const preview = block.slice(0, 10);

    const limitInfo = emailService.checkDailyLimit();

    res.json({
      success: true,
      total,
      limit: block.length,
      preview,
      dailyLimit: { sent: limitInfo.today, remaining: limitInfo.remaining, max: emailService.DAILY_LIMIT }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/api/listd/debug', async (req, res) => {
  try {
    const listDFilters = parseListDFilters(req.query);
    const debug = await planyoReportCsv.debugListD(listDFilters);
    res.json(debug);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/email/batch-status', (req, res) => {
  try {
    const subject = (req.query.subject || '').trim();
    const campaignId = (req.query.campaignId || '').trim();
    const segments = parseSegmentsParam(req.query.segments);
    const listDFilters = parseListDFilters(req.query);
    const engagementType = parseEngagementType(req.query.engagementType || loadUiConfig().mailchimpEngagementType || 'open');
    const batchId = emailService.getBatchId({
      subject,
      campaignId,
      segments,
      engagementType,
      listDEventNameContains: listDFilters.eventNameContains,
      listDStatuses: listDFilters.statuses?.join(',')
    });
    const sentCount = emailService.getSentForBatch(batchId).size;
    const limitInfo = emailService.checkDailyLimit();
    res.json({
      batchId,
      batchSent: sentCount,
      dailyRemaining: limitInfo.remaining,
      dailyLimit: emailService.DAILY_LIMIT
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/email/test', async (req, res) => {
  const { email, subject, body } = req.body || {};
  if (!email || !String(email).trim().includes('@')) {
    return res.status(400).json({ success: false, error: 'Indirizzo email richiesto' });
  }
  if (!subject || !body) {
    return res.status(400).json({ success: false, error: 'Oggetto e messaggio richiesti' });
  }
  try {
    await emailService.sendTestEmail({
      to: email.trim(),
      subject: subject.trim(),
      body: body.trim()
    });
    res.json({ success: true, message: 'Email di prova inviata con successo' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

let emailAbortRequested = false;

router.post('/api/email/send', async (req, res) => {
  if (!requireCacheReady(res)) return;
  res.setTimeout(60 * 60 * 1000);
  const body_ = req.body || {};
  const { campaignId, targetResourceId, eventFilter, eventIds, segments, limit = 100, subject, body: emailBody, engagementType, excludeTargetBooked } = body_;
  const listDFilters = parseListDFilters(body_);
  const segFilter = parseSegmentsParam(segments);
  const evIds = parseEventIdsParam(eventIds);
  const onlyD = segFilter && segFilter.length === 1 && segFilter[0].toUpperCase() === 'D';

  if (!subject || !emailBody) {
    return res.status(400).json({ success: false, error: 'subject e body richiesti' });
  }
  if (onlyD && !process.env.PLANYO_LISTD_CSV_URL) {
    return res.status(400).json({ success: false, error: 'PLANYO_LISTD_CSV_URL richiesto per invio solo Lista D' });
  }

  const limitNum = Math.min(Math.max(parseInt(String(limit), 10) || 100, 100), 500);
  const limitInfo = emailService.checkDailyLimit();
  if (limitInfo.remaining <= 0) {
    return res.status(400).json({
      success: false,
      error: `Limite giornaliero raggiunto (500/giorno). Inviati oggi: ${limitInfo.today}. Riprova domani.`
    });
  }

  const batchId = emailService.getBatchId({
    subject,
    campaignId: campaignId || '',
    segments: segFilter,
    engagementType: parseEngagementType(engagementType || loadUiConfig().mailchimpEngagementType || 'open'),
    listDEventNameContains: listDFilters.eventNameContains,
    listDStatuses: listDFilters.statuses?.join(',')
  });
  const sentSet = emailService.getSentForBatch(batchId);
  const maxToSend = Math.min(limitNum, limitInfo.remaining);

  const cap = captureLogs(async () => {
    const targetId = targetResourceId != null ? targetResourceId : getConfiguredTargetResourceId();
    const mode = parseEngagementType(engagementType || loadUiConfig().mailchimpEngagementType || 'open');
    const excludeListA = parseBoolParam(excludeTargetBooked) ? await getListAExclusions(targetId) : { emailsInA: new Set() };
    let data = onlyD ? [] : await buildEmailListData(campaignId || dataCache.UPLOADED_CAMPAIGN_ID, { targetResourceId: targetId, engagementType: mode });
    data = filterByEventIds(data, evIds);
    data = filterBySegment(data, segFilter);
    data = filterByEvent(data, (eventFilter || '').trim());
    data = await mergeListDFromCsv(data, segFilter || ['A', 'B', 'C', 'D'], listDFilters, excludeListA);
    const registryRows = buildRegistryRowsFromData(data, subject, emailBody, sentSet);
    const pendingData = data.filter((r) => !sentSet.has((r.email || '').toLowerCase()));
    const toSend = takeBlock(pendingData, maxToSend);

    emailAbortRequested = false;
    let sent = 0;
    let failed = 0;
    const successfullySent = [];

    for (const row of toSend) {
      if (emailAbortRequested) break;
      try {
        await emailService.sendPersonalizedEmail({
          to: row.email,
          subject,
          body: emailBody,
          data: row
        });
        sent++;
        successfullySent.push(row.email);
        const rr = registryRows.find((x) => x.email === String(row.email || '').toLowerCase());
        if (rr) {
          rr.data_invio_email = toRegistryTimestamp();
          rr.stato_invio_email = 'inviata';
          rr.errore_invio_email = '';
          rr.ultimo_aggiornamento = rr.data_invio_email;
        }
        if (sent % 50 === 0) console.log('[Email] Inviati:', sent);
      } catch (err) {
        failed++;
        console.error('[Email] Errore per', row.email, err.message);
        const rr = registryRows.find((x) => x.email === String(row.email || '').toLowerCase());
        if (rr) {
          rr.stato_invio_email = 'errore';
          rr.errore_invio_email = String(err.message || '').slice(0, 500);
          rr.ultimo_aggiornamento = toRegistryTimestamp();
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (successfullySent.length > 0) {
      emailService.addSentToBatch(batchId, successfullySent, subject);
    }

    return {
      sent,
      failed,
      total: toSend.length,
      batchSent: sentSet.size + successfullySent.length,
      batchRemaining: pendingData.length - successfullySent.length,
      registryCsv: registryRowsToCsv(registryRows),
      registryFilename: 'REGISTRO_INVII_EMAIL_' + new Date().toISOString().slice(0, 10) + '.csv'
    };
  });

  const out = await cap.run();
  res.json({ ...out, aborted: emailAbortRequested });
});

router.post('/api/email/send-from-registry', async (req, res) => {
  res.setTimeout(60 * 60 * 1000);
  try {
    const body = req.body || {};
    const rows = normalizeRegistryRows(body.rows || []);
    const limit = Math.min(Math.max(parseInt(String(body.limit), 10) || 100, 1), 500);
    if (!rows.length) {
      return res.status(400).json({ success: false, error: 'Registro vuoto o non valido' });
    }

    const limitInfo = emailService.checkDailyLimit();
    if (limitInfo.remaining <= 0) {
      return res.status(400).json({
        success: false,
        error: `Limite giornaliero raggiunto (500/giorno). Inviati oggi: ${limitInfo.today}. Riprova domani.`
      });
    }
    const maxToSend = Math.min(limit, limitInfo.remaining);
    const pending = rows.filter((r) => {
      const st = String(r.stato_invio_email || '').toLowerCase();
      return st !== 'inviata';
    }).slice(0, maxToSend);

    emailAbortRequested = false;
    let sent = 0;
    let failed = 0;
    for (const row of pending) {
      if (emailAbortRequested) break;
      try {
        const subject = row.oggetto_email || '';
        const text = row.contenuto_email || '';
        if (!subject || !text) {
          throw new Error('Oggetto o contenuto email mancanti nel registro');
        }
        await emailService.sendPersonalizedEmail({
          to: row.email,
          subject,
          body: text,
          data: row
        });
        sent++;
        row.data_invio_email = toRegistryTimestamp();
        row.stato_invio_email = 'inviata';
        row.errore_invio_email = '';
        row.ultimo_aggiornamento = row.data_invio_email;
      } catch (err) {
        failed++;
        row.stato_invio_email = 'errore';
        row.errore_invio_email = String(err.message || '').slice(0, 500);
        row.ultimo_aggiornamento = toRegistryTimestamp();
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    return res.json({
      success: true,
      result: {
        sent,
        failed,
        total: pending.length,
        remaining: rows.filter((r) => String(r.stato_invio_email || '').toLowerCase() !== 'inviata').length,
        registryCsv: registryRowsToCsv(rows),
        registryFilename: 'REGISTRO_INVII_EMAIL_' + new Date().toISOString().slice(0, 10) + '.csv'
      },
      aborted: emailAbortRequested
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/email/abort', (_req, res) => {
  emailAbortRequested = true;
  res.json({ ok: true, message: 'Annullamento richiesto' });
});

module.exports = router;
