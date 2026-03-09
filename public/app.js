function parseChildrenAges(input) {
  if (!input.trim()) return [];
  return input
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => !Number.isNaN(v));
}

function validateChildrenAgesInput(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) return null;
  const invalidMsg = "Separa l'età di ciascun bambino con la virgola";

  // Esempio non valido richiesto: "4 6 8"
  const hasComma = raw.includes(",");
  const spaceParts = raw.split(/\s+/).filter(Boolean);
  if (!hasComma && spaceParts.length > 1 && spaceParts.every((p) => /^\d+$/.test(p))) {
    return invalidMsg;
  }

  // Se presente un numero a due cifre superiore a 18, mostra stesso errore.
  const numericTokens = raw.match(/\d+/g) || [];
  if (numericTokens.some((n) => n.length >= 2 && Number(n) > 18)) {
    return invalidMsg;
  }

  return null;
}

function clearFieldErrors() {
  document.querySelectorAll(".field-error").forEach((el) => el.classList.remove("field-error"));
  document.querySelectorAll(".field-error-text").forEach((el) => el.remove());
}

function setFieldError(fieldId, message) {
  const field = document.getElementById(fieldId);
  if (!field) return;
  field.classList.add("field-error");
  const existing = document.getElementById(`err-${fieldId}`);
  if (existing) existing.remove();
  const msg = document.createElement("div");
  msg.id = `err-${fieldId}`;
  msg.className = "field-error-text";
  msg.textContent = message;
  field.insertAdjacentElement("afterend", msg);
}

const LAST_ENTRY = "15:00";
const PARK_CLOSE = "17:30";
const DEFAULT_INTRO_NOTE =
  "Gestisci in autonomia le tue scelte nel corso della giornata in base alle tue esigenze e all'eventuale affollamento di alcune aree.";
const DEFAULT_FINAL_NOTE =
  "Durante la giornata puoi ritirare presso la postazione del fotografo - all'interno del Castello - una copia stampata della tua foto di famiglia in omaggio (servizio offerto dal fotografo)";
let latestPdfBase64 = "";

function toMinutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function notifyParentHeight() {
  if (window.parent === window) return;
  const body = document.body;
  const html = document.documentElement;
  const height = Math.max(
    body ? body.scrollHeight : 0,
    body ? body.offsetHeight : 0,
    html ? html.clientHeight : 0,
    html ? html.scrollHeight : 0,
    html ? html.offsetHeight : 0
  );
  window.parent.postMessage(
    {
      type: "resize-iframe",
      height: Math.max(900, height + 24),
    },
    "*"
  );
}

function scrollToResultBottom() {
  const target = document.getElementById("downloadPdfBtn") || document.getElementById("result");
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "end" });
}

