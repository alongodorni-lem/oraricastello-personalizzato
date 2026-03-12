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
const { runNewsletterSmsJob, checkPhoneInLists } = require('./jobs/newsletter-sms-job');
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
  const { campaignIds, campaignId, lastN = 2, segments = ['A', 'B', 'C'], dryRun = false, targetResourceId, smsText } = req.body || {};

  const cap = captureLogs(async () => {
    let ids = [];
    if (campaignIds && Array.isArray(campaignIds) && campaignIds.length > 0) {
      ids = campaignIds.slice(0, 5);
    } else if (campaignId) {
      ids = [campaignId];
    } else {
      const campaigns = await mailchimp.getLastSentCampaigns(lastN);
      ids = campaigns.map((c) => c.id);
    }
    if (ids.length === 0) throw new Error('Nessuna campagna trovata');

    const seg = Array.isArray(segments) ? segments : [segments];
    const segFilter = seg.length > 0 ? seg.filter((s) => ['A', 'B', 'C'].includes(String(s).toUpperCase())) : null;

    const targetId = targetResourceId != null ? Number(targetResourceId) : (loadUiConfig().targetResourceId ?? config.targetResourceId);
    const customSmsText = (typeof smsText === 'string' && smsText.trim()) ? smsText.trim().slice(0, 160) : null;
    runAbortRequested = false;
    const abortCheck = () => runAbortRequested;
    let total = { inserted: 0, notInserted: 0, duplicates: 0, skipped: 0 };
    for (const id of ids) {
      if (abortCheck()) break;
      const r = await runNewsletterSmsJob(id, { dryRun, segments: segFilter, targetResourceId: targetId, smsText: customSmsText, abortCheck });
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

module.exports = router;
