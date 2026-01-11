// 10_14_setups.js
// v1.3.0 (London 10–14) — Non-bias setups + overlays + LondonFirstSweep (Asia-qualified)
//
// Contains:
// - FrankLondonMW (formerly Type C): double test → mean reversion (ONLY when Daily baseBias === "Ranging")
// - ManipulationSweepReverseA / ManipulationSweepReverseB (overlays): Frankfurt manipulation → London sweep opposite → 10–14 move back in Frankfurt direction
// - LondonFirstSweep (overlay / day-qualifier): Asia range built + Asia untouched 07–09 → FIRST London setup sweep (09–10) of key levels (0.5–8 pips) → qualify 10–14 reversal window
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
//   play: "FrankLondonMW" | "ManipulationSweepReverseA" | "ManipulationSweepReverseB" | "LondonFirstSweep" | null,
//   bias09: "Bullish"/"Bearish"/"Ranging",
//   bias10: "Bullish"/"Bearish"/"Ranging",
//   londonScenario: one of allowed,
//   reason: string,
//   debug: { ... }
// }

const PIP = 0.0001;

// ---- LondonFirstSweep constants (locked) ----
const LFS_MIN_SWEEP_PIPS = 0.5; // min wick beyond level
const LFS_MAX_SWEEP_PIPS = 8;   // max wick beyond level
const LFS_MIN_ASIA_RANGE_PIPS = 15; // Asia range must be >= 15 pips
const LFS_PRE_LONDON_ASIA_SWEEP_MIN_PIPS = 0.5; // "no Asia sweep 07–09" threshold

const ALLOWED_SCENARIOS = new Set([
  "slightly up first → then price down",
  "slightly down first → then price up",
  "range / back and forth",
  "double tap → mean reversion",
  "london first sweep → reversal",
  "no trade (messy day)",
]);

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function pipsAbs(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(a - b) / PIP;
}

