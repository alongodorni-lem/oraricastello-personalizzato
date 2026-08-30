const axios = require('axios');

const BASE_URL = 'https://api.resend.com';

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

function getApiKey() {
  return String(process.env.RESEND_API_KEY || '').trim();
}

function getConfiguredAudienceIds() {
  const raw = String(process.env.RESEND_AUDIENCE_ID || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((v) => String(v || '').trim())
    .filter(Boolean);
}

function getAuthHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
}

async function listAudiences(apiKey) {
  const res = await axios.get(`${BASE_URL}/audiences`, {
    headers: getAuthHeaders(apiKey),
    timeout: 30000
  });
  const rows = Array.isArray(res?.data?.data)
    ? res.data.data
    : (Array.isArray(res?.data?.audiences) ? res.data.audiences : []);
  return rows
    .map((row) => String(row?.id || '').trim())
    .filter(Boolean);
}

async function getGlobalContactByEmail(apiKey, email) {
  const res = await axios.get(`${BASE_URL}/contacts/${encodeURIComponent(email)}`, {
    headers: getAuthHeaders(apiKey),
    timeout: 30000,
    validateStatus: (s) => s < 500
  });
  if (res.status === 404) return { status: 'not_found', contacts: [] };
  if (res.status >= 400) {
    return { status: 'error', reason: `Resend rubrica globale: HTTP ${res.status}` };
  }
  const row = res.data && typeof res.data === 'object' ? (res.data.data || res.data) : null;
  const id = String(row?.id || '').trim();
  const rowEmail = normalizeEmail(row?.email);
  if (!id || (rowEmail && rowEmail !== email)) return { status: 'not_found', contacts: [] };
  return {
    status: 'found',
    contacts: [{
      id,
      email: rowEmail || email,
      scope: 'global'
    }]
  };
}

async function listAudienceContactsByEmail(apiKey, audienceId, email) {
  const direct = await axios.get(`${BASE_URL}/audiences/${encodeURIComponent(audienceId)}/contacts/${encodeURIComponent(email)}`, {
    headers: getAuthHeaders(apiKey),
    timeout: 30000,
    validateStatus: (s) => s < 500
  });
  if (direct.status === 200) {
    const row = direct.data && typeof direct.data === 'object' ? (direct.data.data || direct.data) : null;
    const id = String(row?.id || '').trim();
    const rowEmail = normalizeEmail(row?.email || email);
    if (id) {
      return {
        status: 'found',
        contacts: [{ id, email: rowEmail, audienceId, scope: 'audience' }]
      };
    }
  }
  if (direct.status && direct.status !== 404 && direct.status < 500) {
    return { status: 'error', reason: `Resend lookup audience ${audienceId}: HTTP ${direct.status}` };
  }

  const res = await axios.get(`${BASE_URL}/audiences/${encodeURIComponent(audienceId)}/contacts`, {
    headers: getAuthHeaders(apiKey),
    params: { email },
    timeout: 30000,
    validateStatus: (s) => s < 500
  });

  if (res.status === 404) return { status: 'not_found', contacts: [] };
  if (res.status >= 400) {
    return { status: 'error', reason: `Resend lookup audience ${audienceId}: HTTP ${res.status}` };
  }

  const rows = Array.isArray(res?.data?.data)
    ? res.data.data
    : (Array.isArray(res?.data?.contacts) ? res.data.contacts : []);
  const normalized = rows
    .map((row) => ({
      id: String(row?.id || '').trim(),
      email: normalizeEmail(row?.email),
      audienceId,
      scope: 'audience'
    }))
    .filter((row) => row.id && row.email === email);

  return { status: normalized.length ? 'found' : 'not_found', contacts: normalized };
}

async function getAudienceIdsForPrivacy(apiKey) {
  const configured = getConfiguredAudienceIds();
  if (configured.length) return configured;
  return listAudiences(apiKey);
}

