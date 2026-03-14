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
  out = out.replace(/\{\{evento\}\}/g, data.eventoPrenotato || '');
  return out;
}

/**
 * Invia una singola email personalizzata
 * @param {{ to: string, subject: string, body: string, data: object }} opts
 */
async function sendPersonalizedEmail({ to, subject, body, data }) {
  const transporter = createTransporter();
  const fromAddress = process.env.GMAIL_FROM || process.env.GMAIL_USER;
  const text = applyTemplate(body, data || {});
  const html = text.replace(/\n/g, '<br>');

  await transporter.sendMail({
    from: fromAddress,
    to,
    subject: applyTemplate(subject, data || {}),
    text,
    html
  });

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
  const batches = loadBatches();
  const batch = batches[batchId];
  return new Set(batch?.sent || []);
}

/**
 * Aggiunge email inviate al batch
 */
function addSentToBatch(batchId, emails, subject = '') {
  const batches = loadBatches();
  if (!batches[batchId]) {
    batches[batchId] = { sent: [], subject: subject.slice(0, 80), created: new Date().toISOString() };
  }
  const existing = new Set(batches[batchId].sent);
  emails.forEach((e) => existing.add(e.toLowerCase()));
  batches[batchId].sent = [...existing];
  batches[batchId].updated = new Date().toISOString();
  saveBatches(batches);
}

/**
 * Invia email di prova (non conta nel limite giornaliero)
 * @param {{ to: string, subject: string, body: string }} opts
 */
async function sendTestEmail({ to, subject, body }) {
  const data = { nome: 'Mario', cognome: 'Rossi', email: to, eventoPrenotato: 'Castello delle Sorprese' };
  const transporter = createTransporter();
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
  addSentToBatch,
  DAILY_LIMIT
};
