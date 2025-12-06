// api/webhook.js

// ===============================
// KONFIG: enkel in-memory storage
// (per symbol) med siste N candles
// ===============================
const RECENT_CANDLES_LIMIT = 600; // ca 10 timer med 1m-candles
const recentCandlesStore = {}; // { [symbol]: Candle[] }

// -------------------------------
// HJELPER: sjekk om vi er i London-vinduet
// London-session: ca 09:00–13:59 (CET)
// Vi bruker serverens UTC-tid og legger til +1 time.
// -------------------------------
function isInLondonHours() {
  const now = new Date();
  const hour = now.getUTCHours() + 1; // UTC + 1 ≈ CET
  return hour >= 9 && hour < 14;      // 09:00 <= time < 14:00
}

// -------------------------------
// HJELPER: send melding til Telegram
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
        parse_mode: "Markdown"
      })
    });
  } catch (err) {
    console.error("Error sending Telegram message:", err);
  }
}

// -------------------------------
// HJELPER: legg candle inn i lokal buffer
// -------------------------------
function addCandleToStore(symbol, candle) {
  if (!recentCandlesStore[symbol]) {
    recentCandlesStore[symbol] = [];
  }
  recentCandlesStore[symbol].push(candle);
  if (recentCandlesStore[symbol].length > RECENT_CANDLES_LIMIT) {
    recentCandlesStore[symbol].shift();
  }
}

// -------------------------------
// HJELPER: bygg SMC-request til GPT
// Nå bruker vi recentCandlesStore.
// -------------------------------
function buildSmcRequest(symbol, originalTick) {
  const nowIso = new Date().toISOString();

  const sessionConfig = {
    asia_start: "02:00",
    asia_end: "07:59",
    frankfurt_start: "08:00",
    frankfurt_end: "08:59",
    london_start: "09:00",
    london_end: "13:59"
  };

  const recentCandles = recentCandlesStore[symbol] || [];

  const htfContext = {
    m15_poi_zones: [],
    h1_poi_zones: []
  };

  const request = {
    symbol,
    timeframe: "1m",
    now_timestamp: nowIso,
    timezone: "Europe/Oslo",
    session_config: sessionConfig,
    recent_candles: recentCandles,
    htf_context: htfContext,
    targets: {
      setups_to_evaluate: [
        "frankfurt_london_bos_setup_1"
      ]
    },
    // original-tick fra TradingView for ekstra info
    original_tick: originalTick
  };

  return request;
}

