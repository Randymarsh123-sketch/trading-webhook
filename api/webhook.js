// api/webhook.js
import { kv } from "@vercel/kv";

// -------------------------------
// Telegram
// -------------------------------
async function sendTelegramMessage(message) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error("Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID");
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

// -------------------------------
// OpenAI call
// -------------------------------
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
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`OpenAI error ${r.status}: ${errText}`);
  }

  const j = await r.json();
  return j.choices?.[0]?.message?.content || "{}";
}

// -------------------------------
// Mode (IKKE bruk serverklokka) – bruk flaggene fra Pine
// -------------------------------
function getModeFromData(data) {
  if (data?.is_0900 === true) return "report_0900";
  if (data?.is_0930 === true) return "report_0930";
  return "tick";
}

// -------------------------------
// Systemprompt – kort og presist, ingen “finne på tall”
// -------------------------------
function buildSystemPrompt() {
  return `
Du er en Smart Money Concepts-analytiker for EURUSD.

Du får JSON fra TradingView (5m + HTF 15m/1H) som inkluderer:
- asia_high/asia_low og frankfurt_high/frankfurt_low (beregnet i Pine)
- htf_data.m15 og htf_data.h1 arrays
- oslo_hour/oslo_minute + is_0900/is_0930
- in_london_window boolean

VIKTIG:
- ALLE tall i input er fasit. IKKE gjett eller finn på prisnivåer.
- Hvis asia_high/asia_low/frankfurt_high/frankfurt_low er null -> skriv at nivået ikke er tilgjengelig.
- Bruk KUN tall du faktisk ser i input (nivåfeltene eller candle OHLC).

SESSIONS (NORSK TID / Europe/Oslo):
- Asia 02:00–06:00 (Pine har allerede brukt dette)
- Frankfurt 08:00–09:00
- London 09:00–10:00

MODUS:
- mode="report_0900": lag kort rapport med eksakt 4 linjer:
  Asia: ...
  Frankfurt: ...
  London: ...
  Mulig daily cycle: ...
- mode="report_0930": samme 4 linjer, oppdatert frem til 09:30
- mode="tick": gi kort analyse for 5m, og event:
  - event: "none" | "sweep" | "choch" | "bos" | "frankfurt_manipulation" | "london_sweep" | "other"
  - bias: bullish/bearish/range/unclear

SVAR ALLTID med JSON:
{
  "bias": "bullish" | "bearish" | "range" | "unclear",
  "event": string,
  "comment": string,
  "entry_zone": { "min": number | null, "max": number | null },
  "invalidation": number | null,
  "report_text": string | null
}

Regler:
- I report-modus: fyll report_text (4 linjer), og sett comment til kort 1 setning.
- I tick-modus: report_text = null.
`;
}

// -------------------------------
// HOVEDHANDLER
// -------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const data = req.body; // JSON fra TradingView
    const symbol = data?.symbol || "UNKNOWN";

    // 1) Lagre latest state (for /ask)
    //    Du kan spørre /ask uten symbol => vi lagrer også "latest:any".
    await kv.set(`latest:${symbol}`, data);
    await kv.set("latest:any", data);

    const mode = getModeFromData(data);

    // 2) Kall modellen for report/tick (samme prompt, bare mode styrer output)
    const systemPrompt = buildSystemPrompt();
    const modelInput = { ...data, mode };

    const content = await callOpenAI({
      apiKey,
      systemPrompt,
      userContent: JSON.stringify(modelInput)
    });

    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch {
      analysis = {
        bias: "unclear",
        event: "other",
        comment: "Kunne ikke parse model-respons",
        entry_zone: { min: null, max: null },
        invalidation: null,
        report_text: null
      };
    }

    // 3) Send Telegram når relevant
    let alertSent = false;

    // 09:00 rapport
    if (mode === "report_0900" && analysis.report_text) {
      await sendTelegramMessage(`📊 *09:00 Asia/Frankfurt – ${symbol}*\n\n${analysis.report_text}`);
      alertSent = true;
    }

    // 09:30 rapport
    if (mode === "report_0930" && analysis.report_text) {
      await sendTelegramMessage(`📊 *09:30 London – ${symbol}*\n\n${analysis.report_text}`);
      alertSent = true;
    }

    // CHOCH/BOS alert i London-vindu (tick)
    if (mode === "tick") {
      const eventType = (analysis?.event || "none").toLowerCase();
      const isImportant = eventType === "choch" || eventType === "bos";
      const londonOK = !!data?.in_london_window;

      if (isImportant && londonOK) {
        const bias = analysis.bias || "unclear";
        const comment = analysis.comment || "";

        let entryText = "N/A";
        const ez = analysis.entry_zone;
        if (ez && ez.min != null && ez.max != null) entryText = `${ez.min} - ${ez.max}`;

        const inv = analysis.invalidation != null ? String(analysis.invalidation) : "N/A";

        const msg =
          `🔔 *SMC SIGNAL (London) – ${symbol}*\n` +
          `Event: *${eventType}*\n` +
          `Bias: *${bias}*\n\n` +
          `Comment: ${comment}\n\n` +
          `Entry zone: ${entryText}\n` +
          `Invalidation: ${inv}`;

        await sendTelegramMessage(msg);
        alertSent = true;
      }
    }

    // 4) Returnér OK til TradingView/ReqBin
    return res.status(200).json({
      ok: true,
      mode,
      alert: alertSent,
      stored: true,
      received: data,
      analysis
    });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Server error", detail: String(err?.message || err) });
  }
}
