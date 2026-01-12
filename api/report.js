// report.js
// v1.2.2 — REN MOTOR (orkestrator) for London 10–14 + STATUS MODE
//
// NEW:
// - ?mode=status  -> returns a SHORT, paste-friendly JSON ("status packet")
// - ?mode=backtest&asof=YYYY-MM-DD  -> unchanged backtest mode
//
// Files expected in SAME /api folder:
// - ./daily_bias.js            (computeDailyBias)
// - ./10_14_biasplays.js       (runBiasPlays)
// - ./10_14_setups.js          (runSetups)
//
// This file:
// - Fetches EUR/USD candles (1D/1H/5M) from TwelveData in UTC
// - Applies marketClosed/stale/weekend Friday-lock (LIVE mode)
// - Supports backtest mode: ?mode=backtest&asof=YYYY-MM-DD
// - Slices sessions in Oslo time:
//   Asia: 02:00–06:59
//   Frankfurt: 07:00–08:59
//   London setup: 09:00–09:59
//   Payoff: 10:00–13:55
// - Calls modules in locked order:
//   daily_bias → biasplays → setups
//
// NOTE: All outputs are deterministic given candle data.

const OSLO_TZ = "Europe/Oslo";
const SYMBOL_TD = "EUR/USD";
const SYMBOL_OUT = "EURUSD";
const VERSION = "v1.2.2";

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
  // "Monday".."Sunday"
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
  // TwelveData returns newest-first; reverse for ascending time
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

  return {
    meta: j.meta || null,
    candles,
  };
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
  // rowsSameDay already has osloHHMM
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
  // TwelveData daily candle datetime is often "YYYY-MM-DD"
  const s = String(candle?.datetime || "").trim();
  if (!s) return null;
  if (s.includes(" ")) return s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // ISO fallback
  const ms = parseUtcDatetimeToMs(s);
  return ms ? new Date(ms).toISOString().slice(0, 10) : null;
}