// ===============================
// HOVEDHANDLER
// ===============================
export default async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const data = request.body; // JSON fra TradingView
    console.log("Received from TradingView:", data);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("Missing OPENAI_API_KEY");
      return response
        .status(500)
        .json({ error: "Server missing OPENAI_API_KEY" });
    }

    // ---------------------------
    // 0) Normaliser symbol + lag candle-objekt
    // ---------------------------
    const symbol = data.symbol || "UNKNOWN";

    const now = new Date();
    const timestamp =
      data.time_ms != null
        ? new Date(data.time_ms).toISOString()
        : now.toISOString();

    const candle = {
      timestamp,
      open: data.open,
      high: data.high,
      low: data.low,
      close: data.close,
      volume: data.volume,
      // Vi har foreløpig bare in_london_window som "session"-hint
      session: data.in_london_window ? "london" : "other",
      in_asia_session: false,        // kan forbedres senere
      in_frankfurt_session: false,   // kan forbedres senere
      in_london_session: !!data.in_london_window
    };

    // Legg candle i lokal buffer
    addCandleToStore(symbol, candle);

    // ---------------------------
    // 1) Bare analyser hvert 5. minutt
    // ---------------------------
    const minute = now.getUTCMinutes();
    const isFiveMinuteMark = minute % 5 === 0;

    if (!isFiveMinuteMark) {
      console.log(
        "Skipping GPT call (not 5-min mark). Minute:",
        minute,
        "Symbol:",
        symbol
      );
      return response.status(200).json({
        ok: true,
        skipped: true,
        reason: "not_5min_mark",
        received: data
      });
    }

    // ---------------------------
    // 2) Bygg rikere SMC-request (Løsning A – med recent_candles)
    // ---------------------------
    const smcRequest = buildSmcRequest(symbol, data);

    // ---------------------------
    // 3) Systemprompt til modellen
    // ---------------------------
    const systemPrompt = `
Du er en Smart Money Concepts-markedsanalytiker.

Du får et JSON-objekt med:
- symbol
- timeframe
- now_timestamp
- session_config (asia/frankfurt/london tider)
- recent_candles: liste med 1m candles
  (timestamp, open, high, low, close, volume, session, in_*_session)
- htf_context: høyere timeframe POI-zoner (kan være tomt)
- targets.setups_to_evaluate: hvilke setuper du skal sjekke
- original_tick: siste 1m candle fra TradingView med bl.a.
  asia_high/low, frankfurt_high/low, in_london_window

Oppgaver:

1) Gi en enkel SMC-"snapshot" NÅ (for bakoverkompabilitet):
   - "bias": "bullish" | "bearish" | "range" | "unclear"
   - "event": "none" | "sweep" | "frankfurt_inducement" | "london_sweep" | "choch" | "bos"
   - "comment": kort forklaring i 1–2 setninger
   - "entry_zone": { "min": number | null, "max": number | null }
   - "invalidation": number | null

2) I tillegg skal du, hvis mulig, evaluere setupen:
   "frankfurt_london_bos_setup_1":
   - Frankfurt har manipulert pris én vei (typ Asia-high/low tas ut i Frankfurt).
   - London har sweept likviditet på motsatt side.
   - Det har dannet seg en tydelig BOS etter sweepe.
   - Setup er kun "is_valid": true når HELE sekvensen er komplett.

Hvis setupen er gyldig, lag én entry med:
- Entry (limit) pris rundt 1m FVG eller siste sell-to-buy / buy-to-sell-blokk
- Take Profit basert på H1 FVG / 15m POI hvis tilgjengelig, ellers naturlig struktur-target
- Stop Loss under/over struktur med litt buffer (f.eks. 3 pips)

Du skal ALLTID svare med gyldig JSON på dette formatet (alt i samme objekt):

{
  "bias": "...",
  "event": "...",
  "comment": "...",
  "entry_zone": { "min": null, "max": null },
  "invalidation": null,
  "symbol": "...",
  "timeframe": "...",
  "analysis_timestamp": "...",
  "overall_bias": "...",
  "setups": [
    {
      "name": "frankfurt_london_bos_setup_1",
      "is_valid": false,
      "direction": null,
      "legs": {
        "frankfurt_manipulation": {
          "found": false,
          "direction": null,
          "start_timestamp": null,
          "end_timestamp": null,
          "description": ""
        },
        "london_sweep": {
          "found": false,
          "direction": null,
          "timestamp": null,
          "description": ""
        },
        "bos_confirmation": {
          "found": false,
          "timestamp": null,
          "structure_type": null,
          "description": ""
        }
      },
      "entry": {
        "type": null,
        "price": null,
        "zone_high": null,
        "zone_low": null,
        "timeframe": null,
        "reason": ""
      },
      "take_profit": {
        "price": null,
        "reason": "",
        "poi_references": []
      },
      "stop_loss": {
        "price": null,
        "reason": "",
        "structure_low": null,
        "structure_high": null,
        "buffer_pips": null
      },
      "comment": "",
      "confidence": 0
    }
  ],
  "raw_events": []
}

Hvis du ikke ser noen klar edge:
- bruk "bias": "unclear" og "event": "none".
Hvis du ikke finner et gyldig setup:
- sett "setups": [] ELLER en entry med "is_valid": false.
Bruk tall (number) for prisnivåer der det gir mening.
    `.trim();

    const userContent = JSON.stringify(smcRequest);

    // ---------------------------
    // 4) Kall OpenAI (gpt-4.1-mini)
    // ---------------------------
    const payload = {
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ],
      response_format: { type: "json_object" }
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
    // 5) Parse JSON-svaret
    // ---------------------------
    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch (e) {
      console.error("Failed to parse JSON from model:", content);
      analysis = { raw: content };
    }

    // ---------------------------
    // 6) Setup #1: Frankfurt → London → BOS
    // ---------------------------
    let setupAlertSent = false;
    try {
      const setups = analysis?.setups || [];
      const setup1 = setups.find(
        (s) =>
          s &&
          s.name === "frankfurt_london_bos_setup_1" &&
          s.is_valid === true
      );

      if (setup1) {
        const direction = (setup1.direction || "").toUpperCase();
        const entryPrice = setup1.entry?.price ?? "N/A";
        const tpPrice = setup1.take_profit?.price ?? "N/A";
        const slPrice = setup1.stop_loss?.price ?? "N/A";
        const comment = setup1.comment || analysis.comment || "";

        const msgLines = [
          "*SMC SETUP #1 (Frankfurt → London → BOS)*",
          "",
          `Symbol: ${analysis.symbol || symbol}`,
          `Direction: ${direction || "N/A"}`,
          "",
          `Entry: ${entryPrice}`,
          `Take Profit: ${tpPrice}`,
          `Stop Loss: ${slPrice}`,
          "",
          "Comment:",
          `${comment}`
        ];

        const msg = msgLines.join("\n");
        await sendTelegramMessage(msg);
        setupAlertSent = true;
        console.log("🔔 TELEGRAM ALERT: Setup #1 (Frankfurt→London→BOS)");
      }
    } catch (e) {
      console.error("Error while handling Setup #1:", e);
    }

    // ---------------------------
    // 7) Fallback: enkel CHOCH/BOS i London-vinduet
    //    (kun hvis Setup #1 ikke allerede ga alert)
// ---------------------------
    const importantEvents = ["choch", "bos"];
    const eventType = (analysis?.event || "none").toLowerCase();
    const isImportantEvent = importantEvents.includes(eventType);
    const londonOK = isInLondonHours();
    const shouldAlertSimple = isImportantEvent && londonOK && !setupAlertSent;

    if (shouldAlertSimple) {
      console.log("🔔 TELEGRAM ALERT (simple CHOCH/BOS). Event:", eventType);

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

      const msgLines = [
        "*SMC SIGNAL (London)*",
        "",
        `Symbol: ${symbol}`,
        `Event: ${eventType}`,
        `Bias: ${bias}`,
        "",
        `Comment: ${comment}`,
        "",
        `Entry zone: ${entryText}`,
        `Invalidation: ${invalidationText}`
      ];

      const msg = msgLines.join("\n");
      await sendTelegramMessage(msg);
    } else if (!setupAlertSent) {
      console.log(
        "No Telegram alert – event:",
        eventType,
        "| London hours:",
        londonOK
      );
    }

    const finalAlertFlag = setupAlertSent || shouldAlertSimple;

    // ---------------------------
    // 8) Svar tilbake (for debugging/test)
    // ---------------------------
    return response.status(200).json({
      ok: true,
      alert: finalAlertFlag,
      received: data,
      smc_request: smcRequest,
      analysis
    });
  } catch (err) {
    console.error("Server error:", err);
    return response.status(500).json({ error: "Server error" });
  }
}
