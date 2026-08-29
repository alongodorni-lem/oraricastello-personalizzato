/**
 * Servizio invio email Newsletter via Resend API
 * Placeholder contatto: {{nome}}/$(first_name), {{cognome}}, {{email}}, {{phone}}/$(phone), {{city}}/$(city)
 * Placeholder evento (liste A/B/D): {{evento}}/$(name), {{start_date}}, {{status}}
 * Batch: traccia email già inviate per soggetto+filtri
 */
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const SENT_FILE = path.join(__dirname, '..', 'data', 'newsletter-email-sent.json');
const BATCH_FILE = path.join(__dirname, '..', 'data', 'newsletter-email-batches.json');
const DAILY_LIMIT = Math.max(0, parseInt(process.env.EMAIL_MAX_PER_DAY || '0', 10) || 0);
const EMAIL_RETRY_MAX = Math.max(0, parseInt(process.env.EMAIL_RETRY_MAX || '2', 10) || 2);
const EMAIL_RATE_LIMIT_RETRY_MAX = Math.max(EMAIL_RETRY_MAX, parseInt(process.env.EMAIL_RATE_LIMIT_RETRY_MAX || '8', 10) || 8);
const EMAIL_RETRY_BASE_DELAY_MS = Math.max(0, parseInt(process.env.EMAIL_RETRY_BASE_DELAY_MS || '2500', 10) || 2500);
const RESEND_API_URL = 'https://api.resend.com/emails';
const RESEND_BATCH_API_URL = 'https://api.resend.com/emails/batch';

function getResendConfig() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey) {
    throw new Error('Credenziale Resend mancante (RESEND_API_KEY)');
  }
  if (!from) {
    throw new Error('Mittente email mancante (EMAIL_FROM)');
  }
  return {
    apiKey,
    from,
    replyTo: process.env.EMAIL_REPLY_TO || undefined
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err) {
  const status = Number(err?.response?.status || 0);
  const msg = String(err?.message || '');
  return status === 429 || /status code 429|too many requests|rate limit/i.test(msg);
}

function isRetryableEmailError(err) {
  const code = String(err?.code || '').toUpperCase();
  const status = Number(err?.response?.status || 0);
  const responseCode = String(err?.responseCode || status || '');
  const msg = String(err?.message || '').toLowerCase();
  if (status === 429 || status >= 500) return true;
  if (['ETIMEDOUT', 'ECONNRESET', 'ESOCKET', 'ECONNECTION'].includes(code)) return true;
  if (responseCode.startsWith('4')) return true;
  if (msg.includes('rate') || msg.includes('quota') || msg.includes('too many') || msg.includes('temporar') || msg.includes('try again')) return true;
  if (msg.includes('4.7.0') || msg.includes('421') || msg.includes('450') || msg.includes('451') || msg.includes('452')) return true;
  return false;
}

function getMaxRetries(err) {
  return isRateLimitError(err) ? EMAIL_RATE_LIMIT_RETRY_MAX : EMAIL_RETRY_MAX;
}

