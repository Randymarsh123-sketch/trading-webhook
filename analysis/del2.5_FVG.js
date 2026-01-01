// del2.5_FVG.js
// DEL 2.5 – HTF POI (FVG)
//
// PURPOSE
// - Map HTF Fair Value Gaps (FVG) as POI
// - No bias changes, no entries
//
// FVG DEFINITION
// - Standard 3-candle inefficiency
// - Wick-to-wick ONLY
//
// RELEVANCE LOGIC
// 1H:
// - Freshness: last 96h
// - Remove if:
//   a) CLEARLY SPENT (close beyond boundary)
//   b) FULLY MITIGATED >= 96%
//
// Daily:
// - No freshness limit
// - Remove if:
//   a) CLEARLY SPENT
//   b) FULLY MITIGATED >= 98%

const OSLO_TZ = "Europe/Oslo";
const PIP_SIZE = 0.0001;

// === TUNABLES ===
const H1_FRESH_MS = 96 * 60 * 60 * 1000;
const H1_FULLY_MITIGATED = 0.96;
const D1_FULLY_MITIGATED = 0.98;

// ---------- helpers ----------
function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function parseUtcDatetimeToMs(dtStr) {
  const s = String(dtStr || "").trim();
  if (!s) return null;
  const [d, t] = s.split(" ");
  const [Y, M, D] = d.split("-").map(Number);
  const [h = 0, m = 0, s2 = 0] = (t || "").split(":").map(Number);
  return Date.UTC(Y, M - 1, D, h, m, s2);
}

function formatMsInOslo(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: OSLO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms)).replace(",", "");
}

function pips(diff) {
  return Math.abs(diff) / PIP_SIZE;
}

// ---------- FVG detection ----------
function detectFVGs(candles, tf) {
  const out = [];
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c2 = candles[i - 1];
    const c3 = candles[i];

    const h1 = toNum(c1.high);
    const l1 = toNum(c1.low);
    const h3 = toNum(c3.high);
    const l3 = toNum(c3.low);

    if (!Number.isFinite(h1) || !Number.isFinite(l1) || !Number.isFinite(h3) || !Number.isFinite(l3)) continue;

    const createdAtMs = parseUtcDatetimeToMs(c2.datetime);

    // Bullish FVG
    if (h1 < l3) {
      out.push({
        tf,
        direction: "BULLISH",
        lower: h1,
        upper: l3,
        createdAtMs,
        createdAtUtc: c2.datetime,
        iCreated: i - 1,
      });
    }

    // Bearish FVG
    if (l1 > h3) {
      out.push({
        tf,
        direction: "BEARISH",
        lower: h3,
        upper: l1,
        createdAtMs,
        createdAtUtc: c2.datetime,
        iCreated: i - 1,
      });
    }
  }
  return out;
}

// ---------- mitigation ----------
function mitigationPct(fvg, candles) {
  const lo = fvg.lower;
  const hi = fvg.upper;
  const height = hi - lo;
  if (height <= 0) return 1;

  let deepest = 0;

  for (let i = fvg.iCreated + 1; i < candles.length; i++) {
    const h = toNum(candles[i].high);
    const l = toNum(candles[i].low);

    if (fvg.direction === "BULLISH" && l < hi) {
      deepest = Math.max(deepest, hi - Math.max(l, lo));
    }

    if (fvg.direction === "BEARISH" && h > lo) {
      deepest = Math.max(deepest, Math.min(h, hi) - lo);
    }
  }

  return Math.min(1, deepest / height);
}

function isClearlySpent(fvg, candles) {
  for (let i = fvg.iCreated + 1; i < candles.length; i++) {
    const c = toNum(candles[i].close);
    if (fvg.direction === "BULLISH" && c <= fvg.lower) return true;
    if (fvg.direction === "BEARISH" && c >= fvg.upper) return true;
  }
  return false;
}

// ---------- filtering ----------
function filterFVGs(fvgs, candles, nowMs, tf) {
  return fvgs.filter((fvg) => {
    const mit = mitigationPct(fvg, candles);
    const cutoff = tf === "1H" ? H1_FULLY_MITIGATED : D1_FULLY_MITIGATED;

    if (isClearlySpent(fvg, candles)) return false;
    if (mit >= cutoff) return false;

    if (tf === "1H") {
      if (nowMs - fvg.createdAtMs > H1_FRESH_MS) return false;
    }

    fvg.mitigationPct = mit;
    return true;
  });
}

