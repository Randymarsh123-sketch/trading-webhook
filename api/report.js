const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SYMBOL = "EUR/USD";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function parseDatetimeToUTCms(dtStr) {
  const s = String(dtStr || "").trim();
  if (!s) return null;

  if (!s.includes(" ")) {
    const [Y, M, D] = s.split("-").map((x) => parseInt(x, 10));
    if (!Y || !M || !D) return null;
    return Date.UTC(Y, M - 1, D, 0, 0, 0);
  }

  const [datePart, timePart] = s.split(" ");
  const [Y, M, D] = datePart.split("-").map((x) => parseInt(x, 10));
  const [hh, mm, ss] = timePart.split(":").map((x) => parseInt(x, 10));
  if (!Y || !M || !D) return null;
  return Date.UTC(Y, M - 1, D, hh || 0, mm || 0, ss || 0);
}

function formatUTCmsAsDatetime(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  const h = pad2(d.getUTCHours());
  const min = pad2(d.getUTCMinutes());
  const s = pad2(d.getUTCSeconds());
  return `${y}-${m}-${day} ${h}:${min}:${s}`;
}

// Oslo is UTC+1 in winter, UTC+2 in summer.
// For now (Dec 30) it's UTC+1. We'll compute offset dynamically using Intl.
function getOsloOffsetMinutes(date = new Date()) {
  // We compute offset by formatting date in Oslo and UTC, then comparing components.
  const dtfOslo = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const dtfUtc = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const partsToObj = (parts) => {
    const o = {};
    for (const p of parts) if (p.type !== "literal") o[p.type] = p.value;
    return o;
  };

  const o = partsToObj(dtfOslo.formatToParts(date));
  const u = partsToObj(dtfUtc.formatToParts(date));

  // build ms from the displayed wall times, interpret them as UTC, then diff
  const osloAsUTC = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second);
  const utcAsUTC = Date.UTC(+u.year, +u.month - 1, +u.day, +u.hour, +u.minute, +u.second);

  return Math.round((osloAsUTC - utcAsUTC) / 60000);
}

function getOsloNowRoundedTo5mUTCms() {
  const now = new Date();
  const offsetMin = getOsloOffsetMinutes(now); // minutes Oslo ahead of UTC
  const utcMs = now.getTime();
  const osloMs = utcMs + offsetMin * 60000;

  const roundedOsloMs = Math.floor(osloMs / (5 * 60000)) * (5 * 60000);

  // convert back to UTC ms for comparisons
  return roundedOsloMs - offsetMin * 60000;
}

async function fetchTwelveDataRaw(interval, outputsize, apiKey) {
  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(SYMBOL)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${encodeURIComponent(String(outputsize))}` +
    `&apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
  const data = await res.json();

  if (!data.values) {
    throw new Error("TwelveData response: " + JSON.stringify(data));
  }

  return data.values.reverse(); // oldest->newest
}

function mergeByDatetime(existing, incoming) {
  const map = new Map();
  for (const c of Array.isArray(existing) ? existing : []) map.set(c.datetime, c);
  for (const c of Array.isArray(incoming) ? incoming : []) map.set(c.datetime, c);

  return Array.from(map.values()).sort((a, b) =>
    a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0
  );
}

