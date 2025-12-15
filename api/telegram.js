// api/telegram.js
// Telegram webhook endpoint.
// Bruk: /ask <spørsmål>
// Leser siste lagrede data fra Upstash: last:EURUSD (eller last:<SYMBOL> hvis du skriver /ask EURUSD: ...)

async function upstashGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");

  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) throw new Error(`Upstash GET failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data?.result ?? null;
}

async function sendTelegramMessage(chatId, message) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_TOKEN");

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });

  if (!resp.ok) throw new Error(`Telegram sendMessage failed: ${resp.status} ${await resp.text()}`);
}

async function callOpenAI({ systemPrompt, userContent }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const payload = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: 0.2,
    max_tokens: 500,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  });

  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j.choices?.[0]?.message?.content || "";
}

function buildAskPrompt() {
  return `
Du er en kort, presis EURUSD-assistent.

Du får:
- latest_state (5m + HTF) = oppdatert JSON fra TradingView (lagret)
- question = brukerens spørsmål

VIKTIG:
- IKKE gjett nivåer. Bruk kun tall i latest_state.
- Svar på norsk. Svar kort.

Format:
- Bias: bullish/bearish/range/unclear
- 3–8 korte linjer om hva som har skjedd + hva som er viktig nå
- 3–6 "nivåer" kun hvis de finnes i JSON
- 3–6 "hva du bør vente på"
`;
}

function parseSymbolFromAsk(text) {
  // Valgfritt: /ask EURUSD: ....  eller /ask EURUSD ....
  const raw = text.replace(/^\/ask/i, "").trim();
  const m = raw.match(/^([A-Z]{3,10})(:|\s)\s*(.+)$/);
  if (m) return { symbol: m[1], question: m[3].trim() };
  return { symbol: "EURUSD", question: raw };
}

export default async function handler(req, res) {
  // Telegram trenger raskt svar
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });
  res.status(200).json({ ok: true });

  try {
    const update = req.body;
    const msg = update?.message;
    const chatId = msg?.chat?.id;
    const text = (msg?.text || "").trim();
    if (!chatId || !text) return;

    if (!text.toLowerCase().startsWith("/ask")) return;

    const { symbol, question } = parseSymbolFromAsk(text);
    if (!question) {
      await sendTelegramMessage(chatId, "Skriv f.eks:\n/ask Hva skjedde 09:00–09:30, og hva bør jeg vente på nå?");
      return;
    }

    const latest = await upstashGet(`last:${symbol}`);
    if (!latest) {
      await sendTelegramMessage(chatId, `Ingen lagrede data ennå for ${symbol}. Vent til TradingView har sendt minst én webhook.`);
      return;
    }

    const answer = await callOpenAI({
      systemPrompt: buildAskPrompt(),
      userContent: JSON.stringify({ question, latest_state: latest }),
    });

    await sendTelegramMessage(chatId, `🧠 *ASK* (${symbol})\n\n${answer.trim()}`);
  } catch (err) {
    console.error("telegram error:", err);
  }
}
