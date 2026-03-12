/**
 * Servizio per Lista D: carica dati da report CSV Planyo invece che da API
 * Filtri: nome evento contiene, id evento, stato (riservato, confermato, cancellato)
 */
const axios = require('axios');
const planyo = require('./planyo');

const STATUS_OPTIONS = ['riservato', 'confermato', 'cancellato'];

/**
 * Mappa nomi colonne comuni del report Planyo
 */
const COL_ALIASES = {
  nome: ['first name', 'firstname', 'nome', 'name', 'prenome'],
  cognome: ['last name', 'lastname', 'cognome', 'surname', 'sobrenome'],
  email: ['email', 'e-mail', 'mail', 'e-mail address', 'email address', 'client email', 'user email', 'contact email', 'posta', 'correo'],
  telefono: ['phone', 'telefono', 'tel', 'mobile', 'cellulare'],
  evento: ['resource', 'risorsa', 'resource name', 'evento', 'nome evento'],
  resourceId: ['resource id', 'resource_id', 'id risorsa', 'id evento'],
  stato: ['status', 'stato', 'state']
};

function findColumnIndex(headers, aliases) {
  const h = headers.map((x) => String(x || '').toLowerCase().trim());
  for (const a of aliases) {
    const i = h.findIndex((x) => x.includes(a) || a.includes(x));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Parse CSV semplice (gestisce virgolette)
 */
function parseCsv(text) {
  const lines = [];
  let current = [];
  let inQuotes = false;
  let field = '';

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',' || c === ';') {
        current.push(field.trim());
        field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        current.push(field.trim());
        field = '';
        if (current.some((x) => x)) lines.push(current);
        current = [];
      } else {
        field += c;
      }
    }
  }
  if (field || current.length) {
    current.push(field.trim());
    if (current.some((x) => x)) lines.push(current);
  }
  return lines;
}

/**
 * Carica e parse il CSV dal report Planyo
 * @param {string} csvUrl - URL completo (con shsec se necessario)
 * @returns {Promise<Array<Record<string, string>>>}
 */
async function fetchAndParseCsv(csvUrl) {
  if (!csvUrl || !csvUrl.startsWith('http')) {
    throw new Error('PLANYO_LISTD_CSV_URL non configurato o non valido');
  }

  const res = await axios.get(csvUrl, {
    timeout: 60000,
    responseType: 'text',
    headers: { 'Accept': 'text/csv, text/plain' },
    validateStatus: (s) => s < 500
  });

  if (res.status >= 400) {
    throw new Error(`Errore fetch CSV: HTTP ${res.status}. Verifica che l\'URL e il token shsec siano validi.`);
  }

  let text = typeof res.data === 'string' ? res.data : String(res.data);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => String(h || '').replace(/^\uFEFF/, '').trim());
  const idxNome = findColumnIndex(headers, COL_ALIASES.nome);
  const idxCognome = findColumnIndex(headers, COL_ALIASES.cognome);
  const idxEmail = findColumnIndex(headers, COL_ALIASES.email);
  const idxTelefono = findColumnIndex(headers, COL_ALIASES.telefono);
  const idxEvento = findColumnIndex(headers, COL_ALIASES.evento);
  const idxResourceId = findColumnIndex(headers, COL_ALIASES.resourceId);
  const idxStato = findColumnIndex(headers, COL_ALIASES.stato);

  if (idxEmail < 0) {
    const headerList = headers.length ? headers.join(', ') : '(nessuna intestazione)';
    throw new Error(`Colonna email non trovata nel CSV. Intestazioni trovate: ${headerList}. Verifica il formato del report Planyo.`);
  }

  const result = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const get = (idx) => (idx >= 0 && row[idx] !== undefined ? String(row[idx] || '').trim() : '');
    const email = get(idxEmail);
    if (!email || !email.includes('@')) continue;

    result.push({
      nome: get(idxNome),
      cognome: get(idxCognome),
      email: email.toLowerCase(),
      telefono: get(idxTelefono),
      eventoPrenotato: get(idxEvento),
      resourceId: get(idxResourceId),
      stato: get(idxStato)
    });
  }

  return result;
}

/**
 * Filtra i dati CSV
 * @param {Array} data
 * @param {{ eventNameContains?: string, eventIds?: number[], statuses?: string[] }} filters
 */
function filterListDData(data, filters = {}) {
  let out = data;

  if (filters.eventNameContains && typeof filters.eventNameContains === 'string') {
    const q = filters.eventNameContains.trim().toLowerCase();
    if (q) {
      out = out.filter((r) => (r.eventoPrenotato || '').toLowerCase().includes(q));
    }
  }

  if (filters.eventIds && Array.isArray(filters.eventIds) && filters.eventIds.length > 0) {
    const ids = new Set(filters.eventIds.map(Number).filter((n) => !isNaN(n)));
    out = out.filter((r) => {
      const rid = parseInt(r.resourceId, 10);
      return !isNaN(rid) && ids.has(rid);
    });
  }

  if (filters.statuses && Array.isArray(filters.statuses) && filters.statuses.length > 0) {
    const statusSet = new Set(filters.statuses.map((s) => String(s).toLowerCase().trim()));
    out = out.filter((r) => statusSet.has((r.stato || '').toLowerCase().trim()));
  }

  return out;
}

/**
 * Deduplica per email (mantiene primo record)
 */
function dedupeByEmail(data) {
  const seen = new Set();
  return data.filter((r) => {
    const key = (r.email || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Deduplica per telefono (mantiene primo record, normalizza per confronto)
 */
function dedupeByPhone(data) {
  const seen = new Set();
  return data.filter((r) => {
    const raw = (r.telefono || '').trim();
    if (!raw || raw.length < 9) return true;
    const key = planyo.normalizePhone(raw);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Carica Lista D da CSV con filtri
 * @param {{ eventNameContains?: string, eventIds?: number[], statuses?: string[] }} filters
 * @returns {Promise<Array<{ nome, cognome, email, telefono, eventoPrenotato, segment: 'D' }>>}
 */
async function loadListDFromCsv(filters = {}) {
  const csvUrl = process.env.PLANYO_LISTD_CSV_URL;
  const raw = await fetchAndParseCsv(csvUrl);
  const filtered = filterListDData(raw, filters);
  let deduped = dedupeByEmail(filtered);
  deduped = dedupeByPhone(deduped);

  return deduped.map((r) => ({
    nome: r.nome,
    cognome: r.cognome,
    email: r.email,
    telefono: planyo.normalizePhone(r.telefono) || r.telefono,
    eventoPrenotato: r.eventoPrenotato,
    segment: 'D'
  }));
}

module.exports = {
  fetchAndParseCsv,
  filterListDData,
  dedupeByEmail,
  dedupeByPhone,
  loadListDFromCsv,
  STATUS_OPTIONS
};
