// report.js
// v1.2.3 — REN MOTOR (orkestrator) for London 10–14 + STATUS MODE (time-gated + less 429)
//
// NEW in v1.2.3:
// - mode=status is less 429 sensitive: fetches ONLY (1day + 5min). Skips 1h.
// - mode=status includes time-gated fields: phase, phaseLabel, phaseGuidance, nextCheck.
// - Keeps executionPrompt (one-block execution text) in both status + full output.
//
// Existing:
// - marketClosed/stale/weekend Friday-lock (LIVE mode)
// - backtest: ?mode=backtest&asof=YYYY-MM-DD (engine mode)
// - status: ?mode=status (output mode)
// - sessions sliced in Oslo time:
//   Asia: 02:00–06:59
//   Frankfurt: 07:00–08:59
//   London setup: 09:00–09:59
//   Payoff: 10:00–13:55
//
// Files expected in SAME /api folder:
// - ./daily_bias.js            (computeDailyBias)
// - ./10_14_biasplays.js       (runBiasPlays)
// - ./10_14_setups.js          (runSetups)
//
// NOTE: All outputs are deterministic given candle data.

const OSLO_TZ = "Europe/Oslo";
const SYMBOL_TD = "EUR/USD";
const SYMBOL_OUT = "EURUSD";
const VERSION = "v1.2.3";

const { computeDailyBias } = require("./daily_bias");
const { runBiasPlays } = require("./10_14_biasplays");
const { runSetups } = require("./10_14_setups");

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

// -------------------- Effective now / marketClosed / Friday-lock --------------------
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

