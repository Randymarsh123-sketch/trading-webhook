// report.js
// v1.2.5 — REN MOTOR (orkestrator) for London 10–14 + STATUS MODE
//
// NEW in v1.2.5:
// - Supports deterministic "as-of time" via query params:
//   ?mode=status&asof=YYYY-MM-DD&at=HH:MM
//   Example:
//   https://trading-webhook-eight.vercel.app/api/report?mode=status&asof=2026-01-16&at=09:00
//
// Notes:
// - If (asof + at) is provided, we cut candles up to that Oslo time on that Oslo date.
// - When at is used, marketClosed is forced false (simulation), no Friday-lock/weekend logic.
// - All outputs deterministic given candle data.
//
// Sessions (Oslo time):
//   Asia: 02:00–06:59
//   Frankfurt: 07:00–08:59
//   London setup: 09:00–09:59
//   Payoff: 10:00–13:55
//
// Files expected in SAME /api folder (or updated require paths if you moved them):
// - ./daily_bias.js            (computeDailyBias)
// - ./10_14_biasplays.js       (runBiasPlays)
// - ./10_14_setups.js          (runSetups)
// - ./StatusMal.js             (buildStatusMal)

const OSLO_TZ = "Europe/Oslo";
const SYMBOL_TD = "EUR/USD";
const SYMBOL_OUT = "EURUSD";
const VERSION = "v1.2.5";

const { computeDailyBias } = require("./daily_bias");
const { runBiasPlays } = require("./10_14_biasplays");
const { runSetups } = require("./10_14_setups");
const { buildStatusMal } = require("./StatusMal");

// -------------------- Time helpers --------------------
function parseUtcDatetimeToMs(dtStr) {
  const s = String(dtStr || "").trim();
  if (!s) return null;

  // TwelveData often returns "YYYY-MM-DD HH:MM:SS"
  if (s.includes(" ")) {
    const [datePart, timePart] = s.split(" ");
    const [Y, M, D] = datePart.split("-").map((x) => parseInt(x, 10));
    const [hh, mm, ss] = timePart.split(":").map((x) => parseInt(x, 10));
    if (![Y, M, D].every(Number.isFinite)) return null;
    return Date.UTC(Y, M - 1, D, hh || 0, mm || 0, ss || 0);
  }

  // Or "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [Y, M, D] = s.split("-").map((x) => parseInt(x, 10));
    if (![Y, M, D].every(Number.isFinite)) return null;
    return Date.UTC(Y, M - 1, D, 0, 0, 0);
  }

  // Or ISO
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
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
  return formatMsInOslo(ms).slice(0, 10); // YYYY-MM-DD
}

function getOsloHHMM_fromMs(ms) {
  const osloStr = formatMsInOslo(ms);
  return osloStr.slice(11, 16); // HH:MM
}

function getOsloWeekday(ms) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: OSLO_TZ, weekday: "long" });
  return dtf.format(new Date(ms));
}

function isWeekendWeekdayName(weekday) {
  return weekday === "Saturday" || weekday === "Sunday";
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function parseHHMM(hhmm) {
  const s = String(hhmm || "").trim();
  if (!/^\d{2}:\d{2}$/.test(s)) return null;
  const hh = parseInt(s.slice(0, 2), 10);
  const mm = parseInt(s.slice(3, 5), 10);
  if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null;
  return { hh, mm, s };
}

function parseYYYYMMDD(dateStr) {
  const s = String(dateStr || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const Y = parseInt(s.slice(0, 4), 10);
  const M = parseInt(s.slice(5, 7), 10);
  const D = parseInt(s.slice(8, 10), 10);
  if (![Y, M, D].every(Number.isFinite)) return null;
  return { Y, M, D, s };
}

// Get timezone offset minutes for OSLO at a given UTC ms (e.g. GMT+1 => +60)
function getOsloOffsetMinutesAtUtcMs(msUtc) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: OSLO_TZ,
      timeZoneName: "shortOffset",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = dtf.formatToParts(new Date(msUtc));
    const tz = parts.find((p) => p.type === "timeZoneName")?.value || "";
    // Examples: "GMT+1", "GMT+2", "UTC", "GMT-5"
    const m = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/i);
    if (!m) {
      if (/UTC/i.test(tz) || /GMT/i.test(tz)) return 0;
      return null;
    }
    const sign = m[1] === "-" ? -1 : 1;
    const hh = parseInt(m[2], 10);
    const mm = m[3] ? parseInt(m[3], 10) : 0;
    return sign * (hh * 60 + mm);
  } catch {
    return null;
  }
}

