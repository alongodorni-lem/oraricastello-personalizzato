/**
 * Servizio Lista D: dati da CSV Planyo.
 * Filtri: solo Risorsa (nome evento) e Stato. Risultati: Nome, Cognome, Email, Telefono.
 */
const axios = require('axios');
const planyo = require('./planyo');

const STATUS_OPTIONS = ['riservato', 'confermato', 'cancellato'];

/**
 * Mappa stati Planyo (CSV) → filtri UI (riservato, confermato, cancellato)
 * Etichette esatte dal report Planyo
 */
const PLANYO_STATUS_TO_FILTER = {
  // riservato
  'aggiunto alla lista d\'attesa': 'riservato',
  'non compiuto/a': 'riservato', 'non compiuto': 'riservato', 'non compiuta': 'riservato',
  'riservato': 'riservato',
  // cancellato
  'aggiunto alla lista d\'attesa + cancellato dall\'amministratore': 'cancellato',
  'cancellato automaticamente': 'cancellato',
  'cancellato dall\'utente': 'cancellato',
  'cancellato dall\'amministratore': 'cancellato',
  // confermato
  'check out effettuato': 'confermato',
  'checked-in': 'confermato',
  'checked-in (conflitto!)': 'confermato',
  'confermato': 'confermato',
  'riservato + indirizzo email verificato + confermato': 'confermato'
};

function normalizeStatusToFilter(rawStatus) {
  if (!rawStatus || typeof rawStatus !== 'string') return null;
  const key = String(rawStatus).toLowerCase().trim();
  return PLANYO_STATUS_TO_FILTER[key] || PLANYO_STATUS_TO_FILTER[rawStatus.trim()] || null;
}

/**
 * Colonne usate: Nome, Cognome, Email, Telefono (risultato) + Risorsa, Stato (solo per filtri)
 */
const COL_ALIASES = {
  nome: ['first name', 'firstname', 'nome', 'name', 'prenome'],
  cognome: ['last name', 'lastname', 'cognome', 'surname', 'sobrenome'],
  email: ['email', 'e-mail', 'mail', 'e-mail address', 'email address', 'client email', 'user email', 'contact email', 'posta', 'correo'],
  telefono: ['phone', 'telefono', 'tel', 'mobile', 'cellulare'],
  evento: ['risorsa', 'resource name', 'nome risorsa', 'evento', 'nome evento'],
  stato: ['status', 'stato', 'state', 'reservation status', 'stato prenotazione']
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

  let res;
  try {
    res = await axios.get(csvUrl, {
      timeout: 60000,
      responseType: 'text',
      headers: { 'Accept': 'text/csv, text/plain' },
      validateStatus: (s) => s < 500
    });
  } catch (err) {
    const status = err.response?.status;
    const msg = status === 500
      ? 'Il report CSV Planyo restituisce errore (HTTP 500). Il token shsec potrebbe essere scaduto: rigenera il link dal report Planyo e aggiorna PLANYO_LISTD_CSV_URL.'
      : (status ? `Errore fetch CSV: HTTP ${status}. Verifica che l\'URL e il token shsec siano validi.` : (err.message || 'Errore di connessione al report CSV.'));
    throw new Error(msg);
  }

  if (res.status >= 400) {
    throw new Error(`Errore fetch CSV: HTTP ${res.status}. Verifica che l\'URL e il token shsec siano validi.`);
  }

  let text = typeof res.data === 'string' ? res.data : String(res.data);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  // Planyo può avere righe di intestazione/metadati (es. "Reservations From: ... To: ...") prima delle colonne reali
  // Cerca la prima riga che contiene una colonna email
  let headerRowIdx = -1;
  let headers = [];
  for (let i = 0; i < rows.length; i++) {
    const candidate = rows[i].map((h) => String(h || '').replace(/^\uFEFF/, '').trim());
    if (findColumnIndex(candidate, COL_ALIASES.email) >= 0) {
      headerRowIdx = i;
      headers = candidate;
      break;
    }
  }

  const idxNome = findColumnIndex(headers, COL_ALIASES.nome);
  const idxCognome = findColumnIndex(headers, COL_ALIASES.cognome);
  const idxEmail = findColumnIndex(headers, COL_ALIASES.email);
  const idxTelefono = findColumnIndex(headers, COL_ALIASES.telefono);
  const idxEvento = findColumnIndex(headers, COL_ALIASES.evento);
  const idxStato = findColumnIndex(headers, COL_ALIASES.stato);

  if (idxEmail < 0) {
    const firstLine = rows[0]?.slice(0, 3).join(', ') || '(nessuna intestazione)';
    throw new Error(`Colonna email non trovata nel CSV. Prime righe: ${firstLine}... Verifica il formato del report Planyo.`);
  }

  const result = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
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
      stato: get(idxStato)
    });
  }

  return result;
}

/**
 * Filtra i dati CSV (solo Risorsa e Stato)
 * @param {Array} data
 * @param {{ eventNameContains?: string, statuses?: string[] }} filters
 */
function filterListDData(data, filters = {}) {
  let out = data;

  if (filters.eventNameContains && typeof filters.eventNameContains === 'string') {
    const q = filters.eventNameContains.trim().toLowerCase();
    if (q) {
      out = out.filter((r) => (r.eventoPrenotato || '').toLowerCase().includes(q));
    }
  }

  if (filters.statuses && Array.isArray(filters.statuses) && filters.statuses.length > 0) {
    const statusSet = new Set(filters.statuses.map((s) => String(s).toLowerCase().trim()));
    out = out.filter((r) => {
      const mapped = normalizeStatusToFilter(r.stato);
      return mapped && statusSet.has(mapped);
    });
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
 * @param {{ eventNameContains?: string, statuses?: string[] }} filters
 * @returns {Promise<Array<{ nome, cognome, email, telefono, segment: 'D' }>>}
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
    eventoPrenotato: '',
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
