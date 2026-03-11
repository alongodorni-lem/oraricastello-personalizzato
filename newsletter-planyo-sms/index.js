#!/usr/bin/env node
/**
 * Newsletter Planyo SMS - Entry point
 * Uso:
 *   node index.js --test=39xxxxxxxxxx  # invio prova a 1 numero (testo Lista B)
 *   node index.js --campaign=ID        # singola campagna
 *   node index.js --last=2             # ultime 2 campagne inviate
 *   node index.js --segments=B         # solo Lista B (A,B,C o combinazioni)
 *   node index.js --dry-run            # simulazione
 */
require('dotenv').config();

const mailchimp = require('./services/mailchimp');
const smshosting = require('./services/smshosting');
const { runNewsletterSmsJob, checkPhoneInLists } = require('./jobs/newsletter-sms-job');
const config = require('./config/segments');

function parseArgs() {
  const args = process.argv.slice(2);
  let campaignId = process.env.MAILCHIMP_CAMPAIGN_ID;
  let lastN = null;
  let dryRun = false;
  let segments = null;
  let testPhone = null;
  let testNoAlias = false;
  let checkPhone = null;

  for (const arg of args) {
    if (arg.startsWith('--test=')) testPhone = arg.split('=')[1].trim();
    if (arg.startsWith('--check-phone=')) checkPhone = arg.split('=')[1].trim();
    if (arg === '--no-alias') testNoAlias = true;
    if (arg.startsWith('--campaign=')) campaignId = arg.split('=')[1];
    if (arg.startsWith('--last=')) lastN = parseInt(arg.split('=')[1], 10) || 2;
    if (arg.startsWith('--segments=')) segments = arg.split('=')[1].toUpperCase().split(',').map((s) => s.trim()).filter((s) => ['A', 'B', 'C'].includes(s));
    if (arg === '--dry-run') dryRun = true;
  }

  return { campaignId, lastN, dryRun, segments, testPhone, testNoAlias, checkPhone };
}

async function main() {
  const { campaignId, lastN, dryRun, segments, testPhone, testNoAlias, checkPhone } = parseArgs();

  // Verifica se un numero era in Lista A/B/C per una campagna
  if (checkPhone) {
    let campaignIds = [];
    if (lastN) {
      const campaigns = await mailchimp.getLastSentCampaigns(lastN);
      campaignIds = campaigns.map((c) => c.id);
    } else if (campaignId) {
      campaignIds = [campaignId];
    } else {
      const campaigns = await mailchimp.getLastSentCampaigns(2);
      campaignIds = campaigns.map((c) => c.id);
    }
    if (campaignIds.length === 0) {
      console.error('Specifica --campaign=ID oppure --last=N (es. --last=2)');
      process.exit(1);
    }
    const campaignIdUsed = campaignIds[0];
    console.log('[Check] Verifica numero', checkPhone, 'in campagna', campaignIdUsed);
    const result = await checkPhoneInLists(campaignIdUsed, checkPhone);
    if (result.found) {
      console.log('[Check] Trovato in Lista', result.segment, '| email:', result.email);
    } else {
      console.log('[Check] Numero NON trovato in nessuna lista (A, B, C)');
    }
    return;
  }

  // Invio prova a singolo numero (testo Lista B)
  // Aggiunge suffisso univoco per bypassare blocchi Smshosting su messaggi duplicati
  if (testPhone) {
    const baseText = config.smsTexts.listB;
    const suffix = ' [' + Date.now().toString(36).slice(-6) + ']';
    const text = baseText.length + suffix.length <= 160 ? baseText + suffix : baseText.slice(0, 160 - suffix.length) + suffix;
    console.log('[Test] Invio SMS a', testPhone);
    console.log('[Test] Mittente:', testNoAlias ? 'numerico (default)' : (process.env.SMSHOSTING_FROM || 'default'));
    console.log('[Test] Testo:', text);
    const result = await smshosting.sendSms(testPhone, text, testNoAlias ? { from: '' } : {});
    if (result.success) {
      console.log('[Test] SMS inviato con successo');
    } else {
      console.error('[Test] Errore:', result.error);
      if (result.smsNotInserted) console.error('[Test] smsNotInserted:', result.smsNotInserted);
      process.exit(1);
    }
    return;
  }

  let campaignIds = [];
  if (lastN) {
    const campaigns = await mailchimp.getLastSentCampaigns(lastN);
    campaignIds = campaigns.map((c) => c.id);
    console.log('Ultime', lastN, 'campagne:', campaigns.map((c) => `${c.id} (${c.subject})`).join(', '));
  } else if (campaignId) {
    campaignIds = [campaignId];
  }

  if (campaignIds.length === 0) {
    console.error('Specifica --campaign=ID oppure --last=N (es. --last=2 per ultime 2 campagne)');
    process.exit(1);
  }

  if (segments && segments.length) console.log('Segmenti da processare:', segments.join(', '));

  try {
    for (const id of campaignIds) {
      await runNewsletterSmsJob(id, { dryRun, segments });
      if (campaignIds.length > 1) {
        await new Promise((r) => setTimeout(r, 2000)); // pausa tra campagne
      }
    }
  } catch (err) {
    console.error('Errore:', err.message);
    process.exit(1);
  }
}

main();
