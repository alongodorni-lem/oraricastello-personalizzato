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
  'aggiunto alla lista d\'attesa': 'riservato', 'added to waiting list': 'riservato',
  'non compiuto/a': 'riservato', 'non compiuto': 'riservato', 'non compiuta': 'riservato',
  'not completed': 'riservato',
  'riservato': 'riservato', 'reserved': 'riservato',
  // cancellato
  'aggiunto alla lista d\'attesa + cancellato dall\'amministratore': 'cancellato',
  'added to waiting list + cancelled by admin': 'cancellato',
  'cancellato automaticamente': 'cancellato', 'automatically cancelled': 'cancellato',
  'cancellato dall\'utente': 'cancellato', 'cancelled by client': 'cancellato',
  'cancellato dall\'amministratore': 'cancellato', 'cancelled by admin': 'cancellato',
  'cancelled': 'cancellato', 'canceled': 'cancellato',
  // confermato
  'check out effettuato': 'confermato', 'checked out': 'confermato',
  'checked-in': 'confermato', 'checked in': 'confermato',
  'checked-in (conflitto!)': 'confermato', 'checked in (conflict!)': 'confermato',
  'confermato': 'confermato', 'confirmed': 'confermato', 'completed': 'confermato',
  'riservato + indirizzo email verificato + confermato': 'confermato',
  'reserved + email address verified + confirmed': 'confermato'
};

function normalizeStatusToFilter(rawStatus) {
  if (!rawStatus || typeof rawStatus !== 'string') return null;
  const key = String(rawStatus).toLowerCase().trim();
  if (PLANYO_STATUS_TO_FILTER[key]) return PLANYO_STATUS_TO_FILTER[key];
  if (PLANYO_STATUS_TO_FILTER[rawStatus.trim()]) return PLANYO_STATUS_TO_FILTER[rawStatus.trim()];
  // Fallback: match per contenuto (es. "Reserved + ... + confirmed" o varianti)
  if (key.includes('cancellato') || key.includes('cancelled') || key.includes('canceled')) return 'cancellato';
  if (key.includes('confermato') || key.includes('confirmed') || key.includes('checked in') || key.includes('checked-in') || key.includes('check out') || key.includes('checked out')) return 'confermato';
  if (key.includes('riservato') || key.includes('reserved') || key.includes('lista d\'attesa') || key.includes('waiting list') || key.includes('non compiuto') || key.includes('not completed')) return 'riservato';
  return null;
}

/**
 * Colonne usate: Nome, Cognome, Email, Telefono (risultato) + Risorsa, Stato, IDrisorsa, Creazione
 */
