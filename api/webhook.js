// api/webhook.js
// Mottar TradingView/ReqBin payload, lagrer i Upstash, og (valgfritt) sender "mottatt"-ping til Telegram.

async function tgSend(text) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, skipped: true, reason: "missing_telegram_env" };

  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

export default async function handler(req, res) {
  try {
    // 0) "Er du oppe?" i nettleser
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, message: "webhook alive" });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const payload = req.body;

    // 1) Upstash env
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      return res.status(500).json({
        ok: false,
        error: "Missing UPSTASH env vars",
        need: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
      });
    }

    // 2) Lagre "siste payload"
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

    // 3) (Valgfritt) Telegram ping når du tester manuelt:
    // Sett TELEGRAM_PING_ON_WEBHOOK=true i Vercel hvis du vil ha ping på hvert kall.
    const ping = (process.env.TELEGRAM_PING_ON_WEBHOOK || "").toLowerCase() === "true";
    if (ping) {
      await tgSend(`✅ Webhook mottatt og lagret\nSymbol: ${symbol}\nKey: ${key}`);
    }

    return res.status(200).json({ ok: true, stored: true, key, received_symbol: symbol });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: String(err?.message || err),
    });
  }
}
