// api/webhook.js
// Stores TradingView payload in Upstash (last:SYMBOL + latest:any)
// Sends 09:00 and 09:30 Telegram alerts (Europe/Oslo)
//
// INSPECT dataset:
//   GET  /api/webhook?inspect=1&dataset=dataset:EURUSD:5d
// RAW INSPECT (shows what Upstash returns):
//   GET  /api/webhook?inspect_raw=1&dataset=dataset:EURUSD:5d

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

async function upstashGetRaw(key) {
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

function safeJsonParseMaybeTwice(val) {
  let x = val;
  for (let i = 0; i < 5; i++) {
    if (typeof x !== "string") break;
    const s = x.trim();
    if (
      (s.startsWith("{") && s.endsWith("}")) ||
      (s.startsWith("[") && s.endsWith("]")) ||
      (s.startsWith('"') && s.endsWith('"'))
    ) {
      try {
        x = JSON.parse(s);
      } catch {
        break;
      }
    } else {
      break;
    }
  }
  return x;
}

async function upstashGet(key) {
  const raw = await upstashGetRaw(key);
  return safeJsonParseMaybeTwice(raw);
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

// ---- robust dataset extraction (simple) ----
function normalizeTopKeys(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
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
  const candidatesM5 = ["m5", "m5candles", "m5_candles", "candles_m5", "m5data", "m5_data"];
  const candidatesH1 = ["h1", "h1candles", "h1_candles", "candles_h1", "h1data", "h1_data", "h60", "m60", "hourly"];
  const candidatesD1 = ["d1", "d1candles", "d1_candles", "candles_d1", "d1data", "d1_data", "daily", "d"];

  let m5 = tryGetCandlesFrom(dataset, candidatesM5);
  let h1 = tryGetCandlesFrom(dataset, candidatesH1);
  let d1 = tryGetCandlesFrom(dataset, candidatesD1);

  const nestedKeys = ["data", "dataset", "payload", "store", "candles", "series"];
  if (!m5 || !h1 || !d1) {
    for (const nk of nestedKeys) {
      const nested = dataset?.[nk] ?? dataset?.[nk?.toUpperCase?.()];
      if (!nested || typeof nested !== "object") continue;
      if (!m5) m5 = tryGetCandlesFrom(nested, candidatesM5);
      if (!h1) h1 = tryGetCandlesFrom(nested, candidatesH1);
      if (!d1) d1 = tryGetCandlesFrom(nested, candidatesD1);
    }
  }

  return { m5, h1, d1 };
}

function toStdCandle(x) {
  const ts = Number(x?.ts ?? x?.timestamp ?? x?.time_ms ?? x?.time);
  const o = Number(x?.o ?? x?.open);
  const h = Number(x?.h ?? x?.high);
  const l = Number(x?.l ?? x?.low);
  const c = Number(x?.c ?? x?.close);
  const v = Number(x?.v ?? x?.volume ?? 0);
  return { ts, o, h, l, c, v };
}

function findLastCandleAtOrBefore(arr, atMs) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Number(arr[mid]?.ts);
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

function buildStateFromDataset(dataset, atMs) {
  const symbol = dataset?.meta?.symbol || dataset?.symbol || "EURUSD";
  const picked = pickDatasetCandles(dataset);

  const m5Raw = picked?.m5?.arr;
  const h1Raw = picked?.h1?.arr;
  const d1Raw = picked?.d1?.arr;

  if (!Array.isArray(m5Raw) || m5Raw.length === 0) throw new Error("Dataset missing m5[]");
  if (!Array.isArray(h1Raw) || h1Raw.length === 0) throw new Error("Dataset missing h1[]");
  if (!Array.isArray(d1Raw) || d1Raw.length === 0) throw new Error("Dataset missing d1[]");

  const m5 = m5Raw.map(toStdCandle).filter((x) => Number.isFinite(x.ts));
  const h1 = h1Raw.map(toStdCandle).filter((x) => Number.isFinite(x.ts));
  const d1 = d1Raw.map(toStdCandle).filter((x) => Number.isFinite(x.ts));

  const idx5 = findLastCandleAtOrBefore(m5, atMs);
  if (idx5 < 0) throw new Error("No m5 candle at/before atMs in dataset");
  const last5 = m5[idx5];

  const t = getOsloPartsFromMs(atMs);
  const yyyy = t.yyyy, mm = t.mm, dd = t.dd;

  const m5SameDay = [];
  for (const c of m5) {
    const p = getOsloPartsFromMs(c.ts);
    if (p.yyyy === yyyy && p.mm === mm && p.dd === dd) m5SameDay.push(c);
  }

  const asiaCandles = m5SameDay.filter((c) => {
    const p = getOsloPartsFromMs(c.ts);
    return p.hh >= 2 && p.hh <= 6; // 02:00–06:59
  });

  const frCandles = m5SameDay.filter((c) => {
    const p = getOsloPartsFromMs(c.ts);
    return p.hh === 8; // 08:00–08:59
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

function build0930Prompt() {
  return `ALERT 09:30 (Europe/Oslo) – EURUSD Early-Cycle Decision Point

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

  const system = `Follow the prompt strictly.
CRITICAL: Use ONLY numbers present in the provided state JSON. Do not guess levels.`;

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
    if (req.method === "GET") {
      const datasetKey = String(req.query?.dataset || "").trim();

      // RAW inspect: show type + preview
      if (String(req.query?.inspect_raw || "") === "1" && datasetKey) {
        const raw = await upstashGetRaw(datasetKey);
        const parsed = safeJsonParseMaybeTwice(raw);

        const rawType = raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw;
        const parsedType = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;

        const rawPreview =
          typeof raw === "string" ? raw.slice(0, 400) :
          raw && typeof raw === "object" ? JSON.stringify(raw).slice(0, 400) :
          String(raw);

        const parsedPreview =
          typeof parsed === "string" ? parsed.slice(0, 400) :
          parsed && typeof parsed === "object" ? JSON.stringify(parsed).slice(0, 400) :
          String(parsed);

        return res.status(200).json({
          ok: true,
          inspect_raw: true,
          dataset_key: datasetKey,
          raw_type: rawType,
          parsed_type: parsedType,
          raw_preview_400: rawPreview,
          parsed_preview_400: parsedPreview,
        });
      }

      // structured inspect
      if (String(req.query?.inspect || "") === "1" && datasetKey) {
        const dataset = await upstashGet(datasetKey);
        const picked = pickDatasetCandles(dataset);

        return res.status(200).json({
          ok: true,
          inspect: true,
          dataset_key: datasetKey,
          dataset_type:
            dataset === null ? "null" : Array.isArray(dataset) ? "array" : typeof dataset,
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

    // store live payload anyway
    const payload = req.body || {};
    const symbol = payload?.symbol || "unknown";
    await upstashSet(`last:${symbol}`, payload, 172800);
    await upstashSet("latest:any", payload, 172800);

    const test = String(req.query?.test || "").toLowerCase();
    const datasetKey = String(req.query?.dataset || "").trim();
    const testSymbol = String(req.query?.symbol || symbol || "EURUSD").toUpperCase();

    if (test === "0930") {
      if (!datasetKey) return res.status(200).json({ ok: false, note: "Missing dataset param" });

      const atMs = parseAtMsFromQuery(req);
      if (!atMs) return res.status(200).json({ ok: false, note: "Missing/invalid at or at_ms for dataset test" });

      const dataset = await upstashGet(datasetKey);
      if (!dataset) return res.status(200).json({ ok: false, note: `No dataset found for ${datasetKey}` });

      const state = buildStateFromDataset(dataset, atMs);
      const answer = await callOpenAI({ prompt: build0930Prompt(), state });

      await sendTelegramMessage(`*TEST 0930 – ${testSymbol}*\n_${datasetKey}_\n\n${answer}`);
      return res.status(200).json({ ok: true, test: true, which: test, symbol: testSymbol, dataset: datasetKey });
    }

    return res.status(200).json({ ok: true, stored: true, note: "No test param; normal store only." });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Server error", details: String(err?.message || err) });
  }
}
