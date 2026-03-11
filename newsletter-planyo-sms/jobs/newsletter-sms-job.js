/**
 * Job: da report Mailchimp (open/click) → segmenta per prenotazioni Planyo → invia SMS
 */
const path = require('path');
const fs = require('fs');
const mailchimp = require('../services/mailchimp');
const planyo = require('../services/planyo');
const smshosting = require('../services/smshosting');
const config = require('../config/segments');

const SENT_FILE = path.join(__dirname, '..', 'data', 'newsletter-sms-sent.json');

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

function wasAlreadySent(campaignId, email, segment) {
  const key = `${campaignId}_${email.toLowerCase()}_${segment}`;
  return !!loadSentRegistry()[key];
}

function markAsSent(campaignId, email, segment) {
  const reg = loadSentRegistry();
  reg[`${campaignId}_${email.toLowerCase()}_${segment}`] = new Date().toISOString();
  saveSentRegistry(reg);
}

/**
 * Esegue il job di segmentazione e invio SMS
 * @param {string} campaignId - ID campagna Mailchimp
 * @param {{ dryRun?: boolean }} options
 */
async function runNewsletterSmsJob(campaignId, options = {}) {
  const { dryRun = false, segments: segmentsFilter = null, targetResourceId: overrideTargetId, smsText: customSmsText, abortCheck } = options;
  const { targetResourceId: configTargetId, monthsLookback, smsTexts, adminPhone } = config;
  const targetResourceId = overrideTargetId != null ? Number(overrideTargetId) : configTargetId;

  console.log('[Job] Avvio newsletter-sms-job');
  console.log('[Job] Campagna:', campaignId, '| Dry run:', dryRun);

  // 1. Email da Mailchimp (open + click)
  let emails;
  try {
    console.log('[Job] Recupero open/click da Mailchimp...');
    emails = await mailchimp.getCampaignEngagedEmails(campaignId);
    console.log('[Job] Email da Mailchimp (open/click):', emails.length);
  } catch (err) {
    console.error('[Job] ERRORE Mailchimp:', err.message);
    if (err.response?.status) console.error('[Job] HTTP', err.response.status, err.response?.data);
    throw err;
  }

  if (emails.length === 0) {
    console.log('[Job] Nessuna email da processare. Fine.');
    return { processed: 0, inserted: 0, notInserted: 0, duplicates: 0, skipped: 0 };
  }

  // 1b. Recupera telefoni da Mailchimp (merge_fields) per fallback
  let mailchimpPhones = new Map();
  try {
    const listId = await mailchimp.getCampaignListId(campaignId);
    if (listId) {
      console.log('[Job] Recupero telefoni da Mailchimp (merge_fields)...');
      mailchimpPhones = await mailchimp.getPhonesForEmails(listId, new Set(emails.map((e) => e.toLowerCase())));
      console.log('[Job] Telefoni trovati in Mailchimp:', mailchimpPhones.size);
    }
  } catch (err) {
    console.warn('[Job] Mailchimp phones (skip):', err.message);
  }

  // 2. Carica prenotazioni Planyo (ultimi N mesi)
  let reservationsByEmail;
  try {
    console.log('[Job] Caricamento prenotazioni Planyo (ultimi', monthsLookback, 'mesi)...');
    reservationsByEmail = await planyo.loadReservationsByEmail(monthsLookback);
    console.log('[Job] Prenotazioni caricate per', reservationsByEmail.size, 'email');
  } catch (err) {
    console.error('[Job] ERRORE Planyo:', err.message);
    throw err;
  }

  // 3. Segmenta (phone: Planyo prima, poi Mailchimp; normalizza per SMS)
  const lists = { A: [], B: [], C: [] };
  for (const email of emails) {
    const { segment, phone: planyoPhone } = planyo.segmentEmail(reservationsByEmail, email, targetResourceId);
    let raw = planyoPhone || mailchimpPhones.get(email.toLowerCase()) || '';
    const phone = planyo.normalizePhone(raw) || (raw && !raw.includes('@') && raw.replace(/\D/g, '').length >= 9 ? raw : '');
    lists[segment].push({ email, phone });
  }
  // Riepilogo per segmento (con/senza telefono)
  const segmentSummary = { A: { total: 0, withPhone: 0, noPhone: 0 }, B: { total: 0, withPhone: 0, noPhone: 0 }, C: { total: 0, withPhone: 0, noPhone: 0 } };
  for (const seg of ['A', 'B', 'C']) {
    segmentSummary[seg].total = lists[seg].length;
    segmentSummary[seg].withPhone = lists[seg].filter((x) => x.phone && x.phone.length >= 10).length;
    segmentSummary[seg].noPhone = segmentSummary[seg].total - segmentSummary[seg].withPhone;
  }
  console.log('[Job] Segmenti:');
  console.log('  Lista A (evento target):', segmentSummary.A.total, '| con telefono:', segmentSummary.A.withPhone, '| senza:', segmentSummary.A.noPhone);
  console.log('  Lista B (altri eventi):  ', segmentSummary.B.total, '| con telefono:', segmentSummary.B.withPhone, '| senza:', segmentSummary.B.noPhone);
  console.log('  Lista C (prospect):      ', segmentSummary.C.total, '| con telefono:', segmentSummary.C.withPhone, '| senza:', segmentSummary.C.noPhone);

  // 4. Invia SMS per segmento (solo quelli in segmentsFilter se specificato)
  const segmentsToProcess = segmentsFilter && segmentsFilter.length ? segmentsFilter : ['A', 'B', 'C'];
  let inserted = 0;
  let notInserted = 0;
  let duplicates = 0;
  let skipped = 0;

  const getText = (seg) => customSmsText || (smsTexts['list' + seg] || '');
  for (const segment of ['A', 'B', 'C']) {
    const text = getText(segment);
    if (!segmentsToProcess.includes(segment)) continue;
    for (const { email, phone } of lists[segment]) {
      if (wasAlreadySent(campaignId, email, segment)) {
        skipped++;
        continue;
      }
      if (!phone || phone.length < 10) {
        skipped++;
        continue;
      }
      // Escludi valori che sembrano email (es. PHONE errato in Mailchimp)
      if (phone.includes('@') || /\.[a-z]{2,}$/i.test(phone) || phone.replace(/\D/g, '').length < 9) {
        skipped++;
        continue;
      }

      if (typeof abortCheck === 'function' && abortCheck()) {
        console.log('[Job] Annullato dall\'utente');
        break;
      }

      if (dryRun) {
        inserted++;
        continue;
      }

      const result = await smshosting.sendSms(phone, text);
      if (result.success) {
        markAsSent(campaignId, email, segment);
        inserted++;
        if (inserted % 250 === 0) {
          console.log('[Job] Avanzamento:', inserted, 'SMS inseriti');
        }
      } else {
        notInserted++;
        if (result.isDuplicate) duplicates++;
      }

      await new Promise((r) => setTimeout(r, 500));
    }
    if (typeof abortCheck === 'function' && abortCheck()) break;
  }

  const dupInfo = duplicates > 0 ? ` (${duplicates} duplicati)` : '';
  console.log('[Job] Fine. Inseriti:', inserted, '| Non inseriti:', notInserted + dupInfo);

  // Invio conferma al numero admin (riscontro che gli SMS siano partiti)
  if (!dryRun && adminPhone) {
    const confirmText = `Newsletter SMS inseriti: ${inserted} | Non inseriti: ${notInserted}${duplicates > 0 ? ` (${duplicates} dup)` : ''}`;
    try {
      const res = await smshosting.sendSms(adminPhone, confirmText);
      if (res.success) {
        console.log('[Job] Conferma inviata a', adminPhone);
      } else {
        console.warn('[Job] Conferma admin non inviata:', res.error);
      }
    } catch (err) {
      console.warn('[Job] Errore invio conferma admin:', err.message);
    }
  }

  return { processed: emails.length, inserted, notInserted, duplicates, skipped };
}

