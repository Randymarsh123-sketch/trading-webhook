// del3_dailyCycles.js
// Daily-Cycle module (Frankfurt + London) for post-09:30 bias/hypothesis.
// Matches your locked framework:
// - Asia window: 02:00–06:59 Oslo
// - Pre-Frankfurt: 07:00–07:59
// - Frankfurt: 08:00–08:59
// - London: 09:00–10:00 with decision points 09:30 and 10:00
//
// Core regimes:
// 1) Judas (Failure): Frankfurt breaks ONE side and closes back INSIDE Asia.
//    - Setup1: Frankfurt-only Judas (mini-M inside Frankfurt; failure established early)
//    - Setup2: Frankfurt -> London Judas (double-session M; London 09:00–09:30 finishes liquidity event)
// 2) Asia Break-Retest-Continuation: Frankfurt breaks ONE side and closes OUTSIDE Asia in break direction.
//
// Pre-Frankfurt (07–08) sweeps are tracked as CONTEXT only.
//
// NOTE: Candle timestamps in your CSV are shifted by +1 hour vs Oslo ("1700 means 1600").
// This module supports a timeShiftMinutes option (default -60) to interpret candle times as Oslo.

const DEFAULTS = {
  timeShiftMinutes: -60, // subtract 60 min from candle timestamps to get Oslo
  // Session windows (Oslo time)
  windows: {
    asia: { start: "02:00", end: "06:59" },
    preFrankfurt: { start: "07:00", end: "07:59" },
    frankfurt: { start: "08:00", end: "08:59" },
    londonEarly: { start: "09:00", end: "09:29" },
    londonLate: { start: "09:30", end: "09:59" },
  },

  // Heuristics / thresholds
  pushDetection: {
    // For "mini-M" in Frankfurt-only Judas:
    // count how many times price trades beyond the broken boundary AND closes back inside (rejection).
    minFailedPushes: 2,
  },

  acceptance: {
    // "Acceptance" heuristic: >=2 consecutive closes outside Asia boundary in that direction
    // within the window being evaluated.
    minConsecutiveCloses: 2,
  },

  continuation: {
    // Continuation confirmation thresholds (pips)
    // (Used for summary flags only; you can change later.)
    pipSize: 0.0001,
    smallExtPips: 10,
    bigExtPips: 20,
  },
};

// ---------- Helpers ----------
function toDateMs(time) {
  if (time instanceof Date) return time.getTime();
  if (typeof time === "number") return time; // assume ms
  // string
  const ms = Date.parse(time);
  if (Number.isNaN(ms)) throw new Error(`Unparseable time: ${time}`);
  return ms;
}

