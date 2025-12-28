const { Redis } = require("@upstash/redis");

const basicBlock = require("./analysis/basic");
const dailyBiasBlock = require("./analysis/del1_dailyBias");

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SYMBOL = "EUR/USD";

function mapTfToTwelveData(tf) {
  if (tf === "1D") return { interval: "1day", key: "candles:EURUSD:1D", keep: 120, fetch: 120 };
  if (tf === "1H") return { interval: "1h", key: "candles:EURUSD:1H", keep: 600, fetch: 600 };
  if (tf === "5M") return { interval: "5min", key: "candles:EURUSD:5M", keep: 2500, fetch: 2500 };
  return null;
}

async function fetchCandles(interval, outputsize, apiKey) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(
    SYMBOL
  )}&interval=${interval}&outputsize=${outputsize}&apikey=${apiKey}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.values) {
    throw new Error("TwelveData response: " + JSON.stringify(data));
  }

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
      max_tokens: 700,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error("OpenAI error: " + JSON.stringify(data));
  }

  const text = data?.choices?.[0]?.message?.content;
  if (typeof text === "string" && text.trim()) return text.trim();

  return JSON.stringify(data);
}

module.exports = async (req, res) => {
  try {
    const tf = (req.query.tf || "1D").toUpperCase();
    const cfg = mapTfToTwelveData(tf);
    if (!cfg) return res.status(400).json({ error: "tf must be one of: 1D, 1H, 5M" });

    const question = (req.query.q || "").trim();
    if (!question) return res.status(400).json({ error: "Missing q parameter" });

    const twelveKey = process.env.TWELVEDATA_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!twelveKey || !openaiKey) return res.status(500).json({ error: "Missing API keys" });

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const existing = await redis.get(cfg.key);
    const latest = await fetchCandles(cfg.interval, cfg.fetch, twelveKey);
    const merged = mergeByDatetime(existing, latest);

    const trimmed = merged.slice(Math.max(0, merged.length - cfg.keep));
    await redis.set(cfg.key, trimmed);

    const defaultN = tf === "5M" ? 180 : tf === "1H" ? 120 : 40;
    const n = Math.max(30, Math.min(parseInt(req.query.n || String(defaultN), 10), trimmed.length));
    const candlesForModel = trimmed.slice(Math.max(0, trimmed.length - n));

    const lastDatetime =
      candlesForModel.length > 0
        ? candlesForModel[candlesForModel.length - 1].datetime
        : null;

    const basic = basicBlock();
    const del1 = dailyBiasBlock();

    const system =
      "You are an FX market-structure analysis engine. Follow rules strictly. Output must match the exact template.";

    const user =
      `${basic}\n\n` +
      `OUTPUT TEMPLATE (MUST MATCH EXACTLY)\n` +
      `Basic\n` +
      `Date, time: <use LAST_DATETIME>\n\n` +
      `Del1 - Daily Bias\n` +
      `<del1 output here>\n\n` +
      `Del2 - Asia Range\n` +
      `N/A\n\n` +
      `Del3 - Daily cycles\n` +
      `N/A\n\n` +
      `---\n\n` +
      `DEL1 RULES:\n${del1}\n\n` +
      `DATA (JSON, oldest -> newest)\n` +
      `SYMBOL: EURUSD\n` +
      `TIMEFRAME: ${tf}\n` +
      `LAST_DATETIME: ${lastDatetime}\n\n` +
      `${JSON.stringify(candlesForModel)}\n\n` +
      `QUESTION:\n${question}\n`;

    const answer = await callOpenAIChat({
      apiKey: openaiKey,
      model,
      system,
      user,
    });

    res.status(200).json({
      ok: true,
      tf,
      lastDatetime,
      candlesUsed: candlesForModel.length,
      model,
      answer,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
