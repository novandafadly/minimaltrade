# Backtest Phase 0E — does the broker-flow score predict returns?

**Correction to Phase 0B.** Phase 0B concluded the broker-flow scoring engine
"can't be backtested" because `/api/broker-accumulation` exposes only ~5
net-mover brokers/day. That was an incomplete exploration. The full two-sided
per-day broker book — the same shape the live engine consumes — is available
historically from `/api/broker-summary/{code}?start_date=D&end_date=D` (both
params required; `date=` is ignored), 20 brokers per day back to 2020-01-02, at
1 request per symbol-day. `backfillBrokerSummary.ts` loads it into
`broker_snapshot`. Only `broker-accumulation` was sparse.

## Why not a trade-level replay

With real data, the trade-level replay (`signal_from_history`) produced **1 trade
in ~900 symbol-days**, and `diagnose.ts` (1,126 symbol-days) shows why — it is
the hard gates, not data:

| gate | fails |
|---|---:|
| CONCENTRATION | 1,063 (94%) |
| NET_RR_MIN | 568 (50%) |
| BROKER_FLIP_OR_DISTRIBUTION | 542 (48%) |

Real IDX net-buying is dominated by one broker: average top-1 share **0.69** and
only **2.4** meaningful buyers, versus gate limits of 0.35 and 4. Even with
concentration nearly disabled only 9 of 1,126 became buy-grade. A trade count that
small says nothing about whether the *score* is informative, so Phase 0E skips
the gates and asks the statistical question directly.

## Method (`packages/backtest/src/phase0e.ts`, Postgres only, no API calls)

For each date, rank candidates by a signal and relate the ranks to **forward
excess return** (return minus that date's cross-sectional mean).

- **IC** — per-date Spearman rank correlation, averaged over dates
- **Quintiles** — per-date signal quintiles → mean forward excess return, Q5−Q1
- Signals: the engine's composite and each component, a simple
  `netFlowImbalance` (Σ net value / Σ buy value of the day's book), and two
  trivial controls (5-day momentum, volume pace = today's volume / 20-day avg)
- One observation per (symbol, date) with a full book (≥12 brokers) for the day
  and its whole lookback; 39 symbols, ~100 dates (10 Apr – 11 Sep 2026)
- Overlapping windows inflate the plain t-stat, so a non-overlapping (stride =
  horizon) t-stat is reported too — trust that one

## Results — mean IC by horizon

| signal | 1d | 3d | 5d | 10d |
|---|---:|---:|---:|---:|
| **composite (engine score)** | −0.048 | −0.011 | +0.012 | +0.004 |
| brokerFlowQuality | +0.005 | 0.000 | −0.009 | −0.004 |
| volumeAnomaly | −0.009 | +0.019 | +0.040 | +0.025 |
| smartMoneyMargin | −0.049 | −0.026 | +0.010 | +0.031 |
| priceResponse | −0.073 | −0.033 | −0.008 | −0.006 |
| netFlowImbalance | +0.080 | +0.057 | +0.069 | +0.095 |
| ctrl: momentum 5d | −0.012 | +0.007 | +0.011 | −0.049 |
| ctrl: volume pace | +0.005 | +0.035 | +0.061 | +0.052 |
| *observations / dates* | 4,017 / 106 | 3,939 / 104 | 3,861 / 102 | 3,668 / 97 |

Selected honest (non-overlapping) t-stats: composite 5d **0.02**, 10d −0.44;
volume pace 5d 1.55, 10d 0.89; netFlowImbalance 1d 2.87 (stride 1), 5d 0.51,
10d 0.47.

## Reading it

1. **The engine's composite score has no measurable predictive power** at 1, 3, 5
   or 10 days (|IC| ≤ 0.05, quintiles non-monotonic). At 1 day it is slightly
   *negative* (t −2.29) — short-term reversal in names that already moved. The
   broker components (`brokerFlowQuality`, `smartMoneyMargin`, `priceResponse`)
   are ≈ 0 throughout. With ~3,900 observations an IC above ~0.03–0.04 would
   have been visible; only much smaller effects remain possible.
2. **Volume carries a weak positive tendency at 3–10 days** (volume pace IC
   0.035–0.061, engine `volumeAnomaly` similar), consistent with Phase 0D, where
   the winning technical screen ranked by return × volume pace. On non-overlapping
   tests it is suggestive (t 0.9–1.6), not established.
3. **`netFlowImbalance` — a simple ratio, not part of the engine — has a
   consistently positive IC (0.06–0.09) at every horizon**, 56–68% positive days.
   It is the only broker-derived measure that does. But: it is my own construct;
   32 tests were run (8 signals × 4 horizons, correlated); quintile spreads are
   small and irregular (1d +0.17%, 3d −0.04%, 5d +0.27%, 10d +1.8%); and the 1-day
   spread is below the ~0.4% round-trip cost (0.15% buy + 0.25% sell). A lead worth
   a forward test, not a finding.

## Caveats

- One window / one regime (Apr–Sep 2026); universe skews to liquid names (the
  screener's small-cap picks are under-represented).
- Tests the *score*, not the gates (which independently block ~94% of candidates).
- `seasonal` / `insiders` confluence inputs are null historically; confluence
  contributes 0 (same as in the baselines).
- Exploratory, no parameter fitting — but multiple comparisons are uncorrected.

## Verdict

Treat the composite broker-flow score as **unproven, and on this evidence
unsupported**: do not use its BUY/STRONG_BUY as an entry basis. The live engine
compounds this — its hard gates leave it emitting essentially no buys. The
defensible selection signals today are volume/technical (`screener_technical`,
Phase 0D). Next: keep shadow mode running as the forward check, widen the
backfill to the full ~157-symbol universe (API limit is 6,000/day for 30 days
from 2026-09-20) to sharpen small-cap results, and consider a `netFlowImbalance`
shadow source to confirm or kill that lead.
