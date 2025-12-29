const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SYMBOL = "EUR/USD";
const TD_TIMEZONE = "Europe/Oslo"; // <-- FORCE Oslo time for ALL returned datetimes

async function fetchTwelveData(interval, outputsize, apiKey) {
  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(SYMBOL)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${encodeURIComponent(String(outputsize))}` +
    `&timezone=${encodeURIComponent(TD_TIMEZONE)}` +
    `&apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.values) {
    throw new Error("TwelveData response: " + JSON.stringify(data));
  }

  // newest->oldest => reverse to oldest->newest
  return data.values.reverse();
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

  const inWindow = m5Candles.filter((c) => {
    const dt = String(c.datetime || "");
    return dt.includes(" 08:");
  });

  if (inWindow.length === 0) return "N/A";

  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];

  const o = first.open;
  const cl = last.close;

  if (o == null || cl == null) return "N/A";
  return `Open ${o} → Close ${cl}`;
}

module.exports = async (req, res) => {
  try {
    const twelveKey = process.env.TWELVEDATA_API_KEY;
    if (!twelveKey) {
      return res.status(500).json({ error: "Missing TWELVEDATA_API_KEY in env" });
    }

    // 1) Refresh 1D (timezone forced)
    const existing1D = await redis.get("candles:EURUSD:1D");
    const latest1D = await fetchTwelveData("1day", 120, twelveKey);
    const merged1D = mergeByDatetime(existing1D, latest1D);
    const dailyKept = merged1D.slice(Math.max(0, merged1D.length - 120));
    await redis.set("candles:EURUSD:1D", dailyKept);

    // 2) Refresh 1H (timezone forced)
    const existing1H = await redis.get("candles:EURUSD:1H");
    const latest1H = await fetchTwelveData("1h", 600, twelveKey);
    const merged1H = mergeByDatetime(existing1H, latest1H);
    const h1Kept = merged1H.slice(Math.max(0, merged1H.length - 600));
    await redis.set("candles:EURUSD:1H", h1Kept);

    // 3) Refresh 5M (timezone forced)
    const existing5M = await redis.get("candles:EURUSD:5M");
    const latest5M = await fetchTwelveData("5min", 2500, twelveKey);
    const merged5M = mergeByDatetime(existing5M, latest5M);
    const m5Kept = merged5M.slice(Math.max(0, merged5M.length - 2500));
    await redis.set("candles:EURUSD:5M", m5Kept);

    const now = m5Kept.length ? m5Kept[m5Kept.length - 1].datetime : null;

    const dailyResult = computeDailyScoreAndBias(dailyKept);

    let bias09 = dailyResult.ok ? dailyResult.baseBias : "Ranging";
    let bias10 = dailyResult.ok ? dailyResult.baseBias : "Ranging";

    const m5ForWindow = m5Kept.slice(Math.max(0, m5Kept.length - 180));
    const candle0809 = compute0800to0900(m5ForWindow);

    const londonScenario = "N/A";

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

    answerLines.push(`London scenario: ${londonScenario}`);
    answerLines.push(`08:00–09:00 candle: ${candle0809}`);

    const answer = answerLines.join("\n");

    return res.status(200).json({
      ok: true,
      timezone: TD_TIMEZONE,
      now,
      keys: {
        d1: "candles:EURUSD:1D",
        h1: "candles:EURUSD:1H",
        m5: "candles:EURUSD:5M",
      },
      counts: {
        d1: dailyKept.length,
        h1: h1Kept.length,
        m5: m5Kept.length,
      },
      dailyDebug: dailyResult.ok
        ? {
            d1_datetime: dailyResult.d1.datetime,
            d2_datetime: dailyResult.d2.datetime,
            close_position: Number(dailyResult.closePos.toFixed(4)),
            inside_day: dailyResult.insideDay,
            overlap_regime: dailyResult.overlapRegime,
            overlap_pct_of_smaller_range: Number(dailyResult.overlapPct.toFixed(4)),
          }
        : { ok: false, reason: dailyResult.reason },
      answer,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
