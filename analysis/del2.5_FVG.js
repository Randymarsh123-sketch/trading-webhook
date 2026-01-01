// del2.5_FVG.js
// DEL 2.5 – HTF POI (FVG)
//
// Purpose: Map higher-timeframe Fair Value Gaps (FVG) as POI only.
// - Detect standard 3-candle FVG on: Daily + 1H
// - Classify bullish/bearish
// - Find nearest FVG above/below current price
// - Measure distance (pips) from current price
// - Check overlap with Asia High/Low (from Del 2)
//
// Update (filled logic):
// - Prior version removed too many 1H FVGs (too strict).
// - New rule removes only "clearly spent" FVGs (pro-consensus-ish):
//   Bullish FVG is removed only if a later candle CLOSES below the lower bound.
//   Bearish FVG is removed only if a later candle CLOSES above the upper bound.
//   (Wick-through or partial mitigation does NOT delete the FVG.)

const OSLO_TZ = "Europe/Oslo";
const PIP_SIZE = 0.0001; // EURUSD

// ---------- time helpers ----------
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

// ---------- numeric helpers ----------
function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function pipsFromPriceDiff(diff) {
  const d = Math.abs(Number(diff));
  if (!Number.isFinite(d)) return null;
  return d / PIP_SIZE;
}

// ---------- FVG detection (standard 3-candle inefficiency) ----------
/**
 * Standard definition:
 * Bullish FVG if candle1.high < candle3.low
 * - Zone: [candle1.high, candle3.low]
 *
 * Bearish FVG if candle1.low > candle3.high
 * - Zone: [candle3.high, candle1.low]
 *
 * We anchor "createdAt" on the middle candle (candle2.datetime) for labeling.
 * Zone is strictly between wicks (high/low), which matches common usage.
 */
function detectStandardFVGs(candles, tfLabel) {
  const out = [];
  const arr = Array.isArray(candles) ? candles : [];
  if (arr.length < 3) return out;

  for (let i = 2; i < arr.length; i++) {
    const c1 = arr[i - 2];
    const c2 = arr[i - 1];
    const c3 = arr[i];

    const h1 = toNum(c1.high);
    const l1 = toNum(c1.low);
    const h3 = toNum(c3.high);
    const l3 = toNum(c3.low);

    const t2 = String(c2.datetime || "");
    const ms2 = parseUtcDatetimeToMs(t2) ?? null;

    if (!Number.isFinite(h1) || !Number.isFinite(l1) || !Number.isFinite(h3) || !Number.isFinite(l3)) continue;

    // Bullish FVG
    if (h1 < l3) {
      out.push({
        tf: tfLabel,
        direction: "BULLISH",
        lower: h1,
        upper: l3,
        createdAtUtc: t2 || String(c3.datetime || ""),
        createdAtMs: ms2,
        iCreated: i - 1, // index of candle2
      });
      continue;
    }

    // Bearish FVG
    if (l1 > h3) {
      out.push({
        tf: tfLabel,
        direction: "BEARISH",
        lower: h3,
        upper: l1,
        createdAtUtc: t2 || String(c3.datetime || ""),
        createdAtMs: ms2,
        iCreated: i - 1,
      });
      continue;
    }
  }

  return out;
}

/**
 * Mitigation tracking (optional, debug-friendly):
 * - For bullish FVG: how deep price has traded DOWN into the zone after creation.
 * - For bearish FVG: how deep price has traded UP into the zone after creation.
 * Returns { mitigationPct: 0..1 } where 1 means fully traversed.
 *
 * Note: This does NOT decide "filled". It's for reporting/inspection.
 */