/**
 * Verifica se un numero era presente in una lista (A, B o C) per una campagna
 * @param {string} campaignId
 * @param {string} phone - numero da cercare (es. +393394773418 o 393394773418)
 * @param {{ targetResourceId?: number }} options
 * @returns {Promise<{ found: boolean, segment?: 'A'|'B'|'C', email?: string }>}
 */
async function checkPhoneInLists(campaignId, phone, options = {}) {
  const { targetResourceId: overrideId } = options;
  const { targetResourceId: configId, monthsLookback } = config;
  const targetResourceId = overrideId != null ? Number(overrideId) : configId;
  const searchDigits = String(phone || '').replace(/\D/g, '');
  if (searchDigits.length < 9) return { found: false };

  const emails = await mailchimp.getCampaignEngagedEmails(campaignId);
  if (emails.length === 0) return { found: false };

  let mailchimpPhones = new Map();
  try {
    const listId = await mailchimp.getCampaignListId(campaignId);
    if (listId) {
      mailchimpPhones = await mailchimp.getPhonesForEmails(listId, new Set(emails.map((e) => e.toLowerCase())));
    }
  } catch {
    /* ignore */
  }

  const reservationsByEmail = await planyo.loadReservationsByEmail(monthsLookback);
  const lists = { A: [], B: [], C: [] };

  for (const email of emails) {
    const { segment, phone: planyoPhone } = planyo.segmentEmail(reservationsByEmail, email, targetResourceId);
    let raw = planyoPhone || mailchimpPhones.get(email.toLowerCase()) || '';
    const p = planyo.normalizePhone(raw) || (raw && !raw.includes('@') && raw.replace(/\D/g, '').length >= 9 ? raw.replace(/\D/g, '') : '');
    lists[segment].push({ email, phone: p });
  }

  const norm = (p) => (p || '').replace(/\D/g, '');
  const searchNorm = searchDigits.startsWith('39') ? searchDigits : '39' + searchDigits.replace(/^0/, '');

  for (const seg of ['A', 'B', 'C']) {
    const match = lists[seg].find((x) => {
      const p = norm(x.phone);
      return p === searchNorm || p === searchDigits || p.endsWith(searchDigits.slice(-9));
    });
    if (match) return { found: true, segment: seg, email: match.email };
  }
  return { found: false };
}

module.exports = { runNewsletterSmsJob, checkPhoneInLists };
