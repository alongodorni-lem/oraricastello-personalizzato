/**
 * Job: da report Mailchimp (open/click) → segmenta per prenotazioni Planyo → invia SMS
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mailchimp = require('../services/mailchimp');
const planyo = require('../services/planyo');
const planyoReportCsv = require('../services/planyoReportCsv');
const smshosting = require('../services/smshosting');
const config = require('../config/segments');

const SENT_FILE = path.join(__dirname, '..', 'data', 'newsletter-sms-sent.json');
const SPAM_GUARD_FILE = path.join(__dirname, '..', 'data', 'newsletter-sms-spam-guard.json');
const SPAM_GUARD_HOURS = 24;

function msgHash(text) {
  return crypto.createHash('md5').update((text || '').trim()).digest('hex').slice(0, 16);
}

function loadSpamGuard() {
  try {
    const data = fs.readFileSync(SPAM_GUARD_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveSpamGuard(registry) {
  const dir = path.dirname(SPAM_GUARD_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SPAM_GUARD_FILE, JSON.stringify(registry, null, 2), 'utf8');
}

function wasSameMessageSentRecently(phone, text) {
  const norm = smshosting.normalizePhone(phone);
  if (!norm || norm.length < 9) return false;
  const key = `${norm}_${msgHash(text)}`;
  const reg = loadSpamGuard();
  const ts = reg[key];
  if (!ts) return false;
  const ageMs = Date.now() - new Date(ts).getTime();
  return ageMs < SPAM_GUARD_HOURS * 60 * 60 * 1000;
}

function markMessageSentForSpamGuard(phone, text) {
  const norm = smshosting.normalizePhone(phone);
  if (!norm || norm.length < 9) return;
  const reg = loadSpamGuard();
  const cutoff = Date.now() - SPAM_GUARD_HOURS * 60 * 60 * 1000;
  for (const k of Object.keys(reg)) {
    if (new Date(reg[k]).getTime() < cutoff) delete reg[k];
  }
  reg[`${norm}_${msgHash(text)}`] = new Date().toISOString();
  saveSpamGuard(reg);
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
  const { dryRun = false, segments: segmentsFilter = null, targetResourceId: overrideTargetId, eventIds, listDFilters, smsText: customSmsText, abortCheck, engagementType = 'open' } = options;
  const { targetResourceId: configTargetId, monthsLookback, smsTexts, adminPhone } = config;
  const targetResourceId = overrideTargetId != null ? overrideTargetId : configTargetId;

  const onlyD = segmentsFilter && segmentsFilter.length === 1 && segmentsFilter[0].toUpperCase() === 'D';
  const engagementLabel = engagementType === 'click' ? 'click' : 'open';
  const trackId = campaignId || 'list-d-only';

  console.log('[Job] Avvio newsletter-sms-job');
  console.log('[Job] Campagna:', trackId, '| Solo Lista D:', !!onlyD, '| Dry run:', dryRun);

  // Sempre creare Lista A per prima (serve per escludere da B, C, D)
  let emailsInA = new Set();
  if (process.env.PLANYO_API_KEY) {
    try {
      const reservationsByEmail = await planyo.loadReservationsByEmail(monthsLookback);
      const { emailsInA: setA } = planyo.buildListAAndB(reservationsByEmail, targetResourceId);
      emailsInA = setA;
      console.log('[Job] Lista A (prenotati evento target con data futura):', setA.size, 'email da escludere da B/C/D');
    } catch (err) {
      console.warn('[Job] Planyo API (skip Lista A):', err.message);
    }
  }

  if (onlyD && process.env.PLANYO_LISTD_CSV_URL) {
    const excludeListA = { emailsInA };
    const listD = await planyoReportCsv.loadListDFromCsv(listDFilters || {}, excludeListA);
    const withPhone = listD.filter((x) => x.telefono && x.telefono.length >= 10 && !x.telefono.includes('@'));
    console.log('[Job] Lista D da CSV:', withPhone.length, 'contatti con telefono');
    const getText = () => customSmsText || (config.smsTexts?.listD || '');
    let inserted = 0;
    let notInserted = 0;
    let duplicates = 0;
    let skipped = 0;
    const textD = getText();
    for (const { email, telefono: phone } of withPhone) {
      if (wasAlreadySent(trackId, email, 'D')) { skipped++; continue; }
      if (wasSameMessageSentRecently(phone, textD)) { skipped++; continue; }
      if (typeof abortCheck === 'function' && abortCheck()) break;
      if (dryRun) { inserted++; continue; }
      const result = await smshosting.sendSms(phone, textD);
      if (result.success) {
        markAsSent(trackId, email, 'D');
        markMessageSentForSpamGuard(phone, textD);
        inserted++;
      } else {
        notInserted++;
        if (result.isDuplicate) duplicates++;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!dryRun && adminPhone) {
      try {
        await smshosting.sendSms(adminPhone, `Newsletter SMS Lista D: ${inserted} inseriti | ${notInserted} non inseriti`);
      } catch (_) {}
    }
    return { processed: withPhone.length, inserted, notInserted, duplicates, skipped };
  }

  if (onlyD) {
    console.log('[Job] Solo Lista D richiesta ma PLANYO_LISTD_CSV_URL non impostato. Fine.');
    return { processed: 0, inserted: 0, notInserted: 0, duplicates: 0, skipped: 0 };
  }

  // 1. Carica prenotazioni Planyo (ultimi 18 mesi) - prima operazione: creare sempre Lista A
  let reservationsByEmail;
  try {
    console.log('[Job] Caricamento prenotazioni Planyo (ultimi', monthsLookback, 'mesi)...');
    reservationsByEmail = await planyo.loadReservationsByEmail(monthsLookback);
    console.log('[Job] Prenotazioni caricate per', reservationsByEmail.size, 'email');
  } catch (err) {
    console.error('[Job] ERRORE Planyo:', err.message);
    throw err;
  }

  const evIds = options.eventIds && Array.isArray(options.eventIds) ? options.eventIds.map(Number).filter((n) => !isNaN(n)) : null;
  const hasEventFilter = evIds && evIds.length > 0;

  // 2. Lista A (evento target ultimi 6 mesi) e B (altri eventi 18 mesi, esclusi A)
  const { listA, listB, emailsInA: emailsInASet } = planyo.buildListAAndB(reservationsByEmail, targetResourceId);
  const lists = { A: listA, B: listB, C: [] };

  if (hasEventFilter) {
    lists.A = lists.A.filter((x) => {
      const entry = reservationsByEmail.get(x.email.toLowerCase());
      const resourceIds = (entry?.reservations || []).map((r) => r.resource_id).filter(Boolean).map(Number);
      return resourceIds.some((id) => evIds.includes(id));
    });
    lists.B = lists.B.filter((x) => {
      const entry = reservationsByEmail.get(x.email.toLowerCase());
      const resourceIds = (entry?.reservations || []).map((r) => r.resource_id).filter(Boolean).map(Number);
      return resourceIds.some((id) => evIds.includes(id));
    });
  }

  // 3. Lista C: utenti newsletter (open/click) esclusi Lista A, con controllo solo email
  const segmentsToProcess = segmentsFilter && segmentsFilter.length ? segmentsFilter.filter((s) => s !== 'D') : ['A', 'B', 'C'];
  const needC = segmentsToProcess.includes('C');
  if (needC) {
    let mailchimpEmails = [];
    let mailchimpPhones = new Map();
    try {
      console.log('[Job] Recupero', engagementLabel, 'da Mailchimp...');
      mailchimpEmails = await mailchimp.getCampaignEngagedEmailsWithCache(campaignId, engagementType);
      const filteredEmails = mailchimpEmails;
      console.log('[Job] Email da Mailchimp (' + engagementLabel + ') senza esclusioni:', filteredEmails.length);
      if (filteredEmails.length > 0) {
        console.log('[Job] Recupero telefoni da cache Mailchimp...');
        mailchimpPhones = await mailchimp.getPhonesForEmailsWithCache(null, new Set(filteredEmails.map((e) => e.toLowerCase())));
        console.log('[Job] Telefoni trovati in cache Mailchimp:', mailchimpPhones.size);
      }
      for (const email of filteredEmails) {
        const raw = mailchimpPhones.get(email.toLowerCase()) || '';
        lists.C.push({ email, phone: raw });
      }
    } catch (err) {
      console.error('[Job] ERRORE Mailchimp:', err.message);
      if (err.response?.status) console.error('[Job] HTTP', err.response.status, err.response?.data);
      throw err;
    }
  }

  // 3. Normalizza telefoni per tutti i segmenti
  for (const seg of ['A', 'B', 'C']) {
    lists[seg] = lists[seg].map(({ email, phone: raw }) => {
      const phone = planyo.normalizePhone(raw) || (raw && !raw.includes('@') && raw.replace(/\D/g, '').length >= 9 ? raw : '');
      return { email, phone };
    });
  }
  // Riepilogo per segmento (con/senza telefono)
  const segmentSummary = { A: { total: 0, withPhone: 0, noPhone: 0 }, B: { total: 0, withPhone: 0, noPhone: 0 }, C: { total: 0, withPhone: 0, noPhone: 0 } };
  for (const seg of ['A', 'B', 'C']) {
    segmentSummary[seg].total = lists[seg].length;
    segmentSummary[seg].withPhone = lists[seg].filter((x) => x.phone && x.phone.length >= 10).length;
    segmentSummary[seg].noPhone = segmentSummary[seg].total - segmentSummary[seg].withPhone;
  }
  console.log('[Job] Segmenti:');
  console.log('  Lista A (prenotati evento target):', segmentSummary.A.total, '| con telefono:', segmentSummary.A.withPhone, '| senza:', segmentSummary.A.noPhone);
  console.log('  Lista B (prenot. 18m esclusi A):   ', segmentSummary.B.total, '| con telefono:', segmentSummary.B.withPhone, '| senza:', segmentSummary.B.noPhone);
  console.log('  Lista C (' + engagementLabel + ' newsletter esclusi A):', segmentSummary.C.total, '| con telefono:', segmentSummary.C.withPhone, '| senza:', segmentSummary.C.noPhone);

  // 4. Lista D da CSV (se selezionata) - esclusi evento target ultimi 6 mesi
  let listD = [];
  if (segmentsFilter && segmentsFilter.includes('D') && process.env.PLANYO_LISTD_CSV_URL) {
    try {
      const excludeListA = { emailsInA: emailsInASet };
      listD = await planyoReportCsv.loadListDFromCsv(listDFilters || {}, excludeListA);
      listD = listD.filter((x) => x.telefono && x.telefono.length >= 10 && !x.telefono.includes('@'));
      console.log('[Job] Lista D da CSV:', listD.length, 'contatti con telefono');
    } catch (err) {
      console.error('[Job] Lista D CSV:', err.message);
    }
  }

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
      if (wasSameMessageSentRecently(phone, text)) {
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
        markMessageSentForSpamGuard(phone, text);
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

  if (segmentsFilter && segmentsFilter.includes('D') && listD.length > 0) {
    const text = getText('D');
    for (const { email, telefono: phone } of listD) {
      if (wasAlreadySent(campaignId, email, 'D')) { skipped++; continue; }
      if (wasSameMessageSentRecently(phone, text)) { skipped++; continue; }
      if (!phone || phone.length < 10 || phone.includes('@')) { skipped++; continue; }
      if (typeof abortCheck === 'function' && abortCheck()) break;
      if (dryRun) { inserted++; continue; }
      const result = await smshosting.sendSms(phone, text);
      if (result.success) {
        markAsSent(campaignId, email, 'D');
        markMessageSentForSpamGuard(phone, text);
        inserted++;
      } else {
        notInserted++;
        if (result.isDuplicate) duplicates++;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
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

  const totalProcessed = lists.A.length + lists.B.length + lists.C.length + listD.length;
  return { processed: totalProcessed, inserted, notInserted, duplicates, skipped };
}

/**
 * Verifica se un numero era presente in una lista (A, B o C) per una campagna
 * @param {string} campaignId
 * @param {string} phone - numero da cercare (es. +393394773418 o 393394773418)
 * @param {{ targetResourceId?: number }} options
 * @returns {Promise<{ found: boolean, segment?: 'A'|'B'|'C', email?: string }>}
 */
