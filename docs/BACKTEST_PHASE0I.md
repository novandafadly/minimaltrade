# Phase 0I — do fundamentals predict returns on IDX?

**Verdict: no tradeable edge found.** Book-to-price (BP) is the only factor with a consistently
positive sign, but it is weak (t ≈ 1.4–2.1 once the universe is made point-in-time), its
mean quintile spread is ≈0 and only the median spread is a few percent, before costs. The
"small-cap premium" (size) shrinks from t = −4.4 to t = −1.2 when illiquid names are removed
and its mean is driven by a handful of extreme winners. Profitability (ROE/ROA) and earnings
yield (EP) show nothing. The `QUALITY` flag in `watchlist.ts` therefore has **no empirical
support** from this test.

## Motivation

Phases 0E–0H found no edge from broker flow or technical rules. The Indonesian literature
(Pacific-Basin Finance Journal 2023) points to size, value (operating cash flow / price) and
profitability, so these were tested at 4- and 13-week horizons.

## Data and method

- Quarterly income / balance sheet / cash flow: 12 discrete quarters (Q2-2023 →), 195 symbols,
  archived by `backfillFundamentals.ts` (195 requests, 0 failures).
- Weekly prices: 120 weeks back to 2024-06 (`?frame=weekly`); shares from the latest market-cap
  snapshot (not point-in-time; symbols with a suspected split — price ≈ 1/k **and** volume ≈ k —
  are dropped: 3).
- Universe 187 (15 banks; banks are also reported separately), 27 monthly rebalance dates
  2024-07-05 → 2026-09-04.
- **No look-ahead:** a quarter is usable 90 days after its end; the factor is read at the
  rebalance week's close and the holding period starts at the *next* week's close.
- Statistic: per-date Spearman IC vs forward **excess** return (minus that date's mean), Q5−Q1
  quintile spread, t across dates (13-week uses a non-overlapping stride of 3, i.e. ≈8 independent
  observations). `placebo_random` sits in the same table.
- 9 factors × 2 horizons × 2 universes ⇒ many tests; a lone |t| ≈ 2 is expected by chance
  (16 factor/horizon tests ⇒ ~55% chance of at least one |t| > 2 under the null).

## Headline run (universe = names liquid in Sep 2026), non-bank

| factor | 4w IC (t) | 13w IC (t) | 13w Q5−Q1 |
|---|---|---|---|
| ROE | −0.006 (−0.2) | −0.099 (−1.4) | −30.7% |
| EP | 0.029 (0.9) | −0.036 (−0.2) | −27.8% |
| **BP** | **0.084 (3.0)** | **0.142 (2.5)** | +10.7% |
| CFP | 0.045 (1.7) | 0.026 (0.8) | −13.6% |
| **size** | **−0.077 (−2.3)** | **−0.196 (−4.4)** | −52.8% |
| NIyoy | 0.038 (1.6) | −0.005 (1.1) | +7.8% |
| placebo | −0.007 (−0.4) | −0.005 (1.3) | +0.1% |

Read alone, size and BP look real. They are not robust, see below.

## Why the headline is optimistic

The universe is "liquid **in Sep 2026**": a name is in the sample because it rallied into liquidity
(small caps that later became liquid). That biases exactly the factors that sort by size and
cheapness. Robustness re-runs (non-bank, all with `phase0i.ts` flags):

| variant | BP 4w | BP 13w | size 4w | size 13w | notes |
|---|---|---|---|---|---|
| A. headline | 0.084 (3.0) | 0.142 (2.5) | −0.077 (−2.3) | −0.196 (−4.4) | current-liquid universe |
| B. point-in-time liq ≥ Rp2B/day | 0.072 (2.1) | 0.106 (1.95) | −0.022 (−0.7) | −0.110 (−2.6) | 110–170 names per date |
| C. B, **median** quintiles | Q5−Q1 +2.4% | +4.7% | +0.6% | −3.8% | means were tail-driven |
| D1. B, 2024-07 → 2025-08 | 0.046 (1.2) | 0.050 (0.6) | −0.024 (−0.5) | −0.128 (−3.6) | |
| D2. B, 2025-09 → | 0.099 (1.7) | 0.179 (0.7) | −0.021 (−0.4) | −0.088 (−3.8) | |
| E. point-in-time liq ≥ Rp10B/day | 0.063 (1.6) | 0.108 (1.4) | −0.003 (−0.1) | −0.075 (−1.2) | 70–128 names |

- **size:** the 4-week effect disappears once illiquid names go; the 13-week effect keeps its sign in
  both halves but the mean quintile spread (−21%) collapses to −3.8% at the median: a right tail of
  lottery-like small caps. At Rp10B/day it is not significant. Small caps are also where spreads
  and slippage exceed the 0.6% round-trip cost assumed elsewhere.
- **BP:** positive in every cut and in both halves (IC 0.05–0.18) but t stays ≈ 1.4–2.1 and the mean
  spread is ≈0 (median +2–5% before costs). Consistent but weak; not enough to trade on. The next
  test that could confirm or kill it is weekly/monthly forward tracking, not more backtest cuts.
- **profitability / EP / CFP:** no pattern. ROE has a *negative* 13-week IC in the headline and in
  the first half. The binary `QUALITY` hygiene flag (TTM net income > 0 and operating cash flow
  > 0) was not tested directly; the ranked versions give it no support.

## Caveats

- ~2 years, ≈8 independent 13-week observations: wide error bars, one bull/bear/rebound cycle.
- Shares outstanding are the latest snapshot; the point-in-time liquidity filter fixes the
  liquidity part of the hindsight bias but the universe still only contains names that exist
  now (delisted names are absent).
- The statements API gives no publication dates; 90 days is the outer limit, which is
  conservative (it may hide a post-announcement effect).

## Consequences

1. No fundamental screen is added to the engine or to the shadow sources.
2. The watchlist `QUALITY` flag should be read as a hygiene filter only, not as evidence.
3. Weekly broker/foreign flow over 2024-06 → now (multi-regime) is the remaining unexplored test;
   its data is being backfilled (`backfillBrokerWeekly.ts`).

Reproduce:

```
pnpm --filter @idx/backtest exec tsx src/phase0i.ts -- --database-url=... --out=phase0i.json
# robustness: --min-daily-turnover=2000000000 [--median] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
```
