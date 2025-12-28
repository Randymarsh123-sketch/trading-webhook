const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SYMBOL = "EUR/USD";

function mapTfToTwelveData(tf) {
  if (tf === "1D") return { interval: "1day", key: "candles:EURUSD:1D", keep: 60, fetch: 60 };
  if (tf === "1H") return { interval: "1h", key: "candles:EURUSD:1H", keep: 400, fetch: 400 };
  if (tf === "5M") return { interval: "5min", key: "candles:EURUSD:5M", keep: 2000, fetch: 2000 };
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

  const merged = Array.from(map.values()).sort((a, b) => {
    if (a.datetime < b.datetime) return -1;
    if (a.datetime > b.datetime) return 1;
    return 0;
  });

  return merged;
}

module.exports = async (req, res) => {
  try {
    const tf = (req.query.tf || "5M").toUpperCase();
    const cfg = mapTfToTwelveData(tf);
    if (!cfg) return res.status(400).json({ error: "tf must be one of: 1D, 1H, 5M" });

    const apiKey = process.env.TWELVEDATA_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing TWELVEDATA_API_KEY in env" });

    // 1) Read existing from Redis
    const existing = await redis.get(cfg.key);

    // 2) Fetch latest chunk from TwelveData
    const latest = await fetchCandles(cfg.interval, cfg.fetch, apiKey);

    // 3) Merge + keep last N candles
    const merged = mergeByDatetime(existing, latest);
    const trimmed = merged.slice(Math.max(0, merged.length - cfg.keep));

    // 4) Save back to Redis (this is the “auto update”)
    await redis.set(cfg.key, trimmed);

    // 5) Return candles (always up-to-date)
    res.status(200).json({
      ok: true,
      key: cfg.key,
      tf,
      updated: true,
      count: trimmed.length,
      lastDatetime: trimmed.length ? trimmed[trimmed.length - 1].datetime : null,
      candles: trimmed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
