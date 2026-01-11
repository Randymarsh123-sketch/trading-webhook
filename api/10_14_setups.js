// 10_14_setups.js
// v1.2.1 (London 10–14) — Non-bias setups + overlays
//
// Contains:
// - FrankLondonMW (formerly Type C): double test → mean reversion (ONLY when Daily baseBias === "Ranging")
// - ManipulationSweepReverseA / ManipulationSweepReverseB (overlays): Frankfurt manipulation → London sweep opposite → 10–14 move back in Frankfurt direction
//
// This module does NOT fetch data. It only consumes:
// - daily: output from daily_bias.js (computeDailyBias)
// - sessions: pre-sliced 5M sessions (Oslo time) from report.js
// - ctx: shared context from report.js (pdh/pdl, rowsSameDay, weekdayOslo, marketClosed)
//
// Output contract (deterministic):
// {
//   ok: true,
//   trade: "Yes"/"No",
//   play: "FrankLondonMW" | "ManipulationSweepReverseA" | "ManipulationSweepReverseB" | null,
//   bias09: "Bullish"/"Bearish"/"Ranging",
//   bias10: "Bullish"/"Bearish"/"Ranging",
//   londonScenario: one of allowed,
//   reason: string,
//   debug: { ... }
// }

const PIP = 0.0001;

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

function pips(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(a - b) / PIP;
}

function getWindowStats(windowObj) {
  const rows = windowObj?.rows || [];
  const st = windowObj?.stats || null;
  return { rows, st };
}

function findFirstBreak(rows, level, side /* "UP"|"DOWN" */) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (!Number.isFinite(level)) return null;

  for (const r of rows) {
    if (!r) continue;
    if (side === "UP") {
      if (Number.isFinite(r.high) && r.high > level) return r;
    } else {
      if (Number.isFinite(r.low) && r.low < level) return r;
    }
  }
  return null;
}

function hasAcceptanceBeyond(rows, level, side /* "UP"|"DOWN" */) {
  // "acceptance" = any close beyond level
  if (!Array.isArray(rows) || rows.length === 0) return false;
  if (!Number.isFinite(level)) return false;

  for (const r of rows) {
    if (!Number.isFinite(r.close)) continue;
    if (side === "UP" && r.close > level) return true;
    if (side === "DOWN" && r.close < level) return true;
  }
  return false;
}

function detectTestFail(rows, level, side /* "UP"|"DOWN" */) {
  // "test" = wick beyond level
  // "fail" = after test, a close returns back inside (<= level for UP, >= level for DOWN)
  // AND no acceptance beyond (no close beyond level) in that window.
  if (!Array.isArray(rows) || rows.length === 0) {
    return { tested: false, failed: false, firstTest: null };
  }
  if (!Number.isFinite(level)) {
    return { tested: false, failed: false, firstTest: null };
  }

  const firstTest = findFirstBreak(rows, level, side);
  if (!firstTest) return { tested: false, failed: false, firstTest: null };

  const accepted = hasAcceptanceBeyond(rows, level, side);
  if (accepted) {
    return { tested: true, failed: false, firstTest };
  }

  // No acceptance; now confirm it "fails" by closing back inside after the test candle
  let afterTest = false;
  for (const r of rows) {
    if (!r || !Number.isFinite(r.ms)) continue;
    if (r.ms === firstTest.ms) afterTest = true;
    if (!afterTest) continue;

    if (!Number.isFinite(r.close)) continue;

    if (side === "UP") {
      if (r.close <= level) return { tested: true, failed: true, firstTest };
    } else {
      if (r.close >= level) return { tested: true, failed: true, firstTest };
    }
  }

  // If it never clearly closes back inside, treat as not-failed (ambiguous)
  return { tested: true, failed: false, firstTest };
}

