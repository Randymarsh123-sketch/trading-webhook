const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SYMBOL = "EUR/USD";

async function fetchCandles(interval, outputsize) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(
    SYMBOL
  )}&interval=${interval}&outputsize=${outputsize}&apikey=${process.env.TWELVEDATA_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.values) {
    throw new Error("No data returned from TwelveData");
  }

  return data.values.reverse();
}

module.exports = async (req, res) => {
  try {
    // DAILY – 30 candles
    const daily = await fetchCandles("1day", 30);
    await redis.set("candles:EURUSD:1D", daily);

    // 1H – 10 days = 240 candles
    const h1 = await fetchCandles("1h", 240);
    await redis.set("candles:EURUSD:1H", h1);

    // 5m – 5 days = 1440 candles
    const m5 = await fetchCandles("5min", 1440);
    await redis.set("candles:EURUSD:5M", m5);

    res.status(200).json({
      ok: true,
      message: "Bootstrap complete",
      counts: {
        daily: daily.length,
        h1: h1.length,
        m5: m5.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
