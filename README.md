# OrariCastello Personalizzato

Seconda versione separata da `oraricastello-programma`, con:
- form utente per preferenze e profilo famiglia
- generazione itinerario personalizzato
- download diretto PDF
- registrazione preferenze (inclusa email utente) su Google Sheets

## Stack
- Node.js + Express
- Frontend statico (`public/`)
- PDFKit
- Google Sheets API
- opzionale rifinitura testo con OpenAI

## Avvio locale
1. Copia `.env.example` in `.env` e configura le variabili.
2. Installa dipendenze:
   - `npm install`
3. Avvia in sviluppo:
   - `npm run dev`
4. Apri:
   - `http://localhost:3000`

## API
- `GET /api/health` stato servizio
- `GET /api/program` dataset attività
- `POST /api/personalize` genera piano + PDF scaricabile + log sheets

### Payload `/api/personalize`
```json
{
  "email": "utente@email.it",
  "visitDate": "2026-04-25",
  "arrivalTime": "10:30",
  "stayDuration": "between_2_5h_4h",
  "hasChildren": true,
  "childrenAges": [4, 7],
  "interests": ["Principesse", "Maghi", "Natura"],
  "freeText": "Preferiamo attività tranquille"
}
```

Note:
- `visitDate` deve essere una delle date evento: `2026-04-19`, `2026-04-25`, `2026-04-26`, `2026-05-01`
- `arrivalTime` nel frontend e mostrato a menu ogni 30 minuti, da `09:30` a `15:00`

## Render deploy
1. Crea nuovo repo `oraricastello-personalizzato`.
2. Push del progetto.
3. Su Render crea **Web Service**:
   - Build command: `npm install`
   - Start command: `npm start`
4. Aggiungi Environment Variables da `.env.example`.

## Google Sheets setup
1. Crea Service Account in Google Cloud.
2. Abilita Google Sheets API.
3. Condividi il foglio con la mail del service account.
4. Inserisci le variabili ambiente:
   - Opzione A: `GOOGLE_SERVICE_ACCOUNT_JSON` (JSON raw in una riga, oppure base64 del JSON)
   - Opzione B: `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
   - `GOOGLE_SHEET_ID`
   - `GOOGLE_SHEET_RANGE` (default consigliato: `Sheet1!A:J`)

### Esempio rapido su Windows PowerShell (locale)
```powershell
$sa = Get-Content ".\service-account.json" -Raw
$env:GOOGLE_SERVICE_ACCOUNT_JSON = $sa
$env:GOOGLE_SHEET_ID = "INSERISCI_ID_FOGLIO"
$env:GOOGLE_SHEET_RANGE = "Sheet1!A:J"
npm run dev
```

### Esempio Render
- aggiungi ENV `GOOGLE_SERVICE_ACCOUNT_JSON` con contenuto JSON in una riga (oppure base64)
- aggiungi `GOOGLE_SHEET_ID`
- opzionale `GOOGLE_SHEET_RANGE=Sheet1!A:J`
