// api/webhook.js
// Stores TradingView payload in Upstash (last:SYMBOL + latest:any)
// Sends 09:00 and 09:30 Telegram alerts (Europe/Oslo)
// TESTING:
//   1) Live latest:  POST ?test=0930&symbol=EURUSD
//   2) Sandbox dataset: POST ?test=0930&dataset=dataset:EURUSD:5d&at=2025-12-15T09:30:00+01:00
//                     or POST ?test=0930&dataset=dataset:EURUSD:5d&at_ms=1765758600000

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
    body: JSON.stringify(valueObj),
  });

  if (!resp.ok) throw new Error(`Upstash SET failed: ${resp.status} ${await resp.text()}`);

  const exp = await fetch(`${url}/expire/${encodeURIComponent(key)}/${ttlSeconds}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
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
  const data = await resp.json();
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
  // Returns { yyyy, mm, dd, hh, min } in Europe/Oslo
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

function parseAtMsFromQuery(req) {
  // Prefer at_ms (simple)
  const atMsRaw = req.query?.at_ms;
  if (atMsRaw !== undefined) {
    const n = Number(atMsRaw);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }

  // Or at=ISO-8601 with offset/Z, e.g. 2025-12-15T09:30:00+01:00
  const at = String(req.query?.at || "").trim();
  if (!at) return null;

  const d = new Date(at);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return ms;
}

function findLastCandleAtOrBefore(arr, atMs) {
  // arr: [{ts,o,h,l,c,v}, ...] sorted oldest->newest
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Number(arr[mid]?.ts);
    if (t <= atMs) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function sliceCandlesUpTo(arr, atMs, count) {
  const idx = findLastCandleAtOrBefore(arr, atMs);
  if (idx < 0) return [];
  const start = Math.max(0, idx - (count - 1));
  return arr.slice(start, idx + 1);
}

function maxHigh(arr) {
  let m = null;
  for (const x of arr) {
    const h = Number(x?.h);
    if (!Number.isFinite(h)) continue;
    if (m === null || h > m) m = h;
  }
  return m;
}

function minLow(arr) {
  let m = null;
  for (const x of arr) {
    const l = Number(x?.l);
    if (!Number.isFinite(l)) continue;
    if (m === null || l < m) m = l;
  }
  return m;
}

function buildStateFromDataset(dataset, atMs) {
  const symbol = dataset?.meta?.symbol || "EURUSD";
  const m5 = dataset?.m5 || [];
  const h1 = dataset?.h1 || [];
  const d1 = dataset?.d1 || [];

  if (!Array.isArray(m5) || m5.length === 0) throw new Error("Dataset missing m5[]");
  if (!Array.isArray(h1) || h1.length === 0) throw new Error("Dataset missing h1[]");
  if (!Array.isArray(d1) || d1.length === 0) throw new Error("Dataset missing d1[]");

  const idx5 = findLastCandleAtOrBefore(m5, atMs);
  if (idx5 < 0) throw new Error("No m5 candle at/before atMs in dataset");
  const last5 = m5[idx5];

  // Oslo date parts for session slicing
  const t = getOsloPartsFromMs(atMs);
  const yyyy = t.yyyy;
  const mm = t.mm;
  const dd = t.dd;

  // Grab all m5 candles for this Oslo day
  const m5SameDay = [];
  for (const c of m5) {
    const p = getOsloPartsFromMs(c.ts);
    if (p.yyyy === yyyy && p.mm === mm && p.dd === dd) m5SameDay.push(c);
  }

  // Asia: 02:00–06:59
  const asiaCandles = m5SameDay.filter((c) => {
    const p = getOsloPartsFromMs(c.ts);
    return p.hh >= 2 && p.hh <= 6;
  });

  // Frankfurt: 08:00–08:59
  const frCandles = m5SameDay.filter((c) => {
    const p = getOsloPartsFromMs(c.ts);
    return p.hh === 8;
  });

  const asiaHigh = asiaCandles.length ? maxHigh(asiaCandles) : null;
  const asiaLow = asiaCandles.length ? minLow(asiaCandles) : null;
  const frankfurtHigh = frCandles.length ? maxHigh(frCandles) : null;
  const frankfurtLow = frCandles.length ? minLow(frCandles) : null;

  const londonWindow = (t.hh === 9 && t.min < 30);

  return {
    symbol,
    timeframe: "5m",
    time_ms: Number(last5.ts),
    open: Number(last5.o),
    high: Number(last5.h),
    low: Number(last5.l),
    close: Number(last5.c),
    volume: Number(last5.v ?? 0),
    asia_high: asiaHigh,
    asia_low: asiaLow,
    frankfurt_high: frankfurtHigh,
    frankfurt_low: frankfurtLow,
    in_london_window: londonWindow,
    htf_data: {
      // We keep m15 empty for now (your new model uses Daily + 1H + 5m).
      m15: [],
      h1: sliceCandlesUpTo(h1, atMs, 72).map((x) => ({
        timestamp: Number(x.ts),
        open: Number(x.o),
        high: Number(x.h),
        low: Number(x.l),
        close: Number(x.c),
        volume: Number(x.v ?? 0),
      })),
      d1: sliceCandlesUpTo(d1, atMs, 25).map((x) => ({
        timestamp: Number(x.ts),
        open: Number(x.o),
        high: Number(x.h),
        low: Number(x.l),
        close: Number(x.c),
        volume: Number(x.v ?? 0),
      })),
    },
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
- Hvis noe mangler i state, skriv "unknown (missing data)".
- Ikke referer til fremtidige candles.
- Tidssone: Europe/Oslo.

DATA:
- 5m live candle: state.open/high/low/close/time_ms
- Asia/Frankfurt: state.asia_high/asia_low/frankfurt_high/frankfurt_low
- HTF: state.htf_data.h1 (1H), state.htf_data.d1 (Daily)
- Daily (d1): nyeste candle kan være pågående. For D-1/D-2: bruk de to siste LUKKEDE daily candles.

WICK vs CLOSE:
- "taken/sweep" = wick beyond level is enough
- "break/acceptance" = close beyond level (wick alone doesn't count)

Språk:
- Output MUST follow the template headings.
- Answer in English (template is English).
- No RR, no lot size, no trade management.`;

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
    // Alive check
    if (req.method === "GET") return res.status(200).json({ ok: true, message: "webhook alive" });
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

    // Always store incoming TradingView payload (normal mode)
    const payload = req.body || {};
    const symbol = payload?.symbol || "unknown";
    const key = `last:${symbol}`;

    await upstashSet(key, payload, 172800);
    await upstashSet("latest:any", payload, 172800);

    // ─────────────────────────────
    // TESTMODE
    // ─────────────────────────────
    const test = String(req.query?.test || "").toLowerCase(); // "0900" or "0930"
    const datasetKey = String(req.query?.dataset || "").trim();
    const testSymbol = String(req.query?.symbol || symbol || "EURUSD").toUpperCase();

    if (test === "0900" || test === "0930") {
      let state = null;

      if (datasetKey) {
        const atMs = parseAtMsFromQuery(req);
        if (!atMs) return res.status(200).json({ ok: false, note: "Missing/invalid at or at_ms for dataset test" });

        const dataset = await upstashGet(datasetKey);
        if (!dataset) return res.status(200).json({ ok: false, note: `No dataset found for ${datasetKey}` });

        state = buildStateFromDataset(dataset, atMs);
      } else {
        state = await upstashGet(`last:${testSymbol}`);
        if (!state) return res.status(200).json({ ok: false, note: `No data for last:${testSymbol}` });
      }

      const prompt = test === "0900" ? build0900Prompt() : build0930Prompt();
      const answer = await callOpenAI({ prompt, state });

      const header = datasetKey
        ? `*TEST ${test.toUpperCase()} – ${testSymbol}*\n_${datasetKey}_`
        : `*TEST ${test.toUpperCase()} – ${testSymbol}*`;

      await sendTelegramMessage(`${header}\n\n${answer}`);
      return res.status(200).json({ ok: true, test: true, which: test, symbol: testSymbol, dataset: datasetKey || null });
    }

    // ─────────────────────────────
    // Normal scheduler (09:00 / 09:30) based on payload.time_ms
    // ─────────────────────────────
    const timeMs = payload?.time_ms;
    if (typeof timeMs !== "number") {
      return res.status(200).json({ ok: true, stored: true, key, note: "No time_ms in payload; skipped scheduled alerts." });
    }

    const t = getOsloPartsFromMs(timeMs);
    const dateKey = `${t.yyyy}-${String(t.mm).padStart(2, "0")}-${String(t.dd).padStart(2, "0")}`;

    const is0900 = (t.hh === 9 && t.min === 0);
    const is0930 = (t.hh === 9 && t.min === 30);

    if (is0900 || is0930) {
      const sentKey = `sent:${symbol}:${dateKey}:${is0900 ? "0900" : "0930"}`;
      const already = await upstashGet(sentKey);

      if (!already) {
        const prompt = is0900 ? build0900Prompt() : build0930Prompt();
        const answer = await callOpenAI({ prompt, state: payload });

        const header = is0900 ? `*09:00 London-forberedelse – ${symbol}*` : `*09:30 London update – ${symbol}*`;
        await sendTelegramMessage(`${header}\n\n${answer}`);

        await upstashSet(sentKey, { sent: true, at_ms: timeMs }, 172800);
      }
    }

    return res.status(200).json({ ok: true, stored: true, key, received_symbol: symbol });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Server error", details: String(err?.message || err) });
  }
}
