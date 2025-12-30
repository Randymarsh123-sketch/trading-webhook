const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SYMBOL = "EUR/USD";
const TD_TIMEZONE = "UTC"; // force UTC from TwelveData

function parseUtcDatetimeToMs(dtStr) {
  const s = String(dtStr || "").trim();
  if (!s || !s.includes(" ")) return null;
  const [datePart, timePart] = s.split(" ");
  const [Y, M, D] = datePart.split("-").map((x) => parseInt(x, 10));
  const [hh, mm, ss] = timePart.split(":").map((x) => parseInt(x, 10));
  return Date.UTC(Y, M - 1, D, hh || 0, mm || 0, ss || 0);
}

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

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function computeDailyScoreAndBiasFromTwo(d1, d2) {
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
  const overlapRegime = overlapPct >= 0.7;

  let baseBias = "Ranging";
  if (closePos >= 0.6) baseBias = "Bullish";
  else if (closePos <= 0.4) baseBias = "Bearish";

  const strongClose = closePos >= 0.6 || closePos <= 0.4;
  const midClose = closePos > 0.45 && closePos < 0.55;

  let score = 1;

  if (strongClose && !insideDay && !overlapRegime) score = 3;
  else {
    const score2band =
      (closePos >= 0.55 && closePos < 0.6) || (closePos > 0.4 && closePos <= 0.45);
    if (score2band) score = 2;
    else if (strongClose && (insideDay || overlapRegime)) score = 2;
    else if (!midClose && !overlapRegime && !insideDay) score = 2;
    else score = 1;
  }

  return {
    ok: true,
    score,
    trade: score === 1 ? "No" : "Yes",
    baseBias,
    closePos,
    insideDay,
    overlapRegime,
    overlapPct,
  };
}

function pickDailyIndexForAsof(dailyCandles, asofDateStr) {
  // dailyCandles datetime is like "YYYY-MM-DD"
  // We want the candle whose datetime == asof, else the last candle <= asof.
  const target = String(asofDateStr || "").trim();
  if (!target) return { ok: false, reason: "Empty asof" };

  let exactIdx = -1;
  for (let i = 0; i < dailyCandles.length; i++) {
    if (String(dailyCandles[i].datetime) === target) {
      exactIdx = i;
      break;
    }
  }
  if (exactIdx !== -1) return { ok: true, idx: exactIdx, mode: "exact" };

  // fallback: last <= asof
  let bestIdx = -1;
  for (let i = 0; i < dailyCandles.length; i++) {
    const dt = String(dailyCandles[i].datetime || "");
    if (dt && dt <= target) bestIdx = i;
  }
  if (bestIdx === -1) return { ok: false, reason: `No daily candle <= asof (${target})` };
  return { ok: true, idx: bestIdx, mode: "fallback_leq" };
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
    if (!twelveKey) return res.status(500).json({ error: "Missing TWELVEDATA_API_KEY in env" });

    const asof = req.query.asof ? String(req.query.asof).trim() : null;
    if (asof && !/^\d{4}-\d{2}-\d{2}$/.test(asof)) {
      return res.status(400).json({ error: 'Invalid asof. Use format YYYY-MM-DD, e.g. ?asof=2025-12-12' });
    }

    // Fetch fresh UTC series
    const latest1D = await fetchTwelveData("1day", 120, twelveKey);
    const latest1H = await fetchTwelveData("1h", 600, twelveKey);
    const latest5M = await fetchTwelveData("5min", 2500, twelveKey);

    // Overwrite Redis (removes old bad timestamps)
    await redis.set("candles:EURUSD:1D", latest1D);
    await redis.set("candles:EURUSD:1H", latest1H);
    await redis.set("candles:EURUSD:5M", latest5M);

    // Live "now" still based on latest 5m candle (UTC)
    const nowUtc = latest5M.length ? latest5M[latest5M.length - 1].datetime : null;
    const nowOslo = nowUtc ? formatMsInOslo(parseUtcDatetimeToMs(nowUtc)) : null;

    // DAILY BIAS: live mode uses last two candles.
    // If ?asof=YYYY-MM-DD is set, use that date as D-1 and the previous as D-2.
    let d1 = null;
    let d2 = null;
    let asofMode = null;

    if (!asof) {
      if (latest1D.length < 2) {
        return res.status(500).json({ error: "Not enough daily candles (need at least 2)" });
      }
      d1 = latest1D[latest1D.length - 1];
      d2 = latest1D[latest1D.length - 2];
      asofMode = "live";
    } else {
      const pick = pickDailyIndexForAsof(latest1D, asof);
      if (!pick.ok) return res.status(400).json({ error: pick.reason });
      if (pick.idx < 1) return res.status(400).json({ error: "asof resolves to the first candle; no D-2 available" });
      d1 = latest1D[pick.idx];
      d2 = latest1D[pick.idx - 1];
      asofMode = pick.mode;
    }

    const dailyResult = computeDailyScoreAndBiasFromTwo(d1, d2);

    const candle0809 = compute0800to0900_fromUTC(latest5M.slice(-180));

    const answerLines = [];
    answerLines.push("Basic");
    answerLines.push(`Dato, tid (Oslo): ${nowOslo || "N/A"}`);
    answerLines.push(`Dato, tid (UTC): ${nowUtc || "N/A"}`);
    if (asof) answerLines.push(`Daily test (asof): ${asof} (${asofMode})`);
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
      asof: asof || null,
      counts: { d1: latest1D.length, h1: latest1H.length, m5: latest5M.length },
      dailyDebug: dailyResult.ok
        ? {
            d1_datetime: d1.datetime,
            d2_datetime: d2.datetime,
            close_position: Number(dailyResult.closePos.toFixed(4)),
            inside_day: dailyResult.insideDay,
            overlap_regime: dailyResult.overlapRegime,
            overlap_pct_of_smaller_range: Number(dailyResult.overlapPct.toFixed(4)),
            score: dailyResult.score,
            trade: dailyResult.trade,
            base_bias: dailyResult.baseBias,
          }
        : { ok: false, reason: dailyResult.reason },
      answer: answerLines.join("\n"),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
