# Integrazione Newsletter SMS in un Web Service esistente (Render)

Guida per integrare newsletter-planyo-sms nel progetto **oraricastello-personalizzato** (o qualsiasi app Express).

## 1. Copia la cartella nel progetto

Copia l'intera cartella `newsletter-planyo-sms` nella root del tuo repo (o in una sottocartella):

```
oraricastello-personalizzato/
├── ... (file esistenti)
├── newsletter-planyo-sms/
│   ├── config/
│   ├── data/
│   ├── jobs/
│   ├── public/
│   ├── services/
│   ├── router.js      ← modulo montabile
│   ├── package.json
│   └── .env.example
```

## 2. Installa le dipendenze

Nel `package.json` del progetto principale aggiungi (se non presenti):

```json
{
  "dependencies": {
    "express": "...",
    "axios": "^1.6.0",
    "dotenv": "^16.3.0"
  }
}
```

Poi esegui `npm install`.

## 3. Monta il router nell'app Express

Nel file principale dell'app (es. `server.js` o `app.js`):

```javascript
// Aggiungi questa riga (dopo le altre route)
app.use('/newsletter-sms', require('./newsletter-planyo-sms/router'));
```

## 4. Variabili d'ambiente su Render

Nella dashboard Render → tuo servizio → **Environment** aggiungi:

| Variabile | Descrizione |
|-----------|-------------|
| `MAILCHIMP_API_KEY` | Chiave API Mailchimp (formato xxxx-us21) |
| `PLANYO_API_KEY` | Chiave API Planyo |
| `PLANYO_SITE_ID` | ID sito Planyo (es. 8895) |
| `SMSHOSTING_AUTH_KEY` | Auth key Smshosting |
| `SMSHOSTING_AUTH_SECRET` | Auth secret Smshosting |

## 5. Deploy

Dopo il push su GitHub, Render farà il deploy automatico.

L'interfaccia sarà disponibile su:
**https://oraricastello-personalizzato.onrender.com/newsletter-sms**

---

## Note

- **Timeout**: gli invii lunghi (1700+ SMS) possono richiedere 15+ minuti. Il piano Starter supporta richieste lunghe.
- **File di configurazione**: `data/ui-config.json` e `data/newsletter-sms-sent.json` vengono creati automaticamente. Su Render il filesystem è effimero: i dati si perdono al redeploy. Per persistenza usa un database o servizi esterni (opzionale).
- **Sicurezza**: valuta l'aggiunta di autenticazione (es. Basic Auth o login) se l'interfaccia è pubblica.
