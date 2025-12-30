const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SYMBOL = "EUR/USD";
const TD_TIMEZONE = "UTC";
const OSLO_TZ = "Europe/Oslo";

function parseUtcDatetimeToMs(dtStr) {
  const s = String(dtStr || "").trim();
  if (!s) return null;

  // TwelveData intraday: "YYYY-MM-DD HH:mm:ss"
  if (s.includes(" ")) {
    const [datePart, timePart] = s.split(" ");
    const [Y, M, D] = datePart.split("-").map((x) => parseInt(x, 10));
    const [hh, mm, ss] = timePart.split(":").map((x) => parseInt(x, 10));
    if (!Number.isFinite(Y) || !Number.isFinite(M) || !Number.isFinite(D)) return null;
    return Date.UTC(Y, M - 1, D, hh || 0, mm || 0, ss || 0);
  }

  // Daily can be "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [Y, M, D] = s.split("-").map((x) => parseInt(x, 10));
    if (!Number.isFinite(Y) || !Number.isFinite(M) || !Number.isFinite(D)) return null;
    return Date.UTC(Y, M - 1, D, 0, 0, 0);
  }

  return null;
}

function formatMsInOslo(ms) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: OSLO_TZ,
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

function getOsloDateKeyFromMs(ms) {
  return String(formatMsInOslo(ms)).slice(0, 10);
}