function getRetryDelayMs(err, attempt) {
  const retryAfter = Number(err?.response?.headers?.['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.max(1000, Math.floor(retryAfter * 1000));
  }
  const jitter = Math.floor(Math.random() * 400);
  if (isRateLimitError(err)) {
    return Math.min(60000, 5000 * Math.pow(2, attempt)) + jitter;
  }
  return EMAIL_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + jitter;
}

function loadSentRegistry() {
  try {
    const data = fs.readFileSync(SENT_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveSentRegistry(registry) {
  const dir = path.dirname(SENT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SENT_FILE, JSON.stringify(registry, null, 2), 'utf8');
}

/**
 * Restituisce quanti invii sono stati fatti oggi
 */
function getTodaySentCount() {
  const today = new Date().toISOString().slice(0, 10);
  const reg = loadSentRegistry();
  return reg[today] || 0;
}

/**
 * Verifica se si può inviare ancora (limite configurabile via EMAIL_MAX_PER_DAY)
 * @returns {{ ok: boolean, remaining: number, today: number, limit: number, enabled: boolean }}
 */
function checkDailyLimit() {
  const today = new Date().toISOString().slice(0, 10);
  const reg = loadSentRegistry();
  const sent = reg[today] || 0;
  const enabled = DAILY_LIMIT > 0;
  const remaining = enabled ? Math.max(0, DAILY_LIMIT - sent) : null;
  const ok = enabled ? remaining > 0 : true;
  return { ok, remaining, today: sent, limit: DAILY_LIMIT, enabled };
}

function incrementTodaySent(count) {
  if (!Number.isFinite(count) || count < 1) return;
  const today = new Date().toISOString().slice(0, 10);
  const reg = loadSentRegistry();
  reg[today] = (reg[today] || 0) + count;
  saveSentRegistry(reg);
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    const str = String(value ?? '').trim();
    if (str) return str;
  }
  return '';
}

function buildTemplateData(data = {}) {
  const seg = String(data.segment || '').toUpperCase();
  const eventRaw = pickFirstNonEmpty(
    data.name,
    data.eventoPrenotato,
    data.evento,
    data.resource_name
  );
  const eventName = (seg === 'A' || seg === 'B' || seg === 'D') ? eventRaw : '';
  const firstName = pickFirstNonEmpty(data.first_name, data.nome, data.firstName);
  const lastName = pickFirstNonEmpty(data.cognome, data.last_name, data.lastName);
  const phone = pickFirstNonEmpty(data.phone, data.telefono, data.cellulare);
  const city = pickFirstNonEmpty(data.city, data.citta);
  const status = pickFirstNonEmpty(data.status, data.stato);
  const startDate = pickFirstNonEmpty(data.start_date, data.startDate);

  return {
    ...data,
    nome: firstName,
    first_name: firstName,
    cognome: lastName,
    last_name: lastName,
    email: pickFirstNonEmpty(data.email),
    telefono: phone,
    phone,
    citta: city,
    city,
    evento: eventName,
    eventoPrenotato: eventName,
    name: eventName,
    start_date: startDate,
    status,
    stato: status
  };
}

/**
 * Sostituisce i placeholder nel template.
 * Supporta sia {{campo}} sia $(campo), con retrocompatibilità sui campi storici.
 * @param {string} template
 * @param {object} data
 */
function applyTemplate(template, data) {
  const vars = buildTemplateData(data);
  const normalized = {};
  for (const [k, v] of Object.entries(vars)) {
    normalized[String(k || '').toLowerCase()] = String(v ?? '');
  }
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}|\$\(\s*([a-zA-Z0-9_]+)\s*\)/g, (_m, braced, dollar) => {
    const key = String(braced || dollar || '').toLowerCase();
    return normalized[key] ?? '';
  });
}

function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Invia una singola email personalizzata
 * @param {{ to: string, subject: string, body?: string, html?: string, data: object }} opts
 */
async function sendPersonalizedEmail({ to, subject, body, html, data }) {
  const cfg = getResendConfig();
  const textTemplate = String(body || '');
  const htmlTemplate = String(html || '');
  const resolvedHtml = htmlTemplate ? applyTemplate(htmlTemplate, data || {}) : '';
  const resolvedText = textTemplate
    ? applyTemplate(textTemplate, data || {})
    : (resolvedHtml ? stripHtmlToText(resolvedHtml) : '');
  const finalHtml = resolvedHtml || resolvedText.replace(/\n/g, '<br>');
  const mail = {
    from: cfg.from,
    to,
    subject: applyTemplate(subject, data || {}),
    text: resolvedText,
    html: finalHtml,
    reply_to: cfg.replyTo,
    tags: [
      { name: 'source', value: 'newsletter-sms' },
      { name: 'channel', value: 'email-batch' }
    ]
  };
  let lastErr = null;
  let messageId = null;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await axios.post(RESEND_API_URL, mail, {
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });
      messageId = response?.data?.id || null;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt >= getMaxRetries(err) || !isRetryableEmailError(err)) break;
      const waitMs = getRetryDelayMs(err, attempt);
      await sleep(waitMs);
    }
  }
  if (lastErr) throw lastErr;
  incrementTodaySent(1);
  return { id: messageId };
}

