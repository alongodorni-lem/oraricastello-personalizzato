/**
 * Coda invii SMS: persiste su file cosi' sopravvive al riavvio del processo.
 * Un redeploy Render cancella il disco: non deployare finche' la coda non e' partita.
 */
const fs = require('fs');
const path = require('path');

const QUEUE_FILE = path.join(__dirname, '..', 'data', 'sms-send-queue.json');
const MAX_DELAY_HOURS = 24;

function loadQueue() {
  try {
    const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveQueue(items) {
  const dir = path.dirname(QUEUE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(items, null, 2), 'utf8');
}

function recoverInterrupted(items) {
  let changed = false;
  for (const item of items) {
    if (item && item.status === 'running') {
      item.status = 'queued';
      item.error = 'Ripreso dopo riavvio: i numeri gia inviati vengono saltati.';
      changed = true;
    }
  }
  return changed;
}

let startupRecovered = false;

function listQueue() {
  const items = loadQueue();
  if (!startupRecovered) {
    startupRecovered = true;
    if (recoverInterrupted(items)) saveQueue(items);
  }
  return items.slice().sort((a, b) => String(a.sendAt || '').localeCompare(String(b.sendAt || '')));
}

function addQueuedSend({ delayHours, plannedCount, skippedCount, audienceLabel, payload, recipients }) {
  const hours = Number(delayHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_DELAY_HOURS) {
    throw new Error('Il ritardo deve essere un numero intero di ore da 1 a 24.');
  }
  const smsText = String(payload?.smsText || '').trim().slice(0, 160);
  if (!smsText) throw new Error('Testo SMS obbligatorio');
  const now = Date.now();
  const item = {
    id: 'q_' + now + '_' + Math.random().toString(36).slice(2, 8),
    createdAt: new Date(now).toISOString(),
    sendAt: new Date(now + hours * 60 * 60 * 1000).toISOString(),
    delayHours: hours,
    status: 'queued',
    smsText,
    plannedCount: Number(plannedCount) || 0,
    skippedCount: Number(skippedCount) || 0,
    audienceLabel: String(audienceLabel || '').slice(0, 240),
    payload: { ...payload, smsText },
    recipients: Array.isArray(recipients) ? recipients : [],
    result: null,
    error: null,
    startedAt: null,
    finishedAt: null
  };
  const items = loadQueue();
  items.push(item);
  saveQueue(items);
  return item;
}

function updateItem(id, patch) {
  const items = loadQueue();
  const item = items.find((row) => row.id === id);
  if (!item) return null;
  Object.assign(item, patch);
  saveQueue(items);
  return item;
}

function cancelItem(id) {
  const items = loadQueue();
  const item = items.find((row) => row.id === id);
  if (!item) return { ok: false, error: 'Invio in coda non trovato' };
  if (item.status === 'running') return { ok: false, error: 'Questo invio e\' gia partito e non si puo annullare.' };
  if (item.status !== 'queued') return { ok: false, error: 'Si annullano solo gli invii ancora in coda.' };
  item.status = 'cancelled';
  item.finishedAt = new Date().toISOString();
  saveQueue(items);
  return { ok: true, item };
}

function nextDue() {
  const items = loadQueue();
  const now = Date.now();
  return items
    .filter((item) => item.status === 'queued' && new Date(item.sendAt || 0).getTime() <= now)
    .sort((a, b) => String(a.sendAt).localeCompare(String(b.sendAt)))[0] || null;
}

module.exports = {
  MAX_DELAY_HOURS,
  listQueue,
  addQueuedSend,
  updateItem,
  cancelItem,
  nextDue
};
