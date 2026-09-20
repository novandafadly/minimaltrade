# Shadow mode

**What shadow mode is for.** Forward-test, with real trade plans and costs,
the selection ideas that a backtest can only partly answer: does a screener
pick better than ranking the same candidates by volume, or at random?

History of this document: Phase 0B originally concluded the broker-flow score
"could only be answered forward" because `/api/broker-accumulation` is sparse.
That was wrong -- `/api/broker-summary?start_date=&end_date=` returns full daily
books back to 2020 (see docs/BACKTEST_PHASE0E.md), and Phase 0E found the
composite score has no predictive power. Shadow mode is therefore now the
*forward confirmation* of the historical results (screener_technical from
Phase 0D, screener_flow from Phase 0E), not the only way to test the score.

## How it works

Every EOD, right after the deep funnel, the worker writes to `shadow_plan`:

| source | how the candidates are picked | how the plan is built |
|---|---|---|
| `live` | the real deep-funnel signal (STRONG_BUY / SPECULATIVE_BUY etc.) — ARJUM shortlist + full feature/scoring/risk engine | the real risk engine |
| `screener_arjum` | top-N ARJUM `/api/screener/latest` shortlist by ARJUM's own edge (`wr_event × potential`) | `buildRiskPlan` off OHLCV only (entry = close, stop = 5-day low) |
| `screener_marketcap` | ARJUM shortlist ∩ a liquidity/size band (`turnover_ratio ≥ 0.2%`, market cap Rp 300bn–50tn) — **option B** | same |
| `screener_technical` | liquid momentum-breakout screen (close > SMA20 > SMA50, within 3% of the 20-bar high, positive 20-bar return) over the 60 most liquid names from `/api/market-cap` — **option D** | same |
| `screener_flow` | top-N of the same 60-name technical universe by **broker net-flow imbalance** (Σ net value / Σ buy value of the day's top-20 broker book), positive only. Not part of the engine score — the Phase 0E lead (rank-IC +0.06…+0.09 at 1/3/5/10d, docs/BACKTEST_PHASE0E.md); tracked forward to see if it survives costs + a real trade plan. ~60 extra `/api/broker-summary` requests/day (24h cache, shared with the deep funnel). | same |
| `screener_consensus` | names ≥ 2 of the three screeners above agree on — **ensemble** | same |
| `baseline_volume` | top-N of the ARJUM pool by latest-bar volume | same |
| `baseline_random` | N seeded-random picks of the ARJUM pool | same |

N = `deepFunnelTradePlanMax`. **Every non-`live` plan is built the exact same
way** (`planFromHistory` off OHLCV, 5-day-low stop), so the P&L comparison
isolates two separate questions: *which shortlist* produces profitable setups
(`screener_*` vs the baselines), and *whether the composite score adds value*
on top of the best shortlist (`live` vs `screener_arjum`).

The `screener_*` thresholds live in `apps/worker/src/shadow/constants.ts` and
are **provisional** — tune them from the dashboard once each source has ~20+
evaluated plans. Budget note: the technical screen fetches `/api/history` for
its 60-name universe once per day (cached 24h), well inside the ~1000 req/day
ceiling.

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
- **Verdict** (the dashboard computes this automatically once a source has ~20
  evaluated plans):
  1. If no `screener_*` source beats **both** baselines on expectancy *and*
     profit factor → no screener is proven; the shortlists are noise.
  2. Otherwise the best `screener_*` source is the candidate to promote to the
     live top-of-funnel.
  3. If `live` also beats that best screener → the composite score is adding
     value on top of the shortlist. If not → the score is over-engineered and
     the screener alone does the work.

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
