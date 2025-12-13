// api/ask.js
// POST { symbol: "EURUSD", question: "..." } -> bruker siste lagrede payload og svarer + sender Telegram.

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

async function upstashGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Upstash GET failed: ${resp.status} ${txt}`);
  }

  const data = await resp.json(); // { result: ... }
  return data?.result ?? null;
}

async function openaiAnswer({ symbol, question, lastPayload }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY in Vercel env vars");

  // Ikke lås deg til en spesifikk modell om du ikke vil.
  // Hvis OPENAI_MODEL ikke er satt, bruk en default du eventuelt endrer senere.
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const system = `
Du er en trading-assistent. Bruk KUN tallene som finnes i JSON-dataen (candles/sessions/htf_data).
IKKE finn på Asia/Frankfurt highs/lows som ikke matcher dataen.
Svar kort.

Format:
- Bias (kort)
- 2 scenarier (A/B) + hva som må skje
- Mulig TP/SL kun hvis det gir mening basert på data
`;

  const user = `
Symbol: ${symbol}
Spørsmål: ${question}

SISTE DATA (JSON):
${JSON.stringify(lastPayload).slice(0, 250000)}
`;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_output_tokens: 450,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI error: ${resp.status} ${txt}`);
  }

  const data = await resp.json();

  // Plukk tekst på en robust måte
  let text = "";
  if (typeof data.output_text === "string") text = data.output_text;
  if (!text && Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item?.content) {
        for (const c of item.content) {
          if (c?.type === "output_text" && c?.text) text += c.text;
        }
      }
    }
  }
  return (text || "").trim();
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        message: "ask alive. Use POST {symbol, question}.",
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const { symbol = "EURUSD", question = "" } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ ok: false, error: "Missing 'question' string" });
    }

    const key = `last:${symbol}`;
    const lastPayload = await upstashGet(key);

    if (!lastPayload) {
      return res.status(404).json({
        ok: false,
        error: "No data stored yet for symbol",
        key,
        hint: "Send a webhook first to /api/webhook so we have candles stored.",
      });
    }

    const answer = await openaiAnswer({ symbol, question, lastPayload });

    // Send til Telegram (kort)
    const msg =
      `🧠 ASK (${symbol})\n` +
      `Q: ${question}\n\n` +
      `${answer || "(tomt svar)"}`;

    const tg = await tgSend(msg);

    return res.status(200).json({
      ok: true,
      symbol,
      key_used: key,
      telegram: tg.ok ? "sent" : "skipped",
      answer,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: String(err?.message || err),
    });
  }
}