function pipsSigned(a, b) {
  // (b - a) in pips
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / PIP;
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

  // Double tap of either AsiaHigh or AsiaLow:
  // - Frankfurt test fails
  // - London test fails
  // Then trade is opposite direction (mean reversion / rotation).
  const ffHighTest = detectTestFail(ffRows, asiaHigh, "UP");
  const ldHighTest = detectTestFail(ldRows, asiaHigh, "UP");

  const ffLowTest = detectTestFail(ffRows, asiaLow, "DOWN");
  const ldLowTest = detectTestFail(ldRows, asiaLow, "DOWN");

  const highDoubleFail = ffHighTest.failed && ldHighTest.failed;
  const lowDoubleFail = ffLowTest.failed && ldLowTest.failed;

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
function classifyFrankfurtManipulationWick(ffRows) {
  // Spec-accurate wick-dominance manipulation (measured from Frankfurt OPEN):
  // - Frankfurt range >= 8 pips (high-low)
  // - UP manip if:
  //    upWickPips >= 4
  //    AND upWickPips >= 1.7 * downWickPips
  // - DOWN manip similarly
  if (!Array.isArray(ffRows) || ffRows.length < 2) {
    return { ok: false, reason: "not_enough_frankfurt_rows" };
  }

  const ffOpen = toNum(ffRows[0]?.open);
  if (!Number.isFinite(ffOpen)) return { ok: false, reason: "missing_frankfurt_open" };

  let ffHigh = -Infinity;
  let ffLow = Infinity;

  for (const r of ffRows) {
    if (Number.isFinite(r.high) && r.high > ffHigh) ffHigh = r.high;
    if (Number.isFinite(r.low) && r.low < ffLow) ffLow = r.low;
  }

  const rangePips = Number.isFinite(ffHigh) && Number.isFinite(ffLow) ? (ffHigh - ffLow) / PIP : null;
  if (!(Number.isFinite(rangePips) && rangePips >= 8)) {
    return { ok: false, reason: "frankfurt_range_too_small", ffHigh, ffLow, rangePips };
  }

  const upWickPips = Number.isFinite(ffHigh) ? (ffHigh - ffOpen) / PIP : null;
  const downWickPips = Number.isFinite(ffLow) ? (ffOpen - ffLow) / PIP : null;

  const upOk =
    Number.isFinite(upWickPips) &&
    upWickPips >= 4 &&
    Number.isFinite(downWickPips) &&
    upWickPips >= 1.7 * downWickPips;

  const downOk =
    Number.isFinite(downWickPips) &&
    downWickPips >= 4 &&
    Number.isFinite(upWickPips) &&
    downWickPips >= 1.7 * upWickPips;

  let dir = null;
  if (upOk && !downOk) dir = "UP";
  else if (downOk && !upOk) dir = "DOWN";
  else dir = null;

  if (!dir) {
    return {
      ok: false,
      reason: "no_clear_wick_manipulation",
      ffOpen,
      ffHigh,
      ffLow,
      rangePips,
      upWickPips,
      downWickPips,
    };
  }

  return {
    ok: true,
    dir,
    ffOpen,
    ffHigh,
    ffLow,
    rangePips,
    upWickPips,
    downWickPips,
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
    const returned = ldRows.some((r) => Number.isFinite(r.close) && r.close > level);
    if (!returned) return { ok: false, reason: "sweep_no_return_above_level" };
    return { ok: true, sweepSide: "LOW", level, sweepRow: sweep };
  }

  if (dir === "DOWN") {
    const level = manipulation.ffHigh;
    const sweep = findFirstBreak(ldRows, level, "UP");
    if (!sweep) return { ok: false, reason: "no_sweep_of_frankfurt_high" };
    const returned = ldRows.some((r) => Number.isFinite(r.close) && r.close < level);
    if (!returned) return { ok: false, reason: "sweep_no_return_below_level" };
    return { ok: true, sweepSide: "HIGH", level, sweepRow: sweep };
  }

  return { ok: false, reason: "invalid_dir" };
}

function reachesTargetWithoutBreakingSweep(payoffRows, sweepRow, dir /* "UP"|"DOWN" */, targetPips) {
  // Measure from sweep extreme to payoff excursion.
  // Constraint: sweep extreme must not be broken again BEFORE target is reached.
  if (!Array.isArray(payoffRows) || payoffRows.length === 0) return { ok: false, reason: "missing_payoff_rows" };
  if (!sweepRow) return { ok: false, reason: "missing_sweep_row" };
  if (!Number.isFinite(targetPips)) return { ok: false, reason: "missing_target" };

  const sweepLow = toNum(sweepRow.low);
  const sweepHigh = toNum(sweepRow.high);

  if (dir === "UP") {
    if (!Number.isFinite(sweepLow)) return { ok: false, reason: "missing_sweep_low" };

    let bestHigh = -Infinity;
    for (let i = 0; i < payoffRows.length; i++) {
      const r = payoffRows[i];
      if (Number.isFinite(r.high) && r.high > bestHigh) bestHigh = r.high;

      const movePips = pipsAbs(sweepLow, bestHigh);
      if (Number.isFinite(movePips) && movePips >= targetPips) {
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

    let bestLow = Infinity;
    for (let i = 0; i < payoffRows.length; i++) {
      const r = payoffRows[i];
      if (Number.isFinite(r.low) && r.low < bestLow) bestLow = r.low;

      const movePips = pipsAbs(sweepHigh, bestLow);
      if (Number.isFinite(movePips) && movePips >= targetPips) {
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

  const manipulation = classifyFrankfurtManipulationWick(ffRows);
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

// -------------------- LondonFirstSweep (Asia-qualified) --------------------
function computeHiLoFromRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, reason: "no_rows" };
  let hi = -Infinity;
  let lo = Infinity;
  for (const r of rows) {
    if (Number.isFinite(r?.high) && r.high > hi) hi = r.high;
    if (Number.isFinite(r?.low) && r.low < lo) lo = r.low;
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || !(hi > lo)) return { ok: false, reason: "invalid_hilo", hi, lo };
  return { ok: true, high: hi, low: lo };
}

function findFirstSweepOfLevelInWindow(rows, level, side /* "UP"|"DOWN" */, minPips, maxPips) {
  // Returns { ok:true, row, sweepPips, extreme } where:
  // - For UP sweep: extreme = row.high, sweepPips = (row.high - level)/PIP
  // - For DOWN sweep: extreme = row.low, sweepPips = (level - row.low)/PIP
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, reason: "no_rows" };
  if (!Number.isFinite(level)) return { ok: false, reason: "invalid_level" };
  if (!Number.isFinite(minPips) || !Number.isFinite(maxPips) || minPips < 0 || maxPips <= 0 || maxPips < minPips) {
    return { ok: false, reason: "invalid_pip_bounds" };
  }

  for (const r of rows) {
    if (!r) continue;

    if (side === "UP") {
      if (!Number.isFinite(r.high)) continue;
      if (r.high <= level) continue;
      const sp = (r.high - level) / PIP;
      if (sp >= minPips && sp <= maxPips) {
        return { ok: true, row: r, sweepPips: sp, extreme: r.high };
      }
    } else {
      if (!Number.isFinite(r.low)) continue;
      if (r.low >= level) continue;
      const sp = (level - r.low) / PIP;
      if (sp >= minPips && sp <= maxPips) {
        return { ok: true, row: r, sweepPips: sp, extreme: r.low };
      }
    }
  }

  return { ok: false, reason: "no_sweep_in_bounds" };
}

function hasAsiaSweepBetween0709(ffRows, asiaHigh, asiaLow, minPips) {
  // "No sweep of Asia between 07:00–08:59" (Frankfurt session)
  // We interpret "sweep" as wick beyond AsiaHigh/Low by >= minPips.
  if (!Array.isArray(ffRows) || ffRows.length === 0) return false;
  if (!Number.isFinite(asiaHigh) || !Number.isFinite(asiaLow) || !Number.isFinite(minPips)) return false;

  const minMove = minPips * PIP;
  for (const r of ffRows) {
    if (!r) continue;
    if (Number.isFinite(r.high) && r.high >= asiaHigh + minMove) return true;
    if (Number.isFinite(r.low) && r.low <= asiaLow - minMove) return true;
  }
  return false;
}

function buildCandidateLevels(sessions, ctx) {
  // We include the "key places" set used in testing:
  // - Asia H/L, Asia mid
  // - PDH/PDL
  // - Frankfurt H/L
  // - Prior session H/L (Asia+Frankfurt combined)
  // - London open (09:00 candle open)
  const { st: asiaSt, rows: asiaRows } = getWindowStats(sessions?.asia);
  const { st: ffSt, rows: ffRows } = getWindowStats(sessions?.frankfurt);
  const { rows: ldRows } = getWindowStats(sessions?.londonSetup);

  const levels = [];

  const asiaHigh = toNum(asiaSt?.high);
  const asiaLow = toNum(asiaSt?.low);
  if (Number.isFinite(asiaHigh) && Number.isFinite(asiaLow)) {
    levels.push({ name: "ASIA_HIGH", level: asiaHigh, side: "UP" });
    levels.push({ name: "ASIA_LOW", level: asiaLow, side: "DOWN" });
    levels.push({ name: "ASIA_MID", level: (asiaHigh + asiaLow) / 2, side: "BOTH" });
  }

  const PDH = toNum(ctx?.pdh);
  const PDL = toNum(ctx?.pdl);
  if (Number.isFinite(PDH)) levels.push({ name: "PDH", level: PDH, side: "UP" });
  if (Number.isFinite(PDL)) levels.push({ name: "PDL", level: PDL, side: "DOWN" });

  const ffHigh = toNum(ffSt?.high);
  const ffLow = toNum(ffSt?.low);
  if (Number.isFinite(ffHigh)) levels.push({ name: "FRANKFURT_HIGH", level: ffHigh, side: "UP" });
  if (Number.isFinite(ffLow)) levels.push({ name: "FRANKFURT_LOW", level: ffLow, side: "DOWN" });

  // Prior session (Asia+Frankfurt) high/low from rows
  const priorRows = []
    .concat(Array.isArray(asiaRows) ? asiaRows : [])
    .concat(Array.isArray(ffRows) ? ffRows : []);
  const prior = computeHiLoFromRows(priorRows);
  if (prior.ok) {
    levels.push({ name: "PRIOR_SESSION_HIGH", level: prior.high, side: "UP" });
    levels.push({ name: "PRIOR_SESSION_LOW", level: prior.low, side: "DOWN" });
  }

  // London open = first candle open in londonSetup
  const londonOpen = toNum(ldRows?.[0]?.open);
  if (Number.isFinite(londonOpen)) levels.push({ name: "LONDON_OPEN", level: londonOpen, side: "BOTH" });

  return {
    ok: true,
    levels,
    asiaHigh,
    asiaLow,
  };
}

function pickFirstLondonSweep(ldRows, candidates, minPips, maxPips) {
  // Deterministically pick the earliest sweep across all candidate levels.
  // If multiple sweeps occur on same candle, choose by candidate order.
  if (!Array.isArray(ldRows) || ldRows.length === 0) return { ok: false, reason: "missing_london_setup_rows" };
  if (!Array.isArray(candidates) || candidates.length === 0) return { ok: false, reason: "no_candidate_levels" };

  let best = null;

  // We scan candles in chronological order, and for each candle scan candidates in fixed order.
  for (const r of ldRows) {
    if (!r) continue;

    for (const c of candidates) {
      if (!c || !Number.isFinite(c.level)) continue;

      // BOTH means we accept either UP or DOWN sweep around same level
      const sideList = c.side === "BOTH" ? ["UP", "DOWN"] : [c.side];

      for (const side of sideList) {
        if (side === "UP") {
          if (!Number.isFinite(r.high)) continue;
          if (r.high <= c.level) continue;
          const sp = (r.high - c.level) / PIP;
          if (sp >= minPips && sp <= maxPips) {
            best = { levelName: c.name, level: c.level, sweepSide: "UP", row: r, sweepPips: sp, extreme: r.high };
            return { ok: true, ...best };
          }
        } else {
          if (!Number.isFinite(r.low)) continue;
          if (r.low >= c.level) continue;
          const sp = (c.level - r.low) / PIP;
          if (sp >= minPips && sp <= maxPips) {
            best = { levelName: c.name, level: c.level, sweepSide: "DOWN", row: r, sweepPips: sp, extreme: r.low };
            return { ok: true, ...best };
          }
        }
      }
    }
  }

  return { ok: false, reason: "no_london_first_sweep_found" };
}

function runLondonFirstSweep(daily, sessions, ctx) {
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
      debug: { haveAsia: !!asiaSt, asiaCount: asiaRows.length, ffCount: ffRows.length, ldCount: ldRows.length },
    };
  }

  const asiaHigh = toNum(asiaSt.high);
  const asiaLow = toNum(asiaSt.low);
  if (!Number.isFinite(asiaHigh) || !Number.isFinite(asiaLow) || !(asiaHigh > asiaLow)) {
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

  const asiaRangePips = (asiaHigh - asiaLow) / PIP;
  if (!(Number.isFinite(asiaRangePips) && asiaRangePips >= LFS_MIN_ASIA_RANGE_PIPS)) {
    return {
      ok: true,
      trade: "No",
      play: null,
      bias09,
      bias10,
      londonScenario: "no trade (messy day)",
      reason: "asia_range_too_small",
      debug: { asiaRangePips, minRequired: LFS_MIN_ASIA_RANGE_PIPS },
    };
  }

  // Filter: NO Asia H/L sweep during 07:00–08:59
  const preTouched = hasAsiaSweepBetween0709(ffRows, asiaHigh, asiaLow, LFS_PRE_LONDON_ASIA_SWEEP_MIN_PIPS);
  if (preTouched) {
    return {
      ok: true,
      trade: "No",
      play: null,
      bias09,
      bias10,
      londonScenario: "no trade (messy day)",
      reason: "asia_touched_before_london",
      debug: { asiaHigh, asiaLow, minPips: LFS_PRE_LONDON_ASIA_SWEEP_MIN_PIPS },
    };
  }

  // Build key levels & find FIRST London sweep (09–10) within bounds 0.5–8 pips.
  const lvl = buildCandidateLevels(sessions, ctx);
  const candidates = Array.isArray(lvl.levels) ? lvl.levels : [];
  const first = pickFirstLondonSweep(ldRows, candidates, LFS_MIN_SWEEP_PIPS, LFS_MAX_SWEEP_PIPS);

  if (!first.ok) {
    return {
      ok: true,
      trade: "No",
      play: null,
      bias09,
      bias10,
      londonScenario: "no trade (messy day)",
      reason: "no_london_first_sweep_in_bounds",
      debug: { first, asiaRangePips },
    };
  }

  // This overlay is a DAY-QUALIFIER.
  // It does not define entry; it marks the day as eligible for 10–14 reversal logic.
  return {
    ok: true,
    trade: "Yes",
    play: "LondonFirstSweep",
    bias09,
    bias10,
    londonScenario: "london first sweep → reversal",
    reason: "london_first_sweep_asia_qualified",
    debug: {
      asiaRangePips,
      asiaHigh,
      asiaLow,
      preTouchedAsia0709: preTouched,
      sweep: {
        levelName: first.levelName,
        level: first.level,
        sweepSide: first.sweepSide, // UP => expect down, DOWN => expect up (execution handled elsewhere)
        sweepPips: first.sweepPips,
        extreme: first.extreme,
        ms: first.row?.ms,
        osloHHMM: first.row?.osloHHMM,
      },
      bounds: { minPips: LFS_MIN_SWEEP_PIPS, maxPips: LFS_MAX_SWEEP_PIPS },
    },
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

  // 2) Try ManipulationSweepReverse overlays
  const overlay = runManipulationSweepReverse(daily, sessions, ctx);
  if (overlay.trade === "Yes") return overlay;

  // 3) Try LondonFirstSweep (Asia-qualified) as day-qualifier overlay
  const lfs = runLondonFirstSweep(daily, sessions, ctx);
  if (lfs.trade === "Yes") return lfs;

  // 4) Nothing
  return {
    ok: true,
    trade: "No",
    play: null,
    bias09,
    bias10,
    londonScenario: "no trade (messy day)",
    reason: "no_setups_found",
    debug: { baseBias, mwReason: mw.reason, overlayReason: overlay.reason, lfsReason: lfs.reason },
  };
}

module.exports = {
  runSetups,
  ALLOWED_SCENARIOS,
};
