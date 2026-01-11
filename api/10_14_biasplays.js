// 10_14_biasplays.js
// v1.2.1 (London 10–14) — Bias plays ONLY
//
// Contains:
// - BiasAsiaBreak  (formerly Type A)
// - BiasAsiaNoBreak (formerly Type B) with Variant 1 (sweep) + Variant 2 (6-pip fake)
//
// This module does NOT fetch data. It only consumes:
// - daily: output from daily_bias.js (computeDailyBias)
// - sessions: pre-sliced 5M sessions (Oslo time) from report.js
// - pdh/pdl: yesterday high/low (PDH/PDL) from D-1
//
// Output contract (deterministic):
// {
//   ok: true,
//   trade: "Yes"/"No",
//   play: "BiasAsiaBreak" | "BiasAsiaNoBreak" | null,
//   bias09: "Bullish"/"Bearish"/"Ranging",
//   bias10: "Bullish"/"Bearish"/"Ranging",
//   londonScenario: one of allowed,
//   reason: string,
//   debug: { ... }
// }

const PIP = 0.0001;

// Allowed London scenario strings (locked)
const ALLOWED_SCENARIOS = new Set([
  "slightly up first → then price down",
  "slightly down first → then price up",
  "range / back and forth",
  "double tap → mean reversion",
  "no trade (messy day)",
]);

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function pipsDiff(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(a - b) / PIP;
}

function scenarioForDirectionalMove(dir /* "UP"|"DOWN" */) {
  if (dir === "UP") return "slightly down first → then price up";
  if (dir === "DOWN") return "slightly up first → then price down";
  return "no trade (messy day)";
}

// ---------- Helpers: window/levels ----------
function getWindowStats(windowObj) {
  // windowObj = { rows: [...], stats: {...} }
  const rows = windowObj?.rows || [];
  const st = windowObj?.stats || null;
  return { rows, st };
}

/**
 * Detect a "sweep" of a given level inside a window:
 * - HIGH sweep: any candle.high > level AND later (or same after) a close < level
 * - LOW sweep: any candle.low < level AND later close > level
 * Returns: { swept, sweepMs, sweepExtreme }
 */
function detectSweepOfLevel(rows, level, side /* "HIGH"|"LOW" */) {
  if (!Array.isArray(rows) || rows.length === 0) return { swept: false, sweepMs: null, sweepExtreme: null };
  if (!Number.isFinite(level)) return { swept: false, sweepMs: null, sweepExtreme: null };

  if (side === "HIGH") {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!Number.isFinite(r.high) || !Number.isFinite(r.close)) continue;
      if (r.high > level) {
        for (let j = i; j < rows.length; j++) {
          if (Number.isFinite(rows[j].close) && rows[j].close < level) {
            return { swept: true, sweepMs: r.ms ?? null, sweepExtreme: r.high };
          }
        }
        return { swept: false, sweepMs: null, sweepExtreme: null };
      }
    }
    return { swept: false, sweepMs: null, sweepExtreme: null };
  }

  // LOW
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!Number.isFinite(r.low) || !Number.isFinite(r.close)) continue;
    if (r.low < level) {
      for (let j = i; j < rows.length; j++) {
        if (Number.isFinite(rows[j].close) && rows[j].close > level) {
          return { swept: true, sweepMs: r.ms ?? null, sweepExtreme: r.low };
        }
      }
      return { swept: false, sweepMs: null, sweepExtreme: null };
    }
  }
  return { swept: false, sweepMs: null, sweepExtreme: null };
}

// ---------- Bias Premise: Asia breaks PDH/PDL in bias direction ----------
function asiaBreaksPDH_or_PDL_inBiasDirection(baseBias, asiaRows, pdh, pdl) {
  if (!Array.isArray(asiaRows) || asiaRows.length === 0) return { broke: false, breakMs: null, direction: "NONE" };
  if (baseBias !== "Bullish" && baseBias !== "Bearish") return { broke: false, breakMs: null, direction: "NONE" };
  if (!Number.isFinite(pdh) || !Number.isFinite(pdl)) return { broke: false, breakMs: null, direction: "NONE" };

  if (baseBias === "Bullish") {
    for (const r of asiaRows) {
      if (Number.isFinite(r.high) && r.high > pdh) {
        return { broke: true, breakMs: r.ms ?? null, direction: "UP" };
      }
    }
    return { broke: false, breakMs: null, direction: "NONE" };
  }

  // Bearish
  for (const r of asiaRows) {
    if (Number.isFinite(r.low) && r.low < pdl) {
      return { broke: true, breakMs: r.ms ?? null, direction: "DOWN" };
    }
  }
  return { broke: false, breakMs: null, direction: "NONE" };
}

