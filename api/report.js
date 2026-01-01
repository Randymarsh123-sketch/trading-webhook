// del2_asiaRange.js
// DEL 2 – ASIA RANGE + (new) Asia-state classification + 07:05 gating + internal stats anchors
//
// Design goals:
// - Keep Asia facts "clean" (range, highs/lows, timestamps).
// - Add an Asia-state that can be queried any time AFTER 07:00 Oslo (same day).
// - Add "post-07:00 break" as an AS-OF field (no lookahead): only considers candles up to nowUtcStr.
// - Include internal data/% anchors from your 2024–2025 tests for psychology/reporting.
// - DOES NOT change Del 1 logic; it only consumes baseBias if you pass it in.

const OSLO_TZ = "Europe/Oslo";

/**
 * Internal stats anchors (EUR/USD 2024–2025) from our tests (reference only).
 * Note: This is not used to compute signals; it's for anchoring/reporting.
 */
const ASIA_STATS_REF = Object.freeze({
  sample: "EUR/USD 2024–2025",
  method: "Asia window 02:00–06:59 Oslo; classify relative to Daily bias; measure daily confirmation later same day",
  sharesApprox: { followsDaily: 0.31, againstDaily: 0.38, unclear: 0.31 },
  hitRateApprox: { followsDaily: 0.82, againstDaily: 0.71, unclear: 0.61 },
  note: "Asia High/Low-based context is more informative than open/close; use as context, not as a bias generator.",
});