function updateScrollButtonsState() {
  const upBtn = document.getElementById("scrollUpBtn");
  const downBtn = document.getElementById("scrollDownBtn");
  if (!upBtn || !downBtn) return;
  const top = window.scrollY || document.documentElement.scrollTop || 0;
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  upBtn.disabled = top <= 8;
  downBtn.disabled = top >= max - 8;
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
  const summary = (plan.summary || "").trim();
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
    ${summary ? `<p>${summary}</p>` : ""}
    ${rows}
    <p><strong>${finalNote}</strong></p>
  `;
}

function renderPlan(plan, multiPlan) {
  const container = document.getElementById("result");
  if (!multiPlan) {
    container.innerHTML = renderPlanBlock(plan, "");
    notifyParentHeight();
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
  notifyParentHeight();
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
        <div style="margin-top:8px;font-size:12px;color:#6b7280;">
          &copy; Sistema gestione orari sviluppato in esclusiva da Lem s.r.l. - Per info lemcomunicazione@gmail.com
        </div>
      </div>
    `
  );
  const btn = document.getElementById("downloadPdfBtn");
  if (btn) {
    btn.addEventListener("click", () => downloadPdf(latestPdfBase64));
    scrollToResultBottom();
    notifyParentHeight();
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
  const rawChildrenAges = document.getElementById("childrenAges").value;
  clearFieldErrors();
  submitBtn.disabled = true;
  status.textContent = "Generazione in corso...";

  const payload = {
    email: document.getElementById("email").value.trim(),
    visitDate: document.getElementById("visitDate").value,
    arrivalTime: document.getElementById("arrivalTime").value,
    stayDuration: document.getElementById("stayDuration").value,
    hasChildren: document.getElementById("hasChildren").value === "yes",
    childrenAges: parseChildrenAges(rawChildrenAges),
    interests: selectedInterests(),
    freeText: document.getElementById("freeText").value.trim(),
  };

  const arrivalMins = toMinutes(payload.arrivalTime);
  if (!payload.email) {
    submitBtn.disabled = false;
    setFieldError("email", "Campo obbligatorio");
    status.textContent = "Errore: inserisci l'email.";
    return;
  }
  if (!payload.visitDate) {
    submitBtn.disabled = false;
    setFieldError("visitDate", "Campo obbligatorio");
    status.textContent = "Errore: seleziona una data.";
    return;
  }
  if (!payload.arrivalTime) {
    submitBtn.disabled = false;
    setFieldError("arrivalTime", "Campo obbligatorio");
    status.textContent = "Errore: seleziona un orario di arrivo.";
    return;
  }
  if (!payload.stayDuration) {
    submitBtn.disabled = false;
    setFieldError("stayDuration", "Campo obbligatorio");
    status.textContent = "Errore: seleziona la durata di permanenza.";
    return;
  }
  if (arrivalMins > toMinutes(LAST_ENTRY)) {
    submitBtn.disabled = false;
    setFieldError("arrivalTime", "Orario non valido");
    status.textContent = "Errore: ultimo ingresso alle 15:00.";
    return;
  }
  const maxAvailable = toMinutes(PARK_CLOSE) - arrivalMins;
  if (payload.stayDuration === "over_4h" && maxAvailable <= 240) {
    submitBtn.disabled = false;
    setFieldError("stayDuration", "Durata non compatibile");
    status.textContent = "Errore: con questo orario di arrivo non puoi selezionare oltre 4 ore.";
    return;
  }
  const childrenAgesValidationError = payload.hasChildren ? validateChildrenAgesInput(rawChildrenAges) : null;
  if (childrenAgesValidationError) {
    submitBtn.disabled = false;
    setFieldError("childrenAges", childrenAgesValidationError);
    status.textContent = `Errore: ${childrenAgesValidationError}.`;
    return;
  }
  if (payload.hasChildren && payload.childrenAges.length === 0) {
    submitBtn.disabled = false;
    setFieldError("childrenAges", "Campo obbligatorio");
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
    // Dopo la generazione, porta subito l'utente alla sezione risultato.
    setTimeout(scrollToResultBottom, 120);
    status.textContent = `Completato. Premi "Scarica PDF" per il download.`;
  } catch (err) {
    const errMsg = String(err.message || "");
    if (/Email/i.test(errMsg)) setFieldError("email", "Controlla il valore inserito");
    if (/data/i.test(errMsg)) setFieldError("visitDate", "Controlla il valore inserito");
    if (/orario/i.test(errMsg)) setFieldError("arrivalTime", "Controlla il valore inserito");
    if (/durata/i.test(errMsg)) setFieldError("stayDuration", "Controlla il valore inserito");
    if (/eta|età/i.test(errMsg)) setFieldError("childrenAges", "Controlla il valore inserito");
    status.textContent = `Errore: ${err.message}`;
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById("arrivalTime").addEventListener("change", refreshStayDurationOptions);
document.getElementById("hasChildren").addEventListener("change", syncChildrenAgesRequirement);
document.getElementById("scrollUpBtn").addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});
document.getElementById("scrollDownBtn").addEventListener("click", () => {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
});
syncChildrenAgesRequirement();
refreshStayDurationOptions();
window.addEventListener("load", notifyParentHeight);
window.addEventListener("resize", notifyParentHeight);
window.addEventListener("scroll", updateScrollButtonsState, { passive: true });
window.addEventListener("load", updateScrollButtonsState);
