function parseChildrenAges(input) {
  if (!input.trim()) return [];
  return input
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => !Number.isNaN(v));
}

const LAST_ENTRY = "15:00";
const PARK_CLOSE = "17:30";
const DEFAULT_INTRO_NOTE =
  "Questi sono semplici suggerimenti automatici basati sul programma: gestisci in autonomia le tue scelte nel corso della giornata in base alle tue esigenze e all'eventuale affollamento di alcune aree.";
const DEFAULT_FINAL_NOTE =
  "Durante la giornata non perderti la Passeggiata in natura nel Sentiero Incantato del Parco.\nDurante la giornata puoi ritirare presso la postazione del fotografo - all'interno del Castello - una copia stampata della tua foto di famiglia in omaggio (servizio offerto dal fotografo)";
let latestPdfBase64 = "";

function toMinutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function refreshStayDurationOptions() {
  const arrivalInput = document.getElementById("arrivalTime");
  const select = document.getElementById("stayDuration");
  const arrival = toMinutes(arrivalInput.value);
  const maxAvailable = toMinutes(PARK_CLOSE) - arrival;
  const rules = [
    { id: "at_least_2_5h", min: 150 },
    { id: "between_2_5h_4h", min: 150 },
    { id: "over_4h", min: 241 },
  ];

  let firstEnabled = null;
  Array.from(select.options).forEach((opt) => {
    const rule = rules.find((r) => r.id === opt.value);
    const enabled = rule ? maxAvailable >= rule.min : true;
    opt.disabled = !enabled;
    if (enabled && firstEnabled === null) firstEnabled = opt.value;
  });

  if (select.options[select.selectedIndex]?.disabled && firstEnabled) {
    select.value = firstEnabled;
  }
}

function selectedInterests() {
  return Array.from(document.querySelectorAll(".chips input:checked")).map((el) => el.value);
}

function syncChildrenAgesRequirement() {
  const hasChildren = document.getElementById("hasChildren").value === "yes";
  const agesInput = document.getElementById("childrenAges");
  agesInput.required = hasChildren;
  if (hasChildren) {
    agesInput.placeholder = "obbligatorio se ci sono bambini";
  } else {
    agesInput.placeholder = "solo se presenti bambini";
    agesInput.value = "";
  }
}

