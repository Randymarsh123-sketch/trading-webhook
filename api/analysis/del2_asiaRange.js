// api/analysis/del2_asiaRange.js
// Del2: Asia Range + Break (Oslo time logic) + prompt block

const OSLO_TZ = "Europe/Oslo";

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

  // not expected for 5M, but safe
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

function computeAsiaRange_0200_0659_Oslo(latest5M, nowUtcStr) {
  if (!Array.isArray(latest5M) || latest5M.length === 0) {
    return { ok: false, reason: "No 5M candles" };
  }
  const nowMs = parseUtcDatetimeToMs(nowUtcStr);
  if (nowMs == null) {
    return { ok: false, reason: "Invalid nowUtc for Asia range" };
  }

  const targetOsloDate = getOsloDateKeyFromMs(nowMs);

  const windowStart = "02:00";
  const windowEnd = "06:59";

  const inWindow = [];

  for (const c of latest5M) {
    const ms = parseUtcDatetimeToMs(c.datetime);
    if (ms == null) continue;

    if (getOsloDateKeyFromMs(ms) !== targetOsloDate) continue;

    const { hh, mm } = getOsloHHMM_fromMs(ms);

    // 02:00–06:59 inclusive
    const afterStart = hh > 2 || (hh === 2 && mm >= 0);
    const beforeEnd = hh < 6 || (hh === 6 && mm <= 59);
    if (!afterStart || !beforeEnd) continue;

    const high = toNum(c.high);
    const low = toNum(c.low);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    inWindow.push({ ms, high, low });
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

  return {
    ok: true,
    asiaDateOslo: targetOsloDate,
    windowOslo: { start: windowStart, end: windowEnd },
    candlesCount: inWindow.length,
    asiaHigh,
    asiaLow,
    asiaRange: asiaHigh - asiaLow,
    startTsUtc: new Date(startMs).toISOString(),
    endTsUtc: new Date(endMs).toISOString(),
    startTsOslo: formatMsInOslo(startMs),
    endTsOslo: formatMsInOslo(endMs),
  };
}

function computeAsiaBreakAfter0700_Oslo(latest5M, del2_asiaRange) {
  if (!del2_asiaRange || !del2_asiaRange.ok) {
    return { ok: false, reason: "Asia range not available" };
  }
  if (!Array.isArray(latest5M) || latest5M.length === 0) {
    return { ok: false, reason: "No 5M candles" };
  }

  const targetOsloDate = del2_asiaRange.asiaDateOslo;
  const asiaHigh = toNum(del2_asiaRange.asiaHigh);
  const asiaLow = toNum(del2_asiaRange.asiaLow);

  if (!Number.isFinite(asiaHigh) || !Number.isFinite(asiaLow)) {
    return { ok: false, reason: "Invalid asiaHigh/asiaLow" };
  }

  const checkedFromOslo = "07:00";

  for (const c of latest5M) {
    const ms = parseUtcDatetimeToMs(c.datetime);
    if (ms == null) continue;

    if (getOsloDateKeyFromMs(ms) !== targetOsloDate) continue;

    const { hh, mm, osloStr } = getOsloHHMM_fromMs(ms);

    const after0700 = hh > 7 || (hh === 7 && mm >= 0);
    if (!after0700) continue;

    const h = toNum(c.high);
    const l = toNum(c.low);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;

    const brokeUp = h > asiaHigh;
    const brokeDown = l < asiaLow;

    if (!brokeUp && !brokeDown) continue;

    // If both in same candle, choose stronger distance beyond level
    let breakDirection = "UP";
    let breakPrice = h;

    if (brokeUp && brokeDown) {
      const upDist = h - asiaHigh;
      const downDist = asiaLow - l;
      if (downDist > upDist) {
        breakDirection = "DOWN";
        breakPrice = l;
      } else {
        breakDirection = "UP";
        breakPrice = h;
      }
    } else if (brokeDown) {
      breakDirection = "DOWN";
      breakPrice = l;
    }

    return {
      ok: true,
      checkedFromOslo,
      breakDirection,
      breakPrice,
      breakTsOslo: osloStr,
      breakTsUtc: new Date(ms).toISOString(),
    };
  }

  return {
    ok: true,
    checkedFromOslo,
    breakDirection: "NONE",
  };
}

function computeDel2Asia(latest5M, nowUtcStr) {
  const del2_asiaRange = computeAsiaRange_0200_0659_Oslo(latest5M, nowUtcStr);
  const del2_asiaBreak = computeAsiaBreakAfter0700_Oslo(latest5M, del2_asiaRange);
  return { del2_asiaRange, del2_asiaBreak };
}

function del2_asiaRangePromptBlock() {
  return `
DEL 2 – ASIA RANGE (RULES)

SESSION (Oslo time)
- Asia window: 02:00–06:59 Oslo
- Compute Asia High/Low from 5M candles in that window
- Asia Range = High − Low

BREAK CHECK (Oslo time)
- From 07:00 Oslo onward: find FIRST 5M candle that breaks:
  - UP if candle.high > Asia High
  - DOWN if candle.low < Asia Low
- If no break: Break = NONE

OUTPUT (for report/debug)
- Asia Date (Oslo)
- Asia High / Asia Low / Asia Range
- Candles count
- Start/End timestamps (Oslo + UTC)
- Break direction + break timestamp (Oslo + UTC) + break price

STRICT
- No extra explanations
- Keep it clean
`.trim();
}

module.exports = {
  computeDel2Asia,
  del2_asiaRangePromptBlock,
};