function holdsPDH_or_PDL_before10(rowsSameDayPre10, pdh, pdl) {
  // Disqualifier for FrankLondonMW:
  // "Ingen PDH eller PDL-break som holder"
  //
  // We implement "holds" as: any candle closes beyond PDH/PDL before 10:00.
  if (!Array.isArray(rowsSameDayPre10) || rowsSameDayPre10.length === 0) {
    return { holds: false, which: "NONE" };
  }
  const PDH = toNum(pdh);
  const PDL = toNum(pdl);
  if (!Number.isFinite(PDH) || !Number.isFinite(PDL)) return { holds: false, which: "NONE" };

  for (const r of rowsSameDayPre10) {
    if (!r || !Number.isFinite(r.close) || !r.osloHHMM) continue;
    if (r.osloHHMM >= "10:00") continue;
    if (r.close > PDH) return { holds: true, which: "PDH" };
    if (r.close < PDL) return { holds: true, which: "PDL" };
  }
  return { holds: false, which: "NONE" };
}

// -------------------- FrankLondonMW (formerly Type C) --------------------
function runFrankLondonMW(daily, sessions, ctx) {
  const baseBias = String(daily?.baseBias || "").trim();
  const bias09 = daily?.bias09 || baseBias || "Ranging";
  const bias10 = daily?.bias10 || baseBias || "Ranging";

  if (baseBias !== "Ranging") {
    return {
      ok: true,
      trade: "No",
      play: null,
      bias09,
      bias10,
      londonScenario: "no trade (messy day)",
      reason: "franklondonmw_only_on_ranging_days",
      debug: { baseBias },
    };
  }

  const marketClosed = !!ctx?.marketClosed;
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

  const { st: asiaSt, rows: asiaRows } = getWindowStats(sessions?.asia);
  const { rows: ffRows } = getWindowStats(sessions?.frankfurt);
  const { rows: ldRows } = getWindowStats(sessions?.londonSetup);

  if (!asiaSt || !asiaRows.length || !ffRows.length || !ldRows.length) {
    return {
      ok: true,
      trade: "No",
      play: null,
      bias09,
      bias10,
      londonScenario: "no trade (messy day)",
      reason: "missing_sessions",
      debug: { haveAsia: !!asiaSt, ffCount: ffRows.length, ldCount: ldRows.length },
    };
  }

  // Disqualifier: PDH/PDL "holds" before 10:00
  const rowsSameDay = Array.isArray(ctx?.rowsSameDay) ? ctx.rowsSameDay : [];
  const holdCheck = holdsPDH_or_PDL_before10(rowsSameDay, ctx?.pdh, ctx?.pdl);
  if (holdCheck.holds) {
    return {
      ok: true,
      trade: "No",
      play: null,
      bias09,
      bias10,
      londonScenario: "no trade (messy day)",
      reason: "pdh_pdl_break_holds_before_10",
      debug: { holdCheck },
    };
  }

  const asiaHigh = toNum(asiaSt.high);
  const asiaLow = toNum(asiaSt.low);
  if (!Number.isFinite(asiaHigh) || !Number.isFinite(asiaLow)) {
    return {
      ok: true,
      trade: "No",
      play: null,
      bias09,
      bias10,
      londonScenario: "no trade (messy day)",
      reason: "invalid_asia_levels",
      debug: { asiaHigh, asiaLow },
    };
  }

  // We look for "double tap" of either AsiaHigh or AsiaLow:
  // - Frankfurt first test fails
  // - London second test fails
  //
  // Then trade is opposite direction (mean reversion / rotation).
  const ffHighTest = detectTestFail(ffRows, asiaHigh, "UP");
  const ldHighTest = detectTestFail(ldRows, asiaHigh, "UP");

  const ffLowTest = detectTestFail(ffRows, asiaLow, "DOWN");
  const ldLowTest = detectTestFail(ldRows, asiaLow, "DOWN");

  const highDoubleFail = ffHighTest.failed && ldHighTest.failed;
  const lowDoubleFail = ffLowTest.failed && ldLowTest.failed;

  // If both sides double-fail (rare), day is messy (skip)
  if (highDoubleFail && lowDoubleFail) {
    return {
      ok: true,
      trade: "No",
      play: null,
      bias09,
      bias10,
      londonScenario: "no trade (messy day)",
      reason: "both_sides_double_fail_messy",
      debug: { ffHighTest, ldHighTest, ffLowTest, ldLowTest },
    };
  }

  if (highDoubleFail) {
    // Second attempt at AsiaHigh failed -> take opposite (down)
    return {
      ok: true,
      trade: "Yes",
      play: "FrankLondonMW",
      bias09,
      bias10,
      londonScenario: "double tap → mean reversion",
      reason: "double_test_asia_high_failed",
      debug: {
        side: "ASIA_HIGH",
        ffHighTest,
        ldHighTest,
        holdCheck,
      },
    };
  }

  if (lowDoubleFail) {
    // Second attempt at AsiaLow failed -> take opposite (up)
    return {
      ok: true,
      trade: "Yes",
      play: "FrankLondonMW",
      bias09,
      bias10,
      londonScenario: "double tap → mean reversion",
      reason: "double_test_asia_low_failed",
      debug: {
        side: "ASIA_LOW",
        ffLowTest,
        ldLowTest,
        holdCheck,
      },
    };
  }

  return {
    ok: true,
    trade: "No",
    play: null,
    bias09,
    bias10,
    londonScenario: "no trade (messy day)",
    reason: "no_double_test_fail",
    debug: { ffHighTest, ldHighTest, ffLowTest, ldLowTest, holdCheck },
  };
}

