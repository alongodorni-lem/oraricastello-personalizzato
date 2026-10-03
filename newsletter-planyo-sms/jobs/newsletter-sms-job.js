/**
 * Job: da report Mailchimp (open/click) → segmenta per prenotazioni Planyo → invia SMS
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mailchimp = require('../services/mailchimp');
const planyo = require('../services/planyo');
const planyoReportCsv = require('../services/planyoReportCsv');
const dataCache = require('../services/dataCache');
const smshosting = require('../services/smshosting');
const { applyTemplate } = require('../services/emailService');
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
  if (!email) return false;
  const key = `${campaignId}_${String(email).toLowerCase()}_${segment}`;
  return !!loadSentRegistry()[key];
}

function seedSentRegistryFromPhones(rows, trackId, segment, phonesSet) {
  if (!phonesSet || !phonesSet.size || !Array.isArray(rows) || !rows.length) return 0;
  const reg = loadSentRegistry();
  let added = 0;
  for (const row of rows) {
    const email = String(row?.email || '').toLowerCase().trim();
    const phone = smshosting.normalizePhone(row?.telefono || row?.phone || '');
    const id = email.includes('@') ? email : (phone ? ('phone:' + phone) : '');
    if (!id || !phone || !phonesSet.has(phone)) continue;
    const key = `${trackId}_${id}_${segment}`;
    if (reg[key]) continue;
    reg[key] = new Date().toISOString();
    added += 1;
  }
  if (added) saveSentRegistry(reg);
  return added;
}

function markAsSent(campaignId, email, segment) {
  const reg = loadSentRegistry();
  reg[`${campaignId}_${email.toLowerCase()}_${segment}`] = new Date().toISOString();
  saveSentRegistry(reg);
}

async function sendAdminControlSms(texts) {
  const phone = smshosting.normalizePhone(config.adminPhone || '+393394773418');
  if (!phone) return;
  const unique = [...new Set((texts || []).map((text) => String(text || '').trim()).filter(Boolean))];
  for (const text of unique) {
    try {
      const result = await smshosting.sendSms(phone, text);
      if (result.success) console.log('[Job] SMS controllo admin inviato');
      else console.warn('[Job] SMS controllo admin non inviato:', result.error);
    } catch (err) {
      console.warn('[Job] SMS controllo admin errore:', err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function rememberAdminPhone(seenPhonesInRun) {
  const phone = smshosting.normalizePhone(config.adminPhone || '+393394773418');
  if (phone) seenPhonesInRun.add(phone);
}

/**
 * Esegue il job di segmentazione e invio SMS
 * @param {string} campaignId - ID campagna Mailchimp
 * @param {{ dryRun?: boolean }} options
 */