async function checkPhoneInLists(campaignId, phone, options = {}) {
  const { targetResourceId: overrideId, engagementType = 'open' } = options;
  const { targetResourceId: configId, monthsLookback } = config;
  const targetResourceId = overrideId != null ? overrideId : configId;
  const searchDigits = String(phone || '').replace(/\D/g, '');
  if (searchDigits.length < 9) return { found: false };

  const reservationsByEmail = await planyo.loadReservationsByEmail(monthsLookback);
  const { listA, listB, emailsInA } = planyo.buildListAAndB(reservationsByEmail, targetResourceId);
  const lists = { A: listA, B: listB, C: [] };

  const mailchimpEmails = await mailchimp.getCampaignEngagedEmailsWithCache(campaignId, engagementType);
  let mailchimpPhones = new Map();
  try {
    mailchimpPhones = await mailchimp.getPhonesForEmailsWithCache(null, new Set(mailchimpEmails.map((e) => e.toLowerCase())));
  } catch { /* ignore */ }

  for (const email of mailchimpEmails) {
    const raw = mailchimpPhones.get(email.toLowerCase()) || '';
    const p = planyo.normalizePhone(raw) || (raw && !raw.includes('@') && raw.replace(/\D/g, '').length >= 9 ? raw.replace(/\D/g, '') : '');
    lists.C.push({ email, phone: p });
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

/**
 * Calcola il numero di contatti che corrispondono ai criteri (senza inviare)
 * @param {string} campaignId
 * @param {{ targetResourceId?: number, eventIds?: number[], segments?: string[], listDFilters?: object }} options
 * @returns {Promise<{ total: number, bySegment: { A: number, B: number, C: number, D: number } }>}
 */
async function getSmsPreview(campaignId, options = {}) {
  const { targetResourceId: overrideId, eventIds, segments: segmentsFilter, listDFilters, engagementType = 'open' } = options;
  const { targetResourceId: configId, monthsLookback } = config;
  const targetResourceId = overrideId != null ? overrideId : configId;
  const segFilter = segmentsFilter && segmentsFilter.length ? segmentsFilter.filter((s) => s !== 'D') : ['A', 'B', 'C'];

  const onlyD = segmentsFilter && segmentsFilter.length === 1 && segmentsFilter[0].toUpperCase() === 'D';
  if (onlyD && process.env.PLANYO_LISTD_CSV_URL) {
    let emailsInA = new Set();
    if (process.env.PLANYO_API_KEY) {
      try {
        const res = await planyo.loadReservationsByEmail(monthsLookback);
        const { emailsInA: setA } = planyo.buildListAAndB(res, targetResourceId);
        emailsInA = setA;
      } catch (_) {}
    }
    const excludeListA = { emailsInA };
    const listD = await planyoReportCsv.loadListDFromCsv(listDFilters || {}, excludeListA);
    const count = listD.length;
    return { total: count, bySegment: { A: 0, B: 0, C: 0, D: count } };
  }

  const reservationsByEmail = await planyo.loadReservationsByEmail(monthsLookback);
  const eventIdsNum = eventIds && Array.isArray(eventIds) ? eventIds.map(Number).filter((n) => !isNaN(n)) : null;
  const hasEventFilter = eventIdsNum && eventIdsNum.length > 0;

  // Lista A (prenotati evento target con data futura) e B (prenot. 18m esclusi A)
  const { listA, listB, emailsInA } = planyo.buildListAAndB(reservationsByEmail, targetResourceId);
  const lists = { A: [], B: [], C: [] };
  const toEmailOnly = (src) => src.map(({ email }) => ({ email }));
  lists.A = toEmailOnly(listA);
  lists.B = toEmailOnly(listB);

  if (hasEventFilter) {
    lists.A = lists.A.filter((x) => {
      const entry = reservationsByEmail.get(x.email.toLowerCase());
      const resourceIds = (entry?.reservations || []).map((r) => r.resource_id).filter(Boolean).map(Number);
      return resourceIds.some((id) => eventIdsNum.includes(id));
    });
    lists.B = lists.B.filter((x) => {
      const entry = reservationsByEmail.get(x.email.toLowerCase());
      const resourceIds = (entry?.reservations || []).map((r) => r.resource_id).filter(Boolean).map(Number);
      return resourceIds.some((id) => eventIdsNum.includes(id));
    });
  }

  // Lista C: aperture Mailchimp escluse email in Lista A (match solo email)
  if (segFilter.includes('C')) {
    const mailchimpEmails = await mailchimp.getCampaignEngagedEmailsWithCache(campaignId, engagementType);
    const filteredEmails = mailchimpEmails;
    for (const email of filteredEmails) {
      lists.C.push({ email });
    }
  }

  let total = 0;
  for (const seg of segFilter) {
    total += lists[seg]?.length || 0;
  }

  let listDCount = 0;
  if (segmentsFilter && segmentsFilter.includes('D') && process.env.PLANYO_LISTD_CSV_URL) {
    try {
      const excludeListA = { emailsInA };
      const listD = await planyoReportCsv.loadListDFromCsv(listDFilters || {}, excludeListA);
      listDCount = listD.length;
      total += listDCount;
    } catch (_) {}
  }

  return {
    total,
    bySegment: { A: lists.A.length, B: lists.B.length, C: lists.C.length, D: listDCount }
  };
}

module.exports = { runNewsletterSmsJob, checkPhoneInLists, getSmsPreview };
