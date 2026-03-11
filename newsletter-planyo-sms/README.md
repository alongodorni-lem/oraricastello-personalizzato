# Newsletter Planyo SMS

Integra report Mailchimp (aperture/click) con prenotazioni Planyo e invio SMS via Smshosting.

Progetto in cartella dedicata `newsletter-planyo-sms/` (separato da backend/frontend).

## Segmenti

- **Lista A**: Ha prenotato l'evento target (es. Castello 2026)
- **Lista B**: Ha prenotato altri eventi negli ultimi 18 mesi
- **Lista C**: Nessuna prenotazione negli ultimi 18 mesi

Ogni lista riceve un SMS promozionale diverso.

## Setup

1. Copia `.env.example` in `.env`
2. Compila le variabili:
   - `PLANYO_API_KEY`, `PLANYO_SITE_ID` (stesse del backend prenotazioni)
   - `MAILCHIMP_API_KEY` (con datacenter, es. `xxxx-us21`)
   - `SMSHOSTING_AUTH_KEY`, `SMSHOSTING_AUTH_SECRET` (da [cloud.smshosting.it](https://cloud.smshosting.it/) > Gestione sicurezza API)
3. Personalizza `config/segments.js` (evento target, testi SMS)

## Uso

### Interfaccia web (consigliata per il personale)

```bash
npm run ui
```

Apri [http://localhost:3456](http://localhost:3456) per un'interfaccia semplificata:
- **Invio campagna**: seleziona campagna, liste (A/B/C), avvia invio o simulazione
- **Invio prova**: invia un SMS di test al tuo numero
- **Verifica numero**: controlla se un numero era in una lista

### Da riga di comando

```bash
npm install

# Singola campagna (ID da .env o da parametro)
node index.js --campaign=CAMPAIGN_ID

# Ultime 2 campagne inviate (senza specificare ID)
node index.js --last=2

# Solo simulazione (nessun SMS inviato)
node index.js --last=2 --dry-run
```

Oppure imposta `MAILCHIMP_CAMPAIGN_ID` in `.env` e lancia `node index.js`.

## Schedulazione

Per esecuzione periodica (es. 1 volta al giorno):

- **Render Cron**: aggiungi un cron job che chiama il servizio
- **GitHub Actions**: workflow con `schedule`
- **node-cron**: aggiungi in `index.js` se il processo resta in esecuzione