// -------------------- ManipulationSweepReverse overlays --------------------
function classifyFrankfurtManipulation(ffRows) {
  // Conservative, objective heuristic:
  // - Determine direction by where Frankfurt CLOSE sits inside Frankfurt range.
  // - Needs minimum Frankfurt range (to avoid noise).
  //
  // Returns:
  // { ok, dir: "UP"|"DOWN"|null, ffHigh, ffLow, ffOpen, ffClose, ffRangePips, closePosInRange }
  if (!Array.isArray(ffRows) || ffRows.length < 3) {
    return { ok: false, reason: "not_enough_frankfurt_rows" };
  }

  const ffOpen = ffRows[0].open;
  const ffClose = ffRows[ffRows.length - 1].close;

  let ffHigh = -Infinity;
  let ffLow = Infinity;

  for (const r of ffRows) {
    if (Number.isFinite(r.high) && r.high > ffHigh) ffHigh = r.high;
    if (Number.isFinite(r.low) && r.low < ffLow) ffLow = r.low;
  }

  const range = ffHigh - ffLow;
  const ffRangePips = Number.isFinite(range) && range > 0 ? range / PIP : null;

  if (!(Number.isFinite(ffRangePips) && ffRangePips >= 8)) {
    return { ok: false, reason: "frankfurt_range_too_small", ffRangePips };
  }

  const closePosInRange =
    Number.isFinite(ffClose) && Number.isFinite(ffLow) && Number.isFinite(range) && range > 0
      ? (ffClose - ffLow) / range
      : null;

  // Dir thresholds (conservative):
  // - UP manipulation if closes in top 30% of its range
  // - DOWN manipulation if closes in bottom 30%
  let dir = null;
  if (typeof closePosInRange === "number" && Number.isFinite(closePosInRange)) {
    if (closePosInRange >= 0.70) dir = "UP";
    else if (closePosInRange <= 0.30) dir = "DOWN";
  }

  if (!dir) {
    return {
      ok: false,
      reason: "frankfurt_not_directional_enough",
      ffHigh,
      ffLow,
      ffOpen,
      ffClose,
      ffRangePips,
      closePosInRange,
    };
  }

  return {
    ok: true,
    dir,
    ffHigh,
    ffLow,
    ffOpen,
    ffClose,
    ffRangePips,
    closePosInRange,
  };
}

