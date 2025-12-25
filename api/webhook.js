// api/webhook.js
// Stores TradingView payload in Upstash (last:SYMBOL + latest:any)
// Sends 09:00 and 09:30 Telegram alerts (Europe/Oslo)
//
// TEST (dataset):
//   POST /api/webhook?test=0930&dataset=dataset:EURUSD:5d&at_ms=1734337800000
//
// INSPECT dataset:
//   GET  /api/webhook?inspect=1&dataset=dataset:EURUSD:5d

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

function sanitizeJsonStringNaN(s) {
  // Replace bare NaN tokens with null so JSON.parse won't fail.
  // This is safe here because NaN is not valid JSON anyway.
  return s.replace(/\bNaN\b/g, "null");
}

function safeParseUpstashResult(raw) {
  let x = raw;

  // Upstash can return JSON as string. But your string contains NaN -> invalid JSON.
  // If string, sanitize NaN -> null before parsing.
  for (let i = 0; i < 4; i++) {
    if (typeof x !== "string") break;

    let s = x.trim();

    // If it's a quoted JSON string, parse that first.
    if (s.startsWith('"') && s.endsWith('"')) {
      try {
        x = JSON.parse(s);
        continue;
      } catch {
        break;
      }
    }

    // If it looks like JSON, sanitize NaN then parse.
    if (
      (s.startsWith("{") && s.endsWith("}")) ||
      (s.startsWith("[") && s.endsWith("]"))
    ) {
      s = sanitizeJsonStringNaN(s);
      try {
        x = JSON.parse(s);
        continue;
      } catch {
        break;
      }
    }

    break;
  }

  return x;
}

async function upstashGet(key) {
  const raw = await upstashGetRaw(key);
  return safeParseUpstashResult(raw);
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

function normalizeTopKeys(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  for (const k of Object.keys(obj)) {
    const lk = String(k).toLowerCase();
    if (!(lk in out)) out[lk] = obj[k];
  }
  return out;
}

function toStdCandle(x) {
  const ts = Number(x?.ts ?? x?.timestamp ?? x?.time_ms ?? x?.time);
  const o = x?.o ?? x?.open;
  const h = x?.h ?? x?.high;
  const l = x?.l ?? x?.low;
  const c = x?.c ?? x?.close;
  const v = x?.v ?? x?.volume ?? 0;

  const on = Number(o);
  const hn = Number(h);
  const ln = Number(l);
  const cn = Number(c);
  const vn = Number(v);

  // allow nulls for resampling; but keep ts if valid
  return {
    ts,
    o: Number.isFinite(on) ? on : null,
    h: Number.isFinite(hn) ? hn : null,
    l: Number.isFinite(ln) ? ln : null,
    c: Number.isFinite(cn) ? cn : null,
    v: Number.isFinite(vn) ? vn : null,
  };
}

function findLastCandleAtOrBefore(arr, atMs) {
  let lo = 0,
    hi = arr.length - 1,
    ans = -1;
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
    const h = x?.h;
    if (!Number.isFinite(h)) continue;
    if (m === null || h > m) m = h;
  }
  return m;
}

function minLow(arr) {
  let m = null;
  for (const x of arr) {
    const l = x?.l;
    if (!Number.isFinite(l)) continue;
    if (m === null || l < m) m = l;
  }
  return m;
}

