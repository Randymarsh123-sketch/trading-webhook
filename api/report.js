const { Redis } = require("@upstash/redis");

const basicBlock = require("./analysis/basic");
const dailyBiasBlock = require("./analysis/del1_dailyBias");

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SYMBOL = "EUR/USD";

async function fetchTwelveData(interval, outputsize, apiKey) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(
    SYMBOL
  )}&interval=${interval}&outputsize=${outputsize}&apikey=${apiKey}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.values) {
    throw new Error("TwelveData response: " + JSON.stringify(data));
  }

  // newest->oldest => reverse to oldest->newest
  return data.values.reverse();
}

function mergeByDatetime(existing, incoming) {
  const map = new Map();
  for (const c of Array.isArray(existing) ? existing : []) map.set(c.datetime, c);
  for (const c of Array.isArray(incoming) ? incoming : []) map.set(c.datetime, c);

  return Array.from(map.values()).sort((a, b) =>
    a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0
  );
}

async function callOpenAIChat({ apiKey, model, system, user }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 800,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error("OpenAI error: " + JSON.stringify(data));

  const text = data?.choices?.[0]?.message?.content;
  if (typeof text === "string" && text.trim()) return text.trim();

  return JSON.stringify(data);
}

module.exports = async (req, res) => {
  try {
    const twelveKey = process.env.TWELVEDATA_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!twelveKey || !openaiKey) {
      return res.status(500).json({ error: "Missing API keys (TWELVEDATA_API_KEY / OPENAI_API_KEY)" });
    }

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    // --- 1) ALWAYS refresh candles first (so "opp til nå" is true) ---

    // DAILY refresh (for Del1 rules)
    const existing1D = await redis.get("candles:EURUSD:1D");
    const latest1D = await fetchTwelveData("1day", 120, twelveKey);
    const merged1D = mergeByDatetime(existing1D, latest1D);
    const dailyKept = merged1D.slice(Math.max(0, merged1D.length - 120));
    await redis.set("candles:EURUSD:1D", dailyKept);

    // 5M refresh (defines "now")
    const existing5M = await redis.get("candles:EURUSD:5M");
    const latest5M = await fetchTwelveData("5min", 2500, twelveKey);
    const merged5M = mergeByDatetime(existing5M, latest5M);
    const m5Kept = merged5M.slice(Math.max(0, merged5M.length - 2500));
    await redis.set("candles:EURUSD:5M", m5Kept);

    const now5m = m5Kept.length ? m5Kept[m5Kept.length - 1].datetime : null;

    // Keep model input small: last 180x 5m (~15 hours)
    const m5ForModel = m5Kept.slice(Math.max(0, m5Kept.length - 180));

    // --- 2) Build prompt from modules (Del1 only for now) ---
    const basic = basicBlock();
    const del1 = dailyBiasBlock();

    const question =
      (req.query.q || "").trim() ||
      "Gi meg en kort oppsummering av hva som har skjedd opp til nå (bruk siste 5m candle som 'nå').";

    const system =
      "Du er en nøytral FX analyse-motor. " +
      "Følg reglene slavisk. " +
      "Svar kort og konkret. " +
      "Ikke bruk fancy språk, ikke forklar historikk.";

    const user =
      `${basic}\n\n` +
      `NÅ-TID (definert av siste 5m candle): ${now5m}\n\n` +
      `OUTPUT (foreløpig kun Del1)\n` +
      `Basic\n` +
      `Dato, tid: ${now5m}\n\n` +
      `Del1 - Daily Bias\n` +
      `(bruk kun DAILY D-1 og D-2 for score/bias)\n\n` +
      `${del1}\n\n` +
      `DATA (JSON)\n` +
      `DAILY (oldest->newest):\n${JSON.stringify(dailyKept)}\n\n` +
      `M5 LAST 180 (oldest->newest):\n${JSON.stringify(m5ForModel)}\n\n` +
      `SPØRSMÅL:\n${question}\n`;

    const answer = await callOpenAIChat({
      apiKey: openaiKey,
      model,
      system,
      user,
    });

    res.status(200).json({
      ok: true,
      now: now5m,
      model,
      answer,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
