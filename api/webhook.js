// api/webhook.js

export default async function handler(req, res) {
  try {
    // 1) Enkelt "er du oppe?"-sjekk i nettleser
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, message: "webhook alive" });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    // 2) Les inn JSON body
    const payload = req.body;

    // 3) Sjekk env vars
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      return res.status(500).json({
        ok: false,
        error:
          "Missing UPSTASH env vars. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel.",
      });
    }

    // 4) Lagre "siste payload" i redis (key: last:EURUSD etc)
    // Hvis symbol ikke finnes, bruk "unknown"
    const symbol = payload?.symbol || "unknown";
    const key = `last:${symbol}`;

    const setResp = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!setResp.ok) {
      const txt = await setResp.text();
      return res.status(500).json({ ok: false, error: "Upstash SET failed", details: txt });
    }

    // 5) Svar OK
    return res.status(200).json({
      ok: true,
      stored: true,
      key,
      received_symbol: symbol,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: String(err?.message || err),
    });
  }
}