// --- Resample m1 -> m5 / h1 using fixed ms buckets (OK for testing) ---
function resampleFixedMs(m1, intervalMs) {
  const out = [];
  let curBucket = null;
  let cur = null;

  for (const r of m1) {
    const ts = r.ts;
    if (!Number.isFinite(ts)) continue;

    const bucket = Math.floor(ts / intervalMs) * intervalMs;
    if (curBucket === null || bucket !== curBucket) {
      if (cur) out.push(cur);
      curBucket = bucket;
      cur = { ts: bucket, o: null, h: null, l: null, c: null, v: 0 };
    }

    // skip rows that are totally null
    const o = r.o, h = r.h, l = r.l, c = r.c, v = r.v;
    const hasAny = Number.isFinite(o) || Number.isFinite(h) || Number.isFinite(l) || Number.isFinite(c);
    if (!hasAny) continue;

    // open = first finite o
    if (cur.o === null && Number.isFinite(o)) cur.o = o;

    // high/low
    if (Number.isFinite(h)) cur.h = cur.h === null ? h : Math.max(cur.h, h);
    if (Number.isFinite(l)) cur.l = cur.l === null ? l : Math.min(cur.l, l);

    // close = last finite c
    if (Number.isFinite(c)) cur.c = c;

    // volume sum
    if (Number.isFinite(v)) cur.v += v;
  }

  if (cur) out.push(cur);

  // keep only candles with o/h/l/c
  return out.filter((x) => Number.isFinite(x.ts) && Number.isFinite(x.o) && Number.isFinite(x.h) && Number.isFinite(x.l) && Number.isFinite(x.c));
}

// --- Build daily by Oslo date key (good enough for bias/testing) ---
function buildDailyOslo(m1) {
  const map = new Map();

  for (const r of m1) {
    if (!Number.isFinite(r.ts)) continue;
    const p = getOsloPartsFromMs(r.ts);
    const key = `${p.yyyy}-${String(p.mm).padStart(2, "0")}-${String(p.dd).padStart(2, "0")}`;

    let d = map.get(key);
    if (!d) {
      d = { ts: r.ts, o: null, h: null, l: null, c: null, v: 0, firstSeen: r.ts, lastSeen: r.ts };
      map.set(key, d);
    }

    d.firstSeen = Math.min(d.firstSeen, r.ts);
    d.lastSeen = Math.max(d.lastSeen, r.ts);

    const o = r.o, h = r.h, l = r.l, c = r.c, v = r.v;
    const hasAny = Number.isFinite(o) || Number.isFinite(h) || Number.isFinite(l) || Number.isFinite(c);
    if (!hasAny) continue;

    // daily open = first finite o by time
    if (d.o === null && Number.isFinite(o)) d.o = o;

    if (Number.isFinite(h)) d.h = d.h === null ? h : Math.max(d.h, h);
    if (Number.isFinite(l)) d.l = d.l === null ? l : Math.min(d.l, l);

    if (Number.isFinite(c)) d.c = c;

    if (Number.isFinite(v)) d.v += v;
  }

  const out = [];
  for (const [key, d] of map.entries()) {
    const ts = d.firstSeen; // timestamp representative
    out.push({ ts, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v, _key: key });
  }

  out.sort((a, b) => a.ts - b.ts);
  return out.filter((x) => Number.isFinite(x.o) && Number.isFinite(x.h) && Number.isFinite(x.l) && Number.isFinite(x.c));
}

function pickCandles(dataset) {
  const ds = normalizeTopKeys(dataset);

  const m5 = Array.isArray(ds.m5) ? ds.m5 : null;
  const h1 = Array.isArray(ds.h1) ? ds.h1 : (Array.isArray(ds.h60) ? ds.h60 : null);
  const d1 = Array.isArray(ds.d1) ? ds.d1 : (Array.isArray(ds.daily) ? ds.daily : null);
  const m1 = Array.isArray(ds.m1) ? ds.m1 : null;

  return { m1, m5, h1, d1 };
}

