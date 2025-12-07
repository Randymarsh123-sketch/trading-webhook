// api/webhook.js

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
// HJELPER: finn CET-time (UTC+1) fra time_ms
// TradingView time_ms er i UTC, vi legger til +1 time
// -------------------------------
function getCetHourMinute(timeMs) {
  const dt = new Date(timeMs);
  const utcHour = dt.getUTCHours();
  const cetHour = (utcHour + 1 + 24) % 24; // CET = UTC+1
  const minute = dt.getUTCMinutes();
  return { cetHour, minute };
}

// -------------------------------
// HOVEDHANDLER
// -------------------------------
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

    const timeMs = data.time_ms;
    if (!timeMs) {
      console.error("Missing time_ms in payload");
      return response
        .status(400)
        .json({ error: "Missing time_ms in payload", received: data });
    }

    // Finn CET-time basert på UTC +1
    const { cetHour, minute } = getCetHourMinute(timeMs);

    // Sjekk om dette er 09:00 eller 09:30 CET
    let reportKind = null;
    if (cetHour === 9 && minute === 0) {
      reportKind = "0900";
    } else if (cetHour === 9 && minute === 30) {
      reportKind = "0930";
    }

    if (!reportKind) {
      // Ikke noe vi skal lage rapport på akkurat nå
      return response.status(200).json({
        ok: true,
        skipped: true,
        reason: "no_report_due",
        cetHour,
        minute,
        received: data
      });
    }

    // Bygg et "SMC request"-objekt som sendes til modellen
    const nowIso = new Date(timeMs).toISOString();

    const smcRequest = {
      symbol: data.symbol || null,
      timeframe_base: data.timeframe || "5m",
      now_timestamp: nowIso,
      time_ms: data.time_ms,
      asia_high: data.asia_high ?? null,
      asia_low: data.asia_low ?? null,
      frankfurt_high: data.frankfurt_high ?? null,
      frankfurt_low: data.frankfurt_low ?? null,
      in_london_window: data.in_london_window ?? false,
      last_candle: {
        open: data.open,
        high: data.high,
        low: data.low,
        close: data.close,
        volume: data.volume
      },
      htf_data: data.htf_data || {}
    };

    // ---------------------------
    // Velg systemprompt avhengig av rapport-type
    // ---------------------------
    let systemPrompt = "";
    if (reportKind === "0900") {
      systemPrompt = `
Du er en Smart Money Concepts-analytiker for FX (EURUSD).

Du får JSON-data med:
- 5m siste candle
- Asia-high/low, Frankfurt-high/low
- 15m- og 1H-historikk (htf_data.m15 og htf_data.h1)

Oppgave:
Lag en KORT morgenrapport for London-session rett før London åpner (09:00 CET).

Du skal:
1) Gi kort London-bias frem til ca. 14:00 basert på Asia + Frankfurt + HTF-struktur.
2) Gi kort "daily bias" (hvordan London + NY kan spille ut i løpet av dagen).
3) Beskriv 2 mest sannsynlige scenarioer for London mellom 09:00 og 10:00:
   - Scenario A
   - Scenario B
   For hvert scenario: forklar kort hva som MÅ skje strukturelt (SMC) for at scenariet blir aktuelt
   (f.eks. sweep av Asia-high, BOS over X, manipulasjon i motsatt retning, osv.)

Skriv:
- maks 2 korte avsnitt
- pluss 2 korte bullets (Scenario A og Scenario B).
Bruk enkelt språk (trenger ikke tung teori), men du kan bruke ord som "sweep", "BOS", "manipulasjon" osv.
Ikke skriv i punktliste for alt, bare for scenarioene til slutt.
      `;
    } else if (reportKind === "0930") {
      systemPrompt = `
Du er en Smart Money Concepts-analytiker for FX (EURUSD).

Du får JSON-data med:
- 5m siste candle (nå rundt 09:30 CET)
- Asia-high/low, Frankfurt-high/low
- 15m- og 1H-historikk (htf_data.m15 og htf_data.h1)

Oppgave:
Lag en kort London-oppdatering for 09:30 CET.

Du skal:
1) Si om det har skjedd:
   - manipulasjon i Frankfurt (i forhold til Asia-range)
   - sweep i London (over/under Asia/Frankfurt-nivåer)
   - CHOCH eller BOS på 5m frem til nå.
2) Oppdater session-bias for London (bullish, bearish eller nøytral) og forklar hvorfor på en enkel måte.
3) Beskriv 2 scenarioer videre for London:
   - Scenario A
   - Scenario B
   Forklar hva som MÅ skje før en entry ville gi mening (fra et SMC-perspektiv).

Skriv:
- maks 2 korte avsnitt
- pluss 2 korte bullets (Scenario A og Scenario B).
Bruk enkelt språk, men du kan bruke ord som "sweep", "inducement", "BOS", "CHOCH" og "likviditet".
      `;
    }

    const userPrompt = `
Her er markedsdataene frem til dette tidspunktet (CET):
${JSON.stringify(smcRequest, null, 2)}
    `;

    // ---------------------------
    // Kall OpenAI (gpt-4.1-mini)
    // ---------------------------
    const payload = {
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      // vi vil ha ren tekst, ikke JSON
      temperature: 0.4
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
    const content = gptJson.choices?.[0]?.message?.content || "";

    // ---------------------------
    // Bygg Telegram-melding
    // ---------------------------
    let header = "";
    if (reportKind === "0900") {
      header = `📊 09:00 London morgenrapport – ${smcRequest.symbol || ""}`;
    } else if (reportKind === "0930") {
      header = `📊 09:30 London oppdatering – ${smcRequest.symbol || ""}`;
    }

    const telegramMessage = `${header}\n\n${content}`;

    await sendTelegramMessage(telegramMessage);

    // ---------------------------
    // Svar til TradingView / tester
    // ---------------------------
    return response.status(200).json({
      ok: true,
      report_kind: reportKind,
      cetHour,
      minute,
      received: data,
      smc_request: smcRequest,
      report_text: content
    });
  } catch (err) {
    console.error("Server error:", err);
    return response.status(500).json({ error: "Server error" });
  }
}
