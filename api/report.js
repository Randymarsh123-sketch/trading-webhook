const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SYMBOL = "EUR/USD";
const TD_TIMEZONE = "UTC"; // IMPORTANT: force UTC from TwelveData for intraday correctness

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Parse "YYYY-MM-DD HH:MM:SS" as UTC
function parseUtcDatetimeToMs(dtStr) {
  const s = String(dtStr || "").trim();
  if (!s || !s.includes(" ")) return null;
  const [datePart, timePart] = s.split(" ");
  const [Y, M, D] = datePart.split("-").map((x) => parseInt(x, 10));
  const [hh, mm, ss] = timePart.split(":").map((x) => parseInt(x, 10));
  return Date.UTC(Y, M - 1, D, hh || 0, mm || 0, ss || 0);
}

// Format ms as Oslo local time string "YYYY-MM-DD HH:MM:SS"
function formatMsInOslo(ms) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
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

async function fetchTwelveData(interval, outputsize, apiKey) {
  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(SYMBOL)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${encodeURIComponent(String(outputsize))}` +
    `&timezone=${encodeURIComponent(TD_TIMEZONE)}` +
    `&apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
  const data = await res.json();
  if (!data.values) throw new Error("TwelveData response: " + JSON.stringify(data));
  return data.values.reverse(); // oldest->newest
}

function mergeByDatetime(existing, incoming) {
  const map = new Map();
  for (const c of Array.isArray(existing) ? existing : []) map.set(c.datetime, c);
  for (const c of Array.isArray(incoming) ? incoming : []) map.set(c.datetime, c);
  return Array.from(map.values()).sort((a, b) => (a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0));
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function computeDailyScoreAndBias(dailyCandles) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length < 2) {
    return { ok: false, reason: "Not enough daily candles for D-1/D-2" };
  }

  const d1 = dailyCandles[dailyCandles.length - 1];
  const d2 = dailyCandles[dailyCandles.length - 2];

  const d1High = toNum(d1.high);
  const d1Low = toNum(d1.low);
  const d1Close = toNum(d1.close);

  const d2High = toNum(d2.high);
  const d2Low = toNum(d2.low);

  const range = d1High - d1Low;
  if (!Number.isFinite(range) || range <= 0) return { ok: false, reason: "Invalid D-1 range" };

  const closePos = (d1Close - d1Low) / range;

  const insideDay = d1High <= d2High && d1Low >= d2Low;

  const overlap = Math.max(0, Math.min(d1High, d2High) - Math.max(d1Low, d2Low));
  const d2Range = d2High - d2Low;
  const minRange = Math.min(range, d2Range);
  const overlapPct = minRange > 0 ? overlap / minRange : 0;
  const overlapRegime = overlapPct >= 0.7;

  let baseBias = "Ranging";
  if (closePos >= 0.6) baseBias = "Bullish";
  else if (closePos <= 0.4) baseBias = "Bearish";

  const strongClose = closePos >= 0.6 || closePos <= 0.4;
  const midClose = closePos > 0.45 && closePos < 0.55;

  let score = 1;

  if (strongClose && !insideDay && !overlapRegime) score = 3;
  else {
    const score2band = (closePos >= 0.55 && closePos < 0.6) || (closePos > 0.4 && closePos <= 0.45);
    if (score2band) score = 2;
    else if (strongClose && (insideDay || overlapRegime)) score = 2;
    else if (!midClose && !overlapRegime && !insideDay) score = 2;
    else score = 1;
  }

  return { ok: true, score, trade: score === 1 ? "No" : "Yes", baseBias };
}

function compute0800to0900_fromUTC(m5CandlesLast180) {
  const withOslo = [];
  for (const c of Array.isArray(m5CandlesLast180) ? m5CandlesLast180 : []) {
    const ms = parseUtcDatetimeToMs(c.datetime);
    if (ms == null) continue;
    withOslo.push({ ...c, osloDatetime: formatMsInOslo(ms) });
  }

  const inWindow = withOslo.filter((c) => String(c.osloDatetime).includes(" 08:"));
  if (!inWindow.length) return "N/A";
  return `Open ${inWindow[0].open} → Close ${inWindow[inWindow.length - 1].close}`;
}

module.exports = async (req, res) => {
  try {
    const twelveKey = process.env.TWELVEDATA_API_KEY;
    if (!twelveKey) {
      return res.status(500).json({ error: "Missing TWELVEDATA_API_KEY in env" });
    }

    // Refresh candles from TwelveData (UTC)
    const latest1D = await fetchTwelveData("1day", 120, twelveKey);
    const latest1H = await fetchTwelveData("1h", 600, twelveKey);
    const latest5M = await fetchTwelveData("5min", 2500, twelveKey);

    // Merge/store (keep UTC datetime strings)
    const dailyKept = mergeByDatetime(await redis.get("candles:EURUSD:1D"), latest1D).slice(-120);
    const h1Kept = mergeByDatetime(await redis.get("candles:EURUSD:1H"), latest1H).slice(-600);
    const m5Kept = mergeByDatetime(await redis.get("candles:EURUSD:5M"), latest5M).slice(-2500);

    await redis.set("candles:EURUSD:1D", dailyKept);
    await redis.set("candles:EURUSD:1H", h1Kept);
    await redis.set("candles:EURUSD:5M", m5Kept);

    const nowUtc = m5Kept.length ? m5Kept[m5Kept.length - 1].datetime : null;
    const nowOslo = nowUtc ? formatMsInOslo(parseUtcDatetimeToMs(nowUtc)) : null;

    const dailyResult = computeDailyScoreAndBias(dailyKept);
    const candle0809 = compute0800to0900_fromUTC(m5Kept.slice(-180));

    const answerLines = [];
    answerLines.push("Basic");
    answerLines.push(`Dato, tid (Oslo): ${nowOslo || "N/A"}`);
    answerLines.push(`Dato, tid (UTC): ${nowUtc || "N/A"}`);
    answerLines.push("");
    answerLines.push("Del1 - Daily Bias");

    if (!dailyResult.ok) {
      answerLines.push("Score: N/A");
      answerLines.push("Trade: No");
      answerLines.push("Bias 09: Ranging");
      answerLines.push("Bias 10: Ranging");
    } else {
      answerLines.push(`Score: ${dailyResult.score}`);
      answerLines.push(`Trade: ${dailyResult.trade}`);
      answerLines.push(`Bias 09: ${dailyResult.baseBias}`);
      answerLines.push(`Bias 10: ${dailyResult.baseBias}`);
    }

    answerLines.push("London scenario: N/A");
    answerLines.push(`08:00–09:00 candle: ${candle0809}`);

    return res.status(200).json({
      ok: true,
      timezoneRequestedFromTwelveData: TD_TIMEZONE,
      nowUtc,
      nowOslo,
      counts: { d1: dailyKept.length, h1: h1Kept.length, m5: m5Kept.length },
      answer: answerLines.join("\n"),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
