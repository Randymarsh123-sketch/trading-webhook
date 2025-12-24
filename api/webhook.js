// api/webhook.js
// Lagrer TradingView payload i Upstash (last:SYMBOL + latest:any)
// + sender 09:00 og 09:30 rapport til Telegram basert på nye Daily-cycle prompts (Norsk tid).

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
  return `ALERT 09:00 (Europe/Oslo) – EURUSD Early-Cycle Context

You must output EXACTLY in this structure (same headings, short lines). No extra sections.

Day:
Time:

Daily Cycle bias: Based on Daily
Asia: Classification of Asia
FVG: Near 1H / Daily FVG above/below Asia that can act as a magnet?
Frankfurt:
Manipulation yes/no?
Sweep yes/no?
BOS up/down yes/no?

London:
If London has not started:
What is most likely scenario when it comes to Daily cycle? Judas Swing / Asian Break and Retest / Asian Whipsaw / Dead Frankfurt?

RULES / MODEL (use only candles up to 09:00):
1) DAILY SCORE + BASE DAILY BIAS (ONLY D-1 and D-2 from d1):
- range = high(D-1) - low(D-1)
- close_position = (close(D-1) - low(D-1)) / range
- inside day if high(D-1) <= high(D-2) AND low(D-1) >= low(D-2)
- overlap regime: if D-1 and D-2 overlap heavily (~70%+). If you can't quantify overlap exactly from the numbers quickly, label it as "possible overlap" only when it is clearly large; otherwise "no clear overlap".

Score 3:
- close_position >= 0.60 OR <= 0.40
- NOT inside day
- NOT clear overlap regime

Score 2:
- close_position in [0.55, 0.60) OR (0.40, 0.45]
- OR close_position is strong but inside/overlap exists

Score 1:
- close_position near middle (around 0.45–0.55) OR clear chop/overlap
=> Score 1 means NO TRADE today.

2) BASE DAILY BIAS (before intraday):
- close_position >= 0.60 => Bullish
- close_position <= 0.40 => Bearish
- else => Ranging/Unclear

3) ASIA REFINEMENT of bias (only if score != 1):
- If Asia Low was taken first (wick touches/breaks Asia Low) => bias leans Bullish
- If Asia High was taken first => bias leans Bearish
- If neither side taken => keep base bias
- If BOTH Asia sides taken (any time up to 09:00) => bias = Ranging AND NO TRADE

4) NO-TRADE extra filter (only if you have data to evaluate 07:00–09:00):
- If BOTH Asia High and Asia Low have been taken between 07:00 and 10:00 => NO TRADE.
At 09:00 you can only state: "so far (07:00–09:00) both taken: yes/no/unknown".

5) FVG expectation layer (ONLY if ALL true):
- Score is 2 or 3
- Daily bias defined
- Asia range established
- There exists an unmitigated Daily or 1H FVG
- FVG is OUTSIDE Asia range
- FVG is in OPPOSITE direction of daily bias
If any condition missing => write "FVG: none / not active".

If active:
- Bullish daily bias + FVG above Asia => neutral expectation: price may move up first to rebalance, then later resume bullish
- Bearish daily bias + FVG below Asia => neutral expectation: price may move down first to rebalance, then later resume bearish
Never say "must fill". No price targets.

6) DAILY CYCLE REGIME (09:00 provisional):
Classify most likely regime, but note that Asian Whipsaw final confirmation is at 10:00.
Regime engine order:
A) Asian Whipsaw = both Asia High AND Asia Low taken with wick before 10:00 (at 09:00: can only say "so far yes/no")
B) Asia Break-And-Retest = before 09:30: at least one 5m CLOSE outside Asia High/Low + acceptance (two closes outside OR one clear close without immediate return)
C) Judas Swing eligibility gate = at least one Asia side taken before 09:30 (at 09:00: "eligible so far yes/no")
D) Dead-Frankfurt otherwise

At 09:00, London has not started. Do NOT invent BOS/CHOCH. Only mark "unknown / not applicable yet" if needed.

Also:
- Asia session is 02:00–06:59.
- Frankfurt session is 08:00–08:59.
- London early is 09:00–09:29 (not started yet at 09:00 close).
Keep it concise.`;
}