function computeMitigationPctAfterCreation(fvg, candles) {
  const arr = Array.isArray(candles) ? candles : [];
  const startIdx = Math.max(0, (fvg?.iCreated ?? 0) + 1);

  const lo = toNum(fvg?.lower);
  const hi = toNum(fvg?.upper);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return { mitigationPct: 1 };

  const height = hi - lo;

  let deepest = 0; // 0..height
  for (let i = startIdx; i < arr.length; i++) {
    const c = arr[i];
    const h = toNum(c.high);
    const l = toNum(c.low);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;

    if (fvg.direction === "BULLISH") {
      // How far into the zone did price trade from above? (downward fill)
      // If low goes below upper, it started filling.
      if (l < hi) {
        const fillTo = Math.max(lo, l); // clamp not below lo
        const amount = hi - fillTo;     // 0..height
        if (amount > deepest) deepest = amount;
      }
    } else if (fvg.direction === "BEARISH") {
      // How far into the zone did price trade from below? (upward fill)
      if (h > lo) {
        const fillTo = Math.min(hi, h); // clamp not above hi
        const amount = fillTo - lo;     // 0..height
        if (amount > deepest) deepest = amount;
      }
    }
  }

  const pct = height > 0 ? deepest / height : 1;
  return { mitigationPct: Math.max(0, Math.min(1, pct)) };
}

/**
 * New "clearly filled / spent" logic (less aggressive, closer to common practice):
 *
 * - Bullish FVG (support-type zone):
 *   Consider it "spent" only if a later candle CLOSES <= lower bound.
 *
 * - Bearish FVG (resistance-type zone):
 *   Consider it "spent" only if a later candle CLOSES >= upper bound.
 *
 * This avoids deleting FVGs just because of wick-through/partial mitigation.
 */
function isFvgClearlySpentAfterCreation(fvg, candles) {
  const arr = Array.isArray(candles) ? candles : [];
  const startIdx = Math.max(0, (fvg?.iCreated ?? 0) + 1);

  const lo = toNum(fvg?.lower);
  const hi = toNum(fvg?.upper);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return true;

  for (let i = startIdx; i < arr.length; i++) {
    const c = arr[i];
    const close = toNum(c.close);
    if (!Number.isFinite(close)) continue;

    if (fvg.direction === "BULLISH") {
      if (close <= lo) return true;
    } else if (fvg.direction === "BEARISH") {
      if (close >= hi) return true;
    }
  }

  return false;
}

/**
 * Freshness rules:
 * - Daily: allow older, but filter out clearly spent zones.
 * - 1H: require recent (default last 48h) AND not clearly spent.
 */
function filterRelevantFvgs(fvgs, candles, nowMs, opts) {
  const { requireRecentMs = null } = opts || {};

  const out = [];
  for (const fvg of Array.isArray(fvgs) ? fvgs : []) {
    if (isFvgClearlySpentAfterCreation(fvg, candles)) continue;

    if (requireRecentMs != null && Number.isFinite(requireRecentMs)) {
      const created = Number(fvg.createdAtMs);
      if (!Number.isFinite(created) || !Number.isFinite(nowMs)) continue;
      if (nowMs - created > requireRecentMs) continue;
    }

    out.push(fvg);
  }
  return out;
}