// "No reclaim" after Asia break until 10:00 (Oslo) — proxy logic using rowsSameDay up to 09:59
function noReclaimAfterAsiaBreakUntil10(baseBias, rowsSameDay, breakMs, pdh, pdl) {
  if (!breakMs) return false;
  if (!Array.isArray(rowsSameDay) || rowsSameDay.length === 0) return true;

  // rowsSameDay is already sliced by target Oslo date and as-of effectiveNow
  // We assume report.js passes it, and that report.js already excludes after effectiveNow.
  // We still only care up to 09:59.
  const until10 = rowsSameDay.filter((r) => Number.isFinite(r.ms) && r.ms >= breakMs && r.osloHHMM && r.osloHHMM < "10:00");

  if (until10.length === 0) return true;

  if (baseBias === "Bullish") {
    // reclaim if any low <= PDH after break
    for (const r of until10) {
      if (Number.isFinite(r.low) && r.low <= pdh) return false;
    }
    return true;
  }

  if (baseBias === "Bearish") {
    // reclaim if any high >= PDL after break
    for (const r of until10) {
      if (Number.isFinite(r.high) && r.high >= pdl) return false;
    }
    return true;
  }

  return false;
}

// ---------- Triggers in 09–10 (London setup) ----------
function biasAsiaBreak_trigger(baseBias, sessions) {
  const { rows: ldRows } = getWindowStats(sessions?.londonSetup);
  const { st: asiaSt } = getWindowStats(sessions?.asia);
  const { st: ffSt } = getWindowStats(sessions?.frankfurt);

  if (!ldRows.length || !asiaSt || !ffSt) return { ok: false, reason: "missing_sessions" };

  if (baseBias === "Bullish") {
    // continuation signal in bias direction: sweep of Asia Low or Frankfurt Low
    const s1 = detectSweepOfLevel(ldRows, asiaSt.low, "LOW");
    const s2 = detectSweepOfLevel(ldRows, ffSt.low, "LOW");
    if (s1.swept || s2.swept) return { ok: true, kind: "sweep_low_then_up", sweeps: { asiaLow: s1, ffLow: s2 } };
    return { ok: false, reason: "no_sweep_of_asia_or_ff_low" };
  }

  if (baseBias === "Bearish") {
    // continuation signal in bias direction: sweep of Asia High or Frankfurt High
    const s1 = detectSweepOfLevel(ldRows, asiaSt.high, "HIGH");
    const s2 = detectSweepOfLevel(ldRows, ffSt.high, "HIGH");
    if (s1.swept || s2.swept) return { ok: true, kind: "sweep_high_then_down", sweeps: { asiaHigh: s1, ffHigh: s2 } };
    return { ok: false, reason: "no_sweep_of_asia_or_ff_high" };
  }

  return { ok: false, reason: "no_directional_bias" };
}

// Type B Variant 1 (existing): London takes Asia/FF extreme then fails (closes against the push)
function biasAsiaNoBreak_variant1(baseBias, sessions) {
  const { rows: ldRows } = getWindowStats(sessions?.londonSetup);
  const { st: asiaSt } = getWindowStats(sessions?.asia);
  const { st: ffSt } = getWindowStats(sessions?.frankfurt);

  if (!ldRows.length || !asiaSt || !ffSt) return { ok: false, reason: "missing_sessions" };

  const ldOpen = ldRows[0].open;
  const ldClose = ldRows[ldRows.length - 1].close;

  if (baseBias === "Bullish") {
    const tookHigh = ldRows.some((r) => Number.isFinite(r.high) && r.high > asiaSt.high) || ldRows.some((r) => Number.isFinite(r.high) && r.high > ffSt.high);
    const failedUp = Number.isFinite(ldOpen) && Number.isFinite(ldClose) ? ldClose < ldOpen : false;
    return { ok: tookHigh && failedUp, kind: tookHigh && failedUp ? "london_up_fake_then_down" : "none", tookHigh, failedUp };
  }

  if (baseBias === "Bearish") {
    const tookLow = ldRows.some((r) => Number.isFinite(r.low) && r.low < asiaSt.low) || ldRows.some((r) => Number.isFinite(r.low) && r.low < ffSt.low);
    const failedDown = Number.isFinite(ldOpen) && Number.isFinite(ldClose) ? ldClose > ldOpen : false;
    return { ok: tookLow && failedDown, kind: tookLow && failedDown ? "london_down_fake_then_up" : "none", tookLow, failedDown };
  }

  return { ok: false, reason: "no_directional_bias" };
}

