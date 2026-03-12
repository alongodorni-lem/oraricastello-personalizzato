/**
 * Mailchimp Marketing API - Reports (open/click)
 * https://mailchimp.com/developer/marketing/api/open-reports/
 */
const axios = require('axios');

const BASE_URL = 'https://us21.api.mailchimp.com/3.0';

/**
 * Estrae datacenter dalla API key (formato: xxxxxxxx-dc)
 * @param {string} apiKey
 * @returns {string} datacenter (es. us21)
 */
function getDatacenter(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return 'us21';
  const parts = apiKey.split('-');
  return parts.length > 1 ? parts[1] : 'us21';
}

/**
 * Costruisce base URL Mailchimp
 */
function getBaseUrl(apiKey) {
  const dc = getDatacenter(apiKey);
  return `https://${dc}.api.mailchimp.com/3.0`;
}

/**
 * Ottiene tutti i membri che hanno aperto la campagna
 * @param {string} campaignId
 * @returns {Promise<string[]>} array di email
 */
async function getCampaignOpenEmails(campaignId) {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  if (!apiKey) throw new Error('MAILCHIMP_API_KEY non configurata');

  const baseUrl = getBaseUrl(apiKey);
  const emails = new Set();
  let offset = 0;
  const count = 100;

  while (true) {
    const url = `${baseUrl}/reports/${campaignId}/open-details?count=${count}&offset=${offset}`;
    const res = await axios.get(url, {
      auth: { username: 'anystring', password: apiKey },
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
      validateStatus: (s) => s < 500
    });

    if (res.status === 404) {
      console.warn('[Mailchimp] open-details 404 - campagna senza report o ID non valido');
      break;
    }
    if (res.status >= 400) throw new Error(`Mailchimp ${res.status}: ${JSON.stringify(res.data)}`);

    const members = res.data.members || res.data?.data?.members || [];
    for (const m of members) {
      const email = typeof m.email_address === 'string' ? m.email_address : (m.email_address?.email || m.email);
      if (email) emails.add(email.toLowerCase().trim());
    }

    if (members.length < count) break;
    offset += count;
  }

  return Array.from(emails);
}

/**
 * Ottiene tutti i membri che hanno cliccato link nella campagna
 * @param {string} campaignId
 * @returns {Promise<string[]>} array di email
 */
async function getCampaignClickEmails(campaignId) {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  if (!apiKey) throw new Error('MAILCHIMP_API_KEY non configurata');

  const baseUrl = getBaseUrl(apiKey);
  const emails = new Set();

  // 1. Lista link cliccati
  const clickDetailsRes = await axios.get(
    `${baseUrl}/reports/${campaignId}/click-details?count=100`,
    {
      auth: { username: 'anystring', password: apiKey },
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
      validateStatus: (s) => s < 500
    }
  );

  if (clickDetailsRes.status === 404) return [];
  if (clickDetailsRes.status >= 400) throw new Error(`Mailchimp click-details ${clickDetailsRes.status}`);

  const urls = clickDetailsRes.data.urls || clickDetailsRes.data?.data?.urls || [];
  for (const urlObj of urls) {
    const linkId = urlObj.id;
    if (!linkId) continue;

    let offset = 0;
    const count = 100;
    while (true) {
      const membersRes = await axios.get(
        `${baseUrl}/reports/${campaignId}/click-details/${linkId}/members?count=${count}&offset=${offset}`,
        {
          auth: { username: 'anystring', password: apiKey },
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        }
      );
      const members = membersRes.data.members || membersRes.data?.data?.members || [];
      for (const m of members) {
        const email = typeof m.email_address === 'string' ? m.email_address : (m.email_address?.email || m.email);
        if (email) emails.add(email.toLowerCase().trim());
      }
      if (members.length < count) break;
      offset += count;
    }
  }

  return Array.from(emails);
}

/**
 * Ottiene le ultime N campagne inviate
 * @param {number} count - numero campagne (default 2)
 * @returns {Promise<Array<{ id: string, subject: string, send_time: string }>>}
 */
async function getLastSentCampaigns(count = 2) {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  if (!apiKey) throw new Error('MAILCHIMP_API_KEY non configurata');

  const baseUrl = getBaseUrl(apiKey);
  const res = await axios.get(`${baseUrl}/campaigns`, {
    params: {
      sort_field: 'send_time',
      sort_dir: 'DESC',
      status: 'sent',
      count: Math.min(count, 100)
    },
    auth: { username: 'anystring', password: apiKey },
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000
  });

  const campaigns = res.data.campaigns || [];
  return campaigns.map((c) => ({
    id: c.id,
    subject: c.settings?.subject_line || c.subject_line || 'Senza oggetto',
    send_time: c.send_time
  }));
}

/**
 * Unisce email da open e click (senza duplicati)
 * @param {string} campaignId
 * @returns {Promise<string[]>}
 */
async function getCampaignEngagedEmails(campaignId) {
  const [openEmails, clickEmails] = await Promise.all([
    getCampaignOpenEmails(campaignId),
    getCampaignClickEmails(campaignId)
  ]);
  const all = new Set([...openEmails, ...clickEmails]);
  return Array.from(all);
}

