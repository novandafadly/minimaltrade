# Backtest — Phase 0a: OHLCV backfill + baseline replay

**Goal:** before adding any screener sophistication, establish whether the
mechanical framework the whole system rests on — the risk engine's
entry/TP/SL/lot math, the `minNetRewardToRisk ≥ 2.0` gate, Stockbit fees, and
the fill/exit simulator — even produces positive expectancy on real IDX data.
If the *baselines* (pick liquid stocks with no broker-flow/score logic at all)
bleed money, no screener can save it.

## Method

- `pnpm --filter @idx/backtest run backfill -- --top=150` pulls ~120 days of
  daily OHLCV (`/api/history/{code}`) for the 150 most-liquid IDX symbols (by
  `turnover_ratio × market_cap` from `/api/market-cap`) into `daily_bar`.
  `received_at` on each bar is set to ~post-close of *its own* trading day, so
  the replay leak-guard is honest.
- `pnpm --filter @idx/backtest run replay -- --source=postgres` runs the
  existing `runReplayBatch`: for each trading date, the two blueprint baselines
  (`random_liquid_universe`, `volume_only_ranking`) pick candidates from the
  as-of universe, build a `TradePlan` through the **real** `buildRiskPlan`
  (entry = last close, stop = 5-day low, 2×/3× priceRisk TPs), and the plan is
  simulated forward against real subsequent bars.
- `signal_driven` is empty here — no historical trade plans exist yet (the
  live worker only started producing them recently). Reconstructing historical
  signals from broker-accumulation data is Phase 0b.

## Result — window 2026-03-05 → 2026-09-09 (120 trading days)

**Market context (150-symbol liquid universe over the window):** avg return
**+7.3%**, **median −7.8%**, only **41%** of stocks ended higher. A weak /
down tape for the typical stock — not a bull run that flatters any long
strategy.

| Strategy | Trades | Fill rate | Win rate | Net expectancy / trade | Profit factor | Max drawdown |
|---|---|---|---|---|---|---|
| `random_liquid_universe` | 98 (62 filled) | 63% | **54.8%** | **+Rp 13,048** | **2.76** | Rp 160,372 |
| `volume_only_ranking` | 92 (67 filled) | 73% | 41.8% | +Rp 1,729 | 1.21 | Rp 378,884 |

`avgNetRR` (realised): 0.53 random / 0.055 volume — well below the planned 2.0
because many trades exit at breakeven (SL → entry after TP1) or take a small
loss. `falseAccumulationRate` ≈ 0.38 (share of filled trades whose first exit
leg was the SL).

## Reading

1. **The mechanical framework is not broken.** Even random liquid picks, in a
   down-median-market, net positive with a healthy profit factor. The
   entry/TP/SL/RR-gate/fee model doesn't bleed on noise.
2. **Diversified random beat concentrated volume-ranking clearly.** Volume
   ranking picks the same handful of mega-caps every day; those are efficient
   and mean-reverting, and the "buy the close, momentum TP" rule did poorly on
   them (win rate 42%, PF 1.2, 2.4× the drawdown).
3. **This is the bar.** The broker-flow / composite-score engine (Phase 0b)
   has to beat **+Rp 13k/trade, PF 2.76, 55% win rate** to justify its
   complexity. If it can't, the sophistication is theatre.

## Caveats

- One 6-month window, one market regime. ~90–100 trades per strategy — enough
  to see a direction, not enough to bet a strategy on.
- `random_liquid_universe` is seeded but its picks are arbitrary; a different
  seed gives different (correlated) numbers. It's a sanity floor, not a target.
- `getHistoryAsOf` returns only the last 20 bars per call (existing behaviour);
  fine for the baseline's 5-day-low stop, revisited if Phase 0b needs deeper
  history.

## Next — Phase 0b

Reconstruct `FeatureEngineInput` per historical date from
`/api/broker-accumulation` (per-broker daily `nval`/`nvol`/`bavg`, ~120 days
back) + OHLCV, run the **real** `computeFeatureSnapshot → scoreCandidate →
buildRiskPlan`, and compare the signal-driven result against these baselines.
Gross-buy-vs-gross-sell isn't available historically, so `suspectedTransfer` /
`failedAbsorption` will be under-triggered — documented approximation.