function computeEffectiveNow({ mode, asof, candles5mAsc, staleThresholdMinutes }) {
  const last5mUtc = computeLast5mUtc(candles5mAsc);
  const last5mMs = parseUtcDatetimeToMs(last5mUtc);
  const nowServerMs = Date.now();

  let effectiveNowMs = last5mMs;
  let marketClosed = false;

  const weekdayServerOslo = getOsloWeekday(nowServerMs);
  const weekendByServer = isWeekendWeekdayName(weekdayServerOslo);

  const weekdayLastCandleOslo = last5mMs ? getOsloWeekday(last5mMs) : null;
  const weekendByLastCandle = weekdayLastCandleOslo ? isWeekendWeekdayName(weekdayLastCandleOslo) : false;

  const staleGapMinutes =
    Number.isFinite(last5mMs) ? Math.max(0, (nowServerMs - last5mMs) / 60000) : null;

  const staleThreshold = Number(staleThresholdMinutes || 60);

  if (mode === "backtest") {
    const asofStr = String(asof || "").trim();
    const targetDate =
      /^\d{4}-\d{2}-\d{2}$/.test(asofStr) ? asofStr : getOsloDateKeyFromMs(last5mMs || nowServerMs);

    let best = null;
    for (const c of candles5mAsc) {
      const ms = parseUtcDatetimeToMs(c.datetime);
      if (ms == null) continue;
      if (getOsloDateKeyFromMs(ms) !== targetDate) continue;
      const hhmm = getOsloHHMM_fromMs(ms);
      if (hhmm <= "13:55") best = ms;
    }
    effectiveNowMs = best ?? last5mMs;
    marketClosed = false;

    return {
      ok: true,
      mode,
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

  if (weekendByServer || weekendByLastCandle) {
    const fridayLockMs = detectFridayLockMs(candles5mAsc);
    if (fridayLockMs != null) {
      effectiveNowMs = fridayLockMs;
      marketClosed = true;
      return {
        ok: true,
        mode: "live",
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
    mode: "live",
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

// -------------------- EXECUTION PROMPT --------------------
function normalizeBias(x) {
  const s = String(x || "").trim();
  if (s === "Bullish" || s === "Bearish" || s === "Ranging") return s;
  return "Ranging";
}

function decideDirectionFromBias(bias10) {
  if (bias10 === "Bullish") return "UP";
  if (bias10 === "Bearish") return "DOWN";
  return "—";
}

function mapActiveSetup(finalObj) {
  const play = String(finalObj?.play || "").trim();
  if (play) return play;
  return "NONE";
}

function mapTriggerText(finalObj) {
  if (finalObj && typeof finalObj.triggerText === "string" && finalObj.triggerText.trim()) {
    return finalObj.triggerText.trim();
  }
  const reason = String(finalObj?.reason || "").trim();
  if (reason) return reason;
  return "NO VALID SETUP";
}

function mapQuality(finalObj) {
  const q = String(finalObj?.quality || "").trim();
  if (q === "A" || q === "B") return q;

  const play = String(finalObj?.play || "");
  if (/overlay/i.test(play)) return "A";
  if (play && play !== "NONE") return "B";
  return "—";
}

function buildExecutionPrompt({ effectiveNowMs, bias10, sessions, final }) {
  const date = effectiveNowMs != null ? getOsloDateKeyFromMs(effectiveNowMs) : "N/A";
  const time = effectiveNowMs != null ? getOsloHHMM_fromMs(effectiveNowMs) : "N/A";

  const b10 = normalizeBias(bias10);
  const asia = sessions?.asia?.stats;
  const asiaRange = asia?.ok ? `${asia.low.toFixed(5)} – ${asia.high.toFixed(5)}` : "N/A";

  const tradeGO = final?.trade === "Yes";
  const activeSetup = mapActiveSetup(final);
  const quality = mapQuality(final);

  let triggerStatus = mapTriggerText(final);
  if (tradeGO) {
    // Keep reason visible (useful) but still deterministic
    const reason = String(final?.reason || "").trim();
    triggerStatus = reason ? `CONFIRMED — ${reason}` : "CONFIRMED";
  }

  const trade = tradeGO ? "GO" : "NO";
  const direction = tradeGO ? decideDirectionFromBias(b10) : "—";

  return `
DATE: ${date}   TIME: ${time} (Oslo)
BIAS (10–14): ${b10}
ASIA RANGE: ${asiaRange}

ACTIVE SETUP:
${activeSetup}

TRIGGER STATUS:
${triggerStatus}

TRADE:
${trade}
Direction: ${direction}
Quality: ${quality}
`.trim();
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
  mode,
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
    engineMode: mode,

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
    const asof = url.searchParams.get("asof"); // YYYY-MM-DD

    // outputMode: status/full
    // engine mode: backtest/live
    const modeParam = url.searchParams.get("mode") || "";
    const outputMode = modeParam === "status" ? "status" : "full";
    const mode = modeParam === "backtest" ? "backtest" : "live";

    // ✅ Less 429-sensitive:
    // - status: fetch ONLY (1day + 5min)
    // - full: fetch (1day + 1h + 5min)
    let d1Resp, h1Resp, m5Resp;

    if (outputMode === "status") {
      const [d1, m5] = await Promise.all([tdFetchSeries("1day", 500), tdFetchSeries("5min", 5000)]);
      d1Resp = d1;
      m5Resp = m5;
      h1Resp = { candles: [] }; // deterministic stub
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
    if (outputMode !== "status") {
      kvSetJson(`candles:${SYMBOL_OUT}:1H`, h1Candles);
    }

    // Effective now
    const eff = computeEffectiveNow({
      mode,
      asof,
      candles5mAsc: m5Candles,
      staleThresholdMinutes: 60,
    });

    const effectiveNowMs = parseUtcDatetimeToMs(eff.effectiveNowUtc);
    const osloDateUsed =
      effectiveNowMs != null ? getOsloDateKeyFromMs(effectiveNowMs) : getOsloDateKeyFromMs(Date.now());
    const weekdayOslo = effectiveNowMs != null ? getOsloWeekday(effectiveNowMs) : getOsloWeekday(Date.now());

    // Build rows for day as-of effectiveNow
    const rowsSameDay = buildRowsSameDayAsOf(m5Candles, effectiveNowMs, osloDateUsed);
    const sessions = buildSessions(rowsSameDay);

    // Pick D-1/D-2
    const pick = pickD1D2(dailyCandles, mode === "backtest" ? asof : null, osloDateUsed);
    if (!pick.ok) {
      if (outputMode === "status") {
        return res.status(200).json({
          ok: false,
          mode: "status",
          version: VERSION,
          symbol: SYMBOL_OUT,
          engineMode: mode,
          error: "daily_pick_failed",
          debug: { asofUsed: mode === "backtest" ? asof : null, osloDateUsed, weekdayOslo, pick },
        });
      }

      return res.status(200).json({
        ok: false,
        version: VERSION,
        symbol: SYMBOL_OUT,
        timezoneRequestedFromTwelveData: "UTC",
        mode,
        error: "daily_pick_failed",
        debug: {
          asofUsed: mode === "backtest" ? asof : null,
          osloDateUsed,
          weekdayOslo,
          pick,
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
          engineMode: mode,
          error: "daily_bias_failed",
          debug: { daily },
        });
      }

      return res.status(200).json({
        ok: false,
        version: VERSION,
        symbol: SYMBOL_OUT,
        timezoneRequestedFromTwelveData: "UTC",
        mode,
        error: "daily_bias_failed",
        debug: { daily },
      });
    }

    const PDH = toNum(D_1.high);
    const PDL = toNum(D_1.low);

    const ctx = {
      pdh: PDH,
      pdl: PDL,
      rowsSameDay,
      weekdayOslo,
      marketClosed: !!eff.marketClosed,
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

    const executionPrompt = buildExecutionPrompt({
      effectiveNowMs,
      bias10,
      sessions,
      final,
    });

    if (outputMode === "status") {
      return res.status(200).json(
        buildStatusPacket({
          ok: true,
          version: VERSION,
          symbol: SYMBOL_OUT,
          mode,
          last5mUtc: eff.last5mUtc,
          effectiveNowUtc: eff.effectiveNowUtc,
          effectiveNowOslo: eff.effectiveNowOslo,
          trade,
          bias09,
          bias10,
          londonScenario,
          ctx: { ...ctx, marketClosed: !!eff.marketClosed, weekdayOslo, osloDateUsed },
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
      mode,

      last5mUtc: eff.last5mUtc,
      effectiveNowUtc: eff.effectiveNowUtc,
      effectiveNowOslo: eff.effectiveNowOslo,

      trade,
      bias09,
      bias10,
      londonScenario,

      executionPrompt,

      debug: {
        asofUsed: mode === "backtest" ? asof : null,
        staleGapMinutes: eff.staleGapMinutes,
        staleThresholdMinutes: eff.staleThresholdMinutes,
        weekendByServer: eff.weekendByServer,
        weekendByLastCandle: eff.weekendByLastCandle,
        usedFridayLock: eff.usedFridayLock,
        fridayLockUtc: eff.fridayLockUtc,
        fridayLockOslo: eff.fridayLockOslo,
        marketClosed: eff.marketClosed,

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
