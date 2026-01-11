// daily_bias.js
// DEL 1 – DAILY BIAS (v1.2 LOCKED)
//
// Rules:
// - Uses ONLY D-1 and D-2 DAILY candles
// - No intraday data
// - Bias NEVER changes intraday
// - Output is deterministic and minimal
//
// This file is intentionally isolated so Daily logic
// can be modified later without touching intraday logic.

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function computeClosePosition(candle) {
  const high = toNum(candle.high);
  const low = toNum(candle.low);
  const close = toNum(candle.close);
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return null;
  }
  const range = high - low;
  if (range <= 0) return null;
  return (close - low) / range;
}

function isInsideDay(d1, d2) {
  return (
    toNum(d1.high) <= toNum(d2.high) &&
    toNum(d1.low) >= toNum(d2.low)
  );
}

function overlapPctOfSmallerRange(d1, d2) {
  const h1 = toNum(d1.high);
  const l1 = toNum(d1.low);
  const h2 = toNum(d2.high);
  const l2 = toNum(d2.low);

  if (![h1, l1, h2, l2].every(Number.isFinite)) return null;

  const overlapHigh = Math.min(h1, h2);
  const overlapLow = Math.max(l1, l2);
  const overlap = Math.max(0, overlapHigh - overlapLow);

  const r1 = h1 - l1;
  const r2 = h2 - l2;
  const smaller = Math.min(r1, r2);

  if (smaller <= 0) return null;
  return overlap / smaller;
}

function scoreDaily(closePos, inside, overlapHeavy) {
  if (closePos === null) return 1;

  // Score 3
  if (
    (closePos >= 0.60 || closePos <= 0.40) &&
    !inside &&
    !overlapHeavy
  ) {
    return 3;
  }

  // Score 2
  if (
    (closePos >= 0.55 && closePos < 0.60) ||
    (closePos > 0.40 && closePos <= 0.45) ||
    ((closePos >= 0.60 || closePos <= 0.40) && (inside || overlapHeavy))
  ) {
    return 2;
  }

  // Score 1
  return 1;
}

function baseBiasFromClosePos(closePos) {
  if (closePos === null) return "Ranging";
  if (closePos >= 0.60) return "Bullish";
  if (closePos <= 0.40) return "Bearish";
  return "Ranging";
}

/**
 * PUBLIC API
 *
 * @param {Array} dailyCandles - array of DAILY candles (UTC datetimes)
 * @param {String|null} asofDate - optional YYYY-MM-DD (Oslo date logic handled by caller)
 *
 * Caller responsibility:
 * - Ensure dailyCandles contains D-1 and D-2 for the asof date
 * - Ensure correct candle selection (this function does NOT filter by date)
 */
function computeDailyBias(d1, d2) {
  if (!d1 || !d2) {
    return {
      ok: false,
      reason: "Missing D-1 or D-2 candle",
    };
  }

  const closePos = computeClosePosition(d1);
  const inside = isInsideDay(d1, d2);

  const overlapPct = overlapPctOfSmallerRange(d1, d2);
  const overlapHeavy =
    typeof overlapPct === "number" && overlapPct >= 0.70;

  const score = scoreDaily(closePos, inside, overlapHeavy);
  const baseBias = baseBiasFromClosePos(closePos);

  const trade =
    score === 1 ? "No" : "Yes";

  return {
    ok: true,

    // Core outputs (used by rest of system)
    score,                 // 1 / 2 / 3
    trade,                 // Yes / No
    baseBias,              // Bullish / Bearish / Ranging

    // Bias fields (no intraday refinement here)
    bias09: baseBias,
    bias10: baseBias,

    // Debug / transparency (safe to log)
    closePosition: closePos,
    insideDay: inside,
    overlapPct,
    overlapHeavy,
    d1Date: d1.datetime || null,
    d2Date: d2.datetime || null,
  };
}

module.exports = {
  computeDailyBias,
};
