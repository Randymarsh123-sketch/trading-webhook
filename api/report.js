const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SYMBOL = "EUR/USD";
const TD_TIMEZONE = "UTC";
const OSLO_TZ = "Europe/Oslo";

// IMPORTANT: analysis files are now in repo root: /analysis (NOT under /api)
const del1_dailyBiasPromptBlock = require("../analysis/del1_dailyBias.js");
const { computeDel2Asia, del2_asiaRangePromptBlock } = require("../analysis/del2_asiaRange.js");
const { computeDel3Sessions, del3_dailyCyclesPromptBlock } = require("../analysis/del3_dailyCycles.js");

function parseUtcDatetimeToMs(dtStr) {
  const s = String(dtStr || "").trim();
  if (!s) return null;

  if (s.includes(" ")) {
    const [datePart, timePart] = s.split(" ");
    const [Y, M, D] = datePart.split("-").map((x) => parseInt(x, 10));
    const [hh, mm, ss] = timePart.split(":").map((x) => parseInt(x, 10));
    return Date.UTC(Y, M - 1, D, hh || 0, mm || 0, ss || 0);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [Y, M, D] = s.split("-").map((x) => parseInt(x, 10));
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

// NOTE: Del1 compute is still here for now because your del1 file is a prompt block (rules text).
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
    if (!twelveKey) return res.status(500).json({ error: "Missing TWELVEDATA_API_KEY in env" });

    // Fetch fresh UTC series
    const latest1D = await fetchTwelveData("1day", 120, twelveKey);
    const latest1H = await fetchTwelveData("1h", 600, twelveKey);
    const latest5M = await fetchTwelveData("5min", 2500, twelveKey);

    // Overwrite Redis completely
    await redis.set("candles:EURUSD:1D", latest1D);
    await redis.set("candles:EURUSD:1H", latest1H);
    await redis.set("candles:EURUSD:5M", latest5M);

    const nowUtc = latest5M.length ? latest5M[latest5M.length - 1].datetime : null;
    const nowOslo = nowUtc ? formatMsInOslo(parseUtcDatetimeToMs(nowUtc)) : null;

    const dailyResult = computeDailyScoreAndBias(latest1D);
    const candle0809 = compute0800to0900_fromUTC(latest5M.slice(-180));

    const { del2_asiaRange, del2_asiaBreak } = computeDel2Asia(latest5M, nowUtc);
    const del3_sessions = computeDel3Sessions(latest5M, nowUtc);

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

    answerLines.push("");
    answerLines.push("Del3 - Session Cycles (v0)");
    if (del3_sessions.ok) {
      answerLines.push(`Oslo date: ${del3_sessions.osloDate}`);
      for (const [k, v] of Object.entries(del3_sessions.sessions)) {
        if (v && v.ok) {
          answerLines.push(`${k}: High ${v.high} / Low ${v.low} (candles ${v.candlesCount})`);
        } else {
          answerLines.push(`${k}: N/A`);
        }
      }
    } else {
      answerLines.push(`N/A: ${del3_sessions.reason}`);
    }

    return res.status(200).json({
      ok: true,
      timezoneRequestedFromTwelveData: TD_TIMEZONE,
      nowUtc,
      nowOslo,
      counts: { d1: latest1D.length, h1: latest1H.length, m5: latest5M.length },
      answer: answerLines.join("\n"),

      del2_asiaRange,
      del2_asiaBreak,
      del3_sessions,

      prompts: {
        del1_dailyBias: del1_dailyBiasPromptBlock(),
        del2_asiaRange: del2_asiaRangePromptBlock(),
        del3_dailyCycles: del3_dailyCyclesPromptBlock(),
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