function build0930Prompt() {
  return `ALERT 09:30 (Europe/Oslo) – EURUSD Early-Cycle Decision Point

You must output EXACTLY in this structure (same headings, short lines). No extra sections.

Day:
Time:

Daily Cycle bias: Based on Daily
Asia: Classification of Asia
FVG: Near 1H / Daily FVG above/below Asia that can act as a magnet?

Frankfurt:
Manipulation yes/no?
Sweep yes/no?
BOS up/down yes/no?

London:
Manipulation yes/no?
Sweep yes/no?
BOS up/down yes/no?

What is most likely scenario when it comes to Daily cycle? Judas Swing / Asian Break and Retest / Asian Whipsaw / Dead Frankfurt?
What does London need to do?
For example IF it does this, confirmation of THAT (daily cycle / bearish / bullish)
For example IF it does this, look out for THIS (daily cycle / bearish / bullish)

RULES / MODEL (use only candles up to 09:30):
- Apply the exact same DAILY score/bias rules as 09:00 (D-1, D-2 only).
- If Score 1 => NO TRADE: still fill the template, but "What does London need to do?" must say: "No trade day (Score 1) – ignore early-cycle signals."

ASIA REFINEMENT at 09:30:
- If BOTH Asia sides have been taken by 09:30 => bias = Ranging AND NO TRADE.

NO-TRADE early-cycle filter:
- If BOTH Asia High and Asia Low have been taken between 07:00 and 10:00:
At 09:30 state "so far (07:00–09:30) both taken: yes/no/unknown". If yes => NO TRADE.

DAILY CYCLE REGIME engine (deterministic order):
1) Asian Whipsaw:
- If both Asia High and Asia Low are taken with wick before 10:00.
At 09:30: if both already taken => "Asian Whipsaw (provisional; final at 10:00)".
2) Asia Break-And-Retest:
- BEFORE 09:30: at least one 5m candle CLOSE outside Asia High/Low.
- Acceptance requires: (two closes outside) OR (one clear close without immediate return inside).
If this is true => classify as "Asia Break-And-Retest (expect retest in London main)".
Do NOT claim retest happened unless it already did.
3) Judas Swing:
Eligibility gate: at least one Asia side taken before 09:30.
Judas definition requires: only one Asia side taken before 09:30, and the opposite Asia side taken later before 14:00, and day is NOT whipsaw.
At 09:30 you cannot confirm the later opposite-side-take; you must phrase as:
- "Judas Swing (eligible / watch for opposite Asia side later)" only if eligible conditions match.
4) Dead-Frankfurt:
- If no acceptance-break before 09:30, and not whipsaw, and no Judas eligibility context, then "Dead-Frankfurt" (low early-cycle info; wait for first acceptance-break after 09:30).
- If you are unsure, choose Dead-Frankfurt and say "no acceptance-break confirmed".

FVG layer (same activation rules as 09:00). If not all conditions met => "FVG: none / not active".

Definitions you MUST respect:
- "Sweep / taken" = wick beyond Asia/Frankfurt levels is enough.
- "Break / acceptance" = CLOSE beyond Asia High/Low (wick alone doesn't count).
- BOS up/down: only say YES if you can point to a clear break of a prior swing structure from the provided candles; otherwise "unknown" or "not confirmed".

"What does London need to do?" must be a practical gate:
- If Break-And-Retest regime: London main should show retest of the broken Asia boundary (High/Low/Mid) before continuation is considered.
- If Dead-Frankfurt: wait for first acceptance-break after 09:30; ignore wicks outside Asia in London early.
- If Whipsaw provisional: quality low; prefer waiting toward 10:00 for clarity.
- If Judas eligible: watch for the opposite Asia side to be taken later (before 14:00); until then treat early moves as rebalancing-risk, not trend.

Keep it short.`;
}

async function callOpenAI({ prompt, state }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const system = `Du følger instruksene i prompten strengt.

KRITISK:
- Bruk KUN tall som finnes i state-JSON. Ikke gjett nivåer.
- Hvis noe mangler i state (f.eks. d1/h1/m15), skriv "ukjent (mangler data)".
- Ikke referer til fremtidige candles.
- Tidssone: Europe/Oslo.

DATAKILDER:
- 5m live candle: state.open/high/low/close/time_ms
- Asia/Frankfurt nivåer: state.asia_high, state.asia_low, state.frankfurt_high, state.frankfurt_low
- HTF: state.htf_data.h1 (1H), state.htf_data.d1 (Daily), state.htf_data.m15 (15m)
- HTF-arrays er sortert: eldste → nyeste
- Daily (d1): nyeste candle kan være dagens pågående (ikke lukket). For "gårsdagens candle (D-1)" og "dagen før (D-2)", bruk de to siste LUKKEDE daily candles:
  - D-1 = siste daily candle som er ferdig (normalt d1[-2] hvis d1[-1] er pågående)
  - D-2 = candle før den.

REGLER SOM MÅ FØLGES:
- Daily score/bias: kun D-1 og D-2 (daily OHLC).
- Score=1 => NO TRADE og avslutt vurderinger (men du kan fortsatt beskrive hva som skjer).
- NO TRADE hvis både Asia High og Asia Low blir tatt mellom 07:00 og 10:00 (wick er nok).
- FVG: kun Daily FVG og 1H FVG. Kun unmitigated. Brukes kun som nøytral forventning ("kan fungere som magnet"), aldri som krav, aldri nivå-gjetting.
- 1H brukes aldri som trigger, kun kontekst og FVG-identifikasjon.
- Daily cycle regime må velges deterministisk i denne rekkefølgen:
  1) Asian Whipsaw (begge Asia-sider tatt med wick før 10:00)
  2) Asia Break-And-Retest (acceptance-break før 09:30 med close-regler)
  3) Judas Swing (eligibility + senere motsatt side før 14:00)
  4) Dead-Frankfurt (hvis ingen av de over)
- Wick vs close:
  - "tatt" / sweep = wick utenfor Asia-range er nok
  - "break/acceptance" = close utenfor Asia High/Low (ikke wick).

Språk:
- Svar på engelsk (slik output-formatet er skrevet), kort og praktisk.
- Ikke foreslå RR, lot, trade management. Ikke "entry" med mindre prompten eksplisitt åpner for det (den gjør det ikke her).`;

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
