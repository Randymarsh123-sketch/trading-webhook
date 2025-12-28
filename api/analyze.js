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

  // TwelveData returns newest->oldest. We want oldest->newest.
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

// Chat Completions: always returns visible text in choices[0].message.content
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
      max_tokens: 900,
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
    const tf = (req.query.tf || "5M").toUpperCase();
    const cfg = mapTfToTwelveData(tf);
    if (!cfg) return res.status(400).json({ error: "tf must be one of: 1D, 1H, 5M" });

    const question = (req.query.q || "").trim();
    if (!question) return res.status(400).json({ error: "Missing q parameter" });

    const twelveKey = process.env.TWELVEDATA_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!twelveKey || !openaiKey) return res.status(500).json({ error: "Missing API keys" });

    // IMPORTANT: Use a model that reliably returns text (no "reasoning-only" output)
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    // 1) Read existing candles
    const existing = await redis.get(cfg.key);

    // 2) Fetch latest candles and merge
    const latest = await fetchCandles(cfg.interval, cfg.fetch, twelveKey);
    const merged = mergeByDatetime(existing, latest);

    // 3) Store rolling window
    const trimmed = merged.slice(Math.max(0, merged.length - cfg.keep));
    await redis.set(cfg.key, trimmed);

    // 4) Keep input small (THIS matters a lot)
    // 5M default: last 180 candles (= 15 hours)
    // 1H default: last 120 candles (= 5 days)
    // 1D default: last 40 candles
    const defaultN = tf === "5M" ? 180 : tf === "1H" ? 120 : 40;
    const n = Math.max(30, Math.min(parseInt(req.query.n || String(defaultN), 10), trimmed.length));
    const candlesForModel = trimmed.slice(Math.max(0, trimmed.length - n));

    const lastDatetime =
      candlesForModel.length > 0
        ? candlesForModel[candlesForModel.length - 1].datetime
        : null;

    // 5) Modular prompt blocks
    const basic = basicBlock();
    const del1 = dailyBiasBlock();

    const system =
      "You are an FX market-structure analysis engine. " +
      "Follow the rules strictly. " +
      "Output MUST follow the required format. " +
      "Be short and concrete.";

    const user =
      `${basic}\n\n` +
      `OUTPUT FORMAT (MANDATORY)\n` +
      `Basic\n` +
      `Date / Time (Europe/Oslo)\n\n` +
      `Del 1 – Daily Bias\n\n` +
      `${del1}\n\n` +
      `DATA (JSON, oldest -> newest)\n` +
      `SYMBOL: EURUSD\n` +
      `TIMEFRAME: ${tf}\n` +
      `LAST_DATETIME: ${lastDatetime}\n` +
      `CANDLES_COUNT: ${candlesForModel.length}\n\n` +
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