// Type B Variant 2 (NEW): 6-pip push from London open against bias, then close fails, and London range >= 8 pips
function biasAsiaNoBreak_variant2(baseBias, sessions, minPushPips = 6, minRangePips = 8) {
  const { rows: ldRows, st: ldSt } = getWindowStats(sessions?.londonSetup);
  if (!ldRows.length || !ldSt) return { ok: false, reason: "missing_london" };

  const ldOpen = ldRows[0].open;
  const ldClose = ldRows[ldRows.length - 1].close;
  if (!Number.isFinite(ldOpen) || !Number.isFinite(ldClose)) return { ok: false, reason: "missing_open_close" };

  const ldRangePips = ldSt.rangePips;
  if (!(Number.isFinite(ldRangePips) && ldRangePips >= minRangePips)) {
    return { ok: false, reason: "london_range_too_small", ldRangePips };
  }

  // Measure max excursion from London open during 09–10
  let maxUp = ldOpen;
  let maxDown = ldOpen;

  for (const r of ldRows) {
    if (Number.isFinite(r.high) && r.high > maxUp) maxUp = r.high;
    if (Number.isFinite(r.low) && r.low < maxDown) maxDown = r.low;
  }

  const upPips = pipsDiff(ldOpen, maxUp);
  const downPips = pipsDiff(ldOpen, maxDown);

  if (baseBias === "Bearish") {
    // Must push UP against bearish bias
    const pushedEnough = Number.isFinite(upPips) && upPips >= minPushPips;
    const fail = ldClose <= ldOpen; // close fails (doesn't hold up)
    return {
      ok: pushedEnough && fail,
      kind: pushedEnough && fail ? "london_push_up_fail_then_down" : "none",
      pushedEnough,
      fail,
      upPips,
      downPips,
      ldRangePips,
      thresholds: { minPushPips, minRangePips },
    };
  }

  if (baseBias === "Bullish") {
    // Must push DOWN against bullish bias
    const pushedEnough = Number.isFinite(downPips) && downPips >= minPushPips;
    const fail = ldClose >= ldOpen; // close fails (doesn't hold down)
    return {
      ok: pushedEnough && fail,
      kind: pushedEnough && fail ? "london_push_down_fail_then_up" : "none",
      pushedEnough,
      fail,
      upPips,
      downPips,
      ldRangePips,
      thresholds: { minPushPips, minRangePips },
    };
  }

  return { ok: false, reason: "no_directional_bias" };
}

