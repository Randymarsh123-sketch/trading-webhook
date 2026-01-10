// /api/report.js  (REN v1.2)
// - Henter EUR/USD candles fra TwelveData: 1D, 1H, 5M (timezone=UTC)
// - Overskriver Upstash Redis keys: candles:EURUSD:1D / 1H / 5M
// - Daily bias fastsettes KUN fra daily candles (D-1 og D-2) og endres aldri intraday
// - Returnerer deterministisk v1.2-output (foreløpig uten Type A/B/C motor): Trade No + scenario "no trade (messy day)"
// - asof=YYYY-MM-DD påvirker kun valg av D-1/D-2 (daily). nowUtc/nowOslo er fortsatt live fra siste 5M-candle.

const { Redis } = require("@upstash/redis");

const SYMBOL = "EUR/USD";
const TZ_REQUEST = "UTC";
const OSLO_TZ = "Europe/Oslo";

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// ---------- time helpers ----------
function parseUtcDatetimeToMs(dtStr) {
  const s = String(dtStr || "").trim();
  if (!s) return null;

  if (s.includes(" ")) {
    const [datePart, timePart] = s.split(" ");
    const [Y, M, D] = datePart.split("-").map((x) => parseInt(x, 10));
    const [hh, mm, ss] = timePart.split(":").map((x) => parseInt(x, 10));
    if (!Number.isFinite(Y) || !Number.isFinite(M) || !Number.isFinite(D)) return null;
    return Date.UTC(Y, M - 1, D, hh || 0, mm || 0, ss || 0);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [Y, M, D] = s.split("-").map((x) => parseInt(x, 10));
    if (!Number.isFinite(Y) || !Number.isFinite(M) || !Number.isFinite(D)) return null;
    return Date.UTC(Y, M - 1, D, 0, 0, 0);
  }

  return null;
}

function formatMsInTz(ms, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(new Date(ms));
  const obj = {};
  for (const p of parts) if (p.type !== "literal") obj[p.type] = p.value;
  return `${obj.year}-${obj.month}-${obj.day} ${obj.hour}:${obj.minute}:${obj.second}`;
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function utcDateKeyFromMs(ms) {
  const d = new Date(ms);
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, "0");
  const D = String(d.getUTCDate()).padStart(2, "0");
  return `${Y}-${M}-${D}`;
}

