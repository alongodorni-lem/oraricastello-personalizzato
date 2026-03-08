const { google } = require("googleapis");

function getServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.private_key) parsed.private_key = String(parsed.private_key).replace(/\\n/g, "\n");
      return parsed;
    } catch (_) {
      const decoded = Buffer.from(raw, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);
      if (parsed.private_key) parsed.private_key = String(parsed.private_key).replace(/\\n/g, "\n");
      return parsed;
    }
  }
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (clientEmail && privateKey) {
    return {
      client_email: clientEmail,
      private_key: String(privateKey).replace(/\\n/g, "\n"),
    };
  }
  throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON mancante (oppure imposta GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)");
}

async function appendPreferenceRow(payload, plan, emailStatus) {
  const sheetId = process.env.GOOGLE_SHEET_ID || "1mi0SD4Ebr9l1RYMjn4F3Bk_9kAgheYZbJLnaL0ujJgM";
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID mancante");

  const sa = getServiceAccount();
  const auth = new google.auth.JWT(
    sa.client_email,
    null,
    sa.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  await auth.authorize();

  const sheets = google.sheets({ version: "v4", auth });
  const values = [[
    new Date().toISOString(),
    payload.email || "",
    payload.visitDate || "",
    payload.hasChildren ? "SI" : "NO",
    (payload.childrenAges || []).join(","),
    payload.arrivalTime || "",
    (payload.interests || []).join(","),
    (payload.freeText || "").slice(0, 500),
    plan.itinerary.map((i) => `${i.start}-${i.end} ${i.activity}`).join(" | "),
    emailStatus,
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: process.env.GOOGLE_SHEET_RANGE || "Sheet1!A:J",
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

module.exports = { appendPreferenceRow };
