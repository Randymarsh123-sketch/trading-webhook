// analysis/del3_dailyCycles.js
// Del3: Session-cycles + Asia sweep-status (Oslo time)
//
// Sessions (Oslo):
// - Asia: 02:00–06:59
// - Frankfurt: 08:00–08:59
// - London cutoff/fakeout: 09:00–09:30
// - London main move: 10:00–13:59
//
// Sweep-status (based on Asia High/Low):
// - For each later session: did price take Asia High and/or Asia Low?
// - For each taken: first timestamp (Oslo + UTC) and price
// - Also overall: which was taken first after Asia ended (HIGH / LOW / BOTH / NONE)

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
  const osloStr = formatMsInOslo(ms); // "YYYY-MM-DD HH:mm:ss"
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

// Find first Asia High/Low sweep inside a given window (session)
function findFirstSweepsInWindow(latest5M, targetOsloDate, window, asiaHigh, asiaLow) {
  const { name, startHH, startMM, endHH, endMM, inclusiveEnd = true } = window;

  let firstHigh = null; // { ms, oslo, utc, price }
  let firstLow = null;

  for (const c of latest5M) {
    const ms = parseUtcDatetimeToMs(c.datetime);
    if (ms == null) continue;

    if (getOsloDateKeyFromMs(ms) !== targetOsloDate) continue;

    const { hh, mm, osloStr } = getOsloHHMM_fromMs(ms);
    if (!inTimeWindowOslo(hh, mm, startHH, startMM, endHH, endMM, inclusiveEnd)) continue;

    const h = toNum(c.high);
    const l = toNum(c.low);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;

    if (!firstHigh && h > asiaHigh) {
      firstHigh = {
        ms,
        tsOslo: osloStr,
        tsUtc: new Date(ms).toISOString(),
        price: h,
      };
    }

    if (!firstLow && l < asiaLow) {
      firstLow = {
        ms,
        tsOslo: osloStr,
        tsUtc: new Date(ms).toISOString(),
        price: l,
      };
    }

    // If both found, we can stop scanning this window early
    if (firstHigh && firstLow) break;
  }

  return {
    ok: true,
    name,
    highTaken: !!firstHigh,
    lowTaken: !!firstLow,
    firstHigh,
    firstLow,
  };
}

function computeAsiaSweepStatus(latest5M, targetOsloDate, sessions) {
  const asia = sessions["Asia"];
  if (!asia || !asia.ok) {
    return { ok: false, reason: "Asia session not available" };
  }

  const asiaHigh = toNum(asia.high);
  const asiaLow = toNum(asia.low);
  if (!Number.isFinite(asiaHigh) || !Number.isFinite(asiaLow)) {
    return { ok: false, reason: "Invalid Asia high/low" };
  }

  const windowsAfterAsia = [
    { name: "Frankfurt", startHH: 8, startMM: 0, endHH: 8, endMM: 59, inclusiveEnd: true },
    { name: "London cutoff/fakeout", startHH: 9, startMM: 0, endHH: 9, endMM: 30, inclusiveEnd: true },
    { name: "London main move", startHH: 10, startMM: 0, endHH: 13, endMM: 59, inclusiveEnd: true },
  ];

  const perSession = {};
  for (const w of windowsAfterAsia) {
    perSession[w.name] = findFirstSweepsInWindow(latest5M, targetOsloDate, w, asiaHigh, asiaLow);
  }

  // Determine overall first taken after Asia end (across all windows)
  let earliestHigh = null; // { session, ...firstHigh }
  let earliestLow = null;

  for (const [sessionName, r] of Object.entries(perSession)) {
    if (r && r.firstHigh) {
      if (!earliestHigh || r.firstHigh.ms < earliestHigh.ms) {
        earliestHigh = { session: sessionName, ...r.firstHigh };
      }
    }
    if (r && r.firstLow) {
      if (!earliestLow || r.firstLow.ms < earliestLow.ms) {
        earliestLow = { session: sessionName, ...r.firstLow };
      }
    }
  }

  let firstTaken = "NONE";
  let firstEvent = null;

  if (earliestHigh && earliestLow) {
    if (earliestHigh.ms === earliestLow.ms) {
      firstTaken = "BOTH";
      firstEvent = {
        type: "BOTH",
        session: `${earliestHigh.session} & ${earliestLow.session}`,
        tsOslo: earliestHigh.tsOslo,
        tsUtc: earliestHigh.tsUtc,
        highPrice: earliestHigh.price,
        lowPrice: earliestLow.price,
      };
    } else if (earliestHigh.ms < earliestLow.ms) {
      firstTaken = "HIGH";
      firstEvent = {
        type: "HIGH",
        session: earliestHigh.session,
        tsOslo: earliestHigh.tsOslo,
        tsUtc: earliestHigh.tsUtc,
        price: earliestHigh.price,
      };
    } else {
      firstTaken = "LOW";
      firstEvent = {
        type: "LOW",
        session: earliestLow.session,
        tsOslo: earliestLow.tsOslo,
        tsUtc: earliestLow.tsUtc,
        price: earliestLow.price,
      };
    }
  } else if (earliestHigh) {
    firstTaken = "HIGH";
    firstEvent = {
      type: "HIGH",
      session: earliestHigh.session,
      tsOslo: earliestHigh.tsOslo,
      tsUtc: earliestHigh.tsUtc,
      price: earliestHigh.price,
    };
  } else if (earliestLow) {
    firstTaken = "LOW";
    firstEvent = {
      type: "LOW",
      session: earliestLow.session,
      tsOslo: earliestLow.tsOslo,
      tsUtc: earliestLow.tsUtc,
      price: earliestLow.price,
    };
  }

  const anyHigh = !!earliestHigh;
  const anyLow = !!earliestLow;

  return {
    ok: true,
    asiaHigh,
    asiaLow,
    firstTaken, // HIGH / LOW / BOTH / NONE
    firstEvent, // details
    summary: {
      highTakenAnytime: anyHigh,
      lowTakenAnytime: anyLow,
      bothTakenAnytime: anyHigh && anyLow,
    },
    perSession,
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

  const asiaSweepStatus = computeAsiaSweepStatus(latest5M, osloDate, sessions);

  return {
    ok: true,
    osloDate,
    sessions,
    asiaSweepStatus,
  };
}

function del3_dailyCyclesPromptBlock() {
  return `
DEL 3 – DAILY CYCLES (SESSION FRAMEWORK + ASIA SWEEP STATUS)

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

ASIA SWEEP STATUS (data only)
- Asia High / Asia Low are taken from the Asia session.
- Check AFTER Asia ends:
  - Did price take Asia High?
  - Did price take Asia Low?
- For each later session (Frankfurt / cutoff / main move):
  - first time Asia High is taken (Oslo + UTC) and price
  - first time Asia Low is taken (Oslo + UTC) and price
- Also determine which was taken first overall:
  - HIGH / LOW / BOTH / NONE

STRICT
- No trade decisions here (yet)
- Keep it clean
`.trim();
}

module.exports = {
  computeDel3Sessions,
  del3_dailyCyclesPromptBlock,
};