// Convert an Oslo local datetime (YYYY-MM-DD + HH:MM) to a UTC ms timestamp.
function osloLocalToUtcMs(dateStr, hhmmStr) {
  const d = parseYYYYMMDD(dateStr);
  const t = parseHHMM(hhmmStr);
  if (!d || !t) return null;

  // Initial naive UTC guess
  let guessUtc = Date.UTC(d.Y, d.M - 1, d.D, t.hh, t.mm, 0);

  // Offset at guess
  const off1 = getOsloOffsetMinutesAtUtcMs(guessUtc);
  if (off1 == null) return null;

  // Adjust guess
  let utcMs = Date.UTC(d.Y, d.M - 1, d.D, t.hh, t.mm, 0) - off1 * 60000;

  // Re-check offset (DST boundary safety)
  const off2 = getOsloOffsetMinutesAtUtcMs(utcMs);
  if (off2 != null && off2 !== off1) {
    utcMs = Date.UTC(d.Y, d.M - 1, d.D, t.hh, t.mm, 0) - off2 * 60000;
  }

  return utcMs;
}

// -------------------- TwelveData fetch --------------------
async function tdFetchSeries(interval, outputsize) {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) throw new Error("Missing TWELVEDATA_API_KEY");

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(SYMBOL_TD)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${encodeURIComponent(String(outputsize))}` +
    `&timezone=UTC` +
    `&format=JSON` +
    `&apikey=${encodeURIComponent(apiKey)}`;

  const r = await fetch(url);
  const j = await r.json();

  if (!r.ok) {
    throw new Error(`TwelveData HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  }
  if (j.status && j.status !== "ok") {
    throw new Error(`TwelveData status=${j.status}: ${JSON.stringify(j).slice(0, 300)}`);
  }

  const values = Array.isArray(j.values) ? j.values : [];
  const candles = values
    .map((c) => ({
      datetime: c.datetime,
      open: toNum(c.open),
      high: toNum(c.high),
      low: toNum(c.low),
      close: toNum(c.close),
    }))
    .filter((c) => c.datetime && Number.isFinite(c.high) && Number.isFinite(c.low))
    .reverse();

  return { meta: j.meta || null, candles };
}

// -------------------- Optional Upstash KV write (best-effort) --------------------
async function kvSetJson(key, valueObj) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { ok: false, skipped: true, reason: "KV env missing" };

  try {
    const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(valueObj),
    });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// -------------------- Session slicing (Oslo time windows) --------------------
function sliceSessionRows(rowsSameDay, startHHMM, endHHMMInclusive) {
  return rowsSameDay.filter((r) => r.osloHHMM >= startHHMM && r.osloHHMM <= endHHMMInclusive);
}

function statsFromRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, count: 0 };

  let high = -Infinity;
  let low = Infinity;

  for (const r of rows) {
    if (Number.isFinite(r.high) && r.high > high) high = r.high;
    if (Number.isFinite(r.low) && r.low < low) low = r.low;
  }

  const open = rows[0].open;
  const close = rows[rows.length - 1].close;

  const range = Number.isFinite(high) && Number.isFinite(low) ? high - low : null;
  const rangePips = Number.isFinite(range) ? range / 0.0001 : null;

  const startMs = rows[0].ms;
  const endMs = rows[rows.length - 1].ms;

  return {
    ok: true,
    count: rows.length,
    high,
    low,
    rangePips,
    open: Number.isFinite(open) ? open : null,
    close: Number.isFinite(close) ? close : null,
    startMs,
    endMs,
    startOslo: formatMsInOslo(startMs),
    endOslo: formatMsInOslo(endMs),
  };
}