function detectLondonSweepOpposite(ldRows, manipulation) {
  // If manipulation dir is UP, we want London to sweep BELOW Frankfurt low (opposite)
  // If dir is DOWN, we want London to sweep ABOVE Frankfurt high (opposite)
  if (!Array.isArray(ldRows) || ldRows.length === 0) return { ok: false, reason: "missing_london_rows" };
  if (!manipulation?.ok) return { ok: false, reason: "no_manipulation" };

  const dir = manipulation.dir;
  if (dir === "UP") {
    const level = manipulation.ffLow;
    const sweep = findFirstBreak(ldRows, level, "DOWN");
    if (!sweep) return { ok: false, reason: "no_sweep_of_frankfurt_low" };
    // confirm it returns back above the level within London setup (close > level)
    const returned = ldRows.some((r) => Number.isFinite(r.close) && r.close > level);
    if (!returned) return { ok: false, reason: "sweep_no_return_above_level" };
    return { ok: true, sweepSide: "LOW", level, sweepRow: sweep };
  }

  if (dir === "DOWN") {
    const level = manipulation.ffHigh;
    const sweep = findFirstBreak(ldRows, level, "UP");
    if (!sweep) return { ok: false, reason: "no_sweep_of_frankfurt_high" };
    // confirm it returns back below the level within London setup (close < level)
    const returned = ldRows.some((r) => Number.isFinite(r.close) && r.close < level);
    if (!returned) return { ok: false, reason: "sweep_no_return_below_level" };
    return { ok: true, sweepSide: "HIGH", level, sweepRow: sweep };
  }

  return { ok: false, reason: "invalid_dir" };
}

function reachesTargetWithoutBreakingSweep(payoffRows, sweepRow, dir /* "UP"|"DOWN" */, targetPips) {
  // We measure from the sweep extreme (the wick point) to payoff excursion.
  // Constraint: sweep extreme must not be broken again BEFORE target is reached.
  if (!Array.isArray(payoffRows) || payoffRows.length === 0) return { ok: false, reason: "missing_payoff_rows" };
  if (!sweepRow) return { ok: false, reason: "missing_sweep_row" };
  if (!Number.isFinite(targetPips)) return { ok: false, reason: "missing_target" };

  const sweepLow = toNum(sweepRow.low);
  const sweepHigh = toNum(sweepRow.high);

  if (dir === "UP") {
    if (!Number.isFinite(sweepLow)) return { ok: false, reason: "missing_sweep_low" };

    // Find earliest time we reach target: (payoffHigh - sweepLow) >= target
    let bestHigh = -Infinity;
    for (let i = 0; i < payoffRows.length; i++) {
      const r = payoffRows[i];
      if (Number.isFinite(r.high) && r.high > bestHigh) bestHigh = r.high;

      const movePips = pips(sweepLow, bestHigh);
      if (Number.isFinite(movePips) && movePips >= targetPips) {
        // ensure sweep low not broken before reaching target
        for (let j = 0; j <= i; j++) {
          const rr = payoffRows[j];
          if (Number.isFinite(rr.low) && rr.low < sweepLow) {
            return { ok: false, reason: "sweep_low_broken_before_target", movePips, targetPips };
          }
        }
        return { ok: true, movePips, targetPips };
      }
    }
    return { ok: false, reason: "target_not_reached" };
  }

  if (dir === "DOWN") {
    if (!Number.isFinite(sweepHigh)) return { ok: false, reason: "missing_sweep_high" };

    // earliest time we reach target: (sweepHigh - payoffLow) >= target
    let bestLow = Infinity;
    for (let i = 0; i < payoffRows.length; i++) {
      const r = payoffRows[i];
      if (Number.isFinite(r.low) && r.low < bestLow) bestLow = r.low;

      const movePips = pips(sweepHigh, bestLow);
      if (Number.isFinite(movePips) && movePips >= targetPips) {
        // ensure sweep high not broken before reaching target
        for (let j = 0; j <= i; j++) {
          const rr = payoffRows[j];
          if (Number.isFinite(rr.high) && rr.high > sweepHigh) {
            return { ok: false, reason: "sweep_high_broken_before_target", movePips, targetPips };
          }
        }
        return { ok: true, movePips, targetPips };
      }
    }
    return { ok: false, reason: "target_not_reached" };
  }

  return { ok: false, reason: "invalid_dir" };
}