const COL_ALIASES = {
  nome: ['first name', 'firstname', 'nome', 'name', 'prenome'],
  cognome: ['last name', 'lastname', 'cognome', 'surname', 'sobrenome'],
  email: ['email', 'e-mail', 'mail', 'e-mail address', 'email address', 'client email', 'user email', 'contact email', 'posta', 'correo'],
  telefono: ['phone', 'telefono', 'tel', 'mobile', 'cellulare'],
  evento: ['risorsa', 'resource name', 'nome risorsa', 'evento', 'nome evento'],
  idRisorsa: ['idrisorsa', 'id risorsa', 'resource id', 'resource_id', 'id_risorsa'],
  stato: ['status', 'stato', 'state', 'reservation status', 'stato prenotazione'],
  creazione: ['creazione', 'creation', 'created', 'data creazione', 'creation date', 'insert date', 'insert_date']
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
  const idxIdRisorsa = findColumnIndex(headers, COL_ALIASES.idRisorsa);
  const idxStato = findColumnIndex(headers, COL_ALIASES.stato);
  const idxCreazione = findColumnIndex(headers, COL_ALIASES.creazione);

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
      idRisorsa: get(idxIdRisorsa),
      stato: get(idxStato),
      creazione: get(idxCreazione)
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
      const synonyms = q === 'grotta' ? ['grotta', 'grotto'] : q === 'grotto' ? ['grotto', 'grotta'] : [q];
      out = out.filter((r) => {
        const ev = (r.eventoPrenotato || '').toLowerCase();
        return synonyms.some((s) => ev.includes(s));
      });
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
 * Esclude da Lista D i record la cui email è in Lista A.
 * Lista D = TUTTI i record CSV esclusi quelli con email in Lista A.
 * @param {Array} data
 * @param {{ emailsInA?: Set<string> }} excludeOptions
 */
function excludeListAFromListD(data, excludeOptions = {}) {
  const { emailsInA = new Set() } = excludeOptions;
  if (emailsInA.size === 0) return data;

  return data.filter((r) => !emailsInA.has((r.email || '').toLowerCase()));
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
 * Carica Lista D da cache (se disponibile) o da CSV URL
 * @param {{ eventNameContains?: string, statuses?: string[] }} filters
 * @param {{ emailsInA?: Set<string> }} excludeListA - esclude email in Lista A
 * @returns {Promise<Array<{ nome, cognome, email, telefono, segment: 'D' }>>}
 */
async function loadListDFromCsv(filters = {}, excludeListA = {}) {
  let raw;
  try {
    const dataCache = require('./dataCache');
    const cached = dataCache.loadPlanyoCache();
    if (cached?.contacts?.length) {
      raw = cached.contacts;
    } else {
      const csvUrl = process.env.PLANYO_LISTD_CSV_URL;
      raw = await fetchAndParseCsv(csvUrl);
    }
  } catch (_) {
    const csvUrl = process.env.PLANYO_LISTD_CSV_URL;
    raw = await fetchAndParseCsv(csvUrl);
  }

  let filtered = filterListDData(raw, filters);
  filtered = excludeListAFromListD(filtered, excludeListA);
  let deduped = dedupeByEmail(filtered);
  deduped = dedupeByPhone(deduped);

  return deduped.map((r) => ({
    nome: r.nome,
    cognome: r.cognome,
    email: r.email,
    telefono: planyo.normalizePhone(r.telefono) || r.telefono,
    eventoPrenotato: r.eventoPrenotato || '',
    segment: 'D'
  }));
}

/**
 * Debug: restituisce statistiche e campioni per diagnosi
 * @param {{ eventNameContains?: string, statuses?: string[] }} filters
 */
async function debugListD(filters = {}) {
  const csvUrl = process.env.PLANYO_LISTD_CSV_URL;
  if (!csvUrl) return { error: 'PLANYO_LISTD_CSV_URL non configurato' };
  const raw = await fetchAndParseCsv(csvUrl);
  const afterEvent = filters.eventNameContains
    ? raw.filter((r) => (r.eventoPrenotato || '').toLowerCase().includes((filters.eventNameContains || '').toLowerCase()))
    : raw;
  const afterStatus = filters.statuses?.length
    ? afterEvent.filter((r) => {
        const mapped = normalizeStatusToFilter(r.stato);
        return mapped && new Set(filters.statuses.map((s) => String(s).toLowerCase())).has(mapped);
      })
    : afterEvent;
  const statiUnici = [...new Set(raw.map((r) => r.stato || '(vuoto)'))];
  const risorseUniche = [...new Set(raw.map((r) => (r.eventoPrenotato || '').slice(0, 50)))].slice(0, 15);
  return {
    rawCount: raw.length,
    afterEventFilter: afterEvent.length,
    afterStatusFilter: afterStatus.length,
    statiUnici,
    risorseUniche,
    sampleRaw: raw.slice(0, 5).map((r) => ({ evento: r.eventoPrenotato, stato: r.stato, email: r.email?.slice(0, 3) + '...' })),
    filters: { eventNameContains: filters.eventNameContains, statuses: filters.statuses }
  };
}

module.exports = {
  fetchAndParseCsv,
  filterListDData,
  dedupeByEmail,
  dedupeByPhone,
  loadListDFromCsv,
  debugListD,
  STATUS_OPTIONS
};