function buildMailPayload({ row, subject, body, html, cfg, channel }) {
  const textTemplate = String(body || '');
  const htmlTemplate = String(html || '');
  const resolvedHtml = htmlTemplate ? applyTemplate(htmlTemplate, row || {}) : '';
  const text = textTemplate
    ? applyTemplate(textTemplate, row || {})
    : (resolvedHtml ? stripHtmlToText(resolvedHtml) : '');
  return {
    from: cfg.from,
    to: String(row?.email || '').trim(),
    subject: applyTemplate(subject, row || {}),
    text,
    html: resolvedHtml || text.replace(/\n/g, '<br>'),
    reply_to: cfg.replyTo,
    tags: [
      { name: 'source', value: 'newsletter-sms' },
      { name: 'channel', value: channel }
    ]
  };
}

/**
 * Invia fino a 100 email in un'unica richiesta Resend
 * @param {{ rows: Array<object>, subject: string, body?: string, html?: string, abortCheck?: Function }} opts
 * @returns {Promise<{ sentEmails: string[], failed: Array<{email:string,error:string}> }>}
 */
async function sendPersonalizedBatch({ rows, subject, body, html, abortCheck }) {
  const cfg = getResendConfig();
  const validRows = [];
  const failed = [];
  for (const row of rows || []) {
    const email = String(row?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      failed.push({ email, error: 'Email non valida' });
      continue;
    }
    validRows.push({ ...row, email });
  }
  if (typeof abortCheck === 'function' && abortCheck()) {
    return { sentEmails: [], failed };
  }
  if (!validRows.length) return { sentEmails: [], failed };

  const payload = validRows.map((row) => buildMailPayload({
    row,
    subject,
    body,
    html,
    cfg,
    channel: 'email-batch'
  }));

  let lastErr = null;
  let response = null;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await axios.post(RESEND_BATCH_API_URL, payload, {
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt >= getMaxRetries(err) || !isRetryableEmailError(err)) break;
      const waitMs = getRetryDelayMs(err, attempt);
      console.warn('[Email] Rate/retry Resend, attesa ' + waitMs + 'ms (tentativo ' + (attempt + 1) + ')');
      await sleep(waitMs);
      if (typeof abortCheck === 'function' && abortCheck()) break;
    }
  }
  if (lastErr) throw lastErr;

  const raw = response?.data;
  const items = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
  const sentEmails = [];
  validRows.forEach((row, idx) => {
    const item = items[idx];
    if (item && (item.error || item.message)) {
      failed.push({ email: row.email, error: String(item.error || item.message) });
      return;
    }
    sentEmails.push(row.email);
  });

  incrementTodaySent(sentEmails.length);
  return { sentEmails, failed };
}

/**
 * Genera ID batch da parametri (stesso batch = stesso oggetto + stessi filtri)
 * @param {{ subject: string, campaignId?: string, segments: string[], engagementType?: string, listDEventNameContains?: string, listDStatuses?: string }} params
 */
function getBatchId(params) {
  const str = [
    (params.subject || '').trim(),
    (params.campaignId || '').trim(),
    (params.segments || []).sort().join(','),
    (params.engagementType || 'open').trim(),
    params.listDEventNameContains || '',
    params.listDStatuses || ''
  ].join('|');
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 24);
}