function runManipulationSweepReverse(daily, sessions, ctx) {
  const baseBias = String(daily?.baseBias || "").trim();
  const bias09 = daily?.bias09 || baseBias || "Ranging";
  const bias10 = daily?.bias10 || baseBias || "Ranging";

  const marketClosed = !!ctx?.marketClosed;
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

  const { rows: ffRows } = getWindowStats(sessions?.frankfurt);
  const { rows: ldRows } = getWindowStats(sessions?.londonSetup);
  const { rows: payoffRows } = getWindowStats(sessions?.payoff);

  if (!ffRows.length || !ldRows.length || !payoffRows.length) {
    return {
      ok: true,
      trade: "No",
      play: null,
      bias09,
      bias10,
      londonScenario: "no trade (messy day)",
      reason: "missing_sessions",
      debug: { ffCount: ffRows.length, ldCount: ldRows.length, payoffCount: payoffRows.length },
    };
  }

  const manipulation = classifyFrankfurtManipulation(ffRows);
  if (!manipulation.ok) {
    return {
      ok: true,
      trade: "No",
      play: null,
      bias09,
      bias10,
      londonScenario: "no trade (messy day)",
      reason: "no_frankfurt_manipulation",
      debug: { manipulation },
    };
  }

  const sweep = detectLondonSweepOpposite(ldRows, manipulation);
  if (!sweep.ok) {
    return {
      ok: true,
      trade: "No",
      play: null,
      bias09,
      bias10,
      londonScenario: "no trade (messy day)",
      reason: "no_london_sweep_opposite",
      debug: { manipulation, sweep },
    };
  }

  // After sweep, we want move in original Frankfurt direction during payoff (10–14).
  // A quality: reaches 15 pips without breaking sweep extreme first.
  // B quality: reaches 25 pips without breaking sweep extreme first.
  const dir = manipulation.dir; // "UP" or "DOWN"
  const aCheck = reachesTargetWithoutBreakingSweep(payoffRows, sweep.sweepRow, dir, 15);
  const bCheck = reachesTargetWithoutBreakingSweep(payoffRows, sweep.sweepRow, dir, 25);

  if (bCheck.ok) {
    return {
      ok: true,
      trade: "Yes",
      play: "ManipulationSweepReverseB",
      bias09,
      bias10,
      londonScenario: dir === "UP" ? "slightly down first → then price up" : "slightly up first → then price down",
      reason: "overlay_b_reached_25pips",
      debug: { manipulation, sweep, aCheck, bCheck },
    };
  }

  if (aCheck.ok) {
    return {
      ok: true,
      trade: "Yes",
      play: "ManipulationSweepReverseA",
      bias09,
      bias10,
      londonScenario: dir === "UP" ? "slightly down first → then price up" : "slightly up first → then price down",
      reason: "overlay_a_reached_15pips",
      debug: { manipulation, sweep, aCheck, bCheck },
    };
  }

  return {
    ok: true,
    trade: "No",
    play: null,
    bias09,
    bias10,
    londonScenario: "no trade (messy day)",
    reason: "overlay_move_not_enough_or_broke_sweep",
    debug: { manipulation, sweep, aCheck, bCheck },
  };
}

// -------------------- Public entry: runSetups --------------------
function runSetups(daily, sessions, ctx) {
  const baseBias = String(daily?.baseBias || "").trim();
  const bias09 = daily?.bias09 || baseBias || "Ranging";
  const bias10 = daily?.bias10 || baseBias || "Ranging";
  const marketClosed = !!ctx?.marketClosed;

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

  // 1) Try FrankLondonMW ONLY on Ranging days
  const mw = runFrankLondonMW(daily, sessions, ctx);
  if (mw.trade === "Yes") return mw;

  // 2) Try overlays (can occur on any day that wasn't already a bias-play)
  const overlay = runManipulationSweepReverse(daily, sessions, ctx);
  if (overlay.trade === "Yes") return overlay;

  // 3) Nothing
  return {
    ok: true,
    trade: "No",
    play: null,
    bias09,
    bias10,
    londonScenario: "no trade (messy day)",
    reason: "no_setups_found",
    debug: { baseBias, mwReason: mw.reason, overlayReason: overlay.reason },
  };
}

module.exports = {
  runSetups,
  ALLOWED_SCENARIOS,
};