/**
 * Ottiene list_id dalla campagna
 */
async function getCampaignListId(campaignId) {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  if (!apiKey) throw new Error('MAILCHIMP_API_KEY non configurata');
  const baseUrl = getBaseUrl(apiKey);
  const res = await axios.get(`${baseUrl}/campaigns/${campaignId}`, {
    auth: { username: 'anystring', password: apiKey },
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000
  });
  return res.data.recipients?.list_id || null;
}

/**
 * Verifica se un valore ha forma di numero di cellulare (9-15 cifre, no email)
 */
function looksLikePhone(value) {
  if (!value || typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.includes('@')) return false;
  const digits = v.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return false;
  return true;
}

/**
 * Estrae telefono da merge_fields: prima campi standard, poi qualsiasi campo con forma numero
 */
function extractPhoneFromMergeFields(mergeFields) {
  if (!mergeFields || typeof mergeFields !== 'object') return '';

  // 1) Campi standard (PHONE, MERGE2, ecc.)
  const standardKeys = ['PHONE', 'MERGE2', 'PHONE1', 'MOBILE', 'CELL', 'TELEFONO', 'CELLULARE'];
  for (const k of standardKeys) {
    const v = mergeFields[k];
    if (v && typeof v === 'string' && looksLikePhone(v)) return v.trim();
  }
  for (const k of Object.keys(mergeFields)) {
    if (/phone|merge2|mobile|cell|tel|telefono/i.test(k)) {
      const v = mergeFields[k];
      if (v && typeof v === 'string' && looksLikePhone(v)) return v.trim();
    }
  }

  // 2) Cerca in QUALSIASI campo: se il valore ha forma di cellulare, usalo
  for (const k of Object.keys(mergeFields)) {
    const v = mergeFields[k];
    if (v && typeof v === 'string' && looksLikePhone(v)) return v.trim();
  }
  return '';
}

/**
 * Recupera telefono da Mailchimp per le email coinvolte (merge_fields)
 * @param {string} listId
 * @param {Set<string>} emailsSet - email da cercare
 * @returns {Promise<Map<string, string>>} email -> phone
 */
async function getPhonesForEmails(listId, emailsSet) {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  if (!apiKey || !listId) return new Map();

  const baseUrl = getBaseUrl(apiKey);
  const phoneMap = new Map();
  let offset = 0;
  const count = 500;
  const maxPages = 100;

  for (let page = 0; page < maxPages; page++) {
    const res = await axios.get(`${baseUrl}/lists/${listId}/members`, {
      params: { count, offset },
      auth: { username: 'anystring', password: apiKey },
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });
    const members = res.data.members || [];
    for (const m of members) {
      const email = (typeof m.email_address === 'string' ? m.email_address : m.email_address?.email || '').toLowerCase().trim();
      if (!email || !emailsSet.has(email)) continue;
      const phone = extractPhoneFromMergeFields(m.merge_fields);
      if (phone) phoneMap.set(email, phone);
    }
    if (members.length < count) break;
    offset += count;
  }
  return phoneMap;
}

/**
 * Estrae nome e cognome da merge_fields (FNAME, LNAME o MERGE1, MERGE3)
 */
function extractNameFromMergeFields(mergeFields) {
  if (!mergeFields || typeof mergeFields !== 'object') return { firstName: '', lastName: '' };
  const firstName = (mergeFields.FNAME || mergeFields.MERGE1 || mergeFields.FIRSTNAME || '').toString().trim();
  const lastName = (mergeFields.LNAME || mergeFields.MERGE3 || mergeFields.LASTNAME || '').toString().trim();
  return { firstName, lastName };
}

/**
 * Recupera dettagli membri (nome, cognome, telefono) per le email coinvolte
 * @param {string} listId
 * @param {Set<string>} emailsSet - email da cercare
 * @returns {Promise<Map<string, { firstName: string, lastName: string, phone: string }>>}
 */
async function getMemberDetailsForEmails(listId, emailsSet) {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  if (!apiKey || !listId) return new Map();

  const baseUrl = getBaseUrl(apiKey);
  const detailsMap = new Map();
  let offset = 0;
  const count = 500;
  const maxPages = 100;

  for (let page = 0; page < maxPages; page++) {
    const res = await axios.get(`${baseUrl}/lists/${listId}/members`, {
      params: { count, offset },
      auth: { username: 'anystring', password: apiKey },
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });
    const members = res.data.members || [];
    for (const m of members) {
      const email = (typeof m.email_address === 'string' ? m.email_address : m.email_address?.email || '').toLowerCase().trim();
      if (!email || !emailsSet.has(email)) continue;
      const { firstName, lastName } = extractNameFromMergeFields(m.merge_fields);
      const phone = extractPhoneFromMergeFields(m.merge_fields);
      detailsMap.set(email, { firstName, lastName, phone });
    }
    if (members.length < count) break;
    offset += count;
  }
  return detailsMap;
}

module.exports = {
  getCampaignOpenEmails,
  getCampaignClickEmails,
  getCampaignEngagedEmails,
  getLastSentCampaigns,
  getCampaignListId,
  getPhonesForEmails,
  getMemberDetailsForEmails,
  getBaseUrl,
  getDatacenter
};
