// StatusMal.js
// Kun tekst/format for status-malen. Ingen datafetch, ingen setup-logikk.

function normalizeBias(x) {
  const s = String(x || "").trim();
  if (s === "Bullish" || s === "Bearish" || s === "Ranging") return s;
  return "Ranging";
}

function decideDirectionFromBias(bias10) {
  if (bias10 === "Bullish") return "UP";
  if (bias10 === "Bearish") return "DOWN";
  return "—";
}

function mapActiveSetup(finalObj) {
  const play = String(finalObj?.play || "").trim();
  return play || "NONE";
}

function mapTriggerText(finalObj) {
  if (finalObj && typeof finalObj.triggerText === "string" && finalObj.triggerText.trim()) {
    return finalObj.triggerText.trim();
  }
  const reason = String(finalObj?.reason || "").trim();
  return reason || "NO VALID SETUP";
}

function mapQuality(finalObj) {
  const q = String(finalObj?.quality || "").trim();
  if (q === "A" || q === "B") return q;

  const play = String(finalObj?.play || "");
  if (/overlay/i.test(play)) return "A";
  if (play && play !== "NONE") return "B";
  return "—";
}

/**
 * buildStatusMal
 * Må kalles fra report.js (eller en wrapper) som allerede har:
 * - effectiveNowMs
 * - bias10
 * - sessions (med sessions.asia.stats)
 * - final (trade/play/reason/quality/triggerText)
 *
 * report.js må sende inn disse to funksjonene (så StatusMal.js slipper timezone-logikk):
 * - getOsloDateKeyFromMs(ms) -> "YYYY-MM-DD"
 * - getOsloHHMM_fromMs(ms)   -> "HH:MM"
 */
function buildStatusMal({
  effectiveNowMs,
  bias10,
  sessions,
  final,
  getOsloDateKeyFromMs,
  getOsloHHMM_fromMs,
}) {
  const date = effectiveNowMs != null ? getOsloDateKeyFromMs(effectiveNowMs) : "N/A";
  const time = effectiveNowMs != null ? getOsloHHMM_fromMs(effectiveNowMs) : "N/A";

  const b10 = normalizeBias(bias10);

  const asia = sessions?.asia?.stats;
  const asiaRange =
    asia?.ok && Number.isFinite(asia.low) && Number.isFinite(asia.high)
      ? `${asia.low.toFixed(5)} – ${asia.high.toFixed(5)}`
      : "N/A";

  const tradeGO = final?.trade === "Yes";
  const activeSetup = mapActiveSetup(final);
  const quality = mapQuality(final);

  let triggerStatus = mapTriggerText(final);
  if (tradeGO) {
    const reason = String(final?.reason || "").trim();
    triggerStatus = reason ? `CONFIRMED — ${reason}` : "CONFIRMED";
  }

  const trade = tradeGO ? "GO" : "NO";
  const direction = tradeGO ? decideDirectionFromBias(b10) : "—";

  // SELVE MALEN (rediger fritt her)
  return `
DATE: ${date}   TIME: ${time} (Oslo)
BIAS (10–14): ${b10}
ASIA RANGE: ${asiaRange}

ACTIVE SETUP:
${activeSetup}

TRIGGER STATUS:
${triggerStatus}

TRADE:
${trade}
Direction: ${direction}
Quality: ${quality}
`.trim();
}

module.exports = { buildStatusMal };
