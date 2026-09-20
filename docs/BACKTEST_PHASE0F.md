# Backtest Phase 0F — RSI, Fibonacci and other technical signals

**Question.** Phase 0E showed the engine's broker-flow composite has no
predictive power. Do classic technical signals do better — specifically RSI and
Fibonacci retracements, which are widely believed to work — and do a few
literature-backed alternatives?

**Harness:** `packages/backtest/src/phase0f.ts` (OHLCV from `daily_bar`, no API
calls). Same statistic as Phase 0E: per-date Spearman rank-IC of the signal vs
**forward excess return** (return minus that date's cross-sectional mean), plus
quintile spreads, at 1/3/5/10 trading days. **195 symbols, 19,096 observations,
106 dates (2026-04-10 → 2026-09-17).**

## Pre-registered (fixed before any result was seen; nothing tuned)

- **RSI:** Wilder RSI(2) and RSI(14).
- **Fibonacci:** swing = highest-high / lowest-low over the last 60 bars, up-swings
  only (low before high, range ≥ 10%); `retrace = (hi − close) / (hi − lo)`.
  Signals: raw depth (`fib_retrace`), distance to the nearest of {0.382, 0.5,
  0.618} (`fib_prox`), and an **event study** "close within tolerance of a level
  AND a bounce candle". **Placebo:** the identical rule with arbitrary levels
  {0.30, 0.44, 0.56, 0.72}; tolerances are chosen so both cover 18% of the range —
  a Fibonacci edge must beat equally-dense arbitrary levels, not just zero.
- **Literature-backed:** 1- and 5-day return (short-term reversal), 20-day return
  (momentum), distance to the 20- and 60-day high (52-week-high style), volume
  pace (volume shock).
- **Sanity:** `placebo_random` — seeded noise. Its IC must be ≈ 0.
- **Multiple testing:** 12 signals × 4 horizons = 48 tests → ~2.4 expected
  chance hits at |t| > 2. Trust |t| > 3 on the **non-overlapping** t-stat.

## Results — mean IC (non-overlapping t)

| signal | 1d | 3d | 5d | 10d |
|---|---|---|---|---|
| rsi2 | −0.037 (**−3.07**) | −0.014 (0.11) | −0.008 (0.30) | −0.003 (−0.41) |
| rsi14 | −0.027 (−2.03) | −0.019 (−0.32) | −0.027 (−0.83) | −0.055 (−1.05) |
| fib_retrace | −0.007 (−0.26) | −0.048 (−1.09) | −0.050 (0.11) | −0.012 (0.35) |
| fib_prox | −0.003 (−0.12) | +0.038 (0.52) | +0.054 (0.42) | +0.106 (0.97) |
| plc_prox (placebo levels) | +0.012 (0.50) | +0.025 (0.35) | +0.046 (−0.33) | +0.092 (−0.22) |
| ret1 | −0.051 (**−3.09**) | −0.017 (1.30) | −0.016 (−1.53) | −0.011 (−1.91) |
| ret5 | −0.025 (−1.43) | −0.013 (0.23) | −0.011 (−0.58) | −0.027 (−0.42) |
| ret20 | −0.024 (−1.29) | −0.028 (−0.78) | −0.039 (−1.36) | −0.060 (−0.84) |
| dist_high20 | +0.028 (1.26) | +0.025 (0.81) | +0.029 (−0.03) | +0.025 (0.25) |
| dist_high60 | +0.019 (0.74) | +0.031 (0.73) | +0.017 (−0.12) | −0.025 (−0.34) |
| vol_pace | −0.027 (−2.47) | −0.008 (−0.07) | +0.002 (−0.39) | +0.002 (0.16) |
| placebo_random | −0.006 (−0.79) | +0.001 (−1.58) | −0.005 (−0.06) | −0.004 (−0.71) |

`placebo_random` is ≈ 0 at every horizon → the harness is sound.

## Fibonacci event study — bounce at a level vs bounce at a placebo level

Mean excess forward return (%), non-overlapping t in brackets.

| horizon | Fibonacci levels | placebo levels |
|---|---|---|
| 1d | −0.08 (−0.27), n=242 | −0.21 (−0.60), n=281 |
| 3d | −0.53 (−0.28), n=215 | +0.60 (−1.65), n=257 |
| 5d | −1.09 (−0.58), n=194 | +0.20 (+0.56), n=242 |
| 10d | −2.77 (−0.10), n=157 | −0.60 (−0.50), n=189 |

## Reading it

1. **Fibonacci: no evidence of an edge.** Depth and proximity have |t| ≤ 1.1 at every
   horizon, the placebo levels behave the same as the real ones, and the bounce
   events are statistically indistinguishable from zero (point estimates are even
   slightly negative). Caveat: only ~150–240 events per horizon, so the event study
   cannot detect effects smaller than a few percent — this is *absence of
   evidence*, not proof of uselessness, but it certainly does not support "proven".
2. **RSI and the reversal family show one real, tiny effect:** at 1 day,
   RSI(2) (t −3.07), 1-day return (t −3.09), RSI(14) (−2.03) and volume pace
   (−2.47) all say the same thing — names that jumped today tend to lag
   tomorrow (short-term reversal; also seen in Phase 0E, `priceResponse` t −3.09).
   These four are one phenomenon, not four findings, and it fades to zero by 3
   days. Its size is negligible: Q5−Q1 spreads are 0.09% (RSI2) and −0.06% (ret1)
   per day vs a **0.4% round-trip cost** — statistically detectable, economically
   untradeable.
3. **Nothing supports a momentum / breakout ingredient in the rank test.** 20-day
   return has a mildly *negative* IC (10d −0.060, t −0.84) and names near their
   20/60-day highs do not outperform (Q5−Q1 at 10d −0.6% / −3.0%, insignificant).
   That is at odds with the breakout logic of `screener_technical`, whose Phase 0D
   edge was drawdown control rather than stock selection — consistent with, and a
   reason to test, the hypothesis that the *exit/risk rules* are doing the work
   (see Next).
4. **The earlier "volume is a weak positive lead" does not replicate.** On this
   19k-observation sample volume pace has IC ≈ 0 at 5–10 days (Phase 0E: +0.06 on
   39 symbols). One thing remains: its Q5−Q1 spread is +1.0% (5d) / +1.3% (10d)
   (top quintile alone +0.8% at 5d) while the rank IC is flat — a tail-only effect that needs its own top-decile
   test with a proper t-stat.
5. **Multiple testing:** 4 of 48 tests exceed |t| = 2 (2.4 expected by chance), all
   at 1 day and all the same reversal effect. No result reaches |t| > 3 outside it.

## Caveats

One window / one regime (Apr–Sep 2026); daily bars only (Fibonacci is often used
intraday); universe = liquid names (avg turnover ≥ Rp 500M, price ≥ 51). The
"clears cost" flag in the raw JSON is crude — extreme quintiles of noisy signals
often exceed 0.4% at 10 days; only significant rows matter.

## Verdict

None of the tested technical signals — RSI, Fibonacci, momentum, breakout
proximity — gives a tradeable stock-selection edge on this data. The only
statistically clear effect is a 1-day reversal that is far below transaction
costs. Fibonacci is not supported. Combined with Phase 0E, **stock selection by
either broker flow or classic indicators shows no measurable edge here**, which
shifts the question to whether the positive baseline P&L (Phase 0A/0C/0D) comes
from the exit/risk engine instead.

## Next

1. **Phase 0G — exit-rule ablation:** on *random* liquid picks, which parts of the
   risk engine (stop distance, TP levels, breakeven-after-TP1) generate the
   positive expectancy, and does it hold in both halves of the window?
2. Top-decile volume-shock event study (the only surviving tail lead).
