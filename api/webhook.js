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
// HJELPER: finn modus (tick / 09:00 / 09:30) i NORSK TID
// Antar server-tid ~ UTC og Norge = UTC+1 (vinter).
// -------------------------------
function getAnalysisMode() {
  const now = new Date();
  const osloHour = now.getUTCHours() + 1; // CET ~ Europe/Oslo vintertid
  const minute = now.getUTCMinutes();

  if (osloHour === 9 && minute === 0) return "report_0900";
  if (osloHour === 9 && minute === 30) return "report_0930";
  return "tick";
}

// -------------------------------
// HOVEDHANDLER
// -------------------------------
export default async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const data = request.body; // JSON fra TradingView (5m + HTF)
    console.log("Received from TradingView:", data);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("Missing OPENAI_API_KEY");
      return response
        .status(500)
        .json({ error: "Server missing OPENAI_API_KEY" });
    }

    const mode = getAnalysisMode();

    // ---------------------------
    // 1) Systemprompt til modellen
    // ---------------------------
    const systemPrompt = `
Du er en Smart Money Concepts-analytiker for EURUSD.

Du får JSON fra TradingView med én 5m-candle, ferdig beregnede sessionsnivåer og høyere tidsrammer. Strukturen er:

{
  "symbol": string,
  "timeframe": "5m",
  "time_ms": number,
  "open": number,
  "high": number,
  "low": number,
  "close": number,
  "volume": number,
  "asia_high": number | null,
  "asia_low": number | null,
  "frankfurt_high": number | null,
  "frankfurt_low": number | null,
  "in_london_window": boolean,
  "htf_data": {
    "m15": [ { "timestamp": number, "open": number, "high": number, "low": number, "close": number, "volume": number } ],
    "h1":  [ { ... } ]
  },
  "mode": "tick" | "report_0900" | "report_0930"
}

VIKTIG OM TALL:
- Behandle alle tall i input som fasit. Du skal ALDRI anta, gjette eller finne på egne prisnivåer.
- Når du refererer til Asia-high og Asia-low i teksten, SKAL du bruke verdiene fra "asia_high" og "asia_low" nøyaktig slik de står i JSON.
- Når du refererer til Frankfurt-high og Frankfurt-low, SKAL du bruke "frankfurt_high" og "frankfurt_low" nøyaktig slik de står.
- Hvis et felt er null, skal du eksplisitt skrive at nivået ikke er tilgjengelig. Du skal da ikke hente et annet tall fra candles og late som det er 'Asia high' eller 'Frankfurt low'.
- Når du trenger prisnivåer ellers (for eksempel entry, invalidation eller targets), skal du kun bruke tall du kan lese direkte fra feltene i input (high/low/close osv.). Ikke lag glatte eller avrundede tall som ikke finnes i data.

SESSION-DEFINISJONER (Europe/Oslo – NORSK TID):
- Asia-session er ALLTID 02:00–06:00.
- Pre-Frankfurt (inducement) er 06:00–08:00.
- Frankfurt-session er 08:00–09:00.
- London-open-vindu er 09:00–10:00.
Disse tidene er allerede brukt i Pine-scriptet som beregner "asia_high", "asia_low", "frankfurt_high" og "frankfurt_low". Du skal stole på disse nivåene og ikke regne dem på nytt.

MODUS:
- Feltet "mode" i input forteller hva du skal gjøre:
  - "tick"        = vanlig 5m SMC-analyse
  - "report_0900" = morgenrapport kl. 09:00
  - "report_0930" = London-oppdatering kl. 09:30

STIL PÅ RAPPORTENE:
- Rapport-tekstene skal være KORTE og STRUKTURERTE.
- Bruk alltid følgende struktur i tekst (norsk):

  Asia: kort beskrivelse (1–2 setninger) av hvordan Asia (02–06) har pushet pris og hvor liquidity ligger i forhold til asia_high / asia_low (for eksempel "pushet opp, mye liquidity under higher lows", "bygget tight range, liquidity over high og under low").
  Frankfurt: kort beskrivelse (1–2 setninger) av om Frankfurt har manipulert opp/ned, tatt likviditet rundt Asia-nivåene, og hvordan dette kan brukes av London. Referer til frankfurt_high / frankfurt_low når tilgjengelig.
  London: kort vurdering (1–2 setninger) av London-bias (bullish/bearish/nøytral) og hva som må skje (for eksempel sweep + BOS) før et scenario er aktivt. Ikke gi konkrete entries, bare hva London "bør" gjøre før entry gir mening.
  Mulig daily cycle: én kort label + evt. 1 setning forklaring. Eksempler på labels: "Judas swing", "Asia break & retest", "Asia whipsaw", "Trend day", "Range day". Bruk bare disse typene beskrivelser.

- Bruk linjeskift mellom hver del slik:

  Asia: ...
  Frankfurt: ...
  London: ...
  Mulig daily cycle: ...

- Unngå lange avsnitt. Ingen punktlister, bare korte setninger.

OPPGAVER:

1) Når mode = "tick":
   - Sett "bias" til en av: "bullish", "bearish", "range", "unclear".
   - Sett "event" til en av: "none", "sweep", "choch", "bos", "frankfurt_manipulation", "london_sweep" eller liknende kort kode.
   - Hvis du ser en naturlig FVG-/struktur-entry, fyll "entry_zone.min" og "entry_zone.max" med priser hentet direkte fra candles i input.
   - Hvis det finnes et naturlig invalidation-nivå (for eksempel under siste low eller over en tydelig high), fyll "invalidation" med et eksisterende prisnivå.
   - Skriv "comment" på norsk, 1–3 setninger, kort og teknisk.
   - "report_0900" og "report_0930" skal i dette tilfellet være null.

2) Når mode = "report_0900":
   - Lag en kort morgenrapport på norsk, med nøyaktig denne strukturen:

     Asia: ...
     Frankfurt: ...
     London: ...
     Mulig daily cycle: ...

   - Asia-delen beskriver Asia 02–06 (range/trend, hvor pris ligger i forhold til asia_high/asia_low, liquidity over/under).
   - Frankfurt-delen beskriver 06–09 (inducement + ev. Frankfurt-manipulasjon).
   - London-delen sier 1–2 mest sannsynlige scenarier for London (bullish/bearish/mean-reversion) uten å innføre nye prisnivåer utover dem du har fått.
   - Mulig daily cycle: gi én label og kort forklaring (for eksempel "Asia break & retest – pris har brutt Asia-high og tester nå midten av rangen").
   - I dette tilfellet skal:
       * "report_0900" inneholde hele teksten (string)
       * "report_0930" være null

3) Når mode = "report_0930":
   - Lag en London-oppdatering på norsk med samme struktur:

     Asia: ...
     Frankfurt: ...
     London: ...
     Mulig daily cycle: ...

   - Asia: veldig kort oppsummering (1 setning) av Asia-range og hvor nåværende pris ligger vs Asia-high/low.
   - Frankfurt: om det har vært tydelig manipulasjon/sweep rundt Asia-nivåene, samt om Frankfurt sine highs/lows nå fungerer som liquidity for London.
   - London: hva London faktisk har gjort frem til 09:30 (sweep/CHOCH/BOS eller bare range), og hva som skal til for et mer tydelig scenario.
   - Mulig daily cycle: oppdatert vurdering av hvilken type dag det ligner mest på (Judas swing, Asia whipsaw, osv).
   - I dette tilfellet skal:
       * "report_0930" inneholde teksten
       * "report_0900" være null

SVARFORMAT:
- Svar ALLTID med gyldig JSON på dette formatet:

{
  "bias": "bullish" | "bearish" | "range" | "unclear",
  "event": "none" | "sweep" | "choch" | "bos" | "frankfurt_manipulation" | "london_sweep" | string,
  "comment": string,
  "entry_zone": { "min": number | null, "max": number | null },
  "invalidation": number | null,
  "report_0900": string | null,
  "report_0930": string | null
}
`;

    const payloadForModel = {
      ...data,
      mode
    };

    const userContent = JSON.stringify(payloadForModel);

    // ---------------------------
    // 2) Kall OpenAI (gpt-4.1-mini)
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
    // 3) Parse JSON-svaret
    // ---------------------------
    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch (e) {
      console.error("Failed to parse JSON from model:", content);
      analysis = { raw: content };
    }

    console.log("SMC analysis:", analysis);

    let alertSent = false;

    // ---------------------------
    // 4) 09:00-rapport
    // ---------------------------
    if (mode === "report_0900" && analysis.report_0900) {
      await sendTelegramMessage(`📊 09:00 Asia/Frankfurt\n\n${analysis.report_0900}`);
      alertSent = true;
    }

    // ---------------------------
    // 5) 09:30-rapport
    // ---------------------------
    if (mode === "report_0930" && analysis.report_0930) {
      await sendTelegramMessage(`📊 09:30 London\n\n${analysis.report_0930}`);
      alertSent = true;
    }

    // ---------------------------
    // 6) Enkelt-SMC-signaler (CHOCH/BOS i London-vindu)
    // ---------------------------
    if (mode === "tick" && analysis && typeof analysis === "object") {
      const importantEvents = ["choch", "bos"];
      const eventType = (analysis.event || "none").toString().toLowerCase();
      const isImportantEvent = importantEvents.includes(eventType);
      const londonOK = !!data.in_london_window;

      if (isImportantEvent && londonOK) {
        const bias = analysis.bias || "uklar";
        const comment = analysis.comment || "";
        const entryZone = analysis.entry_zone || null;
        const invalidation = analysis.invalidation ?? null;

        let entryText = "N/A";
        if (entryZone && entryZone.min != null && entryZone.max != null) {
          entryText = `${entryZone.min} - ${entryZone.max}`;
        }

        const invalidationText =
          invalidation != null ? String(invalidation) : "N/A";

        const msgLines = [
          "*SMC SIGNAL (London)*",
          "",
          `Symbol: ${data.symbol || "?"}`,
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
        alertSent = true;
      }
    }

    // ---------------------------
    // 7) Svar til klient
    // ---------------------------
    return response.status(200).json({
      ok: true,
      kind: "ltf_tick",
      mode,
      alert: alertSent,
      received: data,
      analysis
    });
  } catch (err) {
    console.error("Server error:", err);
    return response.status(500).json({ error: "Server error" });
  }
}
