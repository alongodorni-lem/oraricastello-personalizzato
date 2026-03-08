const nodemailer = require("nodemailer");

function createTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("Credenziali Gmail mancanti (GMAIL_USER / GMAIL_APP_PASSWORD)");
  }
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

async function sendPlanEmail({ to, plan, pdfBuffer }) {
  const transporter = createTransporter();
  const fromAddress = process.env.GMAIL_FROM || process.env.GMAIL_USER;
  await transporter.sendMail({
    from: fromAddress,
    to,
    subject: "Il tuo programma personalizzato - Castello delle Sorprese",
    text: `Ciao,\n\nin allegato trovi il tuo programma personalizzato.\n\n${plan.summary}\n\n${plan.finalNote || ""}\n\nA presto!`,
    attachments: [
      {
        filename: "programma-personalizzato.pdf",
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
  });
}

module.exports = { sendPlanEmail };