async function findContactByEmailForPrivacy(email) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@')) {
    return { source: 'resend', status: 'not_found', found: false, reason: 'Email non valida' };
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return { source: 'resend', status: 'skipped', found: false, reason: 'RESEND_API_KEY non configurata' };
  }

  const matches = [];
  const errors = [];
  const searchedIn = ['rubrica globale'];

  try {
    const globalFound = await getGlobalContactByEmail(apiKey, normalized);
    if (globalFound.status === 'error') {
      errors.push(globalFound.reason || 'Errore rubrica globale Resend');
    } else if (Array.isArray(globalFound.contacts) && globalFound.contacts.length) {
      matches.push(...globalFound.contacts);
    }
  } catch (err) {
    errors.push(err.message);
  }

  const audienceIds = await getAudienceIdsForPrivacy(apiKey).catch((err) => {
    errors.push(`Resend audiences: ${err.message}`);
    return [];
  });
  if (audienceIds.length) searchedIn.push('audience (' + audienceIds.length + ')');

  for (const audienceId of audienceIds) {
    try {
      const found = await listAudienceContactsByEmail(apiKey, audienceId, normalized);
      if (found.status === 'error') {
        errors.push(found.reason || `Errore lookup audience ${audienceId}`);
        continue;
      }
      if (Array.isArray(found.contacts) && found.contacts.length) {
        matches.push(...found.contacts);
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (matches.length) {
    const via = matches.some((c) => c.scope === 'global') ? 'rubrica globale' : 'audience';
    return {
      source: 'resend',
      status: 'found',
      found: true,
      contacts: matches,
      reason: 'Trovato in ' + via
    };
  }
  if (errors.length && !audienceIds.length && !matches.length) {
    return {
      source: 'resend',
      status: 'error',
      found: false,
      reason: errors.slice(0, 2).join(' | ')
    };
  }
  return {
    source: 'resend',
    status: 'not_found',
    found: false,
    reason: 'Non presente in ' + searchedIn.join(' e ')
  };
}

async function deleteContactByEmailForPrivacy(email) {
  const found = await findContactByEmailForPrivacy(email);
  if (found.status === 'skipped') return { source: 'resend', status: 'skipped', reason: found.reason };
  if (found.status === 'error') return { source: 'resend', status: 'error', reason: found.reason };
  if (!found.found) return { source: 'resend', status: 'not_found' };

  const apiKey = getApiKey();
  const contacts = Array.isArray(found.contacts) ? found.contacts : [];
  let deletedCount = 0;
  let notFoundCount = 0;
  let failedCount = 0;
  const failReasons = [];

  for (const c of contacts) {
    try {
      const url = c.audienceId
        ? `${BASE_URL}/audiences/${encodeURIComponent(c.audienceId)}/contacts/${encodeURIComponent(c.id || email)}`
        : `${BASE_URL}/contacts/${encodeURIComponent(c.id || email)}`;
      const res = await axios.delete(url, {
        headers: getAuthHeaders(apiKey),
        timeout: 30000,
        validateStatus: (s) => s < 500
      });
      if (res.status === 200 || res.status === 204) {
        deletedCount++;
      } else if (res.status === 404) {
        notFoundCount++;
      } else {
        failedCount++;
        failReasons.push(`HTTP ${res.status}` + (c.audienceId ? ` su audience ${c.audienceId}` : ' su rubrica globale'));
      }
    } catch (err) {
      failedCount++;
      failReasons.push(err.message);
    }
  }

  if (deletedCount > 0 && failedCount === 0) {
    return { source: 'resend', status: 'deleted', deletedContacts: deletedCount, matchedContacts: contacts.length };
  }
  if (deletedCount === 0 && notFoundCount === contacts.length) {
    return { source: 'resend', status: 'not_found' };
  }
  if (deletedCount > 0) {
    return {
      source: 'resend',
      status: 'found_not_deleted',
      deletedContacts: deletedCount,
      matchedContacts: contacts.length,
      reason: `Cancellazione parziale (${deletedCount}/${contacts.length})`
    };
  }
  return {
    source: 'resend',
    status: 'found_not_deleted',
    matchedContacts: contacts.length,
    reason: failReasons[0] || 'Delete non confermato da Resend'
  };
}

module.exports = {
  findContactByEmailForPrivacy,
  deleteContactByEmailForPrivacy
};