function loadBatches() {
  try {
    const data = fs.readFileSync(BATCH_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveBatches(batches) {
  const dir = path.dirname(BATCH_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(BATCH_FILE, JSON.stringify(batches, null, 2), 'utf8');
}

/**
 * Restituisce Set di email già inviate per questo batch
 */
function getSentForBatch(batchId) {
  const map = getSentMapForBatch(batchId);
  return new Set([...map.keys()]);
}

/**
 * Aggiunge email inviate al batch
 */
function addSentToBatch(batchId, emails, subject = '', sentAtByEmail = {}) {
  const batches = loadBatches();
  if (!batches[batchId]) {
    batches[batchId] = { sent: [], sentMap: {}, subject: subject.slice(0, 80), created: new Date().toISOString() };
  }
  const batch = batches[batchId];
  const currentMap = {};
  if (batch.sentMap && typeof batch.sentMap === 'object') {
    for (const k of Object.keys(batch.sentMap)) {
      currentMap[String(k).toLowerCase()] = batch.sentMap[k];
    }
  }
  if (Array.isArray(batch.sent)) {
    batch.sent.forEach((e) => {
      const key = String(e || '').toLowerCase();
      if (key && !currentMap[key]) currentMap[key] = '';
    });
  }
  const nowIso = new Date().toISOString();
  emails.forEach((e) => {
    const key = String(e || '').toLowerCase();
    if (!key) return;
    if (currentMap[key]) return; // conserva timestamp storico
    currentMap[key] = sentAtByEmail[key] || nowIso;
  });
  batch.sentMap = currentMap;
  batch.sent = Object.keys(currentMap);
  batches[batchId].updated = new Date().toISOString();
  saveBatches(batches);
}

/**
 * Restituisce mappa email->timestamp invio per batch
 */
function getSentMapForBatch(batchId) {
  const batches = loadBatches();
  const batch = batches[batchId];
  if (!batch) return new Map();
  const map = new Map();
  if (batch.sentMap && typeof batch.sentMap === 'object') {
    for (const k of Object.keys(batch.sentMap)) {
      const key = String(k || '').toLowerCase();
      if (!key) continue;
      map.set(key, String(batch.sentMap[k] || ''));
    }
  }
  if (Array.isArray(batch.sent)) {
    batch.sent.forEach((e) => {
      const key = String(e || '').toLowerCase();
      if (!key) return;
      if (!map.has(key)) map.set(key, '');
    });
  }
  return map;
}

/**
 * Invia email di prova (non conta nel limite giornaliero)
 * @param {{ to: string, subject: string, body?: string, html?: string }} opts
 */
async function sendTestEmail({ to, subject, body, html }) {
  const data = {
    nome: 'Mario',
    first_name: 'Mario',
    cognome: 'Rossi',
    last_name: 'Rossi',
    email: to,
    telefono: '393331234567',
    phone: '393331234567',
    city: 'Milano',
    citta: 'Milano',
    eventoPrenotato: 'Castello delle Sorprese',
    name: 'Castello delle Sorprese',
    start_date: '2026-10-15',
    status: 'confermato',
    stato: 'confermato',
    segment: 'A'
  };
  const cfg = getResendConfig();
  const textTemplate = String(body || '');
  const htmlTemplate = String(html || '');
  const resolvedHtml = htmlTemplate ? applyTemplate(htmlTemplate, data) : '';
  const text = textTemplate
    ? applyTemplate(textTemplate, data)
    : (resolvedHtml ? stripHtmlToText(resolvedHtml) : '');
  const finalHtml = resolvedHtml || text.replace(/\n/g, '<br>');
  const payload = {
    from: cfg.from,
    to: String(to || '').trim(),
    subject: applyTemplate(subject, data),
    text,
    html: finalHtml,
    reply_to: cfg.replyTo,
    tags: [
      { name: 'source', value: 'newsletter-sms' },
      { name: 'channel', value: 'email-test' }
    ]
  };
  await axios.post(RESEND_API_URL, payload, {
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });
}

module.exports = {
  sendPersonalizedEmail,
  sendPersonalizedBatch,
  sendTestEmail,
  applyTemplate,
  checkDailyLimit,
  getTodaySentCount,
  getBatchId,
  getSentForBatch,
  getSentMapForBatch,
  addSentToBatch,
  DAILY_LIMIT
};
