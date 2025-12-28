const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

module.exports = async (req, res) => {
  try {
    const tf = (req.query.tf || "1D").toUpperCase();

    const allowed = ["1D", "1H", "5M"];
    if (!allowed.includes(tf)) {
      return res.status(400).json({ error: "tf must be one of: 1D, 1H, 5M" });
    }

    const key = `candles:EURUSD:${tf}`;
    const data = await redis.get(key);

    res.status(200).json({
      ok: true,
      key,
      count: Array.isArray(data) ? data.length : 0,
      candles: data || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
