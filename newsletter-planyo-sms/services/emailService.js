/**
 * Servizio invio email Newsletter via Gmail (Nodemailer)
 * Placeholder: {{nome}}, {{cognome}}, {{email}}, {{evento}}
 * Batch: traccia email già inviate per soggetto+filtri (max 500/giorno, invii progressivi)
 */
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const SENT_FILE = path.join(__dirname, '..', 'data', 'newsletter-email-sent.json');
const BATCH_FILE = path.join(__dirname, '..', 'data', 'newsletter-email-batches.json');
const DAILY_LIMIT = 500;
const EMAIL_RETRY_MAX = Math.max(0, parseInt(process.env.EMAIL_RETRY_MAX || '2', 10) || 2);
const EMAIL_RETRY_BASE_DELAY_MS = Math.max(0, parseInt(process.env.EMAIL_RETRY_BASE_DELAY_MS || '2500', 10) || 2500);
let transporterCache = null;

function createTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error('Credenziali Gmail mancanti (GMAIL_USER / GMAIL_APP_PASSWORD)');
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
}

function getTransporter() {
  if (!transporterCache) transporterCache = createTransporter();
  return transporterCache;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableEmailError(err) {
  const code = String(err?.code || '').toUpperCase();
  const responseCode = String(err?.responseCode || '');
  const msg = String(err?.message || '').toLowerCase();
  if (['ETIMEDOUT', 'ECONNRESET', 'ESOCKET', 'ECONNECTION'].includes(code)) return true;
  if (responseCode.startsWith('4')) return true;
  if (msg.includes('rate') || msg.includes('quota') || msg.includes('too many') || msg.includes('temporar') || msg.includes('try again')) return true;
  if (msg.includes('4.7.0') || msg.includes('421') || msg.includes('450') || msg.includes('451') || msg.includes('452')) return true;
  return false;
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
 * Verifica se si può inviare ancora (limite 500/giorno)
 * @returns {{ ok: boolean, remaining: number, today: number }}
 */
function checkDailyLimit() {
  const today = new Date().toISOString().slice(0, 10);
  const reg = loadSentRegistry();
  const sent = reg[today] || 0;
  const remaining = Math.max(0, DAILY_LIMIT - sent);
  return { ok: remaining > 0, remaining, today: sent };
}

/**
 * Sostituisce i placeholder nel template
 * @param {string} template
 * @param {{ nome: string, cognome: string, email: string, eventoPrenotato: string }} data
 */
function applyTemplate(template, data) {
  let out = template || '';
  out = out.replace(/\{\{nome\}\}/g, data.nome || '');
  out = out.replace(/\{\{cognome\}\}/g, data.cognome || '');
  out = out.replace(/\{\{email\}\}/g, data.email || '');
  const seg = String(data.segment || '').toUpperCase();
  const evento = (seg === 'A' || seg === 'B' || seg === 'D') ? (data.eventoPrenotato || '') : '';
  out = out.replace(/\{\{evento\}\}/g, evento);
  return out;
}

/**
 * Invia una singola email personalizzata
 * @param {{ to: string, subject: string, body: string, data: object }} opts
 */
async function sendPersonalizedEmail({ to, subject, body, data }) {
  const transporter = getTransporter();
  const fromAddress = process.env.GMAIL_FROM || process.env.GMAIL_USER;
  const text = applyTemplate(body, data || {});
  const html = text.replace(/\n/g, '<br>');
  const mail = {
    from: fromAddress,
    to,
    subject: applyTemplate(subject, data || {}),
    text,
    html
  };
  let lastErr = null;
  for (let attempt = 0; attempt <= EMAIL_RETRY_MAX; attempt++) {
    try {
      await transporter.sendMail(mail);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt >= EMAIL_RETRY_MAX || !isRetryableEmailError(err)) break;
      const jitter = Math.floor(Math.random() * 400);
      const waitMs = EMAIL_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + jitter;
      await sleep(waitMs);
    }
  }
  if (lastErr) throw lastErr;

  const today = new Date().toISOString().slice(0, 10);
  const reg = loadSentRegistry();
  reg[today] = (reg[today] || 0) + 1;
  saveSentRegistry(reg);
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
 * @param {{ to: string, subject: string, body: string }} opts
 */
async function sendTestEmail({ to, subject, body }) {
  const data = { nome: 'Mario', cognome: 'Rossi', email: to, eventoPrenotato: 'Castello delle Sorprese' };
  const transporter = getTransporter();
  const fromAddress = process.env.GMAIL_FROM || process.env.GMAIL_USER;
  const text = applyTemplate(body, data);
  const html = text.replace(/\n/g, '<br>');

  await transporter.sendMail({
    from: fromAddress,
    to,
    subject: applyTemplate(subject, data),
    text,
    html
  });
}

module.exports = {
  sendPersonalizedEmail,
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
