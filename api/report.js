const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SYMBOL = "EUR/USD";

// TwelveData is returning datetimes ~+10 hours vs Oslo in your setup.
// We correct it here so everything downstream (Asia/London windows) matches Oslo time.
const TIME_SHIFT_HOURS = -10; // 10:20 -> 00:20

function pad2(n) {
  return String(n).padStart(2, "0");
}

function shiftDatetimeString(dtStr, shiftHours) {
  // dtStr formats:
  // - intraday: "YYYY-MM-DD HH:MM:SS"
  // - daily:    "YYYY-MM-DD"
  const s = String(dtStr || "").trim();
  if (!s) return s;

  if (!s.includes(" ")) {
    // daily candle date only: leave as-is
    return s;
  }

  const [datePart, timePart] = s.split(" ");
  const [Y, M, D] = datePart.split("-").map((x) => parseInt(x, 10));
  const [hh, mm, ss] = timePart.split(":").map((x) => parseInt(x, 10));

  // Treat as "floating" time and shift wall-clock hours safely using UTC arithmetic
  const t = Date.UTC(Y, M - 1, D, hh, mm, ss || 0);
  const shifted = new Date(t + shiftHours * 3600 * 1000);

  const y2 = shifted.getUTCFullYear();
  const m2 = pad2(shifted.getUTCMonth() + 1);
  const d2 = pad2(shifted.getUTCDate());
  const h2 = pad2(shifted.getUTCHours());
  const min2 = pad2(shifted.getUTCMinutes());
  const s2 = pad2(shifted.getUTCSeconds());

  return `${y2}-${m2}-${d2} ${h2}:${min2}:${s2}`;
}

async function fetchTwelveData(interval, outputsize, apiKey) {
  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(SYMBOL)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${encodeURIComponent(String(outputsize))}` +
    `&apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.values) {
    throw new Error("TwelveData response: " + JSON.stringify(data));
  }

  // newest->oldest => reverse to oldest->newest
  const values = data.values.reverse();

  // Shift intraday datetimes into Oslo-aligned wall-clock time
  return values.map((c) => ({
    ...c,
    datetime: shiftDatetimeString(c.datetime, TIME_SHIFT_HOURS),
  }));
}

function mergeByDatetime(existing, incoming) {
  const map = new Map();
  for (const c of Array.isArray(existing) ? existing : []) map.set(c.datetime, c);
  for (const c of Array.isArray(incoming) ? incoming : []) map.set(c.datetime, c);

  return Array.from(map.values()).sort((a, b) =>
    a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0
  );
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

  if (strongClose && !insideDay && !overlapRegime) {
    score = 3;
  } else {
    const score2band =
      (closePos >= 0.55 && closePos < 0.60) || (closePos > 0.40 && closePos <= 0.45);

    if (score2band) score = 2;
    else if (strongClose && (insideDay || overlapRegime)) score = 2;
    else if (!midClose && !overlapRegime && !insideDay) score = 2;
    else score = 1;
  }

  const trade = score === 1 ? "No" : "Yes";

  return {
    ok: true,
    d1,
    d2,
    closePos,
    insideDay,
    overlapRegime,
    overlapPct,
    score,
    trade,
    baseBias,
  };
}

function compute0800to0900(m5Candles) {
  if (!Array.isArray(m5Candles) || m5Candles.length === 0) return "N/A";

  const inWindow = m5Candles.filter((c) => String(c.datetime || "").includes(" 08:"));
  if (inWindow.length === 0) return "N/A";

  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];

  if (first.open == null || last.close == null) return "N/A";
  return `Open ${first.open} → Close ${last.close}`;
}

module.exports = async (req, res) => {
  try {
    const twelveKey = process.env.TWELVEDATA_API_KEY;
    if (!twelveKey) {
      return res.status(500).json({ error: "Missing TWELVEDATA_API_KEY in env" });
    }

    // 1) Refresh 1D (daily has date-only, we keep as-is)
    const existing1D = await redis.get("candles:EURUSD:1D");
    const latest1D_raw = await (async () => {
      const url =
        `https://api.twelvedata.com/time_series` +
        `?symbol=${encodeURIComponent(SYMBOL)}` +
        `&interval=1day` +
        `&outputsize=120` +
        `&apikey=${encodeURIComponent(twelveKey)}`;

      const r = await fetch(url);
      const d = await r.json();
      if (!d.values) throw new Error("TwelveData response: " + JSON.stringify(d));
      return d.values.reverse(); // oldest->newest
    })();

    const merged1D = mergeByDatetime(existing1D, latest1D_raw);
    const dailyKept = merged1D.slice(Math.max(0, merged1D.length - 120));
    await redis.set("candles:EURUSD:1D", dailyKept);

    // 2) Refresh 1H (shifted)
    const existing1H = await redis.get("candles:EURUSD:1H");
    const latest1H = await fetchTwelveData("1h", 600, twelveKey);
    const merged1H = mergeByDatetime(existing1H, latest1H);
    const h1Kept = merged1H.slice(Math.max(0, merged1H.length - 600));
    await redis.set("candles:EURUSD:1H", h1Kept);

    // 3) Refresh 5M (shifted) — defines "now"
    const existing5M = await redis.get("candles:EURUSD:5M");
    const latest5M = await fetchTwelveData("5min", 2500, twelveKey);
    const merged5M = mergeByDatetime(existing5M, latest5M);
    const m5Kept = merged5M.slice(Math.max(0, merged5M.length - 2500));
    await redis.set("candles:EURUSD:5M", m5Kept);

    const now = m5Kept.length ? m5Kept[m5Kept.length - 1].datetime : null;

    const dailyResult = computeDailyScoreAndBias(dailyKept);
    const bias09 = dailyResult.ok ? dailyResult.baseBias : "Ranging";
    const bias10 = dailyResult.ok ? dailyResult.baseBias : "Ranging";

    const m5ForWindow = m5Kept.slice(Math.max(0, m5Kept.length - 180));
    const candle0809 = compute0800to0900(m5ForWindow);

    const answerLines = [];
    answerLines.push("Basic");
    answerLines.push(`Dato, tid: ${now || "N/A"}`);
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
      answerLines.push(`Bias 09: ${bias09}`);
      answerLines.push(`Bias 10: ${bias10}`);
    }
    answerLines.push("London scenario: N/A");
    answerLines.push(`08:00–09:00 candle: ${candle0809}`);

    return res.status(200).json({
      ok: true,
      timeShiftHoursApplied: TIME_SHIFT_HOURS,
      now,
      counts: { d1: dailyKept.length, h1: h1Kept.length, m5: m5Kept.length },
      answer: answerLines.join("\n"),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
