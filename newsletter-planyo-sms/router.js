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
const config = require('./config/segments');

const PUBLIC_PATH = path.join(__dirname, 'public');
const UI_CONFIG_FILE = path.join(__dirname, 'data', 'ui-config.json');

router.use(express.json());

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

// API
router.get('/api/config', (req, res) => {
  try {
    const cfg = loadUiConfig();
    const targetResourceId = cfg.targetResourceId ?? config.targetResourceId ?? 236955;
    res.json({ success: true, targetResourceId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/config', (req, res) => {
  try {
    const { targetResourceId } = req.body || {};
    const id = parseInt(String(targetResourceId || ''), 10);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({ success: false, error: 'ID risorsa non valido' });
    }
    const cfg = loadUiConfig();
    cfg.targetResourceId = id;
    saveUiConfig(cfg);
    res.json({ success: true, targetResourceId: id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/api/campaigns', async (req, res) => {
  try {
    const count = parseInt(req.query.last || '5', 10) || 5;
    const campaigns = await mailchimp.getLastSentCampaigns(count);
    res.json({ success: true, campaigns });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/api/run', async (req, res) => {
  res.setTimeout(30 * 60 * 1000);
  const body_ = req.body || {};
  const { campaignIds, campaignId, lastN = 2, segments = ['A', 'B', 'C'], dryRun = false, targetResourceId, eventIds, smsText } = body_;
  const listDFilters = parseListDFilters(body_);

  const cap = captureLogs(async () => {
    const seg = Array.isArray(segments) ? segments : [segments];
    const segFilter = seg.length > 0 ? seg.filter((s) => ['A', 'B', 'C', 'D'].includes(String(s).toUpperCase())) : null;
    const onlyD = segFilter && segFilter.length === 1 && segFilter[0].toUpperCase() === 'D';

    let ids = [];
    if (onlyD && process.env.PLANYO_LISTD_CSV_URL) {
      ids = ['list-d-only'];
    } else if (campaignIds && Array.isArray(campaignIds) && campaignIds.length > 0) {
      ids = campaignIds.slice(0, 5);
    } else if (campaignId) {
      ids = [campaignId];
    } else {
      const campaigns = await mailchimp.getLastSentCampaigns(lastN);
      ids = campaigns.map((c) => c.id);
    }
    if (ids.length === 0) throw new Error('Nessuna campagna trovata (o Lista D senza PLANYO_LISTD_CSV_URL)');

    const evIds = parseEventIdsParam(eventIds);

    const targetId = targetResourceId != null ? Number(targetResourceId) : (loadUiConfig().targetResourceId ?? config.targetResourceId);
    const customSmsText = (typeof smsText === 'string' && smsText.trim()) ? smsText.trim().slice(0, 160) : null;
    runAbortRequested = false;
    const abortCheck = () => runAbortRequested;
    let total = { inserted: 0, notInserted: 0, duplicates: 0, skipped: 0 };
    for (const id of ids) {
      if (abortCheck()) break;
      const r = await runNewsletterSmsJob(id, { dryRun, segments: segFilter, targetResourceId: targetId, eventIds: evIds, listDFilters, smsText: customSmsText, abortCheck });
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
  try {
    const baseText = (typeof customText === 'string' && customText.trim()) ? customText.trim().slice(0, 160) : config.smsTexts.listB;
    const suffix = ' [' + Date.now().toString(36).slice(-6) + ']';
    const text = baseText.length + suffix.length <= 160 ? baseText + suffix : baseText.slice(0, 160 - suffix.length) + suffix;
    const result = await smshosting.sendSms(phone, text, { from: '' });
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
  const { phone, campaignId, lastN = 2, targetResourceId } = req.body || {};
  if (!phone || !String(phone).replace(/\D/g, '').length) {
    return res.status(400).json({ success: false, error: 'Numero telefono richiesto' });
  }
  try {
    let cid = campaignId;
    if (!cid) {
      const campaigns = await mailchimp.getLastSentCampaigns(lastN);
      cid = campaigns[0]?.id;
    }
    if (!cid) return res.status(400).json({ success: false, error: 'Nessuna campagna disponibile' });
    const targetId = targetResourceId != null ? Number(targetResourceId) : (loadUiConfig().targetResourceId ?? config.targetResourceId);
    const result = await checkPhoneInLists(cid, phone, { targetResourceId: targetId });
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

function parseListDFilters(query) {
  const eventNameContains = (query.listDEventNameContains || '').trim() || undefined;
  const eventIds = parseEventIdsParam(query.listDEventIds);
  const statuses = query.listDStatuses ? (Array.isArray(query.listDStatuses) ? query.listDStatuses : String(query.listDStatuses).split(',')).map((s) => s.trim()).filter(Boolean) : undefined;
  return { eventNameContains, eventIds, statuses };
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

router.post('/api/sms/preview/start', (req, res) => {
  try {
    const q = req.body || req.query || {};
    const campaignId = q.campaignId;
    const targetResourceId = q.targetResourceId ? parseInt(q.targetResourceId, 10) : null;
    const eventIds = parseEventIdsParam(q.eventIds);
    const segments = parseSegmentsParam(q.segments);
    const listDFilters = parseListDFilters(q);

    if (!campaignId && (!segments || !segments.includes('D'))) {
      return res.status(400).json({ success: false, error: 'campaignId richiesto (tranne per Lista D sola)' });
    }

    const jobId = getJobId();
    const targetId = targetResourceId ?? loadUiConfig().targetResourceId ?? config.targetResourceId;
    previewJobs.set(jobId, { status: 'pending', createdAt: Date.now() });
    cleanupOldJobs();

    setImmediate(async () => {
      try {
        const result = await getSmsPreview(campaignId || 'dummy', {
          targetResourceId: targetId,
          eventIds,
          segments: segments || ['A', 'B', 'C'],
          listDFilters
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
    const targetResourceId = req.query.targetResourceId ? parseInt(req.query.targetResourceId, 10) : null;
    const eventIds = parseEventIdsParam(req.query.eventIds);
    const segments = parseSegmentsParam(req.query.segments);
    const listDFilters = parseListDFilters(req.query);

    if (!campaignId && (!segments || !segments.includes('D'))) {
      return res.status(400).json({ success: false, error: 'campaignId richiesto (tranne per Lista D sola)' });
    }

    const targetId = targetResourceId ?? loadUiConfig().targetResourceId ?? config.targetResourceId;
    const result = await getSmsPreview(campaignId || 'dummy', {
      targetResourceId: targetId,
      eventIds,
      segments: segments || ['A', 'B', 'C'],
      listDFilters
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
    const targetResourceId = q.targetResourceId ? parseInt(q.targetResourceId, 10) : null;
    const eventFilter = (q.eventFilter || '').trim();
    const eventIds = parseEventIdsParam(q.eventIds);
    const segments = parseSegmentsParam(q.segments);
    const listDFilters = parseListDFilters(q);
    const limit = parseInt(q.limit || '100', 10);

    const onlyD = segments && segments.length === 1 && segments[0].toUpperCase() === 'D';
    if (!campaignId && !onlyD) {
      return res.status(400).json({ success: false, error: 'campaignId richiesto (tranne per Lista D sola)' });
    }

    const jobId = getJobId();
    const targetId = targetResourceId ?? loadUiConfig().targetResourceId ?? config.targetResourceId;
    previewJobs.set(jobId, { status: 'pending', createdAt: Date.now() });
    cleanupOldJobs();

    setImmediate(async () => {
      try {
        let data = onlyD ? [] : await buildEmailListData(campaignId || 'dummy', { targetResourceId: targetId });
        data = filterByEventIds(data, eventIds);
        data = filterBySegment(data, segments);
        data = filterByEvent(data, eventFilter);
        data = await mergeListDFromCsv(data, segments || ['A', 'B', 'C', 'D'], listDFilters);
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
    const targetResourceId = req.query.targetResourceId ? parseInt(req.query.targetResourceId, 10) : null;
    const eventFilter = (req.query.eventFilter || '').trim();
    const eventIds = parseEventIdsParam(req.query.eventIds);
    const segments = parseSegmentsParam(req.query.segments);
    const listDFilters = parseListDFilters(req.query);

    const onlyD = segments && segments.length === 1 && segments[0].toUpperCase() === 'D';
    if (!campaignId && !onlyD) {
      return res.status(400).json({ success: false, error: 'campaignId richiesto (tranne per Lista D sola)' });
    }

    const targetId = targetResourceId ?? loadUiConfig().targetResourceId ?? config.targetResourceId;
    let data = onlyD ? [] : await buildEmailListData(campaignId || 'dummy', { targetResourceId: targetId });
    data = filterByEventIds(data, eventIds);
    data = filterBySegment(data, segments);
    data = filterByEvent(data, eventFilter);
    data = await mergeListDFromCsv(data, segments || ['A', 'B', 'C', 'D'], listDFilters);

    const header = 'nome,cognome,email,telefono,evento,segment';
    const rows = data.map((r) =>
      [escapeCsv(r.nome), escapeCsv(r.cognome), escapeCsv(r.email), escapeCsv(r.telefono), escapeCsv(r.eventoPrenotato), escapeCsv(r.segment)].join(',')
    );
    const csv = '\uFEFF' + header + '\n' + rows.join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="newsletter-email-export.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/api/email/preview', async (req, res) => {
  res.setTimeout(90000);
  try {
    const campaignId = req.query.campaignId;
    const targetResourceId = req.query.targetResourceId ? parseInt(req.query.targetResourceId, 10) : null;
    const eventFilter = (req.query.eventFilter || '').trim();
    const eventIds = parseEventIdsParam(req.query.eventIds);
    const segments = parseSegmentsParam(req.query.segments);
    const listDFilters = parseListDFilters(req.query);
    const limit = parseInt(req.query.limit || '100', 10);

    const onlyD = segments && segments.length === 1 && segments[0].toUpperCase() === 'D';
    if (!campaignId && !onlyD) {
      return res.status(400).json({ success: false, error: 'campaignId richiesto (tranne per Lista D sola)' });
    }

    const targetId = targetResourceId ?? loadUiConfig().targetResourceId ?? config.targetResourceId;
    let data = onlyD ? [] : await buildEmailListData(campaignId || 'dummy', { targetResourceId: targetId });
    data = filterByEventIds(data, eventIds);
    data = filterBySegment(data, segments);
    data = filterByEvent(data, eventFilter);
    data = await mergeListDFromCsv(data, segments || ['A', 'B', 'C', 'D'], listDFilters);
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
  res.setTimeout(60 * 60 * 1000);
  const body_ = req.body || {};
  const { campaignId, targetResourceId, eventFilter, eventIds, segments, limit = 100, subject, body: emailBody } = body_;
  const listDFilters = parseListDFilters(body_);
  const segFilter = parseSegmentsParam(segments);
  const evIds = parseEventIdsParam(eventIds);
  const onlyD = segFilter && segFilter.length === 1 && segFilter[0].toUpperCase() === 'D';

  if ((!campaignId && !onlyD) || !subject || !emailBody) {
    return res.status(400).json({ success: false, error: 'campaignId (tranne Lista D sola), subject e body richiesti' });
  }
  if (onlyD && !process.env.PLANYO_LISTD_CSV_URL) {
    return res.status(400).json({ success: false, error: 'PLANYO_LISTD_CSV_URL richiesto per invio solo Lista D' });
  }

  const limitNum = Math.min(Math.max(parseInt(String(limit), 10) || 100, 100), 500);
  const limitInfo = emailService.checkDailyLimit();
  if (limitInfo.remaining < limitNum) {
    return res.status(400).json({
      success: false,
      error: `Limite giornaliero raggiunto. Inviati oggi: ${limitInfo.today}, rimanenti: ${limitInfo.remaining}. Max 500/giorno.`
    });
  }

  const cap = captureLogs(async () => {
    const targetId = targetResourceId != null ? Number(targetResourceId) : (loadUiConfig().targetResourceId ?? config.targetResourceId);
    let data = onlyD ? [] : await buildEmailListData(campaignId, { targetResourceId: targetId });
    data = filterByEventIds(data, evIds);
    data = filterBySegment(data, segFilter);
    data = filterByEvent(data, (eventFilter || '').trim());
    data = await mergeListDFromCsv(data, segFilter || ['A', 'B', 'C', 'D'], listDFilters);
    const toSend = takeBlock(data, limitNum);

    emailAbortRequested = false;
    let sent = 0;
    let failed = 0;

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
        if (sent % 50 === 0) console.log('[Email] Inviati:', sent);
      } catch (err) {
        failed++;
        console.error('[Email] Errore per', row.email, err.message);
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    return { sent, failed, total: toSend.length };
  });

  const out = await cap.run();
  res.json({ ...out, aborted: emailAbortRequested });
});

router.post('/api/email/abort', (_req, res) => {
  emailAbortRequested = true;
  res.json({ ok: true, message: 'Annullamento richiesto' });
});

module.exports = router;