// ---------- Main public entry ----------
function runBiasPlays(daily, sessions, ctx) {
  // ctx: { pdh, pdl, rowsSameDay, weekdayOslo, marketClosed }
  const baseBias = String(daily?.baseBias || "").trim();
  const bias09 = daily?.bias09 || baseBias || "Ranging";
  const bias10 = daily?.bias10 || baseBias || "Ranging";

  const pdh = toNum(ctx?.pdh);
  const pdl = toNum(ctx?.pdl);
  const rowsSameDay = Array.isArray(ctx?.rowsSameDay) ? ctx.rowsSameDay : [];
  const weekdayOslo = String(ctx?.weekdayOslo || "");
  const marketClosed = !!ctx?.marketClosed;

  // Hard stop if market closed (live). Backtest passes marketClosed=false.
  if (marketClosed) {
    return {
      ok: true,
      trade: "No",
      play: null,
      bias09,
      bias10,
      londonScenario: "no trade (messy day)",
      reason: "market_closed",
      debug: { marketClosed: true },
    };
  }

  // If not a directional bias day => Bias plays are not eligible.
  if (baseBias !== "Bullish" && baseBias !== "Bearish") {
    return {
      ok: true,
      trade: "No",
      play: null,
      bias09,
      bias10,
      londonScenario: "no trade (messy day)",
      reason: "not_a_bias_day",
      debug: { baseBias },
    };
  }

  // Asia/FF/London required
  const { rows: asiaRows, st: asiaSt } = getWindowStats(sessions?.asia);
  const { st: ffSt } = getWindowStats(sessions?.frankfurt);
  const { st: ldSt } = getWindowStats(sessions?.londonSetup);

  if (!asiaRows.length || !asiaSt || !ffSt || !ldSt) {
    return {
      ok: true,
      trade: "No",
      play: null,
      bias09,
      bias10,
      londonScenario: "no trade (messy day)",
      reason: "missing_sessions",
      debug: { haveAsia: !!asiaSt, haveFF: !!ffSt, haveLondon: !!ldSt },
    };
  }

  // ---------- BiasAsiaBreak ----------
  const asiaBreak = asiaBreaksPDH_or_PDL_inBiasDirection(baseBias, asiaRows, pdh, pdl);

  if (asiaBreak.broke) {
    const noReclaim = noReclaimAfterAsiaBreakUntil10(baseBias, rowsSameDay, asiaBreak.breakMs, pdh, pdl);
    if (!noReclaim) {
      return {
        ok: true,
        trade: "No",
        play: null,
        bias09,
        bias10,
        londonScenario: "no trade (messy day)",
        reason: "asia_break_but_reclaim",
        debug: { baseBias, pdh, pdl, asiaBreak, noReclaim },
      };
    }

    const trig = biasAsiaBreak_trigger(baseBias, sessions);
    if (trig.ok) {
      const dir = baseBias === "Bullish" ? "UP" : "DOWN";
      const scenario = scenarioForDirectionalMove(dir);
      return {
        ok: true,
        trade: "Yes",
        play: "BiasAsiaBreak",
        bias09,
        bias10,
        londonScenario: scenario,
        reason: "bias_asia_break_triggered",
        debug: { baseBias, pdh, pdl, asiaBreak, noReclaim, trigger: trig },
      };
    }

    return {
      ok: true,
      trade: "No",
      play: null,
      bias09,
      bias10,
      londonScenario: "no trade (messy day)",
      reason: "bias_asia_break_no_london_trigger",
      debug: { baseBias, pdh, pdl, asiaBreak, noReclaim, trigger: trig },
    };
  }

  // ---------- BiasAsiaNoBreak (Type B) ----------
  // Premise: Asia did NOT break PDH/PDL in bias direction (we are here), so try London fake.

  const v1 = biasAsiaNoBreak_variant1(baseBias, sessions);
  if (v1.ok) {
    const dir = baseBias === "Bullish" ? "UP" : "DOWN";
    const scenario = scenarioForDirectionalMove(dir);
    return {
      ok: true,
      trade: "Yes",
      play: "BiasAsiaNoBreak",
      bias09,
      bias10,
      londonScenario: scenario,
      reason: "bias_asia_no_break_variant1",
      debug: { baseBias, pdh, pdl, variant: "v1", v1 },
    };
  }

  const v2 = biasAsiaNoBreak_variant2(baseBias, sessions, 6, 8);
  if (v2.ok) {
    const dir = baseBias === "Bullish" ? "UP" : "DOWN";
    const scenario = scenarioForDirectionalMove(dir);
    return {
      ok: true,
      trade: "Yes",
      play: "BiasAsiaNoBreak",
      bias09,
      bias10,
      londonScenario: scenario,
      reason: "bias_asia_no_break_variant2",
      debug: { baseBias, pdh, pdl, variant: "v2", v2 },
    };
  }

  // Wednesday + wrong-side hard filter belongs in report.js global filters (Step 4),
  // because it depends on "wrong-side breaks first" logic and shared context.
  // For now we only report that no signal was found.
  return {
    ok: true,
    trade: "No",
    play: null,
    bias09,
    bias10,
    londonScenario: "no trade (messy day)",
    reason: "bias_day_no_signal",
    debug: { baseBias, pdh, pdl, v1, v2, weekdayOslo },
  };
}

module.exports = {
  runBiasPlays,
  ALLOWED_SCENARIOS,
};
