// api/webhook.js
// Stores TradingView payload in Upstash (last:SYMBOL + latest:any)
// Sends 09:00 and 09:30 Telegram alerts (Europe/Oslo)
//
// TEST (recommended):
//   POST /api/webhook?test=0930&dataset=dataset:EURUSD:5d&at_ms=1734337800000
//
// INSPECT dataset shape (VERY IMPORTANT DEBUG):
//   GET  /api/webhook?inspect=1&dataset=dataset:EURUSD:5d
// This returns keys + where m5/h1/d1 were found.

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
  let result = data?.result ?? null;

  // Upstash REST can return JSON as a string (sometimes double-encoded).
  // Parse up to 3 times just in case.
  for (let i = 0; i < 3; i++) {
    if (typeof result !== "string") break;
    const s = result.trim();
    if (
      (s.startsWith("{") && s.endsWith("}")) ||
      (s.startsWith("[") && s.endsWith("]")) ||
      (s.startsWith('"') && s.endsWith('"'))
    ) {
      try {
        result = JSON.parse(s);
      } catch {
        break;
      }
    } else {
      break;
    }
  }

  return result;
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
  const atMsRaw = req.query?.at_ms;
  if (atMsRaw !== undefined) {
    const n = Number(atMsRaw);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }

  const at = String(req.query?.at || "").trim();
  if (!at) return null;

  const d = new Date(at);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return ms;
}

function findLastCandleAtOrBefore(arr, atMs) {
  let lo = 0,
    hi = arr.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Number(arr[mid]?.ts ?? arr[mid]?.timestamp ?? arr[mid]?.time_ms ?? arr[mid]?.time);
    if (Number.isFinite(t) && t <= atMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
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
    const h = Number(x?.h ?? x?.high);
    if (!Number.isFinite(h)) continue;
    if (m === null || h > m) m = h;
  }
  return m;
}

function minLow(arr) {
  let m = null;
  for (const x of arr) {
    const l = Number(x?.l ?? x?.low);
    if (!Number.isFinite(l)) continue;
    if (m === null || l < m) m = l;
  }
  return m;
}

// ---- Robust dataset extractors ----

function normalizeTopKeys(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  // also map uppercase keys to lowercase if needed
  for (const k of Object.keys(obj)) {
    const lk = String(k).toLowerCase();
    if (!(lk in out)) out[lk] = obj[k];
  }
  return out;
}

function tryGetCandlesFrom(obj, keyCandidates) {
  if (!obj || typeof obj !== "object") return null;
  const o = normalizeTopKeys(obj);

  for (const k of keyCandidates) {
    if (Array.isArray(o[k])) return { arr: o[k], path: k };
  }
  return null;
}

function pickDatasetCandles(dataset) {
  // Most common places
  const candidatesM5 = ["m5", "m5candles", "m5_candles", "candles_m5", "m5data", "m5_data"];
  const candidatesH1 = ["h1", "h1candles", "h1_candles", "candles_h1", "h1data", "h1_data", "h60", "m60", "hourly"];
  const candidatesD1 = ["d1", "d1candles", "d1_candles", "candles_d1", "d1data", "d1_data", "daily", "d"];

  // try top-level
  let m5 = tryGetCandlesFrom(dataset, candidatesM5);
  let h1 = tryGetCandlesFrom(dataset, candidatesH1);
  let d1 = tryGetCandlesFrom(dataset, candidatesD1);

  // try common nested keys
  const nestedKeys = ["data", "dataset", "payload", "store", "candles", "series"];
  if (!m5 || !h1 || !d1) {
    for (const nk of nestedKeys) {
      const nested = dataset?.[nk] ?? dataset?.[nk?.toUpperCase?.()];
      if (!nested || typeof nested !== "object") continue;
      m5 = m5 || tryGetCandlesFrom(nested, candidatesM5)?.arr ? { arr: nested?.m5 ?? nested?.M5 ?? nested?.m5candles ?? nested?.m5_candles, path: `${nk}.m5*` } : m5;
      h1 = h1 || tryGetCandlesFrom(nested, candidatesH1)?.arr ? { arr: nested?.h1 ?? nested?.H1 ?? nested?.h60 ?? nested?.m60 ?? nested?.hourly, path: `${nk}.h1*` } : h1;
      d1 = d1 || tryGetCandlesFrom(nested, candidatesD1)?.arr ? { arr: nested?.d1 ?? nested?.D1 ?? nested?.daily ?? nested?.d, path: `${nk}.d1*` } : d1;

      // fallback: use robust search
      if (!m5) m5 = tryGetCandlesFrom(nested, candidatesM5);
      if (!h1) h1 = tryGetCandlesFrom(nested, candidatesH1);
      if (!d1) d1 = tryGetCandlesFrom(nested, candidatesD1);
    }
  }

  // final fallback: deep search (limited)
  function deepFindArray(obj, wants) {
    const seen = new Set();
    const stack = [{ v: obj, p: "" }];
    while (stack.length) {
      const { v, p } = stack.pop();
      if (!v || typeof v !== "object") continue;
      if (seen.has(v)) continue;
      seen.add(v);

      const norm = normalizeTopKeys(v);
      const hit = tryGetCandlesFrom(norm, wants);
      if (hit) return { arr: hit.arr, path: p ? `${p}.${hit.path}` : hit.path };

      for (const k of Object.keys(norm)) {
        const child = norm[k];
        if (child && typeof child === "object") stack.push({ v: child, p: p ? `${p}.${k}` : k });
      }
    }
    return null;
  }

  if (!m5) m5 = deepFindArray(dataset, candidatesM5);
  if (!h1) h1 = deepFindArray(dataset, candidatesH1);
  if (!d1) d1 = deepFindArray(dataset, candidatesD1);

  return {
    m5,
    h1,
    d1,
  };
}

