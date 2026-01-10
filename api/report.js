// /api/report.js — LOCKED v1.2 (single-file “heavy” version)
// Implements:
// - Data refresh: TwelveData 1D/1H/5M (timezone=UTC) + overwrite Redis keys
// - Daily bias (ONLY from D-1 and D-2 daily candles; bias never changes intraday)
// - Session model (Oslo): Asia 02–06, Frankfurt 07–08, London setup 09–10, Payoff 10–14
// - Type A / B / C logic (mechanical, deterministic)
// - Hard filters (wrong-side first, overlap/rot proxy, no structure before 10, Wed+wrong-side)
// - Overlay on non-bias/no-trade: Frankfurt-manip + London-sweep + revers (A/B quality only)
// Output contract (top-level):
// - trade: "Yes"/"No"
// - bias09: "Bullish"/"Bearish"/"Ranging"
// - bias10: "Bullish"/"Bearish"/"Ranging"
// - londonScenario: one of the 5 allowed strings
//
// Notes:
// - asof=YYYY-MM-DD affects ONLY which daily candles are used for bias (D-1 and D-2 selection).
// - nowUtc/nowOslo remain LIVE based on latest 5M candle returned by TwelveData (as your current system).

const { Redis } = require("@upstash/redis");

const SYMBOL = "EUR/USD";
const TZ_REQUEST = "UTC";
const OSLO_TZ = "Europe/Oslo";
const PIP = 0.0001;

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// -------------------------
// Time + number helpers
// -------------------------
function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function parseUtcDatetimeToMs(dtStr) {
  const s = String(dtStr || "").trim();
  if (!s) return null;

  // "YYYY-MM-DD HH:MM:SS"
  if (s.includes(" ")) {
    const [datePart, timePart] = s.split(" ");
    const [Y, M, D] = datePart.split("-").map((x) => parseInt(x, 10));
    const [hh, mm, ss] = timePart.split(":").map((x) => parseInt(x, 10));
    if (!Number.isFinite(Y) || !Number.isFinite(M) || !Number.isFinite(D)) return null;
    return Date.UTC(Y, M - 1, D, hh || 0, mm || 0, ss || 0);
  }

  // "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [Y, M, D] = s.split("-").map((x) => parseInt(x, 10));
    if (!Number.isFinite(Y) || !Number.isFinite(M) || !Number.isFinite(D)) return null;
    return Date.UTC(Y, M - 1, D, 0, 0, 0);
  }

  return null;
}

