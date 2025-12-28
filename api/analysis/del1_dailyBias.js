module.exports = function dailyBiasBlock() {
  return `
DEL 1 – DAILY BIAS (RULES)

DATA RULE
- Use ONLY yesterday (D-1) and the day before (D-2) DAILY candles for score & base bias.
- Do NOT use intraday candles to compute D-1/D-2.

DEFINITIONS (internal only)
- range = high − low
- close_position = (close − low) / range
IMPORTANT: Do NOT show calculations. Do NOT show formulas. Just output the final fields.

INSIDE DAY
- D-1 high ≤ D-2 high AND D-1 low ≥ D-2 low

OVERLAP REGIME
- Heavy overlap between D-1 and D-2 (≈ ≥70%)

SCORING
Score 3:
- close_position ≥ 0.60 OR ≤ 0.40
- NOT inside day
- NOT overlap regime

Score 2:
- close_position in [0.55–0.60) OR (0.40–0.45]
OR strong close_position but inside/overlap exists

Score 1:
- close_position near middle OR clear chop/overlap
Score 1 = ALWAYS Trade: No

BASE DAILY BIAS
- close_position ≥ 0.60 → Bullish
- close_position ≤ 0.40 → Bearish
- else → Ranging

ASIA REFINEMENT (ONLY if the question/time requires it)
- Asia Low taken first → leans Bullish
- Asia High taken first → leans Bearish
- Both taken → Ranging + Trade: No
- No break → keep base bias

MANDATORY OUTPUT (ONLY these lines, no extra text)
Score: 3/2/1
Trade: Yes/No
Bias 09: Bullish/Bearish/Ranging
Bias 10: Bullish/Bearish/Ranging
London scenario: (choose one)
- slightly up first → then price down
- slightly down first → then price up
- range / back and forth
- no trade (messy day)
08:00–09:00 candle: Open → Close (if available; if not available write "N/A")

STRICT
- No calculations
- No explanations
- No extra headings
`.trim();
}
