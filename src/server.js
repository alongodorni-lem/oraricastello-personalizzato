const path = require("path");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { programData } = require("./data/program");
const { buildPersonalPlan } = require("./planner/buildPlan");
const { buildPlanPdf } = require("./services/pdfService");
const { appendPreferenceRow } = require("./services/sheetsService");
const { enrichPlanWithAI } = require("./services/aiService");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "oraricastello-personalizzato" });
});

app.get("/api/program", (_req, res) => {
  res.json({ eventName: programData.eventName, activities: programData.activities });
});

app.post("/api/personalize", async (req, res) => {
  const payload = req.body || {};
  if (!payload.email || !payload.visitDate || !payload.arrivalTime || !payload.stayDuration) {
    return res.status(400).json({ error: "Email, data, orario arrivo e durata permanenza sono obbligatori." });
  }
  const allowedDates = new Set(["2026-04-19", "2026-04-25", "2026-04-26", "2026-05-01"]);
  if (!allowedDates.has(payload.visitDate)) {
    return res.status(400).json({ error: "Data non valida. Seleziona una data disponibile dal menu." });
  }
  const toMinutes = (t) => {
    const [h, m] = String(t).split(":").map(Number);
    return h * 60 + m;
  };
  if (toMinutes(payload.arrivalTime) > toMinutes(programData.gates.lastEntry)) {
    return res.status(400).json({ error: "Orario non valido: ultimo ingresso alle 15:00." });
  }
  const available = toMinutes(programData.gates.parkClose) - toMinutes(payload.arrivalTime);
  if (payload.stayDuration === "over_4h" && available <= 240) {
    return res.status(400).json({ error: "Con questo arrivo non puoi selezionare oltre 4 ore (chiusura alle 17:30)." });
  }
  if (payload.hasChildren === true) {
    const ages = Array.isArray(payload.childrenAges) ? payload.childrenAges : [];
    const validAges = ages.filter((n) => !Number.isNaN(Number(n)));
    if (validAges.length === 0) {
      return res.status(400).json({ error: "Con bambini presenti devi indicare almeno una eta." });
    }
  }

  try {
    let plan = buildPersonalPlan(payload);
    plan = await enrichPlanWithAI(plan);
    const pdfBuffer = await buildPlanPdf(plan);

    const emailStatus = "NOT_SENT (download PDF only)";

    let sheetsStatus = "SAVED";
    try {
      await appendPreferenceRow(payload, plan, emailStatus);
    } catch (err) {
      sheetsStatus = `SHEETS_ERROR: ${err.message}`;
    }

    return res.json({
      ok: true,
      plan,
      sheetsStatus,
      pdfBase64: pdfBuffer.toString("base64"),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Errore interno." });
  }
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`oraricastello-personalizzato listening on ${PORT}`);
});