function formatMsInTz(ms, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
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

function getOsloParts(ms) {
  const s = formatMsInTz(ms, OSLO_TZ);
  const hh = parseInt(s.slice(11, 13), 10);
  const mm = parseInt(s.slice(14, 16), 10);
  return { s, hh, mm, date: s.slice(0, 10) };
}

function isOsloBetween(ms, startHH, startMM, endHH, endMM) {
  const { hh, mm } = getOsloParts(ms);
  const afterStart = hh > startHH || (hh === startHH && mm >= startMM);
  const beforeEnd = hh < endHH || (hh === endHH && mm <= endMM);
  return afterStart && beforeEnd;
}

function isOsloAtOrAfter(ms, hhT, mmT) {
  const { hh, mm } = getOsloParts(ms);
  return hh > hhT || (hh === hhT && mm >= mmT);
}

function pips(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(a - b) / PIP;
}

function directionFromMove(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "NONE";
  if (to > from) return "UP";
  if (to < from) return "DOWN";
  return "NONE";
}

// -------------------------
// TwelveData fetch
// -------------------------
async function tdFetchCandles(interval, outputsize) {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) throw new Error("Missing TWELVEDATA_API_KEY");

  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&timezone=${encodeURIComponent(TZ_REQUEST)}` +
    `&format=JSON&apikey=${encodeURIComponent(apiKey)}`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`TwelveData HTTP ${r.status} for ${interval}`);
  const j = await r.json();
  if (!j || !Array.isArray(j.values)) throw new Error(`Bad TwelveData payload for ${interval}`);
  return { values: j.values, meta: j.meta || null };
}

// -------------------------
// Daily bias (v1.2) — ONLY from daily candles D-1 and D-2
// Base daily bias rule (deterministic):
// - close_position = (close - low)/(high-low)
// - >=0.60 => Bullish
// - <=0.40 => Bearish
// - else => Ranging
// Bias never changes intraday.
// -------------------------
function computeBaseDailyBiasFromD1(d1) {
  const h = toNum(d1?.high);
  const l = toNum(d1?.low);
  const c = toNum(d1?.close);
  if (h == null || l == null || c == null) return { bias: "Ranging", closePos: null, reason: "missing_daily_fields" };
  const range = h - l;
  if (!(range > 0)) return { bias: "Ranging", closePos: null, reason: "invalid_daily_range" };
  const closePos = (c - l) / range;
  if (closePos >= 0.6) return { bias: "Bullish", closePos, reason: "close_pos>=0.60" };
  if (closePos <= 0.4) return { bias: "Bearish", closePos, reason: "close_pos<=0.40" };
  return { bias: "Ranging", closePos, reason: "0.40<close_pos<0.60" };
}

// Pick D-1 and D-2.
// If asof=YYYY-MM-DD: D-1 = that date, D-2 = next candle in array.
// Else: use latest [0] as D-1, [1] as D-2 (simple + deterministic).
function pickD1D2(dailyValues, asof) {
  if (!Array.isArray(dailyValues) || dailyValues.length < 2) return { d1: null, d2: null, mode: "none" };

  if (asof) {
    const idx = dailyValues.findIndex((c) => String(c?.datetime || "").startsWith(asof));
    if (idx >= 0 && dailyValues[idx + 1]) return { d1: dailyValues[idx], d2: dailyValues[idx + 1], mode: "asof" };
    return { d1: dailyValues[0], d2: dailyValues[1], mode: "asof_not_found_fallback_latest" };
  }

  return { d1: dailyValues[0], d2: dailyValues[1], mode: "latest" };
}

// PDH/PDL = previous day's high/low = D-1 high/low (relative to current intraday).
function getPDH_PDL_fromD1(d1) {
  const pdh = toNum(d1?.high);
  const pdl = toNum(d1?.low);
  return { pdh: Number.isFinite(pdh) ? pdh : null, pdl: Number.isFinite(pdl) ? pdl : null };
}

// -------------------------
// Intraday session slicing (M5, Oslo date of now)
// - Uses ONLY candles up to now (no lookahead)
// - Uses Oslo date key of now
// -------------------------
function normalizeM5(latest5M, nowMs) {
  const rows = [];
  if (!Array.isArray(latest5M)) return rows;
  for (const c of latest5M) {
    const ms = parseUtcDatetimeToMs(c.datetime);
    if (ms == null) continue;
    if (nowMs != null && ms > nowMs) continue; // no lookahead
    const o = toNum(c.open);
    const h = toNum(c.high);
    const l = toNum(c.low);
    const cl = toNum(c.close);
    if (o == null || h == null || l == null || cl == null) continue;
    rows.push({ ms, open: o, high: h, low: l, close: cl });
  }
  rows.sort((a, b) => a.ms - b.ms);
  return rows;
}

function sliceByOsloDate(rows, targetOsloDate) {
  return rows.filter((r) => getOsloParts(r.ms).date === targetOsloDate);
}

function statsOfWindow(rows) {
  if (!rows.length) return null;
  let high = -Infinity;
  let low = Infinity;
  for (const r of rows) {
    if (r.high > high) high = r.high;
    if (r.low < low) low = r.low;
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    count: rows.length,
    high,
    low,
    rangePips: pips(high, low),
    open: first.open,
    close: last.close,
    startMs: first.ms,
    endMs: last.ms,
    startOslo: getOsloParts(first.ms).s,
    endOslo: getOsloParts(last.ms).s,
  };
}

function windowRows(rows, startHH, startMM, endHH, endMM) {
  return rows.filter((r) => isOsloBetween(r.ms, startHH, startMM, endHH, endMM));
}

function computeSessions(rowsSameDay) {
  const asia = windowRows(rowsSameDay, 2, 0, 6, 59);
  const frankfurt = windowRows(rowsSameDay, 7, 0, 8, 59);
  const londonSetup = windowRows(rowsSameDay, 9, 0, 9, 59);
  const payoff = windowRows(rowsSameDay, 10, 0, 13, 59);

  return {
    asia: { rows: asia, stats: statsOfWindow(asia) },
    frankfurt: { rows: frankfurt, stats: statsOfWindow(frankfurt) },
    londonSetup: { rows: londonSetup, stats: statsOfWindow(londonSetup) },
    payoff: { rows: payoff, stats: statsOfWindow(payoff) },
  };
}

// -------------------------
// Hard filters (mechanical proxies)
// -------------------------
function detectWrongSideBreakFirst(rowsSameDay, bias, pdh, pdl) {
  if (!rowsSameDay.length) return { ok: false, wrongSide: false, reason: "no_rows" };
  if (bias !== "Bullish" && bias !== "Bearish") return { ok: true, wrongSide: false, reason: "no_directional_bias" };
  if (!Number.isFinite(pdh) || !Number.isFinite(pdl)) return { ok: false, wrongSide: false, reason: "missing_pdh_pdl" };

  // We evaluate from 02:00 to 10:00 Oslo (qualification window)
  const qual = rowsSameDay.filter((r) => isOsloBetween(r.ms, 2, 0, 9, 59));
  let firstHit = null; // "PDH" or "PDL"
  for (const r of qual) {
    if (firstHit) break;
    if (r.high > pdh) firstHit = "PDH";
    else if (r.low < pdl) firstHit = "PDL";
  }

  if (!firstHit) return { ok: true, wrongSide: false, reason: "no_pdh_pdl_break_before_10" };

  if (bias === "Bullish" && firstHit === "PDL") return { ok: true, wrongSide: true, reason: "bullish_but_pdl_broke_first" };
  if (bias === "Bearish" && firstHit === "PDH") return { ok: true, wrongSide: true, reason: "bearish_but_pdh_broke_first" };

  return { ok: true, wrongSide: false, reason: "bias_side_broke_first_or_only" };
}

function detectNoStructureBefore10(sessions) {
  // "Ingen klar struktur før 10" proxy:
  // Require at least 8 pips total range across Frankfurt+LondonSetup combined.
  const ff = sessions.frankfurt.stats;
  const ld = sessions.londonSetup.stats;
  const ffRange = ff?.rangePips ?? 0;
  const ldRange = ld?.rangePips ?? 0;
  const combined = ffRange + ldRange;
  return { noStructure: combined < 8, combinedRangePips: combined };
}

function detectDeepOverlapOrRot(sessions) {
  // "Dyp overlap / rot" proxy:
  // If LondonSetup range < 6 pips AND it has many direction flips (close vs open).
  const rows = sessions.londonSetup.rows || [];
  const st = sessions.londonSetup.stats;
  const rangeP = st?.rangePips ?? 0;
  if (rows.length < 6) return { messy: false, reason: "not_enough_london_rows" };

  let flips = 0;
  let prevDir = null;
  for (const r of rows) {
    const dir = r.close > r.open ? "UP" : r.close < r.open ? "DOWN" : "FLAT";
    if (prevDir && dir !== "FLAT" && prevDir !== "FLAT" && dir !== prevDir) flips++;
    if (dir !== "FLAT") prevDir = dir;
  }

  const messy = rangeP < 6 && flips >= 3;
  return { messy, londonRangePips: rangeP, flips, reason: messy ? "small_range_many_flips" : "ok" };
}

// Wednesday + wrong-side: hard no trade
function isWednesdayOslo(nowMs) {
  if (nowMs == null) return false;
  const d = new Date(formatMsInTz(nowMs, OSLO_TZ).slice(0, 10) + "T00:00:00Z"); // safe-ish
  // The above is not a real Oslo midnight, but weekday is stable by date string.
  // Better: use Intl parts:
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: OSLO_TZ, weekday: "short" }).formatToParts(new Date(nowMs));
  const wk = parts.find((p) => p.type === "weekday")?.value || "";
  return wk.toLowerCase().startsWith("wed");
}

function weekdayNote(nowMs) {
  if (nowMs == null) return null;
  const wk = new Intl.DateTimeFormat("en-US", { timeZone: OSLO_TZ, weekday: "long" }).format(new Date(nowMs));
  return wk; // debug only
}

// -------------------------
// Type A / B / C logic (deterministic, mechanical)
// -------------------------
function asiaBreaksPD(bias, sessions, pdh, pdl) {
  const asia = sessions.asia.rows || [];
  if (!asia.length) return { broke: false, direction: "NONE", tsMs: null };
  if (bias === "Bullish") {
    for (const r of asia) if (r.high > pdh) return { broke: true, direction: "UP", tsMs: r.ms };
  } else if (bias === "Bearish") {
    for (const r of asia) if (r.low < pdl) return { broke: true, direction: "DOWN", tsMs: r.ms };
  }
  return { broke: false, direction: "NONE", tsMs: null };
}

function noReclaimAfterAsiaBreak(bias, rowsSameDay, breakMs, pdh, pdl) {
  // "Ingen reclaim" proxy: after break candle, until 10:00 Oslo:
  // - Bullish: no candle low <= PDH
  // - Bearish: no candle high >= PDL
  if (!breakMs) return false;
  const until10 = rowsSameDay.filter((r) => r.ms >= breakMs && isOsloBetween(r.ms, 0, 0, 9, 59));
  if (!until10.length) return true;

  if (bias === "Bullish") {
    for (const r of until10) if (r.low <= pdh) return false;
    return true;
  }
  if (bias === "Bearish") {
    for (const r of until10) if (r.high >= pdl) return false;
    return true;
  }
  return false;
}

function detectSweepOfLevelInWindow(rows, level, side /*"HIGH"|"LOW"*/) {
  // Sweep definition:
  // - HIGH sweep if any candle high > level and then later within same window we see a close back below level
  // - LOW sweep if any candle low < level and then later within same window we see a close back above level
  if (!rows.length || !Number.isFinite(level)) return { swept: false, sweepMs: null, sweepExtreme: null };

  let swept = false;
  let sweepMs = null;
  let extreme = null;

  if (side === "HIGH") {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.high > level) {
        // require a later close below level (or same candle close below)
        for (let j = i; j < rows.length; j++) {
          if (rows[j].close < level) {
            swept = true;
            sweepMs = r.ms;
            extreme = r.high;
            break;
          }
        }
        if (swept) break;
      }
    }
  } else {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.low < level) {
        for (let j = i; j < rows.length; j++) {
          if (rows[j].close > level) {
            swept = true;
            sweepMs = r.ms;
            extreme = r.low;
            break;
          }
        }
        if (swept) break;
      }
    }
  }

  return { swept, sweepMs, sweepExtreme: extreme };
}

// Type A triggers (09–10): continuation in bias direction after sweep of Asia or Frankfurt extreme.
function typeA_signal(bias, sessions) {
  const ld = sessions.londonSetup.rows || [];
  const asiaSt = sessions.asia.stats;
  const ffSt = sessions.frankfurt.stats;
  if (!ld.length || !asiaSt || !ffSt) return { ok: false, reason: "missing_sessions" };

  if (bias === "Bullish") {
    // sweep low (Asia low or Frankfurt low) inside 09–10, then close above that level
    const sweepAsiaLow = detectSweepOfLevelInWindow(ld, asiaSt.low, "LOW");
    const sweepFfLow = detectSweepOfLevelInWindow(ld, ffSt.low, "LOW");
    const swept = sweepAsiaLow.swept || sweepFfLow.swept;
    return { ok: swept, kind: swept ? "sweep_low_then_up" : "none" };
  }

  if (bias === "Bearish") {
    const sweepAsiaHigh = detectSweepOfLevelInWindow(ld, asiaSt.high, "HIGH");
    const sweepFfHigh = detectSweepOfLevelInWindow(ld, ffSt.high, "HIGH");
    const swept = sweepAsiaHigh.swept || sweepFfHigh.swept;
    return { ok: swept, kind: swept ? "sweep_high_then_down" : "none" };
  }

  return { ok: false, reason: "no_directional_bias" };
}

// Type B: bias day, Asia does NOT break PDH/PDL, London 09–10 makes first move AGAINST bias then fails.
function typeB_signal(bias, sessions) {
  const ld = sessions.londonSetup.rows || [];
  const asiaSt = sessions.asia.stats;
  const ffSt = sessions.frankfurt.stats;
  if (!ld.length || !asiaSt || !ffSt) return { ok: false, reason: "missing_sessions" };

  const ldOpen = ld[0].open;
  const ldClose = ld[ld.length - 1].close;

  if (bias === "Bullish") {
    // "first move down" proxy: London takes (Asia low or Frankfurt low) at least once
    // then "fails": by end of 09–10, close is above London open (buyers regained)
    const tookLow =
      ld.some((r) => r.low < asiaSt.low) || ld.some((r) => r.low < ffSt.low);

    const failedDown = ldClose > ldOpen;
    return { ok: tookLow && failedDown, kind: tookLow && failedDown ? "london_down_fake_then_up" : "none" };
  }

  if (bias === "Bearish") {
    const tookHigh =
      ld.some((r) => r.high > asiaSt.high) || ld.some((r) => r.high > ffSt.high);

    const failedUp = ldClose < ldOpen;
    return { ok: tookHigh && failedUp, kind: tookHigh && failedUp ? "london_up_fake_then_down" : "none" };
  }

  return { ok: false, reason: "no_directional_bias" };
}

// Type C: no-bias day (Ranging), double test of same Asia level (Frankfurt then London), both fail, then mean reversion.
function typeC_signal(sessions, pdh, pdl) {
  const asiaSt = sessions.asia.stats;
  const ff = sessions.frankfurt.rows || [];
  const ld = sessions.londonSetup.rows || [];
  if (!asiaSt || !ff.length || !ld.length) return { ok: false, reason: "missing_sessions" };

  // Must NOT have a PDH/PDL break that "holds" (proxy: >=2 closes beyond PDH/PDL between 02–10).
  const qual = [...sessions.asia.rows, ...sessions.frankfurt.rows, ...sessions.londonSetup.rows];
  let pdhClosesAbove = 0;
  let pdlClosesBelow = 0;
  if (Number.isFinite(pdh)) for (const r of qual) if (r.close > pdh) pdhClosesAbove++;
  if (Number.isFinite(pdl)) for (const r of qual) if (r.close < pdl) pdlClosesBelow++;

  const pdHold = (pdhClosesAbove >= 2) || (pdlClosesBelow >= 2);
  if (pdHold) return { ok: false, reason: "pd_break_holds_proxy" };

  // Find which Asia side is tested twice (HIGH or LOW).
  // "Test+fail" = touches/breaks level then closes back inside.
  const ffTestHigh = detectSweepOfLevelInWindow(ff, asiaSt.high, "HIGH").swept;
  const ffTestLow = detectSweepOfLevelInWindow(ff, asiaSt.low, "LOW").swept;

  let side = null;
  if (ffTestHigh && !ffTestLow) side = "HIGH";
  else if (ffTestLow && !ffTestHigh) side = "LOW";
  else return { ok: false, reason: "no_single_side_test_in_frankfurt" };

  const ldTestSame = side === "HIGH"
    ? detectSweepOfLevelInWindow(ld, asiaSt.high, "HIGH").swept
    : detectSweepOfLevelInWindow(ld, asiaSt.low, "LOW").swept;

  if (!ldTestSame) return { ok: false, reason: "no_second_test_in_london" };

  return { ok: true, side, kind: "double_tap_mean_reversion" };
}

// -------------------------
// Overlay (non-bias/no-trade days) — A/B quality only
// Frankfurt-manip (07–08) + London-sweep (09–10) + reversal after 10 in direction of Frankfurt-manip
// -------------------------
function detectFrankfurtManip(sessions) {
  const asia = sessions.asia.stats;
  const ffRows = sessions.frankfurt.rows || [];
  const ffSt = sessions.frankfurt.stats;
  if (!asia || !ffRows.length || !ffSt) return { ok: false, dir: "NONE", reason: "missing_sessions" };

  // Condition 1: break+close over Asia high or under Asia low in Frankfurt
  let breakCloseOver = false;
  let breakCloseUnder = false;
  for (const r of ffRows) {
    if (r.close > asia.high) breakCloseOver = true;
    if (r.close < asia.low) breakCloseUnder = true;
  }

  // Condition 2: 3 consecutive candles same direction with net move >= 8 pips
  let consecUp = 0;
  let consecDown = 0;
  let maxConsecUp = 0;
  let maxConsecDown = 0;
  for (const r of ffRows) {
    const dir = r.close > r.open ? "UP" : r.close < r.open ? "DOWN" : "FLAT";
    if (dir === "UP") {
      consecUp++; consecDown = 0;
    } else if (dir === "DOWN") {
      consecDown++; consecUp = 0;
    } else {
      consecUp = 0; consecDown = 0;
    }
    if (consecUp > maxConsecUp) maxConsecUp = consecUp;
    if (consecDown > maxConsecDown) maxConsecDown = consecDown;
  }
  const netMovePips = ffSt.rangePips ?? 0;

  let dir = "NONE";
  let strength = "WEAK";

  if (breakCloseOver && !breakCloseUnder) { dir = "UP"; strength = "STRONG"; }
  else if (breakCloseUnder && !breakCloseOver) { dir = "DOWN"; strength = "STRONG"; }
  else if (maxConsecUp >= 3 && netMovePips >= 8) { dir = "UP"; strength = "MED"; }
  else if (maxConsecDown >= 3 && netMovePips >= 8) { dir = "DOWN"; strength = "MED"; }
  else return { ok: false, dir: "NONE", reason: "no_clear_frankfurt_manip" };

  return { ok: true, dir, strength, breakCloseOver, breakCloseUnder, maxConsecUp, maxConsecDown, netMovePips };
}

function detectLondonSweepForOverlay(sessions) {
  const asia = sessions.asia.stats;
  const ff = sessions.frankfurt.stats;
  const ldRows = sessions.londonSetup.rows || [];
  if (!asia || !ff || !ldRows.length) return { ok: false, reason: "missing_sessions" };

  // Primary: sweep Frankfurt extreme (high or low)
  const sweepFfHigh = detectSweepOfLevelInWindow(ldRows, ff.high, "HIGH");
  const sweepFfLow = detectSweepOfLevelInWindow(ldRows, ff.low, "LOW");

  // Secondary: sweep Asia extreme
  const sweepAsiaHigh = detectSweepOfLevelInWindow(ldRows, asia.high, "HIGH");
  const sweepAsiaLow = detectSweepOfLevelInWindow(ldRows, asia.low, "LOW");

  // Tertiary: sweep Asia midline "structure" proxy
  const mid = (asia.high + asia.low) / 2;
  const sweepMidHigh = detectSweepOfLevelInWindow(ldRows, mid, "HIGH");
  const sweepMidLow = detectSweepOfLevelInWindow(ldRows, mid, "LOW");

  // Pick the "clearest" sweep with priority: Frankfurt extreme > Asia extreme > midline
  if (sweepFfHigh.swept) return { ok: true, swept: "FF_HIGH", side: "HIGH", ...sweepFfHigh, level: ff.high };
  if (sweepFfLow.swept) return { ok: true, swept: "FF_LOW", side: "LOW", ...sweepFfLow, level: ff.low };
  if (sweepAsiaHigh.swept) return { ok: true, swept: "ASIA_HIGH", side: "HIGH", ...sweepAsiaHigh, level: asia.high };
  if (sweepAsiaLow.swept) return { ok: true, swept: "ASIA_LOW", side: "LOW", ...sweepAsiaLow, level: asia.low };
  if (sweepMidHigh.swept) return { ok: true, swept: "ASIA_MID", side: "HIGH", ...sweepMidHigh, level: mid };
  if (sweepMidLow.swept) return { ok: true, swept: "ASIA_MID", side: "LOW", ...sweepMidLow, level: mid };

  return { ok: false, reason: "no_clear_sweep_in_09_10" };
}

function detectReversalMoveAfter10(sessions, targetDir /*"UP"|"DOWN"*/, minPips) {
  const payoff = sessions.payoff.rows || [];
  if (!payoff.length) return { ok: false, reason: "no_payoff_rows" };

  // Reference: first candle open at 10:00 window
  const startPrice = payoff[0].open;

  // Track max favorable excursion in target direction
  let best = startPrice;
  for (const r of payoff) {
    if (targetDir === "UP") {
      if (r.high > best) best = r.high;
    } else if (targetDir === "DOWN") {
      if (r.low < best) best = r.low;
    }
  }

  const movePips = pips(startPrice, best);
  if (movePips == null) return { ok: false, reason: "bad_prices" };
  return { ok: movePips >= minPips, movePips };
}

function overlayQuality(frankfurtManip, londonSweep) {
  // A-quality: STRONG Frankfurt + sweep of Frankfurt extreme
  // B-quality: STRONG/MED Frankfurt + sweep of Asia extreme or midline
  if (!frankfurtManip.ok || !londonSweep.ok) return null;

  const sweepIsFf = londonSweep.swept === "FF_HIGH" || londonSweep.swept === "FF_LOW";
  const sweepIsAsiaExtreme = londonSweep.swept === "ASIA_HIGH" || londonSweep.swept === "ASIA_LOW";
  const sweepIsMid = londonSweep.swept === "ASIA_MID";

  if (frankfurtManip.strength === "STRONG" && sweepIsFf) return "A";
  if ((frankfurtManip.strength === "STRONG" || frankfurtManip.strength === "MED") && (sweepIsAsiaExtreme || sweepIsMid)) return "B";
  return null; // C not used
}

// -------------------------
// Scenario mapping (allowed values only)
// -------------------------
const ALLOWED_SCENARIOS = new Set([
  "slightly up first → then price down",
  "slightly down first → then price up",
  "range / back and forth",
  "double tap → mean reversion",
  "no trade (messy day)",
]);

function scenarioForDirectionalTrade(dir /*"UP"|"DOWN"*/) {
  if (dir === "UP") return "slightly down first → then price up";
  if (dir === "DOWN") return "slightly up first → then price down";
  return "no trade (messy day)";
}

// -------------------------
// Main classification (v1.2)
// -------------------------
function classifyV12({ bias, sessions, rowsSameDay, pdh, pdl, nowMs }) {
  // Hard filters first
  const wrongSide = detectWrongSideBreakFirst(rowsSameDay, bias, pdh, pdl);
  const structure = detectNoStructureBefore10(sessions);
  const messy = detectDeepOverlapOrRot(sessions);
  const wed = isWednesdayOslo(nowMs);

  if (wrongSide.ok && wrongSide.wrongSide && wed) {
    return {
      trade: "No",
      scenario: "no trade (messy day)",
      reason: "wednesday_plus_wrong_side",
      tags: { wrongSide, structure, messy, wed },
      type: "NO_TRADE",
    };
  }

  if (wrongSide.ok && wrongSide.wrongSide) {
    return {
      trade: "No",
      scenario: "no trade (messy day)",
      reason: "wrong_side_breaks_first",
      tags: { wrongSide, structure, messy, wed },
      type: "NO_TRADE",
    };
  }

  if (structure.noStructure) {
    return {
      trade: "No",
      scenario: "no trade (messy day)",
      reason: "no_structure_before_10",
      tags: { wrongSide, structure, messy, wed },
      type: "NO_TRADE",
    };
  }

  if (messy.messy) {
    return {
      trade: "No",
      scenario: "no trade (messy day)",
      reason: "deep_overlap_or_rot_proxy",
      tags: { wrongSide, structure, messy, wed },
      type: "NO_TRADE",
    };
  }

  // Core system
  if (bias === "Bullish" || bias === "Bearish") {
    // Type A vs Type B
    const asiaBreak = asiaBreaksPD(bias, sessions, pdh, pdl);

    if (asiaBreak.broke) {
      const noReclaim = noReclaimAfterAsiaBreak(bias, rowsSameDay, asiaBreak.tsMs, pdh, pdl);
      if (noReclaim) {
        const aSig = typeA_signal(bias, sessions);
        if (aSig.ok) {
          const dir = bias === "Bullish" ? "UP" : "DOWN";
          return {
            trade: "Yes",
            scenario: scenarioForDirectionalTrade(dir),
            reason: "type_a",
            type: "TYPE_A",
            tags: { asiaBreak, noReclaim, aSig, wrongSide, structure, messy, wed },
          };
        }
        // If Asia broke+no reclaim but no trigger in 09–10 => no trade
        return {
          trade: "No",
          scenario: "no trade (messy day)",
          reason: "type_a_premises_met_but_no_trigger_09_10",
          type: "NO_TRADE",
          tags: { asiaBreak, noReclaim, wrongSide, structure, messy, wed },
        };
      }
      // Reclaim happened => reject Type A
      return {
        trade: "No",
        scenario: "no trade (messy day)",
        reason: "asia_break_but_reclaim",
        type: "NO_TRADE",
        tags: { asiaBreak, wrongSide, structure, messy, wed },
      };
    }

    // Type B premise: Asia does NOT break PDH/PDL
    const bSig = typeB_signal(bias, sessions);
    if (bSig.ok) {
      const dir = bias === "Bullish" ? "UP" : "DOWN";
      return {
        trade: "Yes",
        scenario: scenarioForDirectionalTrade(dir),
        reason: "type_b",
        type: "TYPE_B",
        tags: { bSig, wrongSide, structure, messy, wed },
      };
    }

    return {
      trade: "No",
      scenario: "no trade (messy day)",
      reason: "bias_day_no_type_a_or_b",
      type: "NO_TRADE",
      tags: { wrongSide, structure, messy, wed },
    };
  }

  // No-bias day (Ranging) => Type C attempt
  const cSig = typeC_signal(sessions, pdh, pdl);
  if (cSig.ok) {
    return {
      trade: "Yes",
      scenario: "double tap → mean reversion",
      reason: "type_c",
      type: "TYPE_C",
      tags: { cSig, wrongSide, structure, messy, wed },
    };
  }

  // Overlay (only if main system did not produce Type C)
  const ffManip = detectFrankfurtManip(sessions);
  const ldSweep = detectLondonSweepForOverlay(sessions);
  if (ffManip.ok && ldSweep.ok) {
    const quality = overlayQuality(ffManip, ldSweep);
    if (quality === "A" || quality === "B") {
      // Reversal after 10 in direction of Frankfurt manipulation
      const move = detectReversalMoveAfter10(sessions, ffManip.dir, 15);
      if (move.ok) {
        const scenario = scenarioForDirectionalTrade(ffManip.dir);
        return {
          trade: "Yes",
          scenario,
          reason: "overlay_frankfurt_london",
          type: `OVERLAY_${quality}`,
          tags: { ffManip, ldSweep, quality, move, wrongSide, structure, messy, wed },
        };
      }
      return {
        trade: "No",
        scenario: "no trade (messy day)",
        reason: "overlay_present_but_no_payoff_move_15p",
        type: "NO_TRADE",
        tags: { ffManip, ldSweep, quality, move, wrongSide, structure, messy, wed },
      };
    }
  }

  return {
    trade: "No",
    scenario: "no trade (messy day)",
    reason: "ranging_day_no_type_c_or_overlay",
    type: "NO_TRADE",
    tags: { wrongSide, structure, messy, wed, ffManip, ldSweep },
  };
}

// -------------------------
// Output contract
// -------------------------
function makeOutput({ trade, bias, scenario }) {
  const b = ["Bullish", "Bearish", "Ranging"].includes(bias) ? bias : "Ranging";
  const sc = ALLOWED_SCENARIOS.has(scenario) ? scenario : "no trade (messy day)";
  return {
    trade: trade === "Yes" ? "Yes" : "No",
    bias09: b,
    bias10: b,
    londonScenario: sc,
  };
}

// -------------------------
// Handler
// -------------------------
module.exports = async function handler(req, res) {
  try {
    const asof = typeof req.query.asof === "string" ? req.query.asof.trim() : null;

    // Fetch candles
    const [d1Resp, h1Resp, m5Resp] = await Promise.all([
      tdFetchCandles("1day", 400),
      tdFetchCandles("1h", 1500),
      tdFetchCandles("5min", 5000),
    ]);

    const daily = d1Resp.values;
    const h1 = h1Resp.values;
    const m5 = m5Resp.values;

    // nowUtc from latest 5m candle (live)
    const nowUtcStr = String(m5?.[0]?.datetime || "").trim();
    const nowMs = parseUtcDatetimeToMs(nowUtcStr);
    const nowOslo = nowMs != null ? formatMsInTz(nowMs, OSLO_TZ) : null;

    // Store (overwrite)
    await Promise.all([
      redis.set("candles:EURUSD:1D", daily),
      redis.set("candles:EURUSD:1H", h1),
      redis.set("candles:EURUSD:5M", m5),
    ]);

    // Daily bias from D-1 and D-2 (only daily used)
    const { d1, d2, mode } = pickD1D2(daily, asof);
    const base = computeBaseDailyBiasFromD1(d1);
    const bias = base.bias;

    // PDH/PDL from D-1
    const { pdh, pdl } = getPDH_PDL_fromD1(d1);

    // Intraday sessions (Oslo date of now)
    const m5Rows = normalizeM5(m5, nowMs);
    const targetOsloDate = nowMs != null ? getOsloParts(nowMs).date : null;
    const sameDay = targetOsloDate ? sliceByOsloDate(m5Rows, targetOsloDate) : [];

    const sessions = computeSessions(sameDay);

    // v1.2 classification
    const cls = classifyV12({ bias, sessions, rowsSameDay: sameDay, pdh, pdl, nowMs });

    const out = makeOutput({
      trade: cls.trade,
      bias,
      scenario: cls.scenario,
    });

    res.status(200).json({
      ok: true,
      version: "v1.2",
      symbol: "EURUSD",
      timezoneRequestedFromTwelveData: TZ_REQUEST,

      nowUtc: nowUtcStr || null,
      nowOslo,

      // v1.2 output
      ...out,

      // debug (not part of the trading output contract)
      debug: {
        asofUsed: asof || null,
        dailyPickMode: mode,
        D_1: d1?.datetime || null,
        D_2: d2?.datetime || null,
        baseBias: bias,
        baseBiasClosePos: base.closePos,
        baseBiasReason: base.reason,
        PDH: pdh,
        PDL: pdl,
        osloDateUsed: targetOsloDate,
        weekdayOslo: weekdayNote(nowMs),
        classification: {
          type: cls.type,
          reason: cls.reason,
        },
        sessionStats: {
          asia: sessions.asia.stats,
          frankfurt: sessions.frankfurt.stats,
          londonSetup: sessions.londonSetup.stats,
          payoff: sessions.payoff.stats,
        },
        filters: cls.tags || null,
        counts: { d1: daily.length, h1: h1.length, m5: m5.length, m5SameDay: sameDay.length },
      },
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
};