function buildStateFromDataset(dataset, atMs) {
  const ds = normalizeTopKeys(dataset);
  const symbol = ds?.meta?.symbol || ds?.symbol || "EURUSD";

  const picked = pickCandles(ds);

  // Normalize m1 if present
  const m1 = Array.isArray(picked.m1) ? picked.m1.map(toStdCandle).filter((x) => Number.isFinite(x.ts)) : null;

  // If m5/h1/d1 missing, build from m1 for testing
  let m5 = Array.isArray(picked.m5) ? picked.m5.map(toStdCandle).filter((x) => Number.isFinite(x.ts)) : null;
  let h1 = Array.isArray(picked.h1) ? picked.h1.map(toStdCandle).filter((x) => Number.isFinite(x.ts)) : null;
  let d1 = Array.isArray(picked.d1) ? picked.d1.map(toStdCandle).filter((x) => Number.isFinite(x.ts)) : null;

  if ((!m5 || !m5.length || !h1 || !h1.length || !d1 || !d1.length) && m1 && m1.length) {
    // Resample from m1
    if (!m5 || !m5.length) m5 = resampleFixedMs(m1, 5 * 60 * 1000);
    if (!h1 || !h1.length) h1 = resampleFixedMs(m1, 60 * 60 * 1000);
    if (!d1 || !d1.length) d1 = buildDailyOslo(m1);
  }

  if (!m5 || !m5.length) throw new Error("Dataset missing m5[] (and could not build from m1)");
  if (!h1 || !h1.length) throw new Error("Dataset missing h1[] (and could not build from m1)");
  if (!d1 || !d1.length) throw new Error("Dataset missing d1[] (and could not build from m1)");

  const idx5 = findLastCandleAtOrBefore(m5, atMs);
  if (idx5 < 0) throw new Error("No m5 candle at/before atMs in dataset");
  const last5 = m5[idx5];

  const t = getOsloPartsFromMs(atMs);
  const yyyy = t.yyyy,
    mm = t.mm,
    dd = t.dd;

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

  const system = `Follow the prompt strictly.
CRITICAL: Use ONLY numbers present in the provided state JSON. Do not guess levels.
If data is missing, write "unknown (missing data)".`;

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
    // INSPECT
    if (req.method === "GET") {
      const inspect = String(req.query?.inspect || "") === "1";
      const datasetKey = String(req.query?.dataset || "").trim();

      if (inspect && datasetKey) {
        const raw = await upstashGetRaw(datasetKey);
        const parsed = safeParseUpstashResult(raw);
        const ds = normalizeTopKeys(parsed);
        const picked = pickCandles(ds);

        return res.status(200).json({
          ok: true,
          inspect: true,
          dataset_key: datasetKey,
          raw_type: raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw,
          parsed_type: parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed,
          top_keys: ds && typeof ds === "object" ? Object.keys(ds).slice(0, 50) : null,
          meta: ds?.meta || null,
          found: {
            has_m1: Array.isArray(picked.m1),
            has_m5: Array.isArray(picked.m5),
            has_h1: Array.isArray(picked.h1),
            has_d1: Array.isArray(picked.d1),
            m1_len: Array.isArray(picked.m1) ? picked.m1.length : 0,
            m5_len: Array.isArray(picked.m5) ? picked.m5.length : 0,
            h1_len: Array.isArray(picked.h1) ? picked.h1.length : 0,
            d1_len: Array.isArray(picked.d1) ? picked.d1.length : 0,
          },
        });
      }

      return res.status(200).json({ ok: true, message: "webhook alive" });
    }

    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

    // Store incoming TradingView payload anyway
    const payload = req.body || {};
    const symbol = payload?.symbol || "unknown";
    await upstashSet(`last:${symbol}`, payload, 172800);
    await upstashSet("latest:any", payload, 172800);

    // TESTMODE
    const test = String(req.query?.test || "").toLowerCase(); // "0930"
    const datasetKey = String(req.query?.dataset || "").trim();
    const testSymbol = String(req.query?.symbol || symbol || "EURUSD").toUpperCase();

    if (test === "0930") {
      if (!datasetKey) return res.status(200).json({ ok: false, note: "Missing dataset param" });

      const atMs = parseAtMsFromQuery(req);
      if (!atMs) return res.status(200).json({ ok: false, note: "Missing/invalid at or at_ms" });

      const dataset = await upstashGet(datasetKey);
      if (!dataset) return res.status(200).json({ ok: false, note: `No dataset found for ${datasetKey}` });

      const state = buildStateFromDataset(dataset, atMs);
      const answer = await callOpenAI({ prompt: build0930Prompt(), state });

      await sendTelegramMessage(`*TEST 0930 – ${testSymbol}*\n_${datasetKey}_\n\n${answer}`);
      return res.status(200).json({ ok: true, test: true, which: "0930", symbol: testSymbol, dataset: datasetKey });
    }

    return res.status(200).json({ ok: true, stored: true, note: "No test param; normal store only." });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Server error", details: String(err?.message || err) });
  }
}
