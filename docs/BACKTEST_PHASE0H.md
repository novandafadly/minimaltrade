# Backtest Phase 0H — is there any profitable long-only rule in this database?

**Question.** After Phase 0G showed the earlier "profitable" results were a look-ahead
artifact, can a systematic search of simple rules (RSI, Fibonacci, pullback, breakout,
volume shock, reversal, the technical screen, with several exit rules) find one that
is genuinely profitable — and survives an out-of-sample check?

**Harness:** `packages/backtest/src/phase0h.ts` (Postgres only, no API calls).

## Design (fixed before looking at results, with one disclosed correction)

- **Honest entry:** signal at the close of D, **buy at the open of D+1** (always fills).
- **Costs:** 0.6% round trip (0.4% Stockbit fees + 0.2% slippage).
- **Grid:** 13 entry signals × 9 exit rules = 117 configs. Signals: RSI(2)<10, RSI(2)<10 above
  SMA50, RSI(14)<30, 1-day drop ≥4%, 5-day drop ≥10%, pullback (>SMA50, ≤90% of 20d high),
  breakout20 + volume, volume shock up/down, Fibonacci bounce (38.2/50/61.8) and an equal-density
  placebo-level version, the technical screen (SMA20>SMA50, near 20d high, ret20>0), gap-down
  reversal. Exits: hold 3/5/10 days; SL5/TP10; SL8/TP8; SL3/TP6; SL10/TP5 ("high win rate");
  SL5 only; TP5 only. Each event is simulated independently (edge per trade, not a portfolio).
- **Success test:** the window is split into two halves (57 dates, 2026-06-15 → 2026-09-04, split
  2026-07-24). A config must show **excess return > 0 and by-date t ≥ 2 in BOTH halves**, with
  ≥ 100 events per half.
- **Placebo calibration:** the same 117-config grid run 60× on random event sets with the same
  per-date counts; the real best score must beat the placebo "best of 117".
- Win rate is reported, never selected on.
- **Disclosed correction:** the first run scored *absolute* returns and printed 3 "survivors".
  Before reading anything into them I noticed that plain hold-for-10-days (no signal at all) was
  strongly positive in the second half, so scoring was changed to the **excess over the mean of all
  eligible events on the same date under the same exit** (the placebo calibration was already
  built on random sets). Both runs are committed; only the excess result is meaningful.

## The database itself is biased upward

Unconditional baseline — mean net return of **every** eligible event, no signal (after 0.6% cost):

| exit | H1 (Jun 15–Jul 24) | H2 (Jul 24–Sep 4) | win rate |
|---|---:|---:|---:|
| hold 3d | −0.60% | +0.76% | 45% |
| hold 5d | −0.31% | +1.96% | 49% |
| **hold 10d** | **+1.99%** | **+4.02%** | 55% |
| TP5 only | +0.82% | +1.23% | 70% |
| SL10/TP5 | +0.35% | +0.79% | 67% |

"Buy anything and hold ten days" earned **+2% to +4% net per trade**. That is a rising market
**plus a universe chosen with hindsight**: `daily_bar` holds the names that were liquid / ranked by
ARJUM around September 2026, so stocks that rallied into September are over-represented. Every
absolute return measured on this database is therefore overstated; only excess-vs-baseline is usable.

## Result

**Survivors (excess > 0 and t ≥ 2 in both halves): 0 of 117.**

Best configs by the weaker half's excess t-stat:

| signal | exit | excess H1 (t) | excess H2 (t) | abs H1 / H2 | win | PF |
|---|---|---:|---:|---:|---:|---:|
| tech: SMA20>SMA50, near 20d high, ret20>0 | SL3/TP6 | +1.57% (2.33) | +0.34% (1.91) | +0.27% / +0.08% | 44.5% | 1.05 |
| tech | SL10/TP5 | +1.31% (1.59) | +0.23% (1.39) | +0.45% / +0.81% | 64.0% | 1.45 |
| tech | SL8/TP8 | +1.71% (1.94) | +0.22% (0.99) | +1.08% / +1.08% | 57.3% | 1.53 |
| pullback (>SMA50, ≤90% of 20d high) | hold 3d | +0.49% (0.69) | +0.56% (1.62) | −0.26% / +1.65% | 48.6% | 1.50 |

**Placebo calibration** (best min excess-t of 117 configs on random events, 60 reps): median 1.06,
p90 1.56, p95 1.87, max 2.63; ~0.02 placebo configs reach t ≥ 2 in both halves. The real best is
1.91 → **empirical p ≈ 0.05** (borderline, after correcting for having tried 117 configs).

## Reading it

1. **No rule is profitable in a way that survives the checks.** Zero survivors. The best candidate
   (a trend / near-20-day-high screen) has a borderline p ≈ 0.05 *for the excess*, but its **absolute**
   expectancy is +0.1% to +0.3% per trade (PF 1.05, win 44%) — break-even, on a database whose
   unconditional drift is itself inflated. It is not a tradeable edge.
2. **The technical screen is the only recurring lead**: positive excess in both halves across five
   different stop/target exits (10 of 10 half-results > 0), though small and mostly individually
   insignificant, and the five exits are not independent. It is consistent with the earlier
   `screener_technical` shadow idea and is already being forward-tested.
3. **High win rate is a trap.** TP5-only exits have 70–80% win rates for *everything*, including the
   unconditional baseline (70%). E.g. "1-day drop ≥4%, TP5 only": win 80% but excess −2.44% (t −3.04)
   in H1. Win rate says nothing about profit.
4. **Reversal / oversold signals underperform the baseline here:** RSI(2)<10 hold-10d has excess
   −1.57% / −3.99% (t −1.66 / −4.50); 5-day-drop ≥10% is worse. In this (upward-biased) universe
   momentum beat mean-reversion — do not over-read it, since the bias favours names that kept rising.
5. **Fibonacci (real levels) shows no edge**, again (consistent with Phase 0F).

## Caveats

Only 57 usable dates (needs 60 bars of lookback + 10 forward, so Mar–Jun cannot be used); one regime
(rising); a hindsight-biased universe (above); events are independent trades with no capital limit;
daily bars only; 117 configs is small relative to the space of possible rules; results at another
cost assumption (e.g. 0.4%) would shift absolute numbers but not the excess-based conclusion.

## Verdict

From this database, **no simple long-only technique can honestly be called profitable.** The most
credible thing is a weak, unproven tendency for trend/near-high names to beat a same-day random pick
under stop/target exits — the forward shadow test (with the corrected evaluator) is the right way to
confirm or kill it. A trustworthy answer needs (a) a point-in-time universe without hindsight (including
names that later became illiquid), (b) more regimes (the weekly frame reaches back to 2024-06), and
(c) out-of-sample forward evidence.
