module.exports = function dailyBiasBlock() {
  return `
DEL 1 – DAILY CANDLE BIAS (MECHANICAL)

USE ONLY DAILY CANDLES
- Use ONLY yesterday (D-1) and the day before (D-2).
- Ignore all other days for scoring.

DEFINITIONS
range = high − low
close_position = (close − low) / range

INSIDE DAY
D-1 high ≤ D-2 high AND D-1 low ≥ D-2 low

OVERLAP REGIME
D-1 and D-2 overlap heavily (approximately ≥70% of the range)

SCORING SYSTEM (DAILY ONLY)

Score 3 (best)
- close_position ≥ 0.60 OR ≤ 0.40
- NOT an inside day
- NOT overlap regime

Score 2 (medium)
- close_position in [0.55–0.60) OR (0.40–0.45]
OR
- close_position strong BUT inside day or overlap exists

Score 1 (poor)
- close_position near middle of range
OR
- clear chop / heavy overlap

Score 1 is ALWAYS NO TRADE.

BASE DAILY BIAS (before intraday info)
- close_position ≥ 0.60 → Bullish
- close_position ≤ 0.40 → Bearish
- otherwise → Ranging / Uncertain

ASIA REFINEMENT RULES
(Use only information available up to the evaluation time)

- Asia Low taken first → bias leans Bullish
- Asia High taken first → bias leans Bearish
- No Asia break → keep daily bias
- Both Asia High and Low taken → Ranging + NO TRADE

BIAS SNAPSHOTS REQUIRED
You must output bias at:
- 09:00
- 10:00

LONDON SCENARIO (SIMPLE LANGUAGE ONLY)
Choose ONE:
- "slightly up first → then price down"
- "slightly down first → then price up"
- "range / back and forth"
- "no trade (messy day)"

MANDATORY OUTPUT FIELDS (DAILY)
- Score: 3 / 2 / 1
- Trade: Yes / No
- Bias 09:00: Bullish / Bearish / Ranging
- Bias 10:00: Bullish / Bearish / Ranging
- London scenario (one line)
- 08:00–09:00 candle: Open → Close

STRICT RULES
- No indicator language
- No historical explanations
- No hindsight
- No questions back
- Follow rules mechanically
`.trim();
}
