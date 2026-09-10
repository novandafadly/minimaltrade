# Backtest Phase 0D — technical screener vs baselines

**Question:** the technical screen added to shadow mode
(`apps/worker/src/shadow/screeners.ts`) needs only OHLCV, so unlike the
ARJUM-shortlist / broker-flow paths it *can* be replayed over history. Does a
rules-based technical screen actually pick better than ranking liquid names by
volume, or picking at random?

**Harness:** `packages/backtest/src/phase0d.ts` — replays the backfilled
`daily_bar` window through `PostgresDataSource`, builds every plan through the
same risk engine (`planFromHistory`, 5-day-low stop, config `v3-2026-09-10`),
simulates fills/exits with `simulateTradePlan` (max hold 20 bars). Three
selection strategies, top 5 picks/day each:

- **technical** — `close > SMA20 > SMA50`, within 3% of the 20-bar high,
  positive 20-bar return, over the 60 most liquid names by 20-day turnover
- **volume** — top 5 by 20-day average volume
- **random** — 5 seeded-random picks of the liquid pool

```
pnpm --filter @idx/backtest exec tsx src/phase0d.ts -- --database-url=… --out=phase0d.json
```

## Result (window 2026-03-05 → 2026-09-09, 120 trading days)

| strategy | trades | NO_TRADE | fill rate | win rate | net expectancy / trade | profit factor | max drawdown | avg net R:R |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **technical** | 106 | 112 | 0.90 | **0.62** | +Rp 9,201 | **3.17** | **Rp 88,380** | 0.38 |
| volume | 240 | 196 | 0.65 | 0.46 | +Rp 5,840 | 1.62 | Rp 812,660 | 0.22 |
| random | 227 | 205 | 0.64 | 0.52 | +Rp 11,205 | 2.51 | Rp 457,453 | 0.46 |

## Reading it

- **Technical clearly beats volume-ranking** on every axis — higher win rate,
  ~2× the profit factor, and **~9× smaller max drawdown**.
- **Technical vs random is a split decision.** Technical wins on the
  risk-adjusted metrics — profit factor (3.17 vs 2.51), win rate (62% vs 52%),
  and especially max drawdown (Rp 88k vs Rp 457k — on Rp 3.8M capital that is
  2.3% vs 12%). It loses on raw per-trade expectancy (Rp 9.2k vs Rp 11.2k) and
  average R:R, and it trades less than half as often (more selective: 106
  fills from 218 plans).
- Net: the technical filter's value here is **drawdown control and hit-rate**,
  not bigger wins. It turns "picking liquid IDX names at random in this window"
  into something with a much smoother equity curve.

## Caveats — do not over-trust this

- **One window, one regime** (Mar–Sep 2026). Phase 0a already showed this
  window is friendly to the risk engine (random_liquid was net positive), and
  the strong `random` numbers here confirm it — so "beat random" is a high bar
  and technical only *partly* clears it.
- **Survivorship-ish bias:** the universe is the ~151 names that had entered
  the funnel and been backfilled, not the full IDX board.
- Single random seed for the `random` baseline.
- `avg net R:R < 0.5` for all three — fees + slippage + breakeven stops eat
  most of the theoretical reward across the board (consistent with Phase 0c).
- These are "if you could take every pick" numbers. With
  `maxSimultaneousPositions: 1` and multi-day holds you would take a small
  fraction, so real results depend heavily on *which* pick you take each day.

## Verdict

The technical screen is **worth promoting to a live watchlist source** and
worth continuing to forward-test (`screener_technical` in shadow mode). It is a
real improvement over volume-ranking and modestly better than random on a
risk-adjusted basis — but the edge is moderate, regime-dependent, and mostly
about *avoiding drawdowns* rather than finding outsized winners. Treat the
daily `screener_technical` picks as a candidate list to review, not a
buy signal.

The ARJUM-shortlist, consensus, and broker-flow (`live`) questions still need
forward data — this backtest says nothing about them.