function filterNotAfter(candles, maxUtcMs) {
  const out = [];
  for (const c of Array.isArray(candles) ? candles : []) {
    const ms = parseDatetimeToUTCms(c.datetime);
    if (ms == null) continue;
    if (ms <= maxUtcMs) out.push(c);
  }
  return out;
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
  if (!Number.isFinite(range) || range <= 0) {
    return { ok: false, reason: "Invalid D-1 range" };
  }

  const closePos = (d1Close - d1Low) / range;
  const insideDay = d1High <= d2High && d1Low >= d2Low;

  const overlap = Math.max(0, Math.min(d1High, d2High) - Math.max(d1Low, d2Low));
  const d2Range = d2High - d2Low;
  const minRange = Math.min(range, d2Range);
  const overlapPct = minRange > 0 ? overlap / minRange : 0;
  const overlapRegime = overlapPct >= 0.70;

  let baseBias = "Ranging";
  if (closePos >= 0.60) baseBias = "Bullish";
  else if (closePos <= 0.40) baseBias = "Bearish";

  const strongClose = closePos >= 0.60 || closePos <= 0.40;
  const midClose = closePos > 0.45 && closePos < 0.55;

  let score = 1;
  if (strongClose && !insideDay && !overlapRegime) score = 3;
  else {
    const score2band =
      (closePos >= 0.55 && closePos < 0.60) || (closePos > 0.40 && closePos <= 0.45);
    if (score2band) score = 2;
    else if (strongClose && (insideDay || overlapRegime)) score = 2;
    else if (!midClose && !overlapRegime && !insideDay) score = 2;
    else score = 1;
  }

  return { ok: true, score, trade: score === 1 ? "No" : "Yes", baseBias };
}

function compute0800to0900(m5Candles) {
  const inWindow = (Array.isArray(m5Candles) ? m5Candles : []).filter((c) =>
    String(c.datetime || "").includes(" 08:")
  );
  if (!inWindow.length) return "N/A";
  return `Open ${inWindow[0].open} → Close ${inWindow[inWindow.length - 1].close}`;
}

module.exports = async (req, res) => {
  try {
    const twelveKey = process.env.TWELVEDATA_API_KEY;
    if (!twelveKey) return res.status(500).json({ error: "Missing TWELVEDATA_API_KEY" });

    const serverNowIso = new Date().toISOString();
    const osloNowRoundedUtcMs = getOsloNowRoundedTo5mUTCms();
    const osloNowRoundedStr = formatUTCmsAsDatetime(osloNowRoundedUtcMs);

    // Fetch raw
    const latest1D_raw = await fetchTwelveDataRaw("1day", 120, twelveKey);
    const latest1H_raw = await fetchTwelveDataRaw("1h", 600, twelveKey);
    const latest5M_raw = await fetchTwelveDataRaw("5min", 2500, twelveKey);

    // Filter out any candles "after now" (based on Oslo-rounded now)
    const latest1H = filterNotAfter(latest1H_raw, osloNowRoundedUtcMs);
    const latest5M = filterNotAfter(latest5M_raw, osloNowRoundedUtcMs);

    // Store merged
    const dailyKept = mergeByDatetime(await redis.get("candles:EURUSD:1D"), latest1D_raw).slice(-120);
    const h1Kept = mergeByDatetime(await redis.get("candles:EURUSD:1H"), latest1H).slice(-600);
    const m5Kept = mergeByDatetime(await redis.get("candles:EURUSD:5M"), latest5M).slice(-2500);

    await redis.set("candles:EURUSD:1D", dailyKept);
    await redis.set("candles:EURUSD:1H", h1Kept);
    await redis.set("candles:EURUSD:5M", m5Kept);

    const dailyResult = computeDailyScoreAndBias(dailyKept);

    const now = m5Kept.length ? m5Kept[m5Kept.length - 1].datetime : osloNowRoundedStr;

    const answerLines = [];
    answerLines.push("Basic");
    answerLines.push(`Dato, tid: ${now}`);
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
    answerLines.push(`08:00–09:00 candle: ${compute0800to0900(m5Kept.slice(-180))}`);

    return res.status(200).json({
      ok: true,
      debug: {
        serverNowIso,
        osloNowRoundedStr,
        rawNow5m: latest5M_raw.length ? latest5M_raw[latest5M_raw.length - 1].datetime : null,
        filteredNow5m: now,
        filtered5mCount: latest5M.length,
      },
      counts: { d1: dailyKept.length, h1: h1Kept.length, m5: m5Kept.length },
      answer: answerLines.join("\n"),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