// ---------- nearest logic ----------
function classifyRelation(price, fvg) {
  if (price < fvg.lower) return "ABOVE";
  if (price > fvg.upper) return "BELOW";
  return "CONTAINS";
}

function nearestByRelation(fvgs, price, wanted) {
  let best = null;
  for (const fvg of fvgs) {
    const rel = classifyRelation(price, fvg);
    if (rel !== wanted) continue;

    const dist =
      rel === "ABOVE" ? pips(fvg.lower - price) :
      rel === "BELOW" ? pips(price - fvg.upper) :
      Math.min(pips(price - fvg.lower), pips(fvg.upper - price));

    if (!best || dist < best.distancePips) {
      best = { ...fvg, relation: rel, distancePips: dist };
    }
  }
  return best;
}

function overlaps(level, fvg) {
  return level >= fvg.lower && level <= fvg.upper;
}

// ---------- main ----------
function computeDel25FVG(latest1H, latest1D, del2_asiaRange, latest5M, nowUtcStr) {
  const nowMs = parseUtcDatetimeToMs(nowUtcStr);
  const nowPrice = toNum(latest5M?.at(-1)?.close ?? latest1H?.at(-1)?.close);

  const raw1H = detectFVGs(latest1H, "1H");
  const raw1D = detectFVGs(latest1D, "1D");

  const fvg1H = filterFVGs(raw1H, latest1H, nowMs, "1H");
  const fvg1D = filterFVGs(raw1D, latest1D, nowMs, "1D");

  const asiaHigh = del2_asiaRange?.ok ? toNum(del2_asiaRange.asiaHigh) : NaN;
  const asiaLow = del2_asiaRange?.ok ? toNum(del2_asiaRange.asiaLow) : NaN;

  function decorate(fvg) {
    if (!fvg) return null;
    return {
      ...fvg,
      createdAtOslo: formatMsInOslo(fvg.createdAtMs),
      overlapsAsiaHigh: Number.isFinite(asiaHigh) ? overlaps(asiaHigh, fvg) : null,
      overlapsAsiaLow: Number.isFinite(asiaLow) ? overlaps(asiaLow, fvg) : null,
    };
  }

  const result = {
    ok: true,
    nowOslo: formatMsInOslo(nowMs),
    nowPrice,
    nearest: {
      "1H": {
        contains: decorate(nearestByRelation(fvg1H, nowPrice, "CONTAINS")),
        above: decorate(nearestByRelation(fvg1H, nowPrice, "ABOVE")),
        below: decorate(nearestByRelation(fvg1H, nowPrice, "BELOW")),
      },
      "1D": {
        contains: decorate(nearestByRelation(fvg1D, nowPrice, "CONTAINS")),
        above: decorate(nearestByRelation(fvg1D, nowPrice, "ABOVE")),
        below: decorate(nearestByRelation(fvg1D, nowPrice, "BELOW")),
      },
    },
  };

  const lines = [];
  lines.push(`Now price: ${nowPrice}`);

  function line(label, fvg) {
    if (!fvg) return `${label}: N/A`;
    return `${label}: ${fvg.tf} ${fvg.direction} [${fvg.lower}–${fvg.upper}] dist ${Math.round(fvg.distancePips)} pips mit ${Math.round(fvg.mitigationPct * 100)}%`;
  }

  lines.push(line("Nearest 1H FVG above/at price", result.nearest["1H"].contains || result.nearest["1H"].above));
  lines.push(line("Nearest 1H FVG below price", result.nearest["1H"].below));
  lines.push(line("Nearest Daily FVG above/at price", result.nearest["1D"].contains || result.nearest["1D"].above));
  lines.push(line("Nearest Daily FVG below price", result.nearest["1D"].below));

  result.reportLines = lines;
  return result;
}

function del25_fvgPromptBlock() {
  return `
DEL 2.5 – HTF POI (FVG)

- Standard 3-candle FVG (wick-to-wick)
- Partial mitigation allowed
- Remove only when:
  • Close beyond boundary
  • OR fully mitigated

THRESHOLDS
- 1H: >= 96% mitigated → ignore
- Daily: >= 98% mitigated → ignore
- 1H freshness: last 96 hours

Output = context map only (no bias change)
`.trim();
}

module.exports = {
  computeDel25FVG,
  del25_fvgPromptBlock,
};