function getOsloHHMM_fromMs(ms) {
  const osloStr = formatMsInOslo(ms); // "YYYY-MM-DD HH:mm:ss"
  const hh = parseInt(osloStr.slice(11, 13), 10);
  const mm = parseInt(osloStr.slice(14, 16), 10);
  return { hh, mm, osloStr };
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

// ---------------------------
// DEL2 – Asia Range (02:00–06:59 Oslo)
// ---------------------------
function computeAsiaRange_0200_0659_Oslo(latest5M, nowUtcStr) {
  if (!Array.isArray(latest5M) || latest5M.length === 0) {
    return { ok: false, reason: "No 5M candles" };
  }
  const nowMs = parseUtcDatetimeToMs(nowUtcStr);
  if (nowMs == null) {
    return { ok: false, reason: "Invalid nowUtc for Asia range" };
  }

  const targetOsloDate = getOsloDateKeyFromMs(nowMs); // YYYY-MM-DD

  const windowStart = "02:00";
  const windowEnd = "06:59";

  const inWindow = [];

  for (const c of latest5M) {
    const ms = parseUtcDatetimeToMs(c.datetime);
    if (ms == null) continue;

    if (getOsloDateKeyFromMs(ms) !== targetOsloDate) continue;

    const { hh, mm } = getOsloHHMM_fromMs(ms);

    // 02:00–06:59 inclusive
    const afterStart = hh > 2 || (hh === 2 && mm >= 0);
    const beforeEnd = hh < 6 || (hh === 6 && mm <= 59);
    if (!afterStart || !beforeEnd) continue;

    const high = toNum(c.high);
    const low = toNum(c.low);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    inWindow.push({ ms, high, low });
  }

  if (!inWindow.length) {
    return {
      ok: false,
      reason: `No candles found in Asia window for Oslo date ${targetOsloDate}`,
      asiaDateOslo: targetOsloDate,
      windowOslo: { start: windowStart, end: windowEnd },
      candlesCount: 0,
    };
  }

  inWindow.sort((a, b) => a.ms - b.ms);

  let asiaHigh = -Infinity;
  let asiaLow = Infinity;

  for (const row of inWindow) {
    if (row.high > asiaHigh) asiaHigh = row.high;
    if (row.low < asiaLow) asiaLow = row.low;
  }

  const startMs = inWindow[0].ms;
  const endMs = inWindow[inWindow.length - 1].ms;

  return {
    ok: true,
    asiaDateOslo: targetOsloDate,
    windowOslo: { start: windowStart, end: windowEnd },
    candlesCount: inWindow.length,

    asiaHigh,
    asiaLow,
    asiaRange: asiaHigh - asiaLow,

    startTsUtc: new Date(startMs).toISOString(),
    endTsUtc: new Date(endMs).toISOString(),
    startTsOslo: formatMsInOslo(startMs),
    endTsOslo: formatMsInOslo(endMs),
  };
}

// ---------------------------
// DEL2 – First break after 07:00 Oslo
// Rules:
// - starting from 07:00 Oslo (same Oslo date), find first 5m candle where:
//   high > asiaHigh  => UP break (breakPrice = candle.high)
//   low  < asiaLow   => DOWN break (breakPrice = candle.low)
// - if both happen in same candle, we choose the one with larger distance beyond level
// ---------------------------
function computeAsiaBreakAfter0700_Oslo(latest5M, del2_asiaRange) {
  if (!del2_asiaRange || !del2_asiaRange.ok) {
    return { ok: false, reason: "Asia range not available" };
  }
  if (!Array.isArray(latest5M) || latest5M.length === 0) {
    return { ok: false, reason: "No 5M candles" };
  }

  const targetOsloDate = del2_asiaRange.asiaDateOslo;
  const asiaHigh = toNum(del2_asiaRange.asiaHigh);
  const asiaLow = toNum(del2_asiaRange.asiaLow);

  if (!Number.isFinite(asiaHigh) || !Number.isFinite(asiaLow)) {
    return { ok: false, reason: "Invalid asiaHigh/asiaLow" };
  }

  const checkedFromOslo = "07:00";

  for (const c of latest5M) {
    const ms = parseUtcDatetimeToMs(c.datetime);
    if (ms == null) continue;

    if (getOsloDateKeyFromMs(ms) !== targetOsloDate) continue;

    const { hh, mm, osloStr } = getOsloHHMM_fromMs(ms);

    // only from 07:00 onward
    const after0700 = hh > 7 || (hh === 7 && mm >= 0);
    if (!after0700) continue;

    const h = toNum(c.high);
    const l = toNum(c.low);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;

    const brokeUp = h > asiaHigh;
    const brokeDown = l < asiaLow;

    if (!brokeUp && !brokeDown) continue;

    // if both in same candle, pick the "stronger" break
    let breakDirection = "UP";
    let breakPrice = h;

    if (brokeUp && brokeDown) {
      const upDist = h - asiaHigh;
      const downDist = asiaLow - l;
      if (downDist > upDist) {
        breakDirection = "DOWN";
        breakPrice = l;
      } else {
        breakDirection = "UP";
        breakPrice = h;
      }
    } else if (brokeDown) {
      breakDirection = "DOWN";
      breakPrice = l;
    }

    return {
      ok: true,
      checkedFromOslo,
      breakDirection,
      breakPrice,
      breakTsOslo: osloStr,
      breakTsUtc: new Date(ms).toISOString(),
    };
  }

  return {
    ok: true,
    checkedFromOslo,
    breakDirection: "NONE",
  };
}

module.exports = async (req, res) => {
  try {
    const twelveKey = process.env.TWELVEDATA_API_KEY;
    if (!twelveKey) return res.status(500).json({ error: "Missing TWELVEDATA_API_KEY in env" });

    // Fetch fresh UTC series
    const latest1D = await fetchTwelveData("1day", 120, twelveKey);
    const latest1H = await fetchTwelveData("1h", 600, twelveKey);
    const latest5M = await fetchTwelveData("5min", 2500, twelveKey);

    // IMPORTANT: overwrite Redis completely for 1H/5M to remove old bad timestamps
    await redis.set("candles:EURUSD:1D", latest1D);
    await redis.set("candles:EURUSD:1H", latest1H);
    await redis.set("candles:EURUSD:5M", latest5M);

    const nowUtc = latest5M.length ? latest5M[latest5M.length - 1].datetime : null;
    const nowOslo = nowUtc ? formatMsInOslo(parseUtcDatetimeToMs(nowUtc)) : null;

    const dailyResult = computeDailyScoreAndBias(latest1D);
    const candle0809 = compute0800to0900_fromUTC(latest5M.slice(-180));

    // DEL2 range
    const del2_asiaRange = computeAsiaRange_0200_0659_Oslo(latest5M, nowUtc);

    // DEL2 break after 07:00
    const del2_asiaBreak = computeAsiaBreakAfter0700_Oslo(latest5M, del2_asiaRange);

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

    // Del2 output (range)
    answerLines.push("");
    answerLines.push("Del2 - Asia Range (02:00–06:59 Oslo)");
    if (del2_asiaRange.ok) {
      answerLines.push(`Asia Date (Oslo): ${del2_asiaRange.asiaDateOslo}`);
      answerLines.push(`Candles: ${del2_asiaRange.candlesCount}`);
      answerLines.push(`High: ${del2_asiaRange.asiaHigh}`);
      answerLines.push(`Low: ${del2_asiaRange.asiaLow}`);
      answerLines.push(`Range: ${del2_asiaRange.asiaRange}`);
      answerLines.push(`Start Oslo: ${del2_asiaRange.startTsOslo}`);
      answerLines.push(`End Oslo: ${del2_asiaRange.endTsOslo}`);
    } else {
      answerLines.push(`N/A: ${del2_asiaRange.reason}`);
    }

    // Del2 output (break)
    answerLines.push("");
    answerLines.push("Del2 - Asia Break after 07:00 (Oslo)");
    if (del2_asiaBreak.ok) {
      answerLines.push(`Checked from: ${del2_asiaBreak.checkedFromOslo}`);
      answerLines.push(`Break: ${del2_asiaBreak.breakDirection}`);
      if (del2_asiaBreak.breakDirection !== "NONE") {
        answerLines.push(`Break Price: ${del2_asiaBreak.breakPrice}`);
        answerLines.push(`Break Oslo: ${del2_asiaBreak.breakTsOslo}`);
        answerLines.push(`Break UTC: ${del2_asiaBreak.breakTsUtc}`);
      }
    } else {
      answerLines.push(`N/A: ${del2_asiaBreak.reason}`);
    }

    return res.status(200).json({
      ok: true,
      timezoneRequestedFromTwelveData: TD_TIMEZONE,
      nowUtc,
      nowOslo,
      counts: { d1: latest1D.length, h1: latest1H.length, m5: latest5M.length },
      answer: answerLines.join("\n"),

      // structured outputs
      del2_asiaRange,
      del2_asiaBreak,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
