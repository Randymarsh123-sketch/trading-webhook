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

async function callOpenAI({ apiKey, model, instructions, input }) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      max_output_tokens: 1500,
      store: false,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error("OpenAI error: " + JSON.stringify(data));
  }

  // Use plain text output
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  // Fallback: extract text from output messages
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item && item.type === "message" && Array.isArray(item.content)) {
        const parts = item.content
          .map((c) => (c && (c.text || c.output_text)) || "")
          .filter(Boolean);
        if (parts.length) return parts.join("\n").trim();
      }
    }
  }

  return JSON.stringify(data);
}

module.exports = async (req, res) => {
  try {
    const tf = (req.query.tf || "5M").toUpperCase();
    const cfg = mapTfToTwelveData(tf);
    if (!cfg) return res.status(400).json({ error: "tf must be one of: 1D, 1H, 5M" });

    const question = (req.query.q || "").trim();
    if (!question) return res.status(400).json({ error: "Missing q parameter" });

    const twelveKey = process.env.TWELVEDATA_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!twelveKey || !openaiKey) return res.status(500).json({ error: "Missing API keys" });

    const model = process.env.OPENAI_MODEL || "gpt-5";

    const existing = await redis.get(cfg.key);
    const latest = await fetchCandles(cfg.interval, cfg.fetch, twelveKey);
    const merged = mergeByDatetime(existing, latest);

    const trimmed = merged.slice(Math.max(0, merged.length - cfg.keep));
    await redis.set(cfg.key, trimmed);

    const defaultN = tf === "5M" ? 300 : tf === "1H" ? 200 : 60;
    const candlesForModel = trimmed.slice(Math.max(0, trimmed.length - defaultN));

    const lastDatetime =
      candlesForModel.length > 0
        ? candlesForModel[candlesForModel.length - 1].datetime
        : null;

    const basic = basicBlock();
    const del1 = dailyBiasBlock();

    const instructions =
      "You are an FX market-structure analysis engine. Follow rules strictly. Output must follow the required format.";

    const input =
      `${basic}\n\n` +
      `OUTPUT FORMAT\n` +
      `Basic\nDate / Time (Europe/Oslo)\n\n` +
      `Del 1 – Daily Bias\n\n` +
      `${del1}\n\n` +
      `DATA (JSON)\n` +
      `SYMBOL: EURUSD\n` +
      `TIMEFRAME: ${tf}\n` +
      `LAST_DATETIME: ${lastDatetime}\n\n` +
      `${JSON.stringify(candlesForModel)}\n\n` +
      `QUESTION:\n${question}\n`;

    const answer = await callOpenAI({
      apiKey: openaiKey,
      model,
      instructions,
      input,
    });

    res.status(200).json({
      ok: true,
      tf,
      lastDatetime,
      answer,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
