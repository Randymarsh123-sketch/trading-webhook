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

function inTimeWindowOslo(hh, mm, startHH, startMM, endHH, endMM, inclusiveEnd) {
  const afterStart = hh > startHH || (hh === startHH && mm >= startMM);
  let beforeEnd = hh < endHH || (hh === endHH && mm < endMM);
  if (inclusiveEnd) beforeEnd = hh < endHH || (hh === endHH && mm <= endMM);
  return afterStart && beforeEnd;
}

function computeSessionStats(latest5M, targetOsloDate, window) {
  const { name, startHH, startMM, endHH, endMM, inclusiveEnd = true } = window;

  if (!Array.isArray(latest5M) || latest5M.length === 0) {
    return { ok: false, name, reason: "No 5M candles" };
  }

  const rows = [];

  for (const c of latest5M) {
    const ms = parseUtcDatetimeToMs(c.datetime);
    if (ms == null) continue;

    if (getOsloDateKeyFromMs(ms) !== targetOsloDate) continue;

    const { hh, mm, osloStr } = getOsloHHMM_fromMs(ms);

    if (!inTimeWindowOslo(hh, mm, startHH, startMM, endHH, endMM, inclusiveEnd)) continue;

    const high = toNum(c.high);
    const low = toNum(c.low);
    const open = toNum(c.open);
    const close = toNum(c.close);
    if (![high, low, open, close].every(Number.isFinite)) continue;

    rows.push({ ms, osloStr, high, low, open, close });
  }

  if (!rows.length) {
    return {
      ok: false,
      name,
      reason: "No candles in window",
      windowOslo: `${String(startHH).padStart(2, "0")}:${String(startMM).padStart(2, "0")}–${String(endHH).padStart(2, "0")}:${String(endMM).padStart(2, "0")}`,
      candlesCount: 0,
    };
  }

  rows.sort((a, b) => a.ms - b.ms);

  let hi = -Infinity;
  let lo = Infinity;

  for (const r of rows) {
    if (r.high > hi) hi = r.high;
    if (r.low < lo) lo = r.low;
  }

  const first = rows[0];
  const last = rows[rows.length - 1];

  return {
    ok: true,
    name,
    windowOslo: `${String(startHH).padStart(2, "0")}:${String(startMM).padStart(2, "0")}–${String(endHH).padStart(2, "0")}:${String(endMM).padStart(2, "0")}`,
    candlesCount: rows.length,
    open: first.open,
    close: last.close,
    high: hi,
    low: lo,
    range: hi - lo,
    startTsOslo: first.osloStr,
    endTsOslo: last.osloStr,
    startTsUtc: new Date(first.ms).toISOString(),
    endTsUtc: new Date(last.ms).toISOString(),
  };
}

function computeDel3Sessions(latest5M, nowUtcStr) {
  const nowMs = parseUtcDatetimeToMs(nowUtcStr);
  if (nowMs == null) return { ok: false, reason: "Invalid nowUtc" };

  const osloDate = getOsloDateKeyFromMs(nowMs);

  const windows = [
    { name: "Asia", startHH: 2, startMM: 0, endHH: 6, endMM: 59, inclusiveEnd: true },
    { name: "Frankfurt", startHH: 8, startMM: 0, endHH: 8, endMM: 59, inclusiveEnd: true },
    { name: "London cutoff/fakeout", startHH: 9, startMM: 0, endHH: 9, endMM: 30, inclusiveEnd: true },
    { name: "London main move", startHH: 10, startMM: 0, endHH: 13, endMM: 59, inclusiveEnd: true },
  ];

  const sessions = {};
  for (const w of windows) {
    sessions[w.name] = computeSessionStats(latest5M, osloDate, w);
  }

  return { ok: true, osloDate, sessions };
}

function del3_dailyCyclesPromptBlock() {
  return `
DEL 3 – DAILY CYCLES (SESSION FRAMEWORK v0)

IMPORTANT
- This block only defines SESSION WINDOWS and the data we extract.
- Do NOT add advanced logic yet (Judas / whipsaw / dead-Frankfurt etc.) until later.

SESSION WINDOWS (Oslo time)
- Asia: 02:00–06:59
- Frankfurt: 08:00–08:59
- London cutoff/fakeout: 09:00–09:30
- London main move: 10:00–13:59

DATA PER SESSION
- High / Low / Range
- Open / Close (first/last 5M candle in the window)
- Candle count
- Start/End timestamps (Oslo + UTC)

STRICT
- Keep it clean
- No extra headings
`.trim();
}

module.exports = {
  computeDel3Sessions,
  del3_dailyCyclesPromptBlock,
};
