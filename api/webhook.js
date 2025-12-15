// api/webhook.js
import { kv } from "@vercel/kv";

async function sendTelegramMessage(chatId, message) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_TOKEN");

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });

  if (!r.ok) throw new Error(`Telegram sendMessage failed: ${await r.text()}`);
}

async function callOpenAI({ apiKey, systemPrompt, userContent }) {
  const payload = {
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j.choices?.[0]?.message?.content || "";
}

function getOsloParts(timeMs) {
  // timeMs = epoch ms
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = dtf.formatToParts(new Date(timeMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const yyyy = map.year;
  const mm = map.month;
  const dd = map.day;
  const hh = Number(map.hour);
  const min = Number(map.minute);

  return {
    dateKey: `${yyyy}-${mm}-${dd}`, // Oslo-date
    hh,
    min,
  };
}

function buildPrompt_0900() {
  return `
09:00 LONDON-FORBEREDELSE

Du er en erfaren SMC-trader.
Skriv en kort, presis London-forberedelse kl. 09:00 norsk tid.

VIKTIG:
- Bruk KUN candle-data frem til 09:00 norsk tid.
- Ikke anta eller referer til fremtidige candles.
- Svar kort og konkret. Stikkord er OK.
- Ingen entries. Ingen trade-forslag.

────────────────────
1) ASIA (02:00–06:00)

Klassifiser Asia som ÉN av disse:
- Buildup / Accumulation
- Manipulation / False direction
- Rebalancing / Mitigation (fra NY)

Beskriv kort:
- Retning Asia beveget pris
- Hvor likviditet sannsynligvis ligger (over/under Asia high/low/mid)

POI:
- Relevante FVG-er på 5m / 15m / 1H over eller under Asia
- Om Asia beveget seg inn i, ut av eller mot HTF-FVG

────────────────────
2) FRANKFURT (08:00–09:00)

- Har Frankfurt manipulert? (JA / NEI)
- Hva ble tatt ut? (Asia high / low / mid / annet nivå)
- Ble manipuleringen clean, eller del av tidligere pre-Frankfurt-bevegelse?
- Hvilke nivåer er fortsatt INTAKTE inn i London?

────────────────────
3) LONDON-PLAN (før 09:30)

Beskriv:
- Hva MÅ skje før en gyldig London-setup kan starte
- Hva bør ignoreres
- Mulige strukturer som kan formes:
  - W / M-pattern
  - Inducement før sweep
  - Fake break før reell retning

────────────────────
4) BIAS

- Session-bias for London basert på 15m / 1H struktur
- Kort hypotese om mest sannsynlig rekkefølge (1–2 setninger maks)

Språk:
- Bruk kun nødvendige begreper: Asia / Frankfurt / High / Low / Mid / Manipulation / Sweep / BOS / CHOCH / Inducement
- Hvis du bruker “inducement”: si NÅR og HVOR den oppsto.
`.trim();
}

function buildPrompt_0930() {
  return `
09:30 ALERT – LONDON UPDATE

Du er en SMC-trader som gir en kort, presis London-oppdatering kl 09:30.

VIKTIG:
- Bruk KUN candle-data frem til 09:30 norsk tid.
- Ikke anta fremtidige candles.
- Svar kort og konkret (stikkord / korte setninger).
- Målet er oversikt og forberedelse – ikke trade-management.

────────────────────
1) STATUS FREM TIL 09:30
────────────────────

Asia:
- Klassifisering (velg én): 
  Buildup / Accumulation / Manipulation / Rebalancing / Range
- Hva ble bygget av likviditet?
- Intakte nivåer (high / low / mid)
- Viktige POI:
  - FVG (5m / 15m / 1H) over / under Asia
  - Om Asia allerede er mitigert eller fortsatt “åpen”

Frankfurt (08–09):
- Manipulation: JA / NEI
- Hvis JA:
  - Hva ble tatt? (Asia high / low / mid)
  - Retning (opp / ned)
- Hvis NEI:
  - Frankfurt klassifiseres som “død / nøytral”

────────────────────
2) LONDON 09:00–09:30
────────────────────

- Har London sweepet noe?
  (Asia high / Asia low / Frankfurt high / Frankfurt low)
- Retning på sweep (opp / ned)
- Reaksjon etter sweep:
  impuls / avvisning / konsolidering
- Struktur:
  - BOS: JA / NEI
  - CHOCH: JA / NEI
  (angi nivå hvis relevant)

────────────────────
3) HVORDAN TOLKE DETTE
────────────────────

Scenario A – Frankfurt manipulation finnes:
- Hva MÅ skje videre for gyldig setup?
- Hva bør ignoreres?
- Typisk modell:
  Judas / W / M / Sweep → BOS → Continuation

Scenario B – Frankfurt er DØD:
- Hva er Londons rolle nå?
- Hvilke signaler er gyldige å følge?
- Hva MÅ bekreftes før man vurderer entry?

────────────────────
4) BIAS
────────────────────

- London session-bias: Bullish / Bearish / Nøytral
- Begrunnelse: (struktur + liquidity + HTF-kontekst)
- Daily bias (kort): samsvarer / divergerer fra London?

────────────────────
5) HVA DU BØR SE ETTER VIDERE
────────────────────

- Konkret sjekkliste:
  - Sweep av ___
  - BOS på ___
  - Retest av ___
- Typisk target-område:
  (HTF FVG / Asia-range / strukturelt nivå)

────────────────────
EKSTRA (KUN HVIS ALLE ER SANNE):
- Frankfurt manipulation = JA
- London sweep = JA
- BOS bekreftet etter sweep

Da:
- Foreslå MULIG entry-logikk (ikke ordre):
  - Etter BOS + pullback / retest
  - Referer til struktur / FVG / OB
- Foreslå naturlig target:
  - Basert på 15m / 1H POI
- Foreslå invalidation:
  - Strukturbrudd som gjør setup ugyldig

Ikke gi trade-størrelse.
Ikke gi RR.
Ikke gi flere entries.
`.trim();
}

export default async function handler(req, res) {
  try {
    // “Er du oppe?”
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, message: "webhook alive" });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const payload = req.body || {};
    const symbol = payload?.symbol || "unknown";
    const timeMs = Number(payload?.time_ms);

    if (!timeMs || Number.isNaN(timeMs)) {
      return res.status(400).json({ ok: false, error: "Missing/invalid time_ms in payload" });
    }

    // 1) Lagre “latest” slik at /ask kan bruke den
    await kv.set("latest:any", payload);
    await kv.set(`latest:${symbol}`, payload);

    // 2) Sjekk Oslo-tid
    const { dateKey, hh, min } = getOsloParts(timeMs);

    // 3) Kun send rapporter på eksakt 09:00 og 09:30 (Oslo)
    const is0900 = hh === 9 && min === 0;
    const is0930 = hh === 9 && min === 30;

    // Hvem skal få rapportene?
    const reportChatId = process.env.TELEGRAM_CHAT_ID; // samme chat du bruker for alerts
    const apiKey = process.env.OPENAI_API_KEY;

    // Hvis du ikke har satt disse, så lagrer vi fortsatt candles, men sender ikke rapport
    if ((!reportChatId || !apiKey) && (is0900 || is0930)) {
      // ikke kast error – bare returner OK
      return res.status(200).json({
        ok: true,
        stored: true,
        note: "Missing TELEGRAM_CHAT_ID or OPENAI_API_KEY so reports are not sent",
      });
    }

    // 4) “Send bare én gang per dag”
    if (is0900) {
      const sentKey = `sent:${dateKey}:0900`;
      const already = await kv.get(sentKey);
      if (!already) {
        const prompt = buildPrompt_0900();
        const answer = await callOpenAI({
          apiKey,
          systemPrompt: prompt,
          userContent: JSON.stringify(payload),
        });

        const msg = `*09:00 London-forberedelse – ${symbol}*\n\n${answer}`.trim();
        await sendTelegramMessage(reportChatId, msg);

        // marker sendt (TTL 3 døgn)
        await kv.set(sentKey, true, { ex: 60 * 60 * 24 * 3 });
      }
    }

    if (is0930) {
      const sentKey = `sent:${dateKey}:0930`;
      const already = await kv.get(sentKey);
      if (!already) {
        const prompt = buildPrompt_0930();
        const answer = await callOpenAI({
          apiKey,
          systemPrompt: prompt,
          userContent: JSON.stringify(payload),
        });

        const msg = `*09:30 London update – ${symbol}*\n\n${answer}`.trim();
        await sendTelegramMessage(reportChatId, msg);

        await kv.set(sentKey, true, { ex: 60 * 60 * 24 * 3 });
      }
    }

    return res.status(200).json({
      ok: true,
      stored: true,
      symbol,
      oslo_time: { hh, min, dateKey },
      sent: { is0900, is0930 },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: String(err?.message || err),
    });
  }
}
