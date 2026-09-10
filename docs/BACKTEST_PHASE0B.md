# Backtest — Phase 0b: reconstruct historical signals, run the real scoring engine

**Goal:** run the actual `computeFeatureSnapshot → scoreCandidate →
buildRiskPlan` engines over ~120 days of reconstructed history and see whether
the broker-flow / composite-score signal beats the Phase 0a baselines
(random_liquid_universe: +Rp 13k/trade, PF 2.76).

## What was built (all merged / mergeable, tested)

- `backfill --phases=broker` — pulls `/api/broker-accumulation/{code}` for the
  liquid universe into `broker_snapshot` (per-broker daily net flow, `bavg` /
  `savg`), `received_at` = post-close of each row's own day. 63,732 rows, 150
  symbols, 2026-03 → 2026-09.
- `PostgresDataSource.getBrokerHistoryAsOf(symbol, asOf, days)` — reconstructs
  a per-day `FeatureEngineInput.brokerSummaryByDay` from `broker_snapshot`.
- `signalFromHistoryStrategy` — mirrors `apps/worker/src/funnel/deep.ts`
  exactly: two-pass scoring, bAvg-based entry, actionable = STRONG_BUY /
  SPECULATIVE_BUY. Wired into `runReplayBatch` as the `signal_from_history`
  strategy.
- `getHistoryAsOf` now returns a 40-bar window with a proper ex-today 20d
  median (was 20 bars / median-incl-today).
- `diagnose.ts` — prints category + gate-failure distribution.

## Result: **0 actionable trades over 120 days.** Here is exactly why.

Diagnostic over 8 sample dates, 1,178 candidate evaluations:

| Gate | Fail rate (strict) | Fail rate (concentration relaxed + structure stop) |
|---|---|---|
| **CONCENTRATION** | **1178 / 1178 (100%)** | 985 / 1178 (84%) |
| **NET_RR_MIN** | 1014 / 1178 (86%) | 868 / 1178 (74%) |
| BROKER_FLIP_OR_DISTRIBUTION | 514 (44%) | 514 (44%) |
| CHASE_LIMIT | 67 (6%) | 67 |
| LIQUIDITY | 15 (1%) | 15 |

`avgMeaningfulBuyerCount = 2.11` (gate needs ≥ 4). `avgTop1Share = 0.728`
(gate needs ≤ 0.35). Category distribution (strict): 1014 NO_TRADE, 164 AVOID,
**0 buy**. Even with the concentration gate gutted *and* a structure-based
stop, only **~9 non-AVOID signals out of 1,178**.

### 1. CONCENTRATION can't be validated with this data — structural, not fixable here

`/api/broker-accumulation` surfaces only the **~5 largest net movers per
symbol per day**. The live pipeline uses `/api/broker-summary`, which returns
the **full ~20–60 broker book**. The feature engine's concentration math
(`meaningfulBuyerCount`, `top1Share`, `HHI`, `brokerFlip`) is designed for the
full book; fed 5 rows it reports everything as hyper-concentrated. This is a
**data-source limitation of the backtest**, not a verdict on the strategy.
There is no historical full-broker-book endpoint in the ARJUM API.

→ **The concentration / broker-flow scoring can only be validated FORWARD**
(shadow mode), where `/api/broker-summary` gives the real book.

### 2. NET_RR_MIN is the real, backtestable finding — the RR gate is brutal

Independent of the broker data: **74–86% of candidates cannot form a valid
2:1 net-RR plan** after Stockbit fees (0.15% / 0.25%), the per-share slippage
allowance, and the 2-tick minimum stop. The deep funnel's flat 3% preliminary
stop makes this worse — the fixed fee/slippage overhead swamps a 3% price
risk. A structure-based stop (5-day low) only moves it 86% → 74%.

This matches a known note in `syntheticFixture.ts` ("a closer stop here would
compute to a NO_TRADE plan"). It means: **with the current risk parameters,
even a perfect signal would produce only a handful of trades per 6 months.**

### 3. BROKER_FLIP false-positives — also a sparsity artifact

44% fail `BROKER_FLIP_OR_DISTRIBUTION` constantly. With ~5 brokers tracked,
the "top buyer yesterday is top seller today" test flips on noise.

## Recommendation

| Question | How to answer it | Status |
|---|---|---|
| Does the mechanical framework make money? | Phase 0a backtest | ✅ done — yes, +Rp 13k/trade baseline |
| Does the broker-flow / concentration signal add value? | **Shadow mode** (live `/api/broker-summary`, tag by source, ~4–8 weeks) | ← next |
| Are the risk-engine params (NET_RR_MIN 2.0, prelim stop, min-stop-ticks) too tight? | Phase 0c param sweep on the baseline framework (backtestable now) | optional |

Backtesting the full scoring engine is a **dead end** given the available
historical data — this was worth ruling out conclusively rather than
assuming. The harness itself stays: it's what shadow-mode analysis and the
Phase 0c param sweep will run on.
