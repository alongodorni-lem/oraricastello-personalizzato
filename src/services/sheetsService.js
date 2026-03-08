const { google } = require("googleapis");

function hasNonEmpty(value) {
  if (typeof value === "string") return value.trim().length > 0;
  return Boolean(value);
}

function validateServiceAccount(sa, sourceLabel) {
  const hasEmail = hasNonEmpty(sa?.client_email);
  const hasKey = hasNonEmpty(sa?.private_key);
  if (!hasEmail || !hasKey) {
    throw new Error(
      `Service account non valido da ${sourceLabel} [has_client_email=${hasEmail}; has_private_key=${hasKey}]`
    );
  }
  return {
    ...sa,
    client_email: String(sa.client_email).trim(),
    private_key: String(sa.private_key).replace(/\\n/g, "\n"),
  };
}

function getServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      return validateServiceAccount(parsed, "GOOGLE_SERVICE_ACCOUNT_JSON(raw)");
    } catch (_) {
      const decoded = Buffer.from(raw, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);
      return validateServiceAccount(parsed, "GOOGLE_SERVICE_ACCOUNT_JSON(base64)");
    }
  }
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (clientEmail && privateKey) {
    return validateServiceAccount({
      client_email: clientEmail,
      private_key: privateKey,
    }, "GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY");
  }
  throw new Error(
    `GOOGLE_SERVICE_ACCOUNT_JSON mancante (oppure imposta GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) [has_json=${hasNonEmpty(
      raw
    )}; has_email=${hasNonEmpty(clientEmail)}; has_private=${hasNonEmpty(privateKey)}]`
  );
}

async function appendPreferenceRow(payload, plan, emailStatus) {
  const sheetId = process.env.GOOGLE_SHEET_ID || "1mi0SD4Ebr9l1RYMjn4F3Bk_9kAgheYZbJLnaL0ujJgM";
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID mancante");

  const sa = getServiceAccount();
  if (!hasNonEmpty(sa.private_key)) {
    throw new Error("private_key vuota dopo parsing variabili ambiente");
  }
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
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