function buildSessions(rowsSameDay) {
  const asiaRows = sliceSessionRows(rowsSameDay, "02:00", "06:59");
  const ffRows = sliceSessionRows(rowsSameDay, "07:00", "08:59");
  const londonRows = sliceSessionRows(rowsSameDay, "09:00", "09:59");
  const payoffRows = sliceSessionRows(rowsSameDay, "10:00", "13:55");

  return {
    asia: { rows: asiaRows, stats: statsFromRows(asiaRows) },
    frankfurt: { rows: ffRows, stats: statsFromRows(ffRows) },
    londonSetup: { rows: londonRows, stats: statsFromRows(londonRows) },
    payoff: { rows: payoffRows, stats: statsFromRows(payoffRows) },
  };
}

// -------------------- Daily candle selection --------------------
function getDailyDateKey(candle) {
  const s = String(candle?.datetime || "").trim();
  if (!s) return null;
  if (s.includes(" ")) return s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = parseUtcDatetimeToMs(s);
  return ms ? new Date(ms).toISOString().slice(0, 10) : null;
}

function pickD1D2(dailyCandlesAsc, asofDate, osloDateUsed) {
  const arr = dailyCandlesAsc || [];
  if (arr.length < 2) return { ok: false, reason: "not_enough_daily_candles" };

  const dateTarget = asofDate || osloDateUsed;
  const dateTargetStr = String(dateTarget || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateTargetStr)) {
    return { ok: false, reason: "invalid_target_date", dateTargetStr };
  }

  let idx = -1;
  for (let i = 0; i < arr.length; i++) {
    const dk = getDailyDateKey(arr[i]);
    if (!dk) continue;
    if (dk <= dateTargetStr) idx = i;
  }

  if (idx < 1) return { ok: false, reason: "cannot_find_d1_d2", dateTargetStr };

  return {
    ok: true,
    d1: arr[idx],
    d2: arr[idx - 1],
    d1Key: getDailyDateKey(arr[idx]),
    d2Key: getDailyDateKey(arr[idx - 1]),
  };
}

// -------------------- Effective now (live) / Friday-lock --------------------
function computeLast5mUtc(candles5mAsc) {
  if (!Array.isArray(candles5mAsc) || candles5mAsc.length === 0) return null;
  const last = candles5mAsc[candles5mAsc.length - 1];
  return last?.datetime || null;
}

function detectFridayLockMs(candles5mAsc) {
  if (!Array.isArray(candles5mAsc) || candles5mAsc.length === 0) return null;

  let bestMs = null;
  for (const c of candles5mAsc) {
    const ms = parseUtcDatetimeToMs(c.datetime);
    if (ms == null) continue;
    const wd = getOsloWeekday(ms);
    if (wd === "Friday") bestMs = ms;
  }
  return bestMs;
}

function computeEffectiveNowLive({ candles5mAsc, staleThresholdMinutes }) {
  const last5mUtc = computeLast5mUtc(candles5mAsc);
  const last5mMs = parseUtcDatetimeToMs(last5mUtc);
  const nowServerMs = Date.now();

  let effectiveNowMs = last5mMs;
  let marketClosed = false;

  const weekdayServerOslo = getOsloWeekday(nowServerMs);
  const weekendByServer = isWeekendWeekdayName(weekdayServerOslo);

  const weekdayLastCandleOslo = last5mMs ? getOsloWeekday(last5mMs) : null;
  const weekendByLastCandle = weekdayLastCandleOslo ? isWeekendWeekdayName(weekdayLastCandleOslo) : false;

  const staleGapMinutes = Number.isFinite(last5mMs) ? Math.max(0, (nowServerMs - last5mMs) / 60000) : null;
  const staleThreshold = Number(staleThresholdMinutes || 60);

  if (weekendByServer || weekendByLastCandle) {
    const fridayLockMs = detectFridayLockMs(candles5mAsc);
    if (fridayLockMs != null) {
      effectiveNowMs = fridayLockMs;
      marketClosed = true;
      return {
        ok: true,
        engineMode: "live",
        last5mUtc,
        effectiveNowUtc: new Date(effectiveNowMs).toISOString().replace("T", " ").slice(0, 19),
        effectiveNowOslo: formatMsInOslo(effectiveNowMs),
        staleGapMinutes,
        staleThresholdMinutes: staleThreshold,
        weekendByServer,
        weekendByLastCandle,
        fridayLockUtc: new Date(fridayLockMs).toISOString().replace("T", " ").slice(0, 19),
        fridayLockOslo: formatMsInOslo(fridayLockMs),
        marketClosed,
        usedFridayLock: true,
      };
    }
    marketClosed = true;
  }

  if (staleGapMinutes != null && staleGapMinutes > staleThreshold) {
    marketClosed = true;
  }

  return {
    ok: true,
    engineMode: "live",
    last5mUtc,
    effectiveNowUtc: effectiveNowMs ? new Date(effectiveNowMs).toISOString().replace("T", " ").slice(0, 19) : null,
    effectiveNowOslo: effectiveNowMs ? formatMsInOslo(effectiveNowMs) : null,
    staleGapMinutes,
    staleThresholdMinutes: staleThreshold,
    weekendByServer,
    weekendByLastCandle,
    fridayLockUtc: null,
    fridayLockOslo: null,
    marketClosed,
    usedFridayLock: false,
  };
}

