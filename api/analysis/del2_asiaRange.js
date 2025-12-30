// /analysis/del2_asiaRange.js
// Del2: Asia Range (02:00–06:59 Europe/Oslo)
// Input: 5M candles lagret i UTC (fra Redis: candles:EURUSD:5M)
// Output: Asia High/Low/Range + start/end timestamps (UTC + Oslo)

const OSLO_TZ = "Europe/Oslo";

// TwelveData/Redis kan gi datetime som ISO eller "YYYY-MM-DD HH:mm:ss"
function parseUtcDate(datetimeStr) {
  if (!datetimeStr || typeof datetimeStr !== "string") return null;

  // Gjør "YYYY-MM-DD HH:mm:ss" -> "YYYY-MM-DDTHH:mm:ss"
  let s = datetimeStr.includes("T") ? datetimeStr : datetimeStr.replace(" ", "T");

  // Hvis ingen timezone/offset, anta UTC og legg på Z
  const hasZone = /Z$|[+-]\d{2}:\d{2}$/.test(s);
  if (!hasZone) s = `${s}Z`;

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function formatIsoLikeInTZ(dateUtc, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(dateUtc);

  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const hh = get("hour");
  const mi = get("minute");
  const ss = get("second");

  // ISO-lignende uten offset (vi gir også UTC-ISO separat)
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}

function getOsloDateKey(dateUtc) {
  // YYYY-MM-DD i Oslo
  const osloIso = formatIsoLikeInTZ(dateUtc, OSLO_TZ);
  return osloIso.slice(0, 10);
}

function toNumber(x) {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * computeAsiaRange
 * @param {Object} args
 * @param {Array}  args.candles5mUtc Array av 5m candles (UTC)
 * @param {string|Date} args.nowUtc Nåtid i UTC (Date eller ISO)
 * @returns {Object} Resultatobjekt
 */
function computeAsiaRange({ candles5mUtc, nowUtc }) {
  const now = nowUtc instanceof Date ? nowUtc : new Date(nowUtc);
  if (Number.isNaN(now.getTime())) {
    return { ok: false, reason: "Invalid nowUtc provided to computeAsiaRange" };
  }

  if (!Array.isArray(candles5mUtc) || candles5mUtc.length === 0) {
    return { ok: false, reason: "No 5M candles provided" };
  }

  const targetOsloDate = getOsloDateKey(now);

  // Window: 02:00–06:59 Oslo
  const windowStart = "02:00";
  const windowEnd = "06:59";

  const inWindow = [];

  for (const c of candles5mUtc) {
    const dUtc = parseUtcDate(c.datetime);
    if (!dUtc) continue;

    // Må være samme Oslo-dato som "i dag"
    if (getOsloDateKey(dUtc) !== targetOsloDate) continue;

    // Hent Oslo time/min
    const osloIso = formatIsoLikeInTZ(dUtc, OSLO_TZ); // YYYY-MM-DDTHH:mm:ss
    const hh = Number(osloIso.slice(11, 13));
    const mm = Number(osloIso.slice(14, 16));

    // 02:00–06:59 (inkludert)
    const afterStart = hh > 2 || (hh === 2 && mm >= 0);
    const beforeEnd = hh < 6 || (hh === 6 && mm <= 59);

    if (!afterStart || !beforeEnd) continue;

    const high = toNumber(c.high);
    const low = toNumber(c.low);
    if (high === null || low === null) continue;

    inWindow.push({ dUtc, high, low });
  }

  if (inWindow.length === 0) {
    return {
      ok: false,
      reason: `No candles found in Asia window for Oslo date ${targetOsloDate}`,
      asiaDateOslo: targetOsloDate,
      windowOslo: { start: windowStart, end: windowEnd },
      candlesCount: 0,
    };
  }

  // Sorter for start/end
  inWindow.sort((a, b) => a.dUtc.getTime() - b.dUtc.getTime());

  let asiaHigh = -Infinity;
  let asiaLow = Infinity;

  for (const row of inWindow) {
    if (row.high > asiaHigh) asiaHigh = row.high;
    if (row.low < asiaLow) asiaLow = row.low;
  }

  const startUtc = inWindow[0].dUtc;
  const endUtc = inWindow[inWindow.length - 1].dUtc;

  return {
    ok: true,
    asiaDateOslo: targetOsloDate,
    windowOslo: { start: windowStart, end: windowEnd },
    candlesCount: inWindow.length,

    asiaHigh,
    asiaLow,
    asiaRange: asiaHigh - asiaLow,

    startTsUtc: startUtc.toISOString(),
    endTsUtc: endUtc.toISOString(),
    startTsOslo: formatIsoLikeInTZ(startUtc, OSLO_TZ),
    endTsOslo: formatIsoLikeInTZ(endUtc, OSLO_TZ),
  };
}

module.exports = {
  computeAsiaRange,
};