// ---------- TwelveData fetch ----------
async function tdFetchCandles(interval, outputsize) {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) throw new Error("Missing TWELVEDATA_API_KEY");

  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&timezone=${encodeURIComponent(TZ_REQUEST)}` +
    `&format=JSON&apikey=${encodeURIComponent(apiKey)}`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`TwelveData HTTP ${r.status} for ${interval}`);
  const j = await r.json();

  if (!j || !Array.isArray(j.values)) {
    throw new Error(`Bad TwelveData payload for ${interval}`);
  }
  return { values: j.values, meta: j.meta || null };
}

// ---------- Daily bias (v1.2) ----------
// Bias from daily candles ONLY. Use D-1 and D-2.
// We compute bias from D-1 close position in D-1 range:
// - close_position = (close - low) / (high - low)
// - >=0.60 => Bullish
// - <=0.40 => Bearish
// - else   => Ranging
function computeBiasFromDailyD1(d1) {
  const h = toNum(d1?.high);
  const l = toNum(d1?.low);
  const c = toNum(d1?.close);

  if (h == null || l == null || c == null) {
    return { bias: "Ranging", closePos: null, reason: "missing_daily_fields" };
  }

  const range = h - l;
  if (!(range > 0)) {
    return { bias: "Ranging", closePos: null, reason: "invalid_daily_range" };
  }

  const closePos = (c - l) / range;

  if (closePos >= 0.6) return { bias: "Bullish", closePos, reason: "close_pos>=0.60" };
  if (closePos <= 0.4) return { bias: "Bearish", closePos, reason: "close_pos<=0.40" };
  return { bias: "Ranging", closePos, reason: "0.40<close_pos<0.60" };
}

// Choose D-1 and D-2 from TwelveData daily list (usually latest-first).
// - If asof=YYYY-MM-DD: pick that date as D-1 and next candle as D-2.
// - Else: pick latest candle whose UTC date is STRICTLY before nowUtc date as D-1 (yesterday in UTC),
//         and next candle after it as D-2.
function pickD1D2(dailyValues, nowUtcStr, asof) {
  if (!Array.isArray(dailyValues) || dailyValues.length < 2) {
    return { d1: null, d2: null, pickedMode: "none" };
  }

  if (asof) {
    const idx = dailyValues.findIndex((c) => String(c?.datetime || "").startsWith(asof));
    if (idx >= 0 && dailyValues[idx + 1]) {
      return { d1: dailyValues[idx], d2: dailyValues[idx + 1], pickedMode: "asof" };
    }
    return { d1: dailyValues[0], d2: dailyValues[1], pickedMode: "asof_not_found_fallback_latest" };
  }

  const nowMs = parseUtcDatetimeToMs(nowUtcStr);
  if (nowMs == null) {
    return { d1: dailyValues[0], d2: dailyValues[1], pickedMode: "now_invalid_fallback_latest" };
  }

  const nowDateKey = utcDateKeyFromMs(nowMs);

  for (let i = 0; i < dailyValues.length; i++) {
    const dt = String(dailyValues[i]?.datetime || "");
    if (!dt) continue;
    const ms = parseUtcDatetimeToMs(dt);
    if (ms == null) continue;
    const dayKey = utcDateKeyFromMs(ms);

    // pick first daily candle strictly before "today" (UTC)
    if (dayKey < nowDateKey && dailyValues[i + 1]) {
      return { d1: dailyValues[i], d2: dailyValues[i + 1], pickedMode: "latest_closed_before_today_utc" };
    }
  }

  // fallback
  return { d1: dailyValues[0], d2: dailyValues[1], pickedMode: "fallback_latest" };
}

// ---------- Output (v1.2 only) ----------
const ALLOWED_SCENARIOS = new Set([
  "slightly up first → then price down",
  "slightly down first → then price up",
  "range / back and forth",
  "double tap → mean reversion",
  "no trade (messy day)",
]);

function makeV12Output({ trade, bias, scenario }) {
  const b = ["Bullish", "Bearish", "Ranging"].includes(bias) ? bias : "Ranging";
  const sc = ALLOWED_SCENARIOS.has(scenario) ? scenario : "no trade (messy day)";
  return {
    trade: trade === "Yes" ? "Yes" : "No",
    bias09: b,
    bias10: b,
    londonScenario: sc,
  };
}

// ---------- Handler ----------
module.exports = async function handler(req, res) {
  try {
    const asof = typeof req.query.asof === "string" ? req.query.asof.trim() : null;

    // Fetch candles
    const [d1Resp, h1Resp, m5Resp] = await Promise.all([
      tdFetchCandles("1day", 400),
      tdFetchCandles("1h", 1500),
      tdFetchCandles("5min", 5000),
    ]);

    const daily = d1Resp.values;
    const h1 = h1Resp.values;
    const m5 = m5Resp.values;

    // nowUtc from latest 5m candle (as per your current system)
    const nowUtcStr = String(m5?.[0]?.datetime || "").trim();
    const nowMs = parseUtcDatetimeToMs(nowUtcStr);
    const nowOslo = nowMs != null ? formatMsInTz(nowMs, OSLO_TZ) : null;

    // Store (overwrite)
    await Promise.all([
      redis.set("candles:EURUSD:1D", daily),
      redis.set("candles:EURUSD:1H", h1),
      redis.set("candles:EURUSD:5M", m5),
    ]);

    // Pick D-1/D-2 and compute bias
    const { d1, d2, pickedMode } = pickD1D2(daily, nowUtcStr, asof);
    const { bias, closePos, reason } = computeBiasFromDailyD1(d1);

    // v1.2 engine not implemented yet => deterministic placeholder:
    // - Trade: No
    // - Scenario: no trade (messy day)
    const out = makeV12Output({
      trade: "No",
      bias,
      scenario: "no trade (messy day)",
    });

    res.status(200).json({
      ok: true,
      version: "v1.2",
      symbol: "EURUSD",
      timezoneRequestedFromTwelveData: TZ_REQUEST,

      nowUtc: nowUtcStr || null,
      nowOslo: nowOslo,

      // v1.2 output (ONLY these fields are meant to be consumed)
      ...out,

      // debug (safe to keep; not part of v1.2 output contract)
      debug: {
        asofUsed: asof || null,
        pickedDailyMode: pickedMode,
        d1: d1?.datetime || null,
        d2: d2?.datetime || null,
        d1ClosePos: closePos,
        d1Reason: reason,
        counts: { d1: daily.length, h1: h1.length, m5: m5.length },
      },
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
};
