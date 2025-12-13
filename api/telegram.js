// api/telegram.js
import { kv } from "@vercel/kv";

async function sendTelegramMessage(chatId, message) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) {
    console.error("Missing TELEGRAM_TOKEN");
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: true
      })
    });
  } catch (err) {
    console.error("Error sending Telegram message:", err);
  }
}

async function callOpenAI({ apiKey, systemPrompt, userContent }) {
  const payload = {
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent }
    ],
    response_format: { type: "json_object" }
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload)
  });

  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j.choices?.[0]?.message?.content || "{}";
}

function buildAskPrompt() {
  return `
Du er en kort, presis EURUSD-assistent.

Du får:
- latest_state (5m + HTF) = oppdatert JSON fra TradingView
- question = brukerens spørsmål

VIKTIG:
- IKKE gjett nivåer. Bruk kun tall i latest_state.
- Svar kort.

Returner JSON:
{
  "bias": "bullish" | "bearish" | "range" | "unclear",
  "answer": "maks ~8-12 linjer",
  "key_levels": ["..."],
  "what_to_wait_for": ["..."]
}
`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  // Telegram krever rask 200 OK
  res.status(200).json({ ok: true });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("Missing OPENAI_API_KEY");
      return;
    }

    const update = req.body;
    const msg = update?.message;
    const chatId = msg?.chat?.id;
    const text = (msg?.text || "").trim();

    if (!chatId || !text) return;

    // Kun svar på /ask ...
    if (!text.toLowerCase().startsWith("/ask")) return;

    const question = text.replace(/^\/ask/i, "").trim();
    if (!question) {
      await sendTelegramMessage(chatId, "Skriv f.eks:\n/ask Hva er bias nå, og hva bør jeg vente på?");
      return;
    }

    const latest = await kv.get("latest:any");
    if (!latest) {
      await sendTelegramMessage(chatId, "Jeg har ikke mottatt candle-data ennå. Vent til TradingView har sendt minst 1 tick.");
      return;
    }

    const content = await callOpenAI({
      apiKey,
      systemPrompt: buildAskPrompt(),
      userContent: JSON.stringify({ question, latest_state: latest })
    });

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = { bias: "unclear", answer: content, key_levels: [], what_to_wait_for: [] };
    }

    const lines = [];
    lines.push(`🧠 *ASK*`);
    lines.push(`Bias: *${parsed.bias || "unclear"}*`);
    lines.push("");
    lines.push(parsed.answer || "");

    await sendTelegramMessage(chatId, lines.join("\n"));
  } catch (err) {
    console.error("telegram error:", err);
  }
}