function pickD1D2(dailyCandlesAsc, asofDate, osloDateUsed) {
  // dailyCandlesAsc in ascending time
  const arr = dailyCandlesAsc || [];
  if (arr.length < 2) return { ok: false, reason: "not_enough_daily_candles" };

  const dateTarget = asofDate || osloDateUsed; // we treat these as YYYY-MM-DD
  const dateTargetStr = String(dateTarget || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateTargetStr)) {
    return { ok: false, reason: "invalid_target_date", dateTargetStr };
  }

  // find last candle with dateKey <= target
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
  // We "hard-lock" live weekend to the last candle that is Friday (Oslo),
  // ideally near 23:55 Oslo, but we simply pick the latest candle whose Oslo weekday is Friday.
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

  // stale gap is measured from server time to last candle time
  const staleGapMinutes =
    Number.isFinite(last5mMs) ? Math.max(0, (nowServerMs - last5mMs) / 60000) : null;

  const staleThreshold = Number(staleThresholdMinutes || 60);

  if (mode === "backtest") {
    // Backtest: effectiveNow is forced to 13:55 Oslo on asof date (or current Oslo date fallback)
    const asofStr = String(asof || "").trim();
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(asofStr) ? asofStr : getOsloDateKeyFromMs(last5mMs || nowServerMs);

    // Pick last candle whose OsloDate == targetDate and osloHHMM <= 13:55
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

  // LIVE mode:
  // If weekend (by server OR by last candle), lock to Friday and mark marketClosed.
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

  // If stale beyond threshold, treat as closed
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
}) {
  const asia = sessions?.asia?.stats || null;
  const ff = sessions?.frankfurt?.stats || null;
  const ld = sessions?.londonSetup?.stats || null;
  const po = sessions?.payoff?.stats || null;

  // Pull out LondonFirstSweep details if present
  const lfs = final?.play === "LondonFirstSweep" ? final?.debug?.sweep || null : null;

  return {
    ok: !!ok,
    mode: "status",
    version,
    symbol,
    engineMode: mode, // live/backtest
    last5mUtc,
    effectiveNowUtc,
    effectiveNowOslo,

    trade,
    play: final?.play || null,
    reason: final?.reason || null,
    bias09,
    bias10,
    londonScenario,

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
          sweepSide: lfs.sweepSide ?? null, // UP sweep => expect down; DOWN sweep => expect up
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

    // IMPORTANT:
    // We reuse ?mode=status without breaking existing behavior:
    // - engineMode: backtest/live
    // - outputMode: status/full
    const modeParam = url.searchParams.get("mode") || "";
    const outputMode = modeParam === "status" ? "status" : "full";
    const mode = modeParam === "backtest" ? "backtest" : "live";

    // Fetch candles (sizes chosen for safety)
    const [d1Resp, h1Resp, m5Resp] = await Promise.all([
      tdFetchSeries("1day", 500),
      tdFetchSeries("1h", 2000),
      tdFetchSeries("5min", 5000),
    ]);

    const dailyCandles = d1Resp.candles;
    const h1Candles = h1Resp.candles;
    const m5Candles = m5Resp.candles;

    // Best-effort store (non-blocking for logic correctness)
    kvSetJson(`candles:${SYMBOL_OUT}:1D`, dailyCandles);
    kvSetJson(`candles:${SYMBOL_OUT}:1H`, h1Candles);
    kvSetJson(`candles:${SYMBOL_OUT}:5M`, m5Candles);

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

    // Build rows for the day AS-OF effectiveNow
    const rowsSameDay = buildRowsSameDayAsOf(m5Candles, effectiveNowMs, osloDateUsed);
    const sessions = buildSessions(rowsSameDay);

    // Pick D-1/D-2
    const pick = pickD1D2(dailyCandles, mode === "backtest" ? asof : null, osloDateUsed);
    if (!pick.ok) {
      // In status mode, still return a short packet
      if (outputMode === "status") {
        return res.status(200).json({
          ok: false,
          mode: "status",
          version: VERSION,
          symbol: SYMBOL_OUT,
          engineMode: mode,
          error: "daily_pick_failed",
          debug: {
            asofUsed: mode === "backtest" ? asof : null,
            osloDateUsed,
            weekdayOslo,
            pick,
          },
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
          counts: { d1: dailyCandles.length, h1: h1Candles.length, m5: m5Candles.length, m5SameDay: rowsSameDay.length },
        },
      });
    }

    const D_1 = pick.d1;
    const D_2 = pick.d2;

    // Daily bias computation
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

      // extra (for status)
      osloDateUsed,
    };

    // Run modules in locked order
    const biasPlay = runBiasPlays(daily, sessions, ctx);
    let final = biasPlay;

    if (biasPlay.trade !== "Yes") {
      const setup = runSetups(daily, sessions, ctx);
      final = setup; // keep setup response (gives reasons)
    }

    // Ensure outputs are clean
    const trade = final.trade === "Yes" ? "Yes" : "No";
    const bias09 = String(final.bias09 || daily.bias09 || daily.baseBias || "Ranging");
    const bias10 = String(final.bias10 || daily.bias10 || daily.baseBias || "Ranging");
    const londonScenario = String(final.londonScenario || "no trade (messy day)");

    // Classification object (simple)
    const classification =
      trade === "Yes"
        ? { type: String(final.play || "SIGNAL"), reason: String(final.reason || "signal") }
        : { type: "NO_TRADE", reason: String(final.reason || "no_signal") };

    // ✅ NEW: STATUS output (short)
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
          ctx: {
            ...ctx,
            marketClosed: !!eff.marketClosed,
            weekdayOslo,
            osloDateUsed,
          },
          sessions,
          final,
          classification,
        })
      );
    }

    // Default: full report (unchanged, just version bumped)
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

        // Module debug for backtest analysis (kept deterministic)
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
