// api/webhook.js

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// ─────────────────────────────
// Hjelpere
// ─────────────────────────────
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
    }),
  });
}

async function getLastPayload(symbol) {
  const res = await fetch(
    `${UPSTASH_URL}/get/${encodeURIComponent(`last:${symbol}`)}`,
    {
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
      },
    }
  );
  const json = await res.json();
  return json?.result || null;
}

async function askGPT(systemPrompt, userData) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userData) },
      ],
      temperature: 0.3,
    }),
  });
  const json = await res.json();
  return json.choices[0].message.content;
}

// ─────────────────────────────
// PROMPTS
// ─────────────────────────────
const PROMPT_0900 = `
09:00 LONDON-FORBEREDELSE

Du er en erfaren SMC-trader.
Skriv en kort, presis London-forberedelse kl. 09:00 norsk tid.

VIKTIG:
- Bruk KUN candle-data frem til 09:00 norsk tid.
- Ikke anta eller referer til fremtidige candles.
- Svar kort og konkret. Stikkord er OK.
- Ingen entries. Ingen trade-forslag.

1) ASIA (02:00–06:00)
Klassifiser Asia som ÉN:
- Buildup / Accumulation
- Manipulation / False direction
- Rebalancing / Mitigation (fra NY)

Beskriv:
- Retning Asia beveget pris
- Hvor likviditet ligger (over/under Asia high/low/mid)

POI:
- Relevante FVG-er (5m / 15m / 1H)
- Om Asia beveget seg inn i eller ut av HTF-FVG

2) FRANKFURT (08:00–09:00)
- Har Frankfurt manipulert? (JA / NEI)
- Hva ble tatt?
- Clean manipulation eller del av pre-Frankfurt?
- Hvilke nivåer er INTAKTE inn i London?

3) LONDON-PLAN
- Hva MÅ skje før gyldig setup
- Hva bør ignoreres
- Mulige strukturer: W / M / Inducement / Fake break

4) BIAS
- London session-bias basert på 15m / 1H
- Kort hypotese (1–2 setninger)

Bruk kun nødvendige begreper.
`;

const PROMPT_0930 = `
09:30 ALERT – LONDON UPDATE

Du er en SMC-trader som gir en kort London-oppdatering kl 09:30.

VIKTIG:
- Bruk KUN candle-data frem til 09:30 norsk tid.
- Ikke anta fremtidige candles.
- Svar kort og konkret.

1) STATUS
Asia:
- Klassifisering
- Intakte nivåer
- Viktige POI/FVG

Frankfurt:
- Manipulation: JA / NEI
- Hvis JA: hva og retning
- Hvis NEI: Frankfurt er DØD

2) LONDON 09–09:30
- Sweep: JA / NEI (hva)
- Reaksjon
- BOS / CHOCH (angi nivå)

3) TOLKNING
Scenario A – Frankfurt finnes
Scenario B – Frankfurt er død

4) BIAS
- London bias
- Daily bias (kort)

5) SE ETTER VIDERE
- Sweep av ___
- BOS på ___
- Retest av ___

EKSTRA (KUN HVIS ALLE ER SANNE):
- Frankfurt manipulation = JA
- London sweep = JA
- BOS bekreftet

Da:
- Mulig entry-logikk (struktur/FVG)
- Target (15m/1H)
- Invalidation
`;

// ─────────────────────────────
// HANDLER
// ─────────────────────────────
export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "alive" });
  }

  try {
    const symbol = req.body?.symbol || "EURUSD";

    // Lagre payload
    await fetch(`${UPSTASH_URL}/set/last:${symbol}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    // Finn norsk tid
    const now = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Europe/Oslo" })
    );
    const hh = now.getHours();
    const mm = now.getMinutes();

    const data = await getLastPayload(symbol);

    if (hh === 9 && mm === 0) {
      const text = await askGPT(PROMPT_0900, data);
      await sendTelegram(`📊 09:00 London-forberedelse\n\n${text}`);
    }

    if (hh === 9 && mm === 30) {
      const text = await askGPT(PROMPT_0930, data);
      await sendTelegram(`📊 09:30 London update\n\n${text}`);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