function renderPlanBlock(plan, title) {
  const introNote = plan.introNote || DEFAULT_INTRO_NOTE;
  const finalNote = (plan.finalNote || DEFAULT_FINAL_NOTE).replace(/\n/g, "<br>");
  const shortStayWarning =
    plan.metadata?.stayDuration === "at_least_2_5h"
      ? "Se ti fermi 2,5 ore potresti non riuscire a partecipare a tutte le attività"
      : "";
  const rows = plan.itinerary
    .map(
      (s, i) => {
        if (s.kind === "separator") {
          return `<hr style="border:0;border-top:1px solid #d7dff1;margin:12px 0;">`;
        }

        const inferredColorKey =
          s.colorKey ||
          (/Giardino delle Principesse|Ballo nel Castello/i.test(s.activity)
            ? "blue"
            : /Scuola di Magia|Stanza dei segreti|Mago Merlino|Sentiero Incantato|Lezione|Mini Torneo/i.test(
                  s.activity
                )
              ? "brown"
              : /Snoezelen/i.test(s.activity)
                ? "pink"
              : /K-POP/i.test(s.activity)
                ? "red"
                : /BEE-Dance|Ape Maia/i.test(s.activity)
                  ? "black"
                  : /Area Benessere|Yin Yoga|Meditazione del Cuore/i.test(s.activity)
                    ? "green"
                    : null);
        const normalizedNote =
          s.note === "abbinata a Mago Merlino: tempo percorso (60 min)"
            ? "Per la passeggiata nel parco calcola almeno 30 minuti"
            : s.note;
        const colorStyle =
          inferredColorKey === "blue"
            ? "color:#1d4ed8;font-weight:700"
            : inferredColorKey === "purple"
              ? "color:#7c3aed;font-weight:700"
              : inferredColorKey === "pink"
                ? "color:#db2777;font-weight:700"
              : inferredColorKey === "brown"
                ? "color:#92400e;font-weight:700"
                : inferredColorKey === "green"
                  ? "color:#15803d;font-weight:700"
                  : inferredColorKey === "red"
                    ? "color:#b91c1c;font-weight:700"
                    : inferredColorKey === "black"
                      ? "color:#111827;font-weight:700"
                      : null;
        const isWellness = /Area Benessere/i.test(s.activity);
        const displayNote =
          s.activity === "Spettacoli - K-POP" && normalizedNote === "obbligatoria: bambini da 7 anni in su"
            ? ""
            : (normalizedNote || "");

        if (s.kind === "section") {
          return `
      <div class="step">
        <strong style="${colorStyle || "color:#1a2452;font-weight:700"}">${s.activity}</strong>
        ${displayNote ? `<br><span style="color:#556080">${displayNote}</span>` : ""}
      </div>
    `;
        }

        if (s.kind === "item" || s.kind === "lunch") {
          return `
      <div class="step">
        ${
          s.kind === "lunch"
            ? `<span style="color:#b91c1c;font-weight:700">${s.activity}</span>`
            : colorStyle
              ? `<span style="${colorStyle}">${s.activity}</span>`
              : s.activity
        }<br>
        ${s.location ? `<span style="color:#556080">${s.location}</span><br>` : ""}
        ${displayNote ? `<span style="${s.kind === "lunch" ? "color:#b91c1c;font-weight:700" : (colorStyle || "color:#556080")}">${displayNote}</span>` : ""}
      </div>
    `;
        }

        return `
      <div class="step">
        ${s.preActivityText ? `<span style="color:#556080">${s.preActivityText}</span><br>` : ""}
        <strong>${i + 1}. ${s.start} - ${s.end}</strong><br>
        ${
          s.kind === "lunch"
            ? `<span style="color:#b91c1c;font-weight:700">${s.activity}</span>`
            : colorStyle
              ? `<span style="${colorStyle}">${s.activity}</span>`
              : isWellness
                ? `<span style="color:#15803d;font-weight:700">${s.activity}</span>`
              : s.activity
        }<br>
        <span style="color:#556080">${s.location}</span><br>
        <span style="${
          s.kind === "lunch"
            ? "color:#b91c1c;font-weight:700"
            : colorStyle
              ? colorStyle
              : isWellness
                ? "color:#15803d;font-weight:700"
              : "color:#556080"
        }">${displayNote}</span>
      </div>
    `;
      }
    )
    .join("");
  return `
    ${title ? `<p><strong>${title}</strong></p>` : ""}
    ${shortStayWarning ? `<p style="color:#b91c1c">${shortStayWarning}</p>` : ""}
    <p><em>${introNote}</em></p>
    <p>${plan.summary}</p>
    ${rows}
    <p><strong>${finalNote}</strong></p>
  `;
}

function renderPlan(plan, multiPlan) {
  const container = document.getElementById("result");
  if (!multiPlan) {
    container.innerHTML = renderPlanBlock(plan, "");
    return;
  }
  const focusedHtml = (multiPlan.focusedPlans || [])
    .map((entry) =>
      renderPlanBlock(
        entry.plan,
        `${multiPlan.focusedIntro} per chi ama ${entry.interest}:`
      )
    )
    .join('<hr style="border:0;border-top:1px solid #d7dff1;margin:16px 0;">');

  container.innerHTML = `
    <p><strong>${multiPlan.intro}</strong></p>
    ${renderPlanBlock(multiPlan.commonPlan || plan, "")}
    <hr style="border:0;border-top:1px solid #1a2452;margin:18px 0;">
    ${focusedHtml}
  `;
}

function renderPdfButton() {
  const container = document.getElementById("result");
  if (!latestPdfBase64) return;
  container.insertAdjacentHTML(
    "beforeend",
    `
      <div style="margin-top:14px;">
        <button id="downloadPdfBtn" type="button" style="background:#b91c1c;color:#fff;border:0;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer;">
          Scarica PDF
        </button>
      </div>
    `
  );
  const btn = document.getElementById("downloadPdfBtn");
  if (btn) {
    btn.addEventListener("click", () => downloadPdf(latestPdfBase64));
    return;
  }
}

function downloadPdf(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "programma-personalizzato.pdf";
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById("planner-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById("submitBtn");
  const status = document.getElementById("status");
  submitBtn.disabled = true;
  status.textContent = "Generazione in corso...";

  const payload = {
    email: document.getElementById("email").value.trim(),
    visitDate: document.getElementById("visitDate").value,
    arrivalTime: document.getElementById("arrivalTime").value,
    stayDuration: document.getElementById("stayDuration").value,
    hasChildren: document.getElementById("hasChildren").value === "yes",
    childrenAges: parseChildrenAges(document.getElementById("childrenAges").value),
    interests: selectedInterests(),
    freeText: document.getElementById("freeText").value.trim(),
  };

  const arrivalMins = toMinutes(payload.arrivalTime);
  if (arrivalMins > toMinutes(LAST_ENTRY)) {
    submitBtn.disabled = false;
    status.textContent = "Errore: ultimo ingresso alle 15:00.";
    return;
  }
  const maxAvailable = toMinutes(PARK_CLOSE) - arrivalMins;
  if (payload.stayDuration === "over_4h" && maxAvailable <= 240) {
    submitBtn.disabled = false;
    status.textContent = "Errore: con questo orario di arrivo non puoi selezionare oltre 4 ore.";
    return;
  }
  if (payload.hasChildren && payload.childrenAges.length === 0) {
    submitBtn.disabled = false;
    status.textContent = "Errore: con bambini presenti devi indicare almeno una eta.";
    return;
  }

  try {
    const res = await fetch("/api/personalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Errore durante la generazione.");

    latestPdfBase64 = data.pdfBase64 || "";
    renderPlan(data.plan, data.multiPlan);
    renderPdfButton();
    status.textContent = `Completato. Premi "Scarica PDF" per il download. Sheets: ${data.sheetsStatus}.`;
  } catch (err) {
    status.textContent = `Errore: ${err.message}`;
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById("arrivalTime").addEventListener("change", refreshStayDurationOptions);
document.getElementById("hasChildren").addEventListener("change", syncChildrenAgesRequirement);
syncChildrenAgesRequirement();
refreshStayDurationOptions();
