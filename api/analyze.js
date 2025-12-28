const { Redis } = require("@upstash/redis");

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

  return Array.from(map.values()).sort((a, b) => (a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0));
}

function extractTextFromResponsesApi(resp) {
  // Newer Responses API often includes output_text
  if (resp && typeof resp.output_text === "string" && resp.output_text.trim()) return resp.output_text;

  // Fallback: try to find text in output items
  const out = resp && Array.isArray(resp.output) ? resp.output : [];
  for (const item of out) {
    if (item && item.type === "message" && Array.isArray(item.content)) {
      const texts = item.content
        .filter((c) => c && (c.type === "output_text" || c.type === "text") && (c.text || c.output_text))
        .map((c) => c.text || c.output_text);
      if (texts.length) return texts.join("\n");
    }
  }
  return JSON.stringify(resp);
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
      input, // plain text input is allowed
      max_output_tokens: 600,
      store: false,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error("OpenAI error: " + JSON.stringify(data));
  }
  return data;
}

module.exports = async (req, res) => {
  try {
    const tf = (req.query.tf || "5M").toUpperCase();
    const cfg = mapTfToTwelveData(tf);
    if (!cfg) return res.status(400).json({ error: "tf must be one of: 1D, 1H, 5M" });

    const question = (req.query.q || "").trim();
    if (!question) {
      return res.status(400).json({
        error: "Missing q (question). Example: /api/analyze?tf=5M&q=What%20happened%20at%2009:45%20sweep",
      });
    }

    const twelveKey = process.env.TWELVEDATA_API_KEY;
    if (!twelveKey) return res.status(500).json({ error: "Missing TWELVEDATA_API_KEY in env" });

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY in env" });

    const model = process.env.OPENAI_MODEL || "gpt-5";

    // 1) Read existing
    const existing = await redis.get(cfg.key);

    // 2) Fetch latest chunk + merge
    const latest = await fetchCandles(cfg.interval, cfg.fetch, twelveKey);
    const merged = mergeByDatetime(existing, latest);

    // 3) Keep rolling window in Redis
    const trimmed = merged.slice(Math.max(0, merged.length - cfg.keep));
    await redis.set(cfg.key, trimmed);

    // 4) To keep OpenAI request small: analyze only last N candles
    // Defaults: 5M=300 (25 hours), 1H=200 (~8 days), 1D=60 (~60 days)
    const defaultN = tf === "5M" ? 300 : tf === "1H" ? 200 : 60;
    const n = Math.max(20, Math.min(parseInt(req.query.n || String(defaultN), 10), trimmed.length));
    const candlesForModel = trimmed.slice(Math.max(0, trimmed.length - n));

    const lastDatetime = candlesForModel.length ? candlesForModel[candlesForModel.length - 1].datetime : null;

    const instructions =
      "You are an FX market-structure analyst (SMC style). " +
      "Use only the candles provided. Be concrete, short, and specific. " +
      "If the question asks about a specific time (like 09:45), focus on the candles around that time. " +
      "Return: (1) what likely swept liquidity, (2) whether it looks like manipulation/displacement, (3) what to watch next.";

    const input =
      `SYMBOL: EURUSD\nTIMEFRAME: ${tf}\nLAST_DATETIME: ${lastDatetime}\n` +
      `CANDLES (oldest->newest, JSON):\n${JSON.stringify(candlesForModel)}\n\n` +
      `QUESTION:\n${question}\n`;

    // 5) Ask OpenAI
    const resp = await callOpenAI({ apiKey: openaiKey, model, instructions, input });
    const answer = extractTextFromResponsesApi(resp);

    res.status(200).json({
      ok: true,
      tf,
      key: cfg.key,
      candlesUsed: candlesForModel.length,
      lastDatetime,
      answer,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
