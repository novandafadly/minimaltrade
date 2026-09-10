# Shadow mode

**The question backtesting could not answer** (Phase 0b): does the broker-flow
composite score actually pick better trades than ranking the same candidates
by volume, or picking at random? The historical broker feed
(`/api/broker-accumulation`, ~5 brokers/day) is too sparse to reconstruct the
scoring engine's concentration inputs. Live `/api/broker-summary` gives the
full book — so this can only be answered **forward**.

## How it works

Every EOD, right after the deep funnel, the worker writes to `shadow_plan`:

| source | how the candidates are picked | how the plan is built |
|---|---|---|
| `live` | the real deep-funnel signal (STRONG_BUY / SPECULATIVE_BUY etc.) | the real risk engine |
| `baseline_volume` | top-N of the **raw screener candidate pool** by latest-bar volume | `buildRiskPlan` off OHLCV only (entry = close, stop = 5-day low) |
| `baseline_random` | N seeded-random picks of the same pool | same |

N = `deepFunnelTradePlanMax` (3). Same pool, same risk-engine machinery — the
only thing that differs is *which* names get picked, so the P&L comparison
isolates the value of the score.

A **forward evaluator** runs each EOD: for every `shadow_plan` with no
recorded outcome that now has ≥ 3 `daily_bar` rows after its trading date, it
runs the backtest fill/exit simulator and records `outcome_status`,
`filled_lots`, `first_exit_reason`, `net_pnl`, `bars_held`.

## Reading the results

`GET /api/shadow` (behind the same basic auth as the dashboard):

```json
{
  "stats": [
    { "source": "baseline_random", "plans": 42, "pending": 9, "evaluated": 33,
      "fillRate": 0.7, "winRate": 0.48, "expectancy": 5100, "profitFactor": 1.8 },
    { "source": "baseline_volume", ... },
    { "source": "live", ... }
  ],
  "recent": [ ... last 60 shadow plans with their outcomes ... ]
}
```

- `expectancy` / `profitFactor` / `winRate` are over **evaluated** plans only.
- **Verdict:** the score adds value if, after a few weeks (≈15–30 trading
  days → ~45–90 `live` plans), `live` beats **both** baselines on expectancy
  *and* profit factor. If it only matches them, the ARJUM screener + the
  liquidity filter is doing the work and the composite score is theatre. If
  it's worse, the score is actively harmful and should be dropped or
  reweighted.

## Caveats

- Needs time. ~20 IDX trading days/month; statistical confidence takes 1–3
  months.
- `daily_bar` only advances once per day (the deep funnel populates it), so
  the shortest-held trades take ~3 trading days to get an outcome.
- Fees/slippage in the evaluator use the *current* `StrategyConfig`, not the
  one active on each plan's day — a small approximation.
- The `live` mirror only captures plans that were actionable
  (STRONG_BUY / SPECULATIVE_BUY / WATCHLIST with a plan); NO_TRADE days
  contribute nothing, which is correct — you can't trade a NO_TRADE.