// ---------- nearest selection + metrics ----------
function distancePipsToZone(price, lower, upper) {
  const p = toNum(price);
  const lo = toNum(lower);
  const hi = toNum(upper);
  if (!Number.isFinite(p) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;

  if (p < lo) return pipsFromPriceDiff(lo - p);
  if (p > hi) return pipsFromPriceDiff(p - hi);
  return 0;
}

function zoneRelationToPrice(price, lower, upper) {
  const p = toNum(price);
  const lo = toNum(lower);
  const hi = toNum(upper);
  if (!Number.isFinite(p) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return "UNKNOWN";
  if (hi < p) return "BELOW";
  if (lo > p) return "ABOVE";
  return "CONTAINS";
}

function overlapsLevel(level, lower, upper, tolPips = 0) {
  const lvl = toNum(level);
  const lo = toNum(lower);
  const hi = toNum(upper);
  if (!Number.isFinite(lvl) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return false;
  const tol = (Number(tolPips) || 0) * PIP_SIZE;
  return lvl >= lo - tol && lvl <= hi + tol;
}

function pickNearestAboveBelow(fvgs, price) {
  const p = toNum(price);
  if (!Number.isFinite(p)) return { above: null, below: null, contains: null };

  let bestAbove = null;
  let bestBelow = null;
  let bestContains = null;

  for (const fvg of Array.isArray(fvgs) ? fvgs : []) {
    const lo = toNum(fvg.lower);
    const hi = toNum(fvg.upper);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) continue;

    const rel = zoneRelationToPrice(p, lo, hi);
    const dist = distancePipsToZone(p, lo, hi);

    const candidate = { ...fvg, distancePips: dist, relation: rel };

    if (rel === "ABOVE") {
      if (!bestAbove || (candidate.distancePips != null && candidate.distancePips < bestAbove.distancePips))
        bestAbove = candidate;
    } else if (rel === "BELOW") {
      if (!bestBelow || (candidate.distancePips != null && candidate.distancePips < bestBelow.distancePips))
        bestBelow = candidate;
    } else if (rel === "CONTAINS") {
      const height = hi - lo;
      const bestHeight = bestContains ? toNum(bestContains.upper) - toNum(bestContains.lower) : Infinity;
      if (!bestContains || height < bestHeight) bestContains = candidate;
    }
  }

  return { above: bestAbove, below: bestBelow, contains: bestContains };
}

// ---------- current price selection ----------
function pickNowPrice({ latest5M, latest1H, fallback = null }) {
  if (Array.isArray(latest5M) && latest5M.length) {
    const last = latest5M[latest5M.length - 1];
    const c = toNum(last.close);
    if (Number.isFinite(c)) return c;
  }
  if (Array.isArray(latest1H) && latest1H.length) {
    const last = latest1H[latest1H.length - 1];
    const c = toNum(last.close);
    if (Number.isFinite(c)) return c;
  }
  const f = toNum(fallback);
  return Number.isFinite(f) ? f : null;
}

// ---------- main compute ----------
function computeDel25FVG(latest1H, latest1D, del2_asiaRange, latest5M, nowUtcStr) {
  const nowMs = parseUtcDatetimeToMs(nowUtcStr);
  if (nowMs == null) return { ok: false, reason: "Invalid nowUtc for FVG module" };

  const nowPrice = pickNowPrice({ latest5M, latest1H, fallback: null });
  if (nowPrice == null) return { ok: false, reason: "Cannot determine nowPrice (need close in 5M or 1H)" };

  const raw1H = detectStandardFVGs(latest1H, "1H");
  const raw1D = detectStandardFVGs(latest1D, "1D");

  const H48 = 48 * 60 * 60 * 1000;
  const rel1H = filterRelevantFvgs(raw1H, latest1H, nowMs, { requireRecentMs: H48 });
  const rel1D = filterRelevantFvgs(raw1D, latest1D, nowMs, { requireRecentMs: null });

  const near1H = pickNearestAboveBelow(rel1H, nowPrice);
  const near1D = pickNearestAboveBelow(rel1D, nowPrice);

  const asiaHigh = del2_asiaRange?.ok ? toNum(del2_asiaRange.asiaHigh) : NaN;
  const asiaLow = del2_asiaRange?.ok ? toNum(del2_asiaRange.asiaLow) : NaN;

  function decorateNearest(n, candlesForMitigation) {
    if (!n) return null;

    const mit = computeMitigationPctAfterCreation(n, candlesForMitigation);

    return {
      tf: n.tf,
      direction: n.direction,
      lower: n.lower,
      upper: n.upper,
      createdAtUtc: n.createdAtUtc,
      createdAtOslo: n.createdAtMs != null ? formatMsInOslo(n.createdAtMs) : null,
      relationToPrice: n.relation,
      distancePips: n.distancePips,
      mitigationPct: Number.isFinite(mit.mitigationPct) ? Number(mit.mitigationPct.toFixed(3)) : null,
      overlapsAsiaHigh: Number.isFinite(asiaHigh) ? overlapsLevel(asiaHigh, n.lower, n.upper, 0) : null,
      overlapsAsiaLow: Number.isFinite(asiaLow) ? overlapsLevel(asiaLow, n.lower, n.upper, 0) : null,
    };
  }

  const map = {
    ok: true,
    nowUtc: new Date(nowMs).toISOString(),
    nowOslo: formatMsInOslo(nowMs),
    nowPrice,
    asia: del2_asiaRange?.ok
      ? {
          asiaDateOslo: del2_asiaRange.asiaDateOslo,
          asiaHigh: del2_asiaRange.asiaHigh,
          asiaLow: del2_asiaRange.asiaLow,
          asiaRange: del2_asiaRange.asiaRange,
          windowOslo: del2_asiaRange.windowOslo,
        }
      : { ok: false, reason: "Asia range not available (Del 2)" },

    nearest: {
      "1H": {
        contains: decorateNearest(near1H.contains, latest1H),
        above: decorateNearest(near1H.above, latest1H),
        below: decorateNearest(near1H.below, latest1H),
      },
      "1D": {
        contains: decorateNearest(near1D.contains, latest1D),
        above: decorateNearest(near1D.above, latest1D),
        below: decorateNearest(near1D.below, latest1D),
      },
    },
    counts: {
      detected: { "1H": raw1H.length, "1D": raw1D.length },
      relevant: { "1H": rel1H.length, "1D": rel1D.length },
      note: "Relevant = NOT clearly spent (close beyond boundary). 1H also limited to last 48h.",
    },
  };

  const lines = [];
  lines.push(`Now price: ${nowPrice}`);
  if (map.asia?.ok !== false) {
    lines.push(`Asia H/L: ${map.asia.asiaHigh} / ${map.asia.asiaLow} (Oslo ${map.asia.windowOslo?.start}-${map.asia.windowOslo?.end})`);
  } else {
    lines.push(`Asia H/L: N/A`);
  }

  function lineForNearest(label, obj) {
    if (!obj) return `${label}: N/A`;
    const dist = obj.distancePips == null ? "N/A" : `${Math.round(obj.distancePips)} pips`;
    const overlapBits = [];
    if (obj.overlapsAsiaHigh) overlapBits.push("aligns AsiaHigh");
    if (obj.overlapsAsiaLow) overlapBits.push("aligns AsiaLow");
    const overlapTxt = overlapBits.length ? ` (${overlapBits.join(", ")})` : "";
    const mitTxt = obj.mitigationPct == null ? "" : ` mit:${Math.round(obj.mitigationPct * 100)}%`;
    return `${label}: ${obj.tf} ${obj.direction} [${obj.lower}–${obj.upper}] dist ${dist}${mitTxt}${overlapTxt}`;
  }

  const oneHAbove = map.nearest["1H"].contains || map.nearest["1H"].above;
  lines.push(lineForNearest("Nearest 1H FVG above/at price", oneHAbove));
  lines.push(lineForNearest("Nearest 1H FVG below price", map.nearest["1H"].below));
  lines.push(lineForNearest("Nearest Daily FVG above/at price", map.nearest["1D"].contains || map.nearest["1D"].above));
  lines.push(lineForNearest("Nearest Daily FVG below price", map.nearest["1D"].below));

  map.reportLines = lines;

  return map;
}

function del25_fvgPromptBlock() {
  return `
DEL 2.5 – HTF POI (FVG) (RULES)

PURPOSE
- Map higher-timeframe Fair Value Gaps (FVG) as POI only.
- No bias changes. No entries. Just context.

FVG DEFINITION (standard 3-candle inefficiency; wick-to-wick)
Bullish FVG:
- Candle1.high < Candle3.low
- Zone = [Candle1.high, Candle3.low]

Bearish FVG:
- Candle1.low > Candle3.high
- Zone = [Candle3.high, Candle1.low]

RELEVANT FILTER (pro-consensus-ish)
- Keep FVGs even if partially mitigated (wick touch / partial fill is allowed).
- Remove ONLY when "clearly spent":
  - Bullish FVG: later candle CLOSE <= zone.lower
  - Bearish FVG: later candle CLOSE >= zone.upper

FRESHNESS
- Daily: no strict age limit (still must be not clearly spent).
- 1H: last ~48 hours (still must be not clearly spent).

OUTPUT (map only)
- Current price (now)
- Nearest FVG above price (Daily + 1H)
- Nearest FVG below price (Daily + 1H)
- Direction (bullish/bearish), zone bounds, distance (pips)
- Mitigation% (0–100, for debug only)
- Asia overlap checks (from Del2 Asia High/Low):
  - "Asia High aligns with FVG" = AsiaHigh inside zone
  - "Asia Low aligns with FVG" = AsiaLow inside zone

STRICT
- No extra explanations
- Keep it clean
`.trim();
}

module.exports = {
  computeDel25FVG,
  del25_fvgPromptBlock,
};
