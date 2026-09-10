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
| `live` | the real deep-funnel signal (STRONG_BUY / SPECULATIVE_BUY etc.) — ARJUM shortlist + full feature/scoring/risk engine | the real risk engine |
| `screener_arjum` | top-N ARJUM `/api/screener/latest` shortlist by ARJUM's own edge (`wr_event × potential`) | `buildRiskPlan` off OHLCV only (entry = close, stop = 5-day low) |
| `screener_marketcap` | ARJUM shortlist ∩ a liquidity/size band (`turnover_ratio ≥ 0.2%`, market cap Rp 300bn–50tn) — **option B** | same |
| `screener_technical` | liquid momentum-breakout screen (close > SMA20 > SMA50, within 3% of the 20-bar high, positive 20-bar return) over the 60 most liquid names from `/api/market-cap` — **option D** | same |
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