// -------------------- As-of (asof + at) cutoff --------------------
function pickEffectiveNowMsForAsOfAt(candles5mAsc, asofDate, atHHMM) {
  const d = parseYYYYMMDD(asofDate);
  const t = parseHHMM(atHHMM);
  if (!d || !t) return { ok: false, reason: "invalid_asof_or_at" };

  const targetUtcMs = osloLocalToUtcMs(d.s, t.s);
  if (targetUtcMs == null) return { ok: false, reason: "cannot_compute_target_utc_ms" };

  const targetDate = d.s;

  let bestMs = null;
  let bestUtcStr = null;

  for (const c of candles5mAsc) {
    const ms = parseUtcDatetimeToMs(c.datetime);
    if (ms == null) continue;
    if (ms > targetUtcMs) continue;
    if (getOsloDateKeyFromMs(ms) !== targetDate) continue;

    // pick latest <= target
    bestMs = ms;
    bestUtcStr = c.datetime;
  }

  if (bestMs == null) {
    return {
      ok: false,
      reason: "no_5m_candle_found_before_cutoff",
      targetDate,
      atHHMM: t.s,
    };
  }

  return {
    ok: true,
    engineMode: "asof_at",
    last5mUtc: computeLast5mUtc(candles5mAsc),
    effectiveNowUtc: bestUtcStr,
    effectiveNowOslo: formatMsInOslo(bestMs),
    effectiveNowMs: bestMs,
    targetUtcMs,
    targetOslo: `${targetDate} ${t.s}:00`,
    marketClosed: false,
  };
}