async function runNewsletterSmsJob(campaignId, options = {}) {
  const { dryRun = false, prepareOnly = false, segments: segmentsFilter = null, targetResourceId: overrideTargetId, eventIds, listDFilters, smsText: customSmsText, abortCheck, engagementType = 'open', excludeTargetBooked = false, progress } = options;
  const touchProgress = (vals) => {
    if (!progress || typeof progress !== 'object') return;
    if (vals.inserted != null) progress.inserted = vals.inserted;
    if (vals.notInserted != null) progress.notInserted = vals.notInserted;
    if (vals.skipped != null) progress.skipped = vals.skipped;
    if (vals.duplicates != null) progress.duplicates = vals.duplicates;
  };
  const { targetResourceId: configTargetId, monthsLookback, smsTexts, adminPhone } = config;
  const targetResourceId = overrideTargetId != null ? overrideTargetId : configTargetId;

  const onlyD = segmentsFilter && segmentsFilter.length === 1 && segmentsFilter[0].toUpperCase() === 'D';
  const onlyE = segmentsFilter && segmentsFilter.length === 1 && segmentsFilter[0].toUpperCase() === 'E';
  const hasE = !!(segmentsFilter && segmentsFilter.map((s) => String(s).toUpperCase()).includes('E'));
  const engagementLabel = engagementType === 'click' ? 'click' : 'open';
  const trackId = campaignId || 'list-d-only';
  const seenPhonesInRun = new Set();
  const lookbackHours = Math.max(1, parseInt(process.env.SMS_RESUME_LOOKBACK_HOURS || '24', 10) || 24);
  let providerSentPhones = new Set();
  try {
    providerSentPhones = await smshosting.listSentPhonesSince(new Date(Date.now() - lookbackHours * 60 * 60 * 1000), new Date(), { abortCheck });
    console.log('[Job] Numeri gia presenti su SMS Hosting (ultime', lookbackHours, 'ore):', providerSentPhones.size);
  } catch (err) {
    console.warn('[Job] Recupero invii SMS Hosting fallito:', err.message);
  }

  const alreadyDelivered = (email, segment, phone, text) => {
    const id = email && String(email).includes('@') ? String(email).toLowerCase() : (phone ? ('phone:' + phone) : '');
    if (id && wasAlreadySent(trackId, id, segment)) return true;
    if (text && wasSameMessageSentRecently(phone, text)) return true;
    const norm = smshosting.normalizePhone(phone);
    return !!(norm && providerSentPhones.has(norm));
  };

  console.log('[Job] Avvio newsletter-sms-job');
  console.log('[Job] Campagna:', trackId, '| Solo Lista D:', !!onlyD, '| Solo file manuale:', !!onlyE, '| Dry run:', dryRun);

  // Sempre creare Lista A per prima (serve per escludere da B, C, D)
  let emailsInA = new Set();
  let cachedSegmentation = null;
  if (process.env.PLANYO_API_KEY) {
    try {
      cachedSegmentation = await planyo.getCachedListAAndB(targetResourceId, monthsLookback);
      emailsInA = cachedSegmentation.emailsInA;
      console.log('[Job] Lista A (prenotati evento target con data futura):', emailsInA.size, 'email da escludere da B/C/D');
    } catch (err) {
      console.warn('[Job] Planyo API (skip Lista A):', err.message);
    }
  }

  if (onlyD && process.env.PLANYO_LISTD_CSV_URL) {
    const excludeListA = excludeTargetBooked ? { emailsInA } : {};
    const listD = await planyoReportCsv.loadListDFromCsv(listDFilters || {}, excludeListA);
    const withPhone = listD.filter((x) => x.telefono && x.telefono.length >= 10 && !x.telefono.includes('@'));
    const seeded = seedSentRegistryFromPhones(withPhone, trackId, 'D', providerSentPhones);
    if (seeded) console.log('[Job] Registro locale ricostruito da SMS Hosting:', seeded, 'numeri Lista D');
    console.log('[Job] Lista D da CSV:', withPhone.length, 'contatti con telefono');
    const getText = () => customSmsText || (config.smsTexts?.listD || '');
    let inserted = 0;
    let notInserted = 0;
    let duplicates = 0;
    let skipped = 0;
    const textD = getText();
    if (!dryRun && !prepareOnly) {
      await sendAdminControlSms([textD]);
      rememberAdminPhone(seenPhonesInRun);
    }
    for (const row of withPhone) {
      const email = row.email;
      const phone = row.telefono;
      const textResolved = applyTemplate(textD, row);
      if (alreadyDelivered(email, 'D', phone, textResolved)) { skipped++; continue; }
      const normPhone = smshosting.normalizePhone(phone);
      if (!normPhone || seenPhonesInRun.has(normPhone)) { skipped++; continue; }
      seenPhonesInRun.add(normPhone);
      if (typeof abortCheck === 'function' && abortCheck()) break;
      if (dryRun) { inserted++; continue; }
      const result = await smshosting.sendSms(normPhone, textResolved);
      if (result.success) {
        markAsSent(trackId, email, 'D');
        markMessageSentForSpamGuard(phone, textResolved);
        inserted++;
      } else {
        notInserted++;
        if (result.isDuplicate) duplicates++;
      }
      touchProgress({ inserted, notInserted, skipped, duplicates });
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!dryRun && adminPhone) {
      try {
        await smshosting.sendSms(adminPhone, `Newsletter SMS Lista D: ${inserted} inseriti | ${notInserted} non inseriti`);
      } catch (_) {}
    }
    touchProgress({ inserted, notInserted, skipped, duplicates });
    return { processed: withPhone.length, inserted, notInserted, duplicates, skipped };
  }

  if (onlyD) {
    console.log('[Job] Solo Lista D richiesta ma PLANYO_LISTD_CSV_URL non impostato. Fine.');
    return { processed: 0, inserted: 0, notInserted: 0, duplicates: 0, skipped: 0 };
  }

  if (onlyE) {
    const excludeListA = excludeTargetBooked ? { emailsInA } : {};
    const listE = dataCache.getManualContacts(excludeListA);
    const withPhone = listE.filter((x) => x.telefono && x.telefono.length >= 10 && !x.telefono.includes('@'));
    const seededE = seedSentRegistryFromPhones(withPhone, trackId, 'E', providerSentPhones);
    if (seededE) console.log('[Job] Registro locale ricostruito da SMS Hosting:', seededE, 'numeri file manuale');
    console.log('[Job] Lista E da file manuale:', withPhone.length, 'contatti con telefono');
    const textE = customSmsText || (config.smsTexts?.listD || '');
    let inserted = 0;
    let notInserted = 0;
    let duplicates = 0;
    let skipped = 0;
    if (!dryRun && !prepareOnly) {
      await sendAdminControlSms([textE]);
      rememberAdminPhone(seenPhonesInRun);
    }
    for (const row of withPhone) {
      const email = row.email;
      const phone = row.telefono;
      const id = email && email.includes('@') ? email : ('phone:' + phone);
      const textResolved = applyTemplate(textE, row);
      if (alreadyDelivered(id, 'E', phone, textResolved)) { skipped++; continue; }
      const normPhone = smshosting.normalizePhone(phone);
      if (!normPhone || seenPhonesInRun.has(normPhone)) { skipped++; continue; }
      seenPhonesInRun.add(normPhone);
      if (typeof abortCheck === 'function' && abortCheck()) break;
      if (dryRun) { inserted++; continue; }
      const result = await smshosting.sendSms(normPhone, textResolved);
      if (result.success) {
        markAsSent(trackId, id, 'E');
        markMessageSentForSpamGuard(phone, textResolved);
        inserted++;
      } else {
        notInserted++;
        if (result.isDuplicate) duplicates++;
      }
      touchProgress({ inserted, notInserted, skipped, duplicates });
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!dryRun && adminPhone) {
      try {
        await smshosting.sendSms(adminPhone, `Newsletter SMS file manuale: ${inserted} inseriti | ${notInserted} non inseriti`);
      } catch (_) {}
    }
    touchProgress({ inserted, notInserted, skipped, duplicates });
    return { processed: withPhone.length, inserted, notInserted, duplicates, skipped };
  }

  const evIds = options.eventIds && Array.isArray(options.eventIds) ? options.eventIds.map(Number).filter((n) => !isNaN(n)) : null;
  const hasEventFilter = evIds && evIds.length > 0;

  // 1. Carica segmentazione A/B da cache sessione; usa API solo se serve filtro evento.
  let reservationsByEmail = null;
  let listA = [];
  let listB = [];
  let emailsInASet = new Set();

  if (cachedSegmentation && !hasEventFilter) {
    listA = [...cachedSegmentation.listA];
    listB = [...cachedSegmentation.listB];
    emailsInASet = new Set(cachedSegmentation.emailsInA);
  } else {
    try {
      console.log('[Job] Caricamento prenotazioni Planyo (ultimi', monthsLookback, 'mesi)...');
      reservationsByEmail = await planyo.loadReservationsByEmail(monthsLookback);
      console.log('[Job] Prenotazioni caricate per', reservationsByEmail.size, 'email');
      const segmented = planyo.buildListAAndB(reservationsByEmail, targetResourceId);
      listA = segmented.listA;
      listB = segmented.listB;
      emailsInASet = segmented.emailsInA;
    } catch (err) {
      console.error('[Job] ERRORE Planyo:', err.message);
      throw err;
    }
  }
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
  const segmentsToProcess = segmentsFilter && segmentsFilter.length ? segmentsFilter.filter((s) => s !== 'D' && s !== 'E') : ['A', 'B', 'C'];
  const needC = segmentsToProcess.includes('C');
  if (needC) {
    let mailchimpEmails = [];
    let mailchimpPhones = new Map();
    try {
      console.log('[Job] Recupero', engagementLabel, 'da Mailchimp...');
      mailchimpEmails = await mailchimp.getCampaignEngagedEmailsWithCache(campaignId, engagementType);
      const filteredEmails = excludeTargetBooked
        ? mailchimpEmails.filter((email) => !emailsInASet.has(email.toLowerCase().trim()))
        : mailchimpEmails;
      console.log('[Job] Email da Mailchimp (' + engagementLabel + ')', excludeTargetBooked ? 'dopo esclusione Lista A:' : 'senza esclusioni:', filteredEmails.length);
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
      const excludeListA = excludeTargetBooked ? { emailsInA: emailsInASet } : {};
      listD = await planyoReportCsv.loadListDFromCsv(listDFilters || {}, excludeListA);
      listD = listD.filter((x) => x.telefono && x.telefono.length >= 10 && !x.telefono.includes('@'));
      const seeded = seedSentRegistryFromPhones(listD, trackId, 'D', providerSentPhones);
      if (seeded) console.log('[Job] Registro locale ricostruito da SMS Hosting:', seeded, 'numeri Lista D');
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
  if (!dryRun && !prepareOnly) {
    const controlTexts = [];
    for (const segment of ['A', 'B', 'C']) {
      if (!segmentsToProcess.includes(segment)) continue;
      controlTexts.push(getText(segment));
    }
    if (segmentsFilter && segmentsFilter.includes('D')) controlTexts.push(getText('D'));
    if (hasE) controlTexts.push(getText('E') || getText('D'));
    await sendAdminControlSms(controlTexts);
    rememberAdminPhone(seenPhonesInRun);
  }
  for (const segment of ['A', 'B', 'C']) {
    const text = getText(segment);
    if (!segmentsToProcess.includes(segment)) continue;
    for (const { email, phone } of lists[segment]) {
      if (alreadyDelivered(email, segment, phone, text)) {
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
      const normPhone = smshosting.normalizePhone(phone);
      if (!normPhone || seenPhonesInRun.has(normPhone)) {
        skipped++;
        continue;
      }
      seenPhonesInRun.add(normPhone);

      if (typeof abortCheck === 'function' && abortCheck()) {
        console.log('[Job] Annullato dall\'utente');
        break;
      }

      if (dryRun) {
        inserted++;
        continue;
      }

      const result = await smshosting.sendSms(normPhone, text);
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
      touchProgress({ inserted, notInserted, skipped, duplicates });

      await new Promise((r) => setTimeout(r, 500));
    }
    if (typeof abortCheck === 'function' && abortCheck()) break;
  }

  if (segmentsFilter && segmentsFilter.includes('D') && listD.length > 0) {
    const text = getText('D');
    for (const row of listD) {
      const email = row.email;
      const phone = row.telefono;
      const textResolved = applyTemplate(text, row);
      if (alreadyDelivered(email, 'D', phone, textResolved)) { skipped++; continue; }
      if (!phone || phone.length < 10 || phone.includes('@')) { skipped++; continue; }
      const normPhone = smshosting.normalizePhone(phone);
      if (!normPhone || seenPhonesInRun.has(normPhone)) { skipped++; continue; }
      seenPhonesInRun.add(normPhone);
      if (typeof abortCheck === 'function' && abortCheck()) break;
      if (dryRun) { inserted++; continue; }
      const result = await smshosting.sendSms(normPhone, textResolved);
      if (result.success) {
        markAsSent(campaignId, email, 'D');
        markMessageSentForSpamGuard(phone, textResolved);
        inserted++;
      } else {
        notInserted++;
        if (result.isDuplicate) duplicates++;
      }
      touchProgress({ inserted, notInserted, skipped, duplicates });
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  if (hasE) {
    const text = getText('E') || getText('D');
    const excludeListA = excludeTargetBooked ? { emailsInA: emailsInASet } : {};
    const listE = dataCache.getManualContacts(excludeListA);
    console.log('[Job] Lista E da file manuale:', listE.length, 'contatti');
    for (const row of listE) {
      const phone = row.telefono || row.phone;
      const email = String(row.email || '').toLowerCase().trim() || ('phone:' + phone);
      const textResolved = applyTemplate(text, row);
      if (alreadyDelivered(email, 'E', phone, textResolved)) { skipped++; continue; }
      if (!phone || phone.length < 10 || String(phone).includes('@')) { skipped++; continue; }
      const normPhone = smshosting.normalizePhone(phone);
      if (!normPhone || seenPhonesInRun.has(normPhone)) { skipped++; continue; }
      seenPhonesInRun.add(normPhone);
      if (typeof abortCheck === 'function' && abortCheck()) break;
      if (dryRun) { inserted++; continue; }
      const result = await smshosting.sendSms(normPhone, textResolved);
      if (result.success) {
        markAsSent(campaignId, email, 'E');
        markMessageSentForSpamGuard(phone, textResolved);
        inserted++;
      } else {
        notInserted++;
        if (result.isDuplicate) duplicates++;
      }
      touchProgress({ inserted, notInserted, skipped, duplicates });
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
  const { targetResourceId: overrideId, eventIds, segments: segmentsFilter, listDFilters, engagementType = 'open', excludeTargetBooked = false } = options;
  const { targetResourceId: configId, monthsLookback } = config;
  const targetResourceId = overrideId != null ? overrideId : configId;
  const segFilter = segmentsFilter && segmentsFilter.length ? segmentsFilter.filter((s) => s !== 'D' && s !== 'E') : ['A', 'B', 'C'];

  const onlyD = segmentsFilter && segmentsFilter.length === 1 && segmentsFilter[0].toUpperCase() === 'D';
  if (onlyD && process.env.PLANYO_LISTD_CSV_URL) {
    let emailsInA = new Set();
    if (process.env.PLANYO_API_KEY) {
      try {
        const segmented = await planyo.getCachedListAAndB(targetResourceId, monthsLookback);
        emailsInA = segmented.emailsInA;
      } catch (_) {}
    }
    const excludeListA = excludeTargetBooked ? { emailsInA } : {};
    const listD = await planyoReportCsv.loadListDFromCsv(listDFilters || {}, excludeListA);
    const count = listD.length;
    return { total: count, bySegment: { A: 0, B: 0, C: 0, D: count, E: 0 } };
  }

  const onlyE = segmentsFilter && segmentsFilter.length === 1 && String(segmentsFilter[0]).toUpperCase() === 'E';
  if (onlyE) {
    let emailsInA = new Set();
    if (excludeTargetBooked && process.env.PLANYO_API_KEY) {
      try {
        const segmented = await planyo.getCachedListAAndB(targetResourceId, monthsLookback);
        emailsInA = segmented.emailsInA;
      } catch (_) {}
    }
    const count = dataCache.getManualContacts(excludeTargetBooked ? { emailsInA } : {}).length;
    return { total: count, bySegment: { A: 0, B: 0, C: 0, D: 0, E: count } };
  }

  const eventIdsNum = eventIds && Array.isArray(eventIds) ? eventIds.map(Number).filter((n) => !isNaN(n)) : null;
  const hasEventFilter = eventIdsNum && eventIdsNum.length > 0;

  let reservationsByEmail = null;
  let listA = [];
  let listB = [];
  let emailsInA = new Set();
  if (!hasEventFilter) {
    try {
      const segmented = await planyo.getCachedListAAndB(targetResourceId, monthsLookback);
      listA = segmented.listA;
      listB = segmented.listB;
      emailsInA = segmented.emailsInA;
    } catch (_) {}
  }
  if (listA.length === 0 && listB.length === 0 && emailsInA.size === 0) {
    reservationsByEmail = await planyo.loadReservationsByEmail(monthsLookback);
    const segmented = planyo.buildListAAndB(reservationsByEmail, targetResourceId);
    listA = segmented.listA;
    listB = segmented.listB;
    emailsInA = segmented.emailsInA;
  } else if (hasEventFilter) {
    reservationsByEmail = await planyo.loadReservationsByEmail(monthsLookback);
  }
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
    const filteredEmails = excludeTargetBooked
      ? mailchimpEmails.filter((email) => !emailsInA.has(email.toLowerCase().trim()))
      : mailchimpEmails;
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
      const excludeListA = excludeTargetBooked ? { emailsInA } : {};
      const listD = await planyoReportCsv.loadListDFromCsv(listDFilters || {}, excludeListA);
      listDCount = listD.length;
      total += listDCount;
    } catch (_) {}
  }

  let listECount = 0;
  if (segmentsFilter && segmentsFilter.map((s) => String(s).toUpperCase()).includes('E')) {
    const excludeListA = excludeTargetBooked ? { emailsInA } : {};
    listECount = dataCache.getManualContacts(excludeListA).length;
    total += listECount;
  }

  return {
    total,
    bySegment: { A: lists.A.length, B: lists.B.length, C: lists.C.length, D: listDCount, E: listECount }
  };
}

module.exports = { runNewsletterSmsJob, checkPhoneInLists, getSmsPreview };