function toStdCandle(x) {
  // Accept both formats:
  //  - {ts,o,h,l,c,v}
  //  - {timestamp,open,high,low,close,volume}
  const ts = Number(x?.ts ?? x?.timestamp ?? x?.time_ms ?? x?.time);
  const o = Number(x?.o ?? x?.open);
  const h = Number(x?.h ?? x?.high);
  const l = Number(x?.l ?? x?.low);
  const c = Number(x?.c ?? x?.close);
  const v = Number(x?.v ?? x?.volume ?? 0);
  return { ts, o, h, l, c, v };
}

function buildStateFromDataset(dataset, atMs) {
  const symbol = dataset?.meta?.symbol || dataset?.symbol || "EURUSD";

  const picked = pickDatasetCandles(dataset);

  const m5Info = picked.m5;
  const h1Info = picked.h1;
  const d1Info = picked.d1;

  const m5Raw = m5Info?.arr;
  const h1Raw = h1Info?.arr;
  const d1Raw = d1Info?.arr;

  if (!Array.isArray(m5Raw) || m5Raw.length === 0) throw new Error("Dataset missing m5[]");
  if (!Array.isArray(h1Raw) || h1Raw.length === 0) throw new Error("Dataset missing h1[]");
  if (!Array.isArray(d1Raw) || d1Raw.length === 0) throw new Error("Dataset missing d1[]");

  // normalize candle objects
  const m5 = m5Raw.map(toStdCandle).filter((x) => Number.isFinite(x.ts));
  const h1 = h1Raw.map(toStdCandle).filter((x) => Number.isFinite(x.ts));
  const d1 = d1Raw.map(toStdCandle).filter((x) => Number.isFinite(x.ts));

  if (!m5.length) throw new Error("Dataset m5[] exists but timestamps are missing/invalid");
  if (!h1.length) throw new Error("Dataset h1[] exists but timestamps are missing/invalid");
  if (!d1.length) throw new Error("Dataset d1[] exists but timestamps are missing/invalid");

  const idx5 = findLastCandleAtOrBefore(m5, atMs);
  if (idx5 < 0) throw new Error("No m5 candle at/before atMs in dataset");
  const last5 = m5[idx5];

  const t = getOsloPartsFromMs(atMs);
  const yyyy = t.yyyy,
    mm = t.mm,
    dd = t.dd;

  // All m5 candles for this Oslo day
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

  const londonWindow = t.hh === 9 && t.min < 30;

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

// ===== PROMPTS =====
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
What is most likely scenario when it comes to Daily cycle? Judas Swing / Asian Break and Retest / Asian Whipsaw / Dead Frankfurt?`;
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
For example IF it does this, look out for THIS (daily cycle / bearish / bullish)`;
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
- 5m: state.open/high/low/close/time_ms
- Asia/Frankfurt: state.asia_high/asia_low/frankfurt_high/frankfurt_low
- HTF: state.htf_data.h1 (1H), state.htf_data.d1 (Daily)
- Daily (d1): bruk de to siste LUKKEDE daily candles for D-1/D-2 hvis mulig.

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
    // --- Inspect dataset (debug) ---
    // GET /api/webhook?inspect=1&dataset=dataset:EURUSD:5d
    if (req.method === "GET") {
      const inspect = String(req.query?.inspect || "") === "1";
      const datasetKey = String(req.query?.dataset || "").trim();
      if (inspect && datasetKey) {
        const dataset = await upstashGet(datasetKey);
        const picked = pickDatasetCandles(dataset);

        return res.status(200).json({
          ok: true,
          inspect: true,
          dataset_key: datasetKey,
          top_keys: dataset && typeof dataset === "object" ? Object.keys(dataset).slice(0, 200) : null,
          found: {
            m5_path: picked?.m5?.path || null,
            h1_path: picked?.h1?.path || null,
            d1_path: picked?.d1?.path || null,
            m5_len: Array.isArray(picked?.m5?.arr) ? picked.m5.arr.length : 0,
            h1_len: Array.isArray(picked?.h1?.arr) ? picked.h1.arr.length : 0,
            d1_len: Array.isArray(picked?.d1?.arr) ? picked.d1.arr.length : 0,
          },
        });
      }

      return res.status(200).json({ ok: true, message: "webhook alive" });
    }

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

    const is0900 = t.hh === 9 && t.min === 0;
    const is0930 = t.hh === 9 && t.min === 30;

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