// -------------------- Rows preparation --------------------
function buildRowsSameDayAsOf(candles5mAsc, effectiveNowMs, osloDateUsed) {
  const out = [];
  for (const c of candles5mAsc) {
    const ms = parseUtcDatetimeToMs(c.datetime);
    if (ms == null) continue;
    if (effectiveNowMs != null && ms > effectiveNowMs) continue;
    if (getOsloDateKeyFromMs(ms) !== osloDateUsed) continue;

    out.push({
      ms,
      datetime: c.datetime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      osloHHMM: getOsloHHMM_fromMs(ms),
    });
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}

// -------------------- Time-gated phase (for status) --------------------
function getPhaseFromOsloHHMM(hhmm) {
  if (!hhmm || typeof hhmm !== "string") {
    return { phase: "UNKNOWN", phaseLabel: "Unknown", phaseGuidance: "No guidance.", nextCheck: null };
  }

  if (hhmm < "02:00") {
    return {
      phase: "PRE_ASIA",
      phaseLabel: "Pre-Asia",
      phaseGuidance: "Ingen handling. Systemet er designet for London 10–14.",
      nextCheck: "Sjekk igjen etter 07:05 for Frankfurt-data.",
    };
  }

  if (hhmm < "07:00") {
    return {
      phase: "ASIA",
      phaseLabel: "Asia pågår (02:00–06:59)",
      phaseGuidance: "Kun kontekst. Ingen entries. Logg Asia-range og struktur.",
      nextCheck: "Sjekk igjen etter 07:05 (Frankfurt åpnet).",
    };
  }

  if (hhmm < "09:00") {
    return {
      phase: "FRANKFURT",
      phaseLabel: "Frankfurt pågår (07:00–08:59)",
      phaseGuidance: "Kun kontekst. Ingen entries. Følg test av Asia high/low.",
      nextCheck: "Sjekk igjen 09:05–09:15 (London setup starter).",
    };
  }

  if (hhmm < "10:00") {
    return {
      phase: "LONDON_SETUP",
      phaseLabel: "London setup (09:00–09:59)",
      phaseGuidance: "KUN kvalifisering. Ingen entries før 10:00. Se etter sweep/return og clean structure.",
      nextCheck: "Sjekk igjen 09:45–09:59 før payoff åpner.",
    };
  }

  if (hhmm < "14:00") {
    return {
      phase: "PAYOFF",
      phaseLabel: "Payoff (10:00–14:00)",
      phaseGuidance: "Execution-vindu. Ikke let etter nye setups. Følg kun aktivt signal.",
      nextCheck: "Sjekk igjen rundt 13:50–13:55 (end-of-window).",
    };
  }

  return {
    phase: "POST_PAYOFF",
    phaseLabel: "Etter payoff (etter 14:00)",
    phaseGuidance: "Ingen nye trades. Klassifiser dagen og logg outcome.",
    nextCheck: "Kjør backtest/klassifisering om ønskelig.",
  };
}

// -------------------- Status builder --------------------
function buildStatusPacket({
  ok,
  version,
  symbol,
  engineMode,
  last5mUtc,
  effectiveNowUtc,
  effectiveNowOslo,
  trade,
  bias09,
  bias10,
  londonScenario,
  ctx,
  sessions,
  final,
  classification,
  executionPrompt,
}) {
  const asia = sessions?.asia?.stats || null;
  const ff = sessions?.frankfurt?.stats || null;
  const ld = sessions?.londonSetup?.stats || null;
  const po = sessions?.payoff?.stats || null;

  const lfs = final?.play === "LondonFirstSweep" ? final?.debug?.sweep || null : null;

  const hhmm = effectiveNowOslo && effectiveNowOslo.length >= 16 ? effectiveNowOslo.slice(11, 16) : null;
  const phaseObj = getPhaseFromOsloHHMM(hhmm);

  return {
    ok: !!ok,
    mode: "status",
    version,
    symbol,
    engineMode,

    last5mUtc,
    effectiveNowUtc,
    effectiveNowOslo,

    phase: phaseObj.phase,
    phaseLabel: phaseObj.phaseLabel,
    phaseGuidance: phaseObj.phaseGuidance,
    nextCheck: phaseObj.nextCheck,

    trade,
    play: final?.play || null,
    reason: final?.reason || null,
    bias09,
    bias10,
    londonScenario,

    executionPrompt: executionPrompt || null,

    marketClosed: !!ctx?.marketClosed,
    weekdayOslo: ctx?.weekdayOslo || null,
    osloDateUsed: ctx?.osloDateUsed || null,

    levels: {
      pdh: ctx?.pdh ?? null,
      pdl: ctx?.pdl ?? null,
    },

    sessions: {
      asia,
      frankfurt: ff,
      londonSetup: ld,
      payoff: po,
    },

    londonFirstSweep: lfs
      ? {
          levelName: lfs.levelName ?? null,
          level: lfs.level ?? null,
          sweepSide: lfs.sweepSide ?? null,
          sweepPips: lfs.sweepPips ?? null,
          extreme: lfs.extreme ?? null,
          osloHHMM: lfs.osloHHMM ?? null,
        }
      : null,

    classification,
  };
}

// -------------------- Main handler --------------------
module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    const modeParam = url.searchParams.get("mode") || "";
    const outputMode = modeParam === "status" ? "status" : "full";

    const asof = url.searchParams.get("asof"); // YYYY-MM-DD
    const at = url.searchParams.get("at");     // HH:MM (Oslo)

    const wantAsOfAt = !!(asof && at);

    // Fetch candles
    // - status: fetch ONLY (1day + 5min)
    // - full: fetch (1day + 1h + 5min)
    let d1Resp, h1Resp, m5Resp;

    if (outputMode === "status") {
      const [d1, m5] = await Promise.all([tdFetchSeries("1day", 500), tdFetchSeries("5min", 5000)]);
      d1Resp = d1;
      m5Resp = m5;
      h1Resp = { candles: [] };
    } else {
      const [d1, h1, m5] = await Promise.all([
        tdFetchSeries("1day", 500),
        tdFetchSeries("1h", 2000),
        tdFetchSeries("5min", 5000),
      ]);
      d1Resp = d1;
      h1Resp = h1;
      m5Resp = m5;
    }

    const dailyCandles = d1Resp.candles;
    const h1Candles = h1Resp.candles;
    const m5Candles = m5Resp.candles;

    // Best-effort store
    kvSetJson(`candles:${SYMBOL_OUT}:1D`, dailyCandles);
    kvSetJson(`candles:${SYMBOL_OUT}:5M`, m5Candles);
    if (outputMode !== "status") kvSetJson(`candles:${SYMBOL_OUT}:1H`, h1Candles);

    // Effective now selection:
    let engineMode = "live";
    let last5mUtc = computeLast5mUtc(m5Candles);
    let effectiveNowUtc = null;
    let effectiveNowOslo = null;
    let effectiveNowMs = null;

    // debug for asof+at
    let asofAtDebug = null;

    if (wantAsOfAt) {
      const cut = pickEffectiveNowMsForAsOfAt(m5Candles, asof, at);
      if (!cut.ok) {
        return res.status(200).json({
          ok: false,
          mode: outputMode === "status" ? "status" : "full",
          version: VERSION,
          symbol: SYMBOL_OUT,
          engineMode: "asof_at",
          error: "asof_at_cut_failed",
          debug: { asof, at, cut },
        });
      }

      engineMode = cut.engineMode;
      last5mUtc = cut.last5mUtc;
      effectiveNowUtc = cut.effectiveNowUtc;
      effectiveNowOslo = cut.effectiveNowOslo;
      effectiveNowMs = cut.effectiveNowMs;

      asofAtDebug = {
        asof,
        at,
        targetOslo: cut.targetOslo,
        targetUtcMs: cut.targetUtcMs,
      };
    } else {
      const eff = computeEffectiveNowLive({
        candles5mAsc: m5Candles,
        staleThresholdMinutes: 60,
      });

      engineMode = eff.engineMode;
      last5mUtc = eff.last5mUtc;
      effectiveNowUtc = eff.effectiveNowUtc;
      effectiveNowOslo = eff.effectiveNowOslo;
      effectiveNowMs = parseUtcDatetimeToMs(effectiveNowUtc);
    }

    const osloDateUsed =
      effectiveNowMs != null ? getOsloDateKeyFromMs(effectiveNowMs) : getOsloDateKeyFromMs(Date.now());
    const weekdayOslo =
      effectiveNowMs != null ? getOsloWeekday(effectiveNowMs) : getOsloWeekday(Date.now());

    // Build rows for day as-of effectiveNow
    const rowsSameDay = buildRowsSameDayAsOf(m5Candles, effectiveNowMs, osloDateUsed);
    const sessions = buildSessions(rowsSameDay);

    // Daily selection (use asof date if provided, else osloDateUsed)
    const pick = pickD1D2(dailyCandles, wantAsOfAt ? asof : null, osloDateUsed);
    if (!pick.ok) {
      if (outputMode === "status") {
        return res.status(200).json({
          ok: false,
          mode: "status",
          version: VERSION,
          symbol: SYMBOL_OUT,
          engineMode,
          error: "daily_pick_failed",
          debug: { asofUsed: wantAsOfAt ? asof : null, osloDateUsed, weekdayOslo, pick, asofAtDebug },
        });
      }

      return res.status(200).json({
        ok: false,
        version: VERSION,
        symbol: SYMBOL_OUT,
        timezoneRequestedFromTwelveData: "UTC",
        engineMode,
        error: "daily_pick_failed",
        debug: {
          asofUsed: wantAsOfAt ? asof : null,
          osloDateUsed,
          weekdayOslo,
          pick,
          asofAtDebug,
          counts: {
            d1: dailyCandles.length,
            h1: h1Candles.length,
            m5: m5Candles.length,
            m5SameDay: rowsSameDay.length,
          },
        },
      });
    }

    const D_1 = pick.d1;
    const D_2 = pick.d2;

    const daily = computeDailyBias(D_1, D_2);
    if (!daily.ok) {
      if (outputMode === "status") {
        return res.status(200).json({
          ok: false,
          mode: "status",
          version: VERSION,
          symbol: SYMBOL_OUT,
          engineMode,
          error: "daily_bias_failed",
          debug: { daily, asofAtDebug },
        });
      }

      return res.status(200).json({
        ok: false,
        version: VERSION,
        symbol: SYMBOL_OUT,
        timezoneRequestedFromTwelveData: "UTC",
        engineMode,
        error: "daily_bias_failed",
        debug: { daily, asofAtDebug },
      });
    }

    const PDH = toNum(D_1.high);
    const PDL = toNum(D_1.low);

    // marketClosed:
    // - live mode: as per live detection (stale/weekend/friday-lock)
    // - asof_at: forced false (simulation)
    const marketClosed = wantAsOfAt ? false : (function () {
      // recompute quickly from effectiveNowOslo and last candle gap is already handled in live helper;
      // we trust live helper result by re-running it once more isn't needed.
      // We'll infer from engineMode=live via weekday/weekend is already reflected in previous effectiveNow.
      // If it was Friday lock/weekend, effectiveNowOslo would be Friday and it would have returned marketClosed true.
      // BUT we didn't keep that flag here, so infer conservatively: marketClosed if weekend by server OR effectiveNow is on weekend.
      const wd = effectiveNowMs != null ? getOsloWeekday(effectiveNowMs) : null;
      return wd ? isWeekendWeekdayName(wd) : false;
    })();

    const ctx = {
      pdh: PDH,
      pdl: PDL,
      rowsSameDay,
      weekdayOslo,
      marketClosed,
      osloDateUsed,
    };

    // Run modules in locked order
    const biasPlay = runBiasPlays(daily, sessions, ctx);
    let final = biasPlay;

    if (biasPlay.trade !== "Yes") {
      final = runSetups(daily, sessions, ctx);
    }

    const trade = final.trade === "Yes" ? "Yes" : "No";
    const bias09 = String(final.bias09 || daily.bias09 || daily.baseBias || "Ranging");
    const bias10 = String(final.bias10 || daily.bias10 || daily.baseBias || "Ranging");
    const londonScenario = String(final.londonScenario || "no trade (messy day)");

    const classification =
      trade === "Yes"
        ? { type: String(final.play || "SIGNAL"), reason: String(final.reason || "signal") }
        : { type: "NO_TRADE", reason: String(final.reason || "no_signal") };

    const executionPrompt = buildStatusMal({
      effectiveNowMs,
      bias10,
      sessions,
      final,
      getOsloDateKeyFromMs,
      getOsloHHMM_fromMs,
    });

    if (outputMode === "status") {
      return res.status(200).json(
        buildStatusPacket({
          ok: true,
          version: VERSION,
          symbol: SYMBOL_OUT,
          engineMode,
          last5mUtc,
          effectiveNowUtc,
          effectiveNowOslo,
          trade,
          bias09,
          bias10,
          londonScenario,
          ctx,
          sessions,
          final,
          classification,
          executionPrompt,
        })
      );
    }

    return res.status(200).json({
      ok: true,
      version: VERSION,
      symbol: SYMBOL_OUT,
      timezoneRequestedFromTwelveData: "UTC",
      engineMode,

      last5mUtc,
      effectiveNowUtc,
      effectiveNowOslo,

      trade,
      bias09,
      bias10,
      londonScenario,

      executionPrompt,

      debug: {
        asofAtDebug,
        D_1: pick.d1Key,
        D_2: pick.d2Key,
        baseBias: daily.baseBias,
        baseBiasClosePos: daily.closePosition,
        PDH,
        PDL,
        osloDateUsed,
        weekdayOslo,

        classification,

        sessionStats: {
          asia: sessions.asia.stats,
          frankfurt: sessions.frankfurt.stats,
          londonSetup: sessions.londonSetup.stats,
          payoff: sessions.payoff.stats,
        },

        counts: {
          d1: dailyCandles.length,
          h1: h1Candles.length,
          m5: m5Candles.length,
          m5SameDay: rowsSameDay.length,
        },

        moduleDebug: {
          biasPlay: biasPlay?.debug || null,
          biasPlayReason: biasPlay?.reason || null,
          finalPlay: final?.play || null,
          finalReason: final?.reason || null,
          finalDebug: final?.debug || null,
        },
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      version: VERSION,
      symbol: SYMBOL_OUT,
      error: String(err?.message || err),
    });
  }
};
