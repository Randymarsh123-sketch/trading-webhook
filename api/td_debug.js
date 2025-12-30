module.exports = async (req, res) => {
  try {
    const apiKey = process.env.TWELVEDATA_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing TWELVEDATA_API_KEY" });

    const symbol = req.query.symbol || "EUR/USD";
    const interval = req.query.interval || "5min";
    const timezone = req.query.timezone || ""; // optional

    const url =
      `https://api.twelvedata.com/time_series` +
      `?symbol=${encodeURIComponent(symbol)}` +
      `&interval=${encodeURIComponent(interval)}` +
      `&outputsize=10` +
      (timezone ? `&timezone=${encodeURIComponent(timezone)}` : "") +
      `&apikey=${encodeURIComponent(apiKey)}`;

    const r = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
    const data = await r.json();

    // Return meta + last 3 candles only
    const values = Array.isArray(data.values) ? data.values : null;
    const last3 = values ? values.slice(0, 3) : null; // newest first

    res.status(200).json({
      ok: true,
      request: { symbol, interval, timezone: timezone || null, url },
      meta: data.meta || null,
      last3,
      raw: values ? undefined : data, // only include raw error payload when values missing
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
