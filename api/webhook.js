// api/webhook.js
// Lagrer TradingView payload i Upstash (last:SYMBOL + latest:any)
// + sender 09:00 og 09:30 rapport til Telegram basert på dine prompts (Norsk tid).

async function upstashSet(key, valueObj, ttlSeconds = 172800) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");

  const endpoint = `${url}/set/${encodeURIComponent(key)}`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    // Upstash REST /set tar JSON body = value. Vi legger inn payload direkte.
    body: JSON.stringify(valueObj),
  });

  if (!resp.ok) throw new Error(`Upstash SET failed: ${resp.status} ${await resp.text()}`);

  // Sett TTL (expire) i egen call for å være sikker
  const exp = await fetch(`${url}/expire/${encodeURIComponent(key)}/${ttlSeconds}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  // ikke hard-fail på expire
  if (!exp.ok) console.warn("Upstash EXPIRE failed:", await exp.text());
}

async function upstashGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");

  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Upstash GET failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json(); // { result: ... }
  return data?.result ?? null;
}

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Missing TELEGRAM_TOKEN / TELEGRAM_CHAT_ID");

  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });

  if (!resp.ok) throw new Error(`Telegram sendMessage failed: ${resp.status} ${await resp.text()}`);
}

function getOsloPartsFromMs(ms) {
  // Returnerer { yyyy, mm, dd, hh, min } i Europe/Oslo
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = dtf.formatToParts(new Date(Number(ms)));
  const m = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = p.value;

  return {
    yyyy: Number(m.year),
    mm: Number(m.month),
    dd: Number(m.day),
    hh: Number(m.hour),
    min: Number(m.minute),
  };
}

function build0900Prompt() {
  return `09:00 LONDON-FORBEREDELSE

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
  (f.eks: London må sweep Frankfurt low før bullish continuation)
- Hva bør ignoreres (støy, tidlig breakout, Asia-range chop)
- Mulige strukturer som kan formes:
  - W / M-pattern
  - Inducement før sweep
  - Fake break før reell retning

────────────────────
4) BIAS

- Session-bias for London basert på 15m / 1H struktur
- Kort hypotese om mest sannsynlig rekkefølge (1–2 setninger maks)
  (f.eks: først mitigate 1H FVG → deretter reversal i tråd med HTF-bias)

Språk:
- Bruk kun nødvendige begreper: Asia / Frankfurt / High / Low / Mid / Manipulation / Sweep / BOS / CHOCH / Inducement
- Hvis du bruker “inducement”: si NÅR og HVOR den oppsto.`;
}

function build0930Prompt() {
  return `09:30 ALERT – LONDON UPDATE

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
  (f.eks: BOS over/under X etter sweep)
- Hva bør ignoreres?
  (f.eks: små wicks / range-støy)
- Typisk modell:
  Judas / W / M / Sweep → BOS → Continuation

Scenario B – Frankfurt er DØD:
- Hva er Londons rolle nå?
  (f.eks: London skaper egen manipulation)
- Hvilke signaler er gyldige å følge?
  (f.eks: London-sweep + BOS uten Frankfurt)
- Hva MÅ bekreftes før man vurderer entry?
  (strukturbrudd, retest, clean impuls)

────────────────────
4) BIAS
────────────────────

- London session-bias: Bullish / Bearish / Nøytral
- Begrunnelse:
  (struktur + liquidity + HTF-kontekst)
- Daily bias (kort):
  samsvarer / divergerer fra London?

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
Ikke gi flere entries.`;
}

async function callOpenAI({ prompt, state }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const system = `Du følger instruksene i prompten strengt.
VIKTIG: Bruk KUN tall som finnes i state-JSON. Ikke gjett nivåer.
Svar på norsk.`;

  const user = `PROMPT:
${prompt}

STATE (JSON):
${JSON.stringify(state).slice(0, 240000)}`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: 700,
    }),
  });

  if (!r.ok) throw new Error(`OpenAI failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || "").trim();
}

export default async function handler(req, res) {
  try {
    // "Alive" check
    if (req.method === "GET") return res.status(200).json({ ok: true, message: "webhook alive" });
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

    const payload = req.body || {};
    const symbol = payload?.symbol || "unknown";
    const key = `last:${symbol}`;

    // LAGRE payload
    await upstashSet(key, payload, 172800);        // 2 døgn
    await upstashSet("latest:any", payload, 172800);

    // Tidsstyring (norsk tid) basert på payload.time_ms (ms)
    const timeMs = payload?.time_ms;
    if (typeof timeMs !== "number") {
      return res.status(200).json({ ok: true, stored: true, key, note: "No time_ms in payload; skipped scheduled alerts." });
    }

    const t = getOsloPartsFromMs(timeMs);
    const dateKey = `${t.yyyy}-${String(t.mm).padStart(2, "0")}-${String(t.dd).padStart(2, "0")}`;

    // Trigger kun på 09:00 og 09:30 (Oslo)
    const is0900 = (t.hh === 9 && t.min === 0);
    const is0930 = (t.hh === 9 && t.min === 30);

    // Anti-dupe (per dag)
    if (is0900 || is0930) {
      const sentKey = `sent:${symbol}:${dateKey}:${is0900 ? "0900" : "0930"}`;
      const already = await upstashGet(sentKey);

      if (!already) {
        const prompt = is0900 ? build0900Prompt() : build0930Prompt();
        const answer = await callOpenAI({ prompt, state: payload });

        const header = is0900 ? `*09:00 London-forberedelse – ${symbol}*` : `*09:30 London update – ${symbol}*`;
        const msg = `${header}\n\n${answer}`;

        await sendTelegramMessage(msg);

        // Marker som sendt (TTL 48t)
        await upstashSet(sentKey, { sent: true, at_ms: timeMs }, 172800);
      }
    }

    return res.status(200).json({ ok: true, stored: true, key, received_symbol: symbol });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Server error", details: String(err?.message || err) });
  }
}
