// api/webhook.js

export default async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Only POST allowed" });
  }

  // --- Helper: send Telegram message ---
  async function sendTelegram(message) {
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
          parse_mode: "Markdown"
        })
      });
    } catch (err) {
      console.error("Error sending Telegram message:", err);
    }
  }

  try {
    const data = request.body; // JSON fra TradingView
    console.log("Received from TradingView:", data);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("Missing OPENAI_API_KEY");
      return response.status(500).json({ error: "Server missing OPENAI_API_KEY" });
    }

    // ---------------------------
    // 1) Systemprompt til modellen
    // ---------------------------
    const systemPrompt = `
Du er en Smart Money Concepts-markedsanalytiker.

Du får 1m-data i JSON fra TradingView med:
- symbol, time_ms, open, high, low, close, volume
- asia_high / asia_low
- frankfurt_high / frankfurt_low
- in_london_window (true/false)

Oppgave:
- Vurder kort om bias akkurat NÅ er bullish, bearish, range eller uklar.
- Sjekk om denne candle'n ser ut til å inngå i:
  - sweep av Asia- eller Frankfurt-high/low
  - inducement (fake move før motsatt retning)
  - CHOCH eller BOS (strukturbrudd).
- Vurder om markedet nå er:
  - "klar for retrace til FVG" eller
  - "fortsatt i likviditetsjakt" eller
  - "ingen klar edge".

Svar KUN med gyldig JSON på dette formatet:

{
  "bias": "bullish" | "bearish" | "range" | "unclear",
  "event": "none" | "sweep" | "frankfurt_inducement" | "london_sweep" | "choch" | "bos",
  "comment": "kort forklaring på 1–2 setninger",
  "entry_zone": { "min": null, "max": null },
  "invalidation": null
}

- Hvis du IKKE ser noen klar edge, bruk:
  - "bias": "unclear"
  - "event": "none"
- Hvis du ser mulig FVG-entry, fyll inn "entry_zone.min" og "entry_zone.max" som tall (prisnivåer).
- Hvis du ser naturlig stop / invalidation, fyll inn "invalidation" som tall.
`;

    const userContent = JSON.stringify(data);

    // ---------------------------
    // 2) Kall OpenAI (gpt-4.1-mini)
    // ---------------------------
    const payload = {
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ],
      response_format: { type: "json_object" } // tving JSON-svar
    };

    const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!gptRes.ok) {
      const errText = await gptRes.text();
      console.error("OpenAI API error:", gptRes.status, errText);
      return response
        .status(500)
        .json({ error: "OpenAI API error", detail: errText });
    }

    const gptJson = await gptRes.json();
    const content = gptJson.choices?.[0]?.message?.content || "{}";

    // ---------------------------
    // 3) Prøv å parse JSON-svaret
    // ---------------------------
    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch (e) {
      console.error("Failed to parse JSON from model:", content);
      analysis = { raw: content };
    }

    // ---------------------------
    // 4) FILTRERING: signal vs ikke-signal
    // ---------------------------
    const eventType = analysis?.event || "none";
    const isSignal = eventType && eventType !== "none";

    if (isSignal) {
      console.log("SMC SIGNAL:", analysis);

      // Bygg fin tekst til Telegram
      const bias = analysis.bias || "ukjent";
      const comment = analysis.comment || "";
      const entryZone = analysis.entry_zone || null;
      const invalidation = analysis.invalidation ?? null;

      let entryText = "N/A";
      if (
        entryZone &&
        entryZone.min != null &&
        entryZone.max != null
      ) {
        entryText = `${entryZone.min} - ${entryZone.max}`;
      }

      const invalidationText =
        invalidation != null ? String(invalidation) : "N/A";

      const msg = [
        "*SMC SIGNAL*",
        "",
        `Symbol: ${data.symbol || "?"}`,
        `Event: ${eventType}`,
        `Bias: ${bias}`,
        "",
        `Comment: ${comment}`,
        "",
        `Entry zone: ${entryText}`,
        `Invalidation: ${invalidationText}`
      ].join("\n");

      await sendTelegram(msg);
    } else {
      console.log("SMC no signal this candle.");
    }

    // ---------------------------
    // 5) Send svar tilbake
    // ---------------------------
    return response.status(200).json({
      ok: true,
      signal: isSignal,
      received: data,
      analysis: isSignal ? analysis : null
    });

  } catch (err) {
    console.error("Server error:", err);
    return response.status(500).json({ error: "Server error" });
  }
}