function parseUtcDatetimeToMs(dtStr) {
  const s = String(dtStr || "").trim();
  if (!s) return null;

  if (s.includes(" ")) {
    const [datePart, timePart] = s.split(" ");
    const [Y, M, D] = datePart.split("-").map((x) => parseInt(x, 10));
    const [hh, mm, ss] = timePart.split(":").map((x) => parseInt(x, 10));
    if (!Number.isFinite(Y) || !Number.isFinite(M) || !Number.isFinite(D)) return null;
    return Date.UTC(Y, M - 1, D, hh || 0, mm || 0, ss || 0);
  }

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
  const osloStr = formatMsInOslo(ms);
  const hh = parseInt(osloStr.slice(11, 13), 10);
  const mm = parseInt(osloStr.slice(14, 16), 10);
  return { hh, mm, osloStr };
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function isOsloTimeAtOrAfter(ms, hhTarget, mmTarget) {
  const { hh, mm } = getOsloHHMM_fromMs(ms);
  return hh > hhTarget || (hh === hhTarget && mm >= mmTarget);
}

function isOsloTimeWithinAsiaWindow(ms) {
  const { hh, mm } = getOsloHHMM_fromMs(ms);
  const afterStart = hh > 2 || (hh === 2 && mm >= 0);
  const beforeEnd = hh < 6 || (hh === 6 && mm <= 59);
  return afterStart && beforeEnd;
}

/**
 * Compute Asia range facts for the Oslo date of nowUtcStr:
 * - window 02:00–06:59 Oslo
 * - Asia High/Low/Range
 * - Start/End timestamps (UTC + Oslo)
 * - Also includes Asia open/close (first candle open, last candle close) and close-position-in-range.
 */
function computeAsiaRange_0200_0659_Oslo(latest5M, nowUtcStr) {
  if (!Array.isArray(latest5M) || latest5M.length === 0) {
    return { ok: false, reason: "No 5M candles" };
  }

  const nowMs = parseUtcDatetimeToMs(nowUtcStr);
  if (nowMs == null) return { ok: false, reason: "Invalid nowUtc for Asia range" };

  const targetOsloDate = getOsloDateKeyFromMs(nowMs);
  const windowStart = "02:00";
  const windowEnd = "06:59";

  const inWindow = [];

  for (const c of latest5M) {
    const ms = parseUtcDatetimeToMs(c.datetime);
    if (ms == null) continue;

    if (getOsloDateKeyFromMs(ms) !== targetOsloDate) continue;
    if (!isOsloTimeWithinAsiaWindow(ms)) continue;

    const high = toNum(c.high);
    const low = toNum(c.low);
    const open = toNum(c.open);
    const close = toNum(c.close);

    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    // open/close are optional in some feeds; keep them if present
    inWindow.push({
      ms,
      high,
      low,
      open: Number.isFinite(open) ? open : null,
      close: Number.isFinite(close) ? close : null,
    });
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

  // Asia open/close (best-effort)
  const asiaOpen = inWindow[0].open;
  const asiaClose = inWindow[inWindow.length - 1].close;

  const asiaRange = asiaHigh - asiaLow;
  const closePos =
    Number.isFinite(asiaRange) && asiaRange > 0 && Number.isFinite(asiaClose)
      ? (asiaClose - asiaLow) / asiaRange
      : null;

  return {
    ok: true,
    asiaDateOslo: targetOsloDate,
    windowOslo: { start: windowStart, end: windowEnd },
    candlesCount: inWindow.length,
    asiaHigh,
    asiaLow,
    asiaRange,
    // extra helpful fields
    asiaOpen, // first candle open (may be null if not available)
    asiaClose, // last candle close (may be null if not available)
    asiaClosePosInRange: closePos, // 0..1 (null if missing)
    startTsUtc: new Date(startMs).toISOString(),
    endTsUtc: new Date(endMs).toISOString(),
    startTsOslo: formatMsInOslo(startMs),
    endTsOslo: formatMsInOslo(endMs),
  };
}

/**
 * Compute FIRST break of Asia High/Low from 07:00 Oslo onward, AS-OF nowUtcStr.
 * - No lookahead: only considers candles with ms <= nowMs.
 * - Break = NONE if not broken up to now.
 */
function computeAsiaBreakAfter0700_Oslo_AsOf(latest5M, del2_asiaRange, nowUtcStr) {
  if (!del2_asiaRange || !del2_asiaRange.ok) {
    return { ok: false, reason: "Asia range not available" };
  }
  if (!Array.isArray(latest5M) || latest5M.length === 0) {
    return { ok: false, reason: "No 5M candles" };
  }

  const nowMs = parseUtcDatetimeToMs(nowUtcStr);
  if (nowMs == null) return { ok: false, reason: "Invalid nowUtc for Asia break" };

  const targetOsloDate = del2_asiaRange.asiaDateOslo;
  const asiaHigh = toNum(del2_asiaRange.asiaHigh);
  const asiaLow = toNum(del2_asiaRange.asiaLow);

  if (!Number.isFinite(asiaHigh) || !Number.isFinite(asiaLow)) {
    return { ok: false, reason: "Invalid asiaHigh/asiaLow" };
  }

  const checkedFromOslo = "07:00";

  // Sort by time so "first break" is deterministic
  const rows = [];
  for (const c of latest5M) {
    const ms = parseUtcDatetimeToMs(c.datetime);
    if (ms == null) continue;
    if (ms > nowMs) continue; // AS-OF filter (no lookahead)
    if (getOsloDateKeyFromMs(ms) !== targetOsloDate) continue;
    if (!isOsloTimeAtOrAfter(ms, 7, 0)) continue;

    const h = toNum(c.high);
    const l = toNum(c.low);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;

    rows.push({ ms, h, l });
  }

  rows.sort((a, b) => a.ms - b.ms);

  for (const r of rows) {
    const brokeUp = r.h > asiaHigh;
    const brokeDown = r.l < asiaLow;
    if (!brokeUp && !brokeDown) continue;

    const osloStr = formatMsInOslo(r.ms);

    let breakDirection = "UP";
    let breakPrice = r.h;

    // If both in the same candle, pick the larger overshoot (simple heuristic).
    if (brokeUp && brokeDown) {
      const upDist = r.h - asiaHigh;
      const downDist = asiaLow - r.l;
      if (downDist > upDist) {
        breakDirection = "DOWN";
        breakPrice = r.l;
      } else {
        breakDirection = "UP";
        breakPrice = r.h;
      }
    } else if (brokeDown) {
      breakDirection = "DOWN";
      breakPrice = r.l;
    }

    return {
      ok: true,
      checkedFromOslo,
      asOfUtc: new Date(nowMs).toISOString(),
      asOfOslo: formatMsInOslo(nowMs),
      breakDirection,
      breakPrice,
      breakTsOslo: osloStr,
      breakTsUtc: new Date(r.ms).toISOString(),
    };
  }

  return {
    ok: true,
    checkedFromOslo,
    asOfUtc: new Date(nowMs).toISOString(),
    asOfOslo: formatMsInOslo(nowMs),
    breakDirection: "NONE",
  };
}

/**
 * Classify Asia relative to the base daily bias (Bullish/Bearish/Ranging),
 * but only after Asia window is complete (>= 07:00 Oslo).
 *
 * Simple and robust first version:
 * - Determine Asia directional feel from Asia close position in range:
 *   - closePos >= 0.60 => Asia bullish
 *   - closePos <= 0.40 => Asia bearish
 *   - else => Asia unclear
 *
 * Then map against baseBias:
 * - If baseBias is Bullish/Bearish:
 *   - follows if Asia dir matches baseBias
 *   - against if opposite
 *   - unclear otherwise
 * - If baseBias is Ranging or missing => state is "ASIA_UKLAR" (context only)
 */
function classifyAsiaState(del2_asiaRange, baseBias) {
  if (!del2_asiaRange || !del2_asiaRange.ok) {
    return { ok: false, reason: "Asia range not available for classification" };
  }

  const closePos = del2_asiaRange.asiaClosePosInRange;
  let asiaDir = "UNCLEAR";
  if (typeof closePos === "number" && Number.isFinite(closePos)) {
    if (closePos >= 0.6) asiaDir = "BULLISH";
    else if (closePos <= 0.4) asiaDir = "BEARISH";
  }

  const bb = String(baseBias || "").trim(); // "Bullish" / "Bearish" / "Ranging"
  const baseIsDirectional = bb === "Bullish" || bb === "Bearish";

  let asiaState = "ASIA_UKLAR";
  if (baseIsDirectional) {
    if (bb === "Bullish" && asiaDir === "BULLISH") asiaState = "ASIA_FOLGER_DAILY";
    else if (bb === "Bearish" && asiaDir === "BEARISH") asiaState = "ASIA_FOLGER_DAILY";
    else if (bb === "Bullish" && asiaDir === "BEARISH") asiaState = "ASIA_MOT_DAILY";
    else if (bb === "Bearish" && asiaDir === "BULLISH") asiaState = "ASIA_MOT_DAILY";
    else asiaState = "ASIA_UKLAR";
  }

  // Guidance text (short; report-friendly)
  let guidance = "Asia context: no clear direction → lower conviction / protection.";
  if (asiaState === "ASIA_FOLGER_DAILY") {
    guidance = "Asia følger daily bias → bias styrket (cleaner day odds).";
  } else if (asiaState === "ASIA_MOT_DAILY") {
    guidance = "Asia mot daily bias → behold daily bias, forvent liquidity-sweep før levering.";
  }

  return {
    ok: true,
    baseBias: baseIsDirectional ? bb : "Ranging/Unknown",
    asiaDir, // BULLISH / BEARISH / UNCLEAR (derived from close position in range)
    asiaState, // ASIA_FOLGER_DAILY / ASIA_MOT_DAILY / ASIA_UKLAR
    guidance,
    statsRef: ASIA_STATS_REF,
  };
}

/**
 * Public API: computeDel2Asia
 *
 * Args:
 * - latest5M: array of 5m candles (UTC datetimes)
 * - nowUtcStr: current time (UTC string) used as "as-of" (no lookahead)
 * - baseBias (optional): "Bullish" | "Bearish" | "Ranging" (from Del 1)
 *
 * Output:
 * - del2_asiaRange: facts
 * - del2_asiaBreak: first break after 07:00 AS-OF nowUtcStr
 * - del2_asiaState: follows/mot/uklar classification + guidance + stats anchors
 *
 * Gate:
 * - Before 07:00 Oslo on the target date, we return ok:false for state (and optionally for range)
 *   because Asia window isn't complete yet.
 */
function computeDel2Asia(latest5M, nowUtcStr, baseBias) {
  const nowMs = parseUtcDatetimeToMs(nowUtcStr);
  if (nowMs == null) {
    return {
      del2_asiaRange: { ok: false, reason: "Invalid nowUtc for DEL2" },
      del2_asiaBreak: { ok: false, reason: "Invalid nowUtc for DEL2" },
      del2_asiaState: { ok: false, reason: "Invalid nowUtc for DEL2" },
    };
  }

  const targetOsloDate = getOsloDateKeyFromMs(nowMs);
  const after0700 = isOsloTimeAtOrAfter(nowMs, 7, 0);

  // Always compute range facts if possible (even before 07:00),
  // BUT we will "gate" the state/guidance until >=07:00.
  const del2_asiaRange = computeAsiaRange_0200_0659_Oslo(latest5M, nowUtcStr);

  // Break is meaningful only after 07:00; before that we return NONE (so far) or gated.
  const del2_asiaBreak = after0700
    ? computeAsiaBreakAfter0700_Oslo_AsOf(latest5M, del2_asiaRange, nowUtcStr)
    : {
        ok: true,
        checkedFromOslo: "07:00",
        asOfUtc: new Date(nowMs).toISOString(),
        asOfOslo: formatMsInOslo(nowMs),
        breakDirection: "NONE",
        note: "Gated: Asia break check starts at 07:00 Oslo; before that, treat as NONE (so far).",
      };

  // State/guidance should NOT be available before >=07:00 Oslo.
  const del2_asiaState = after0700
    ? classifyAsiaState(del2_asiaRange, baseBias)
    : {
        ok: false,
        reason: `Asia context is available only after 07:00 Oslo (target date ${targetOsloDate}).`,
        targetOsloDate,
        availableFromOslo: "07:00",
        asOfOslo: formatMsInOslo(nowMs),
        statsRef: ASIA_STATS_REF,
      };

  return { del2_asiaRange, del2_asiaBreak, del2_asiaState };
}

function del2_asiaRangePromptBlock() {
  return `
DEL 2 – ASIA RANGE + ASIA CONTEXT (RULES)

SESSION (Oslo time)
- Asia window: 02:00–06:59 Oslo
- Compute Asia High/Low from 5M candles in that window
- Asia Range = High − Low
- Also keep (best-effort): Asia Open (first candle open) and Asia Close (last candle close)

AVAILABILITY / GATING
- Asia context/state can be produced ONLY after 07:00 Oslo (same Oslo date).
- You may request the Asia context any time after 07:00 (07:05 / 09:30 / 10:30 / later). It should be stable for that day.

ASIA STATE (relative to Daily bias; reference only)
- Determine Asia directional feel using Asia Close position in range:
  - closePos >= 0.60 → Asia bullish
  - closePos <= 0.40 → Asia bearish
  - else → Asia unclear
- If Daily bias is directional (Bullish/Bearish):
  - Asia follows daily bias → ASIA_FOLGER_DAILY
  - Asia against daily bias → ASIA_MOT_DAILY
  - otherwise → ASIA_UKLAR
- If Daily bias is Ranging/unknown → ASIA_UKLAR

BREAK CHECK (Oslo time; AS-OF, no lookahead)
- From 07:00 Oslo onward: find FIRST 5M candle that breaks:
  - UP if candle.high > Asia High
  - DOWN if candle.low < Asia Low
- Report break status AS-OF 'nowUtc' (ignore any candles after nowUtc).
- If no break up to now: Break = NONE

OUTPUT (for report/debug)
- Asia Date (Oslo)
- Asia High / Asia Low / Asia Range
- Candles count
- Start/End timestamps (Oslo + UTC)
- Asia Open/Close (if available) + close-position-in-range (if available)
- Asia state (FOLGER/MOT/UKLAR) + short guidance
- Post-07:00 break (AS-OF): direction + timestamp (Oslo+UTC) + price, or NONE
- Include internal stats anchors (EURUSD 2024–2025):
  - followsDaily ≈ 82%
  - againstDaily ≈ 71%
  - unclear ≈ 61%
  - shares ≈ 31/38/31

STRICT
- No extra explanations beyond the fields above
- Keep it clean
`.trim();
}

module.exports = {
  computeDel2Asia,
  del2_asiaRangePromptBlock,
  // exporting helpers can be handy for tests/debug, but optional:
  ASIA_STATS_REF,
};