function addMinutes(ms, minutes) {
  return ms + minutes * 60_000;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Create "HH:MM" string in local time for a Date(ms)
function hhmmLocal(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Compare "HH:MM" lexicographically (works because zero padded)
function inWindow(hhmm, start, end) {
  return hhmm >= start && hhmm <= end;
}

function withinWindow(candleMsOslo, win) {
  const t = hhmmLocal(candleMsOslo);
  return inWindow(t, win.start, win.end);
}

function sliceByWindow(candles, win, timeShiftMinutes) {
  return candles.filter((c) => {
    const ms = addMinutes(toDateMs(c.time), timeShiftMinutes);
    return withinWindow(ms, win);
  });
}

function lastCandleOfWindow(candles, win, timeShiftMinutes) {
  const slice = sliceByWindow(candles, win, timeShiftMinutes);
  if (!slice.length) return null;
  // candles are expected sorted; if not, sort by time
  const sorted = [...slice].sort((a, b) => toDateMs(a.time) - toDateMs(b.time));
  return sorted[sorted.length - 1];
}

function maxHigh(candles) {
  return candles.reduce((m, c) => (c.high > m ? c.high : m), -Infinity);
}

function minLow(candles) {
  return candles.reduce((m, c) => (c.low < m ? c.low : m), Infinity);
}

function closePosition(close, asiaHigh, asiaLow) {
  if (close > asiaHigh) return "above";
  if (close < asiaLow) return "below";
  return "inside";
}

function countConsecutiveClosesOutside(candles, boundary, dir /* "above"|"below" */) {
  let best = 0;
  let cur = 0;
  for (const c of candles) {
    const ok = dir === "above" ? c.close > boundary : c.close < boundary;
    if (ok) {
      cur += 1;
      best = Math.max(best, cur);
    } else {
      cur = 0;
    }
  }
  return best;
}

// Count failed pushes beyond a boundary where close returns inside (rejection).
// For bullish boundary (AsiaHigh): push if high > boundary, rejected if close <= boundary.
// For bearish boundary (AsiaLow): push if low < boundary, rejected if close >= boundary.
function countFailedPushes(candles, boundary, side /* "high"|"low" */) {
  let pushes = 0;
  for (const c of candles) {
    if (side === "high") {
      if (c.high > boundary && c.close <= boundary) pushes += 1;
    } else {
      if (c.low < boundary && c.close >= boundary) pushes += 1;
    }
  }
  return pushes;
}

function pipDistance(a, b, pipSize) {
  return Math.abs(a - b) / pipSize;
}

// ---------- Core analysis ----------
function analyzeDailyCycle(input) {
  const opts = deepMerge(DEFAULTS, input?.options || {});
  const candles = (input?.candles5m || []).slice().sort((a, b) => toDateMs(a.time) - toDateMs(b.time));

  // Asia values should preferably come from your del2 module.
  // But if you pass asiaHigh/asiaLow, we use them.
  const asiaHigh = input?.asia?.high;
  const asiaLow = input?.asia?.low;
  const asiaMid = input?.asia?.mid ?? (asiaHigh != null && asiaLow != null ? (asiaHigh + asiaLow) / 2 : null);

  if (asiaHigh == null || asiaLow == null) {
    throw new Error("del3_dailyCycles.js requires asia.high and asia.low from your del2 Asia module.");
  }

  // Window slices
  const preF = sliceByWindow(candles, opts.windows.preFrankfurt, opts.timeShiftMinutes);
  const ff = sliceByWindow(candles, opts.windows.frankfurt, opts.timeShiftMinutes);
  const ldnE = sliceByWindow(candles, opts.windows.londonEarly, opts.timeShiftMinutes);
  const ldnL = sliceByWindow(candles, opts.windows.londonLate, opts.timeShiftMinutes);

  const ffCloseCandle = lastCandleOfWindow(candles, opts.windows.frankfurt, opts.timeShiftMinutes);
  const ffClose = ffCloseCandle?.close ?? null;

  // If missing slices (data gaps), return a structured error-like output
  const dataOk = preF.length && ff.length && (ldnE.length || ldnL.length) && ffClose != null;
  if (!dataOk) {
    return {
      ok: false,
      reason: "Missing candles for required windows (07–10) or missing Frankfurt close.",
      debug: {
        preFrankfurtCount: preF.length,
        frankfurtCount: ff.length,
        londonEarlyCount: ldnE.length,
        londonLateCount: ldnL.length,
        frankfurtClose: ffClose,
      },
    };
  }

  // Break checks relative to Asia
  const preBreakHigh = preF.length ? maxHigh(preF) > asiaHigh : false;
  const preBreakLow = preF.length ? minLow(preF) < asiaLow : false;

  const ffBreakHigh = maxHigh(ff) > asiaHigh;
  const ffBreakLow = minLow(ff) < asiaLow;

  const ffBreakCount = (ffBreakHigh ? 1 : 0) + (ffBreakLow ? 1 : 0);
  const ffBreakSide =
    ffBreakCount === 1 ? (ffBreakHigh ? "high" : "low") : ffBreakCount === 2 ? "both" : "none";

  const ffClosePos = closePosition(ffClose, asiaHigh, asiaLow);

  // Regime gate you’ve locked:
  // Only days where Frankfurt breaks ONE side are considered "in-scope" for your main system.
  const inScope = ffBreakSide === "high" || ffBreakSide === "low";

  // Acceptance check in Frankfurt
  const ffAcceptAbove = countConsecutiveClosesOutside(ff, asiaHigh, "above") >= opts.acceptance.minConsecutiveCloses;
  const ffAcceptBelow = countConsecutiveClosesOutside(ff, asiaLow, "below") >= opts.acceptance.minConsecutiveCloses;

  // Determine regime
  let regime = "none"; // "failure" | "continuation" | "none"
  if (inScope) {
    if (ffClosePos === "inside") regime = "failure";
    if (ffClosePos === "above" || ffClosePos === "below") {
      // only treat as continuation if closing outside on the same side as the break
      if (ffBreakSide === "high" && ffClosePos === "above") regime = "continuation";
      if (ffBreakSide === "low" && ffClosePos === "below") regime = "continuation";
      // Otherwise it's "messy" (e.g., breaks high but closes below AsiaLow — rare but possible).
      if (regime !== "continuation") regime = "none";
    }
  }

  // Setup detection
  const setups = [];
  const notes = [];

  // Setup A / Judas family
  if (regime === "failure") {
    // Mini-M heuristic = multiple failed pushes in Frankfurt beyond the broken boundary.
    const boundary = ffBreakSide === "high" ? asiaHigh : asiaLow;
    const failedPushes = countFailedPushes(ff, boundary, ffBreakSide);

    const isSetup1 = failedPushes >= opts.pushDetection.minFailedPushes;
    const isSetup2Candidate = !isSetup1; // simple split: if no mini-M, London may complete (double-session)

    // Evaluate London early completion for setup2 candidate:
    // "last liquidity event (often Frankfurt high/low) without acceptance" + displacement opposite.
    // We keep this conservative and only label "setup2" if these conditions are clearly met.
    let setup2Confirmed = false;
    if (isSetup2Candidate) {
      const ffExtreme = ffBreakSide === "high" ? maxHigh(ff) : minLow(ff);
      const ldnEarlyExtreme = ffBreakSide === "high" ? maxHigh(ldnE) : minLow(ldnE);

      const tookFFExtreme = ffBreakSide === "high" ? ldnEarlyExtreme > ffExtreme : ldnEarlyExtreme < ffExtreme;

      // "no acceptance" in the sweep direction during 09:00–09:30
      const ldnNoAccept =
        ffBreakSide === "high"
          ? countConsecutiveClosesOutside(ldnE, ffExtreme, "above") < opts.acceptance.minConsecutiveCloses
          : countConsecutiveClosesOutside(ldnE, ffExtreme, "below") < opts.acceptance.minConsecutiveCloses;

      // "displacement opposite" heuristic: in London early or late, price moves beyond opposite Asia boundary
      // OR prints a strong continuation in the opposite direction.
      const oppositeBoundary = ffBreakSide === "high" ? asiaLow : asiaHigh;
      const ldnOppBreak =
        ffBreakSide === "high" ? minLow([...ldnE, ...ldnL]) < oppositeBoundary : maxHigh([...ldnE, ...ldnL]) > oppositeBoundary;

      // Conservative confirm: took FF extreme + no acceptance + some opposite displacement sign
      if (tookFFExtreme && ldnNoAccept && ldnOppBreak) setup2Confirmed = true;
    }

    if (isSetup1) {
      setups.push({
        id: "JUDAS_SETUP1_FRANKFURT_ONLY",
        label: "Frankfurt-only Judas (mini-M)",
        family: "JUDAS",
        frequencyHint: "12–13%",
        successHint: "80–90% failure expansion",
        play: "After 09:30, wait for retrace/mitigation into Frankfurt-origin/Asia levels; trade continuation opposite.",
      });
      notes.push(`Frankfurt failed pushes: ${failedPushes} (>= ${opts.pushDetection.minFailedPushes})`);
    } else if (setup2Confirmed) {
      setups.push({
        id: "JUDAS_SETUP2_DOUBLE_SESSION",
        label: "Frankfurt → London Judas (double-session M)",
        family: "JUDAS",
        frequencyHint: "8–9%",
        successHint: "80–90% failure expansion",
        play: "London 09:00–09:30 finishes liquidity; after 09:30 wait retrace/mitigation; trade continuation opposite.",
      });
      notes.push("London early likely completed the second top/bottom (liquidity event) without acceptance.");
    } else {
      // Still failure regime, but not confidently split into setup1/2 by heuristics
      setups.push({
        id: "JUDAS_GENERIC_FAILURE",
        label: "Judas failure (unspecified subtype)",
        family: "JUDAS",
        frequencyHint: "20–22% (family)",
        successHint: "80–90% failure expansion",
        play: "After 09:30, treat London as a discount window; wait retrace/mitigation and trade continuation opposite.",
      });
      notes.push("Failure regime confirmed by Frankfurt close back inside Asia; subtype unclear by heuristic.");
    }
  }

  // Break–Retest–Continuation
  if (regime === "continuation") {
    setups.push({
      id: "BRC_ASIA_BREAK_RETEST_CONTINUATION",
      label: "Asia Break → Retest → Continuation",
      family: "CONTINUATION",
      frequencyHint: "28–32%",
      successHint: "75–85% continuation",
      play: "After 09:30, expect mitigation into Asia breakpoint / Frankfurt range / Frankfurt origin, then continuation in Frankfurt direction.",
    });

    // Helpful “don’t want to see M” note
    notes.push("Continuation regime: avoid M/rejection at the extreme; prefer W/absorption at retest.");
  }

  // No-trade / out-of-scope notes
  if (!inScope) {
    if (ffBreakSide === "none") notes.push("Dead Frankfurt (08–09): no Asia side taken.");
    if (ffBreakSide === "both") notes.push("Frankfurt whipsaw (08–09): both Asia sides taken (messy).");
  } else if (regime === "none") {
    notes.push("In-scope break occurred, but Frankfurt close did not align cleanly with break direction (messy day).");
  }

  // Pre-Frankfurt context (07–08 sweeps)
  const preContext = {
    tookAsiaHigh: preBreakHigh,
    tookAsiaLow: preBreakLow,
    note:
      preBreakHigh || preBreakLow
        ? "Pre-Frankfurt sweeps addressed liquidity; treat as context (may strengthen origin zones), not as trigger."
        : "No pre-Frankfurt Asia sweep detected.",
  };

  // Simple “after 10:00” hook: this does NOT generate a new setup day,
  // it only suggests that if a regime is confirmed, you may look for LVL2/LVL3 pullback-continuation entries.
  const after10 = {
    ruleOfThumb:
      "If nothing with clear structure has happened by 10:00, Europe is done; exception: extensions of confirmed Judas/Continuation via pullback-continuation.",
    enabledForRegimes: ["failure", "continuation"],
    timing: "10:00–12:00 (Oslo)",
    note:
      "After 10:00 entries are timing tools (e.g., retrace into supply/FVG/EMA cluster) inside an already-confirmed regime, not new setups.",
  };

  // Compact “09/09:30/10” hypothesis text builders (use in raport.js)
  const hypothesis = buildHypothesis({
    inScope,
    regime,
    ffBreakSide,
    ffClosePos,
    preContext,
    setups,
  });

  return {
    ok: true,
    meta: {
      asia: { high: asiaHigh, low: asiaLow, mid: asiaMid },
      preFrankfurt: { tookAsiaHigh: preBreakHigh, tookAsiaLow: preBreakLow },
      frankfurt: {
        breakSide: ffBreakSide,
        breakHigh: ffBreakHigh,
        breakLow: ffBreakLow,
        close: ffClose,
        closePos: ffClosePos,
        acceptAbove: ffAcceptAbove,
        acceptBelow: ffAcceptBelow,
      },
    },
    inScope,
    regime, // "failure" | "continuation" | "none"
    setups,
    hypothesis,
    notes,
    preContext,
    after10,
  };
}

// ---------- Hypothesis text (for report/prompt use) ----------
function buildHypothesis({ inScope, regime, ffBreakSide, ffClosePos, preContext, setups }) {
  if (!inScope) {
    return {
      t0900: "No main-system day: Frankfurt did not take exactly one Asia side (dead or whipsaw).",
      t0930: "No-trade bias: avoid forcing a narrative; wait for NY if anything.",
      t1000: "No-trade baseline: unless an exceptional clean story emerges, Europe edge is low.",
    };
  }

  if (regime === "failure") {
    const s = setups[0]?.label || "Judas failure";
    return {
      t0900: `Failure regime likely: Frankfurt took Asia ${ffBreakSide} but closed back inside Asia (Judas family). Pre-context: ${preContext.note}`,
      t0930: `${s}: expect London to offer mitigation/retrace; after 09:30 look for continuation opposite the Frankfurt break.`,
      t1000:
        "If no clean mitigation has occurred by 10:00, reduce expectations; only trade extensions if structure remains intact (pullback-continuation).",
    };
  }

  if (regime === "continuation") {
    return {
      t0900: `Continuation regime likely: Frankfurt broke Asia ${ffBreakSide} and closed outside Asia in that direction. Pre-context: ${preContext.note}`,
      t0930:
        "Expect London to price in the Frankfurt impulse via retrace/mitigation into Asia breakpoint / Frankfurt range / origin; continuation in Frankfurt direction typically after 09:30.",
      t1000:
        "After 10:00, only look for pullback-continuation (LVL2/LVL3 timing) if Asia is not reclaimed and structure holds.",
    };
  }

  // regime none but inScope
  return {
    t0900: "Messy in-scope day: Frankfurt took one Asia side but close did not align cleanly; treat cautiously.",
    t0930: "No clear bias: avoid forcing either Judas or continuation story; require extra confirmation or stand down.",
    t1000: "If unclear by 10:00, Europe edge is low; default to no-trade.",
  };
}

// ---------- tiny deep merge ----------
function deepMerge(a, b) {
  if (!b) return a;
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v) && a?.[k] && typeof a[k] === "object") {
      out[k] = deepMerge(a[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = {
  analyzeDailyCycle,
  DEFAULTS,
};
