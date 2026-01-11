// api/status.js
// Public status endpoint for ChatGPT summaries

import report from "./report.js"; // juster om report.js eksporterer annerledes
import { runSetups } from "./10_14_setups.js"; // hvis du eksporterer runSetups

export default async function handler(req, res) {
  try {
    // 1) Bygg dagens report (sessions + ctx)
    // Du må tilpasse denne linja til hvordan report.js faktisk fungerer hos deg.
    // Typisk: const r = await report({ date: "YYYY-MM-DD" })
    const r = await report(req);

    // 2) Kjør setups (inkl. LondonFirstSweep)
    const setups = runSetups(r.daily, r.sessions, r.ctx);

    // 3) Returner en “minimal status-pakke” som er lett å lese
    res.status(200).json({
      ok: true,
      dateOslo: r.dateOslo || r.ctx?.dateOslo || null,
      marketClosed: !!r.ctx?.marketClosed,

      asia: {
        high: r.sessions?.asia?.stats?.high ?? null,
        low: r.sessions?.asia?.stats?.low ?? null,
        rangePips: r.sessions?.asia?.stats?.high && r.sessions?.asia?.stats?.low
          ? (r.sessions.asia.stats.high - r.sessions.asia.stats.low) / 0.0001
          : null
      },

      pdh: r.ctx?.pdh ?? null,
      pdl: r.ctx?.pdl ?? null,

      setups
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
