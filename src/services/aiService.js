async function enrichPlanWithAI(plan) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return plan;

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const prompt = [
    "Migliora in italiano la sintesi di un itinerario famigliare per evento.",
    "Mantieni tono pratico, max 70 parole.",
    `Input: ${plan.summary}`,
  ].join("\n");

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
      }),
    });
    if (!res.ok) return plan;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) return plan;
    return { ...plan, summary: text };
  } catch (_) {
    return plan;
  }
}

module.exports = { enrichPlanWithAI };
