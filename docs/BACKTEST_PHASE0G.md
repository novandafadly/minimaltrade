# Backtest Phase 0G — the entry-convention look-ahead, and where random-pick P&L comes from

> **⚠ ERRATUM (2026-09-21) — Phases 0A, 0C and 0D, and every shadow-mode outcome
> written before this fix, used a look-ahead entry.** Their absolute P&L,
> expectancy and profit-factor numbers are inflated; conclusions that rely on
> "the framework / random picks / the screener is net positive" are **not
> supported**. The corrected numbers are below (and Phase 0D is re-run at the
> end). Phase 0E/0F (rank-IC studies) never simulated fills and are unaffected.

## The bug

`planFromHistory` builds every plan from the **close of day D**
(`entryTrigger = close_D`), so it can only be acted on from the next session.
But `replayEngine`, the shadow evaluator and the Phase 0D/param-sweep scripts
called `simulateTradePlan` with the **bar of day D itself** as the entry bar, and
`simulateEntry` fills at `min(open_D, entryTrigger)` — i.e. at the open of day D
whenever day D closed higher. Nobody who decides after the close can buy at
that open. The per-trade look-ahead gain is the day's intraday up-move: on the
random trade set below, `E[max(0, close−open)/close] = 1.86%` — more than 4× the
0.4% round-trip cost. It also flatters momentum/breakout-style picks most,
because they select names that already closed strongly.

## Measurement (`packages/backtest/src/phase0g.ts`)

941 random liquid trades (25 picks/date, 85 dates 2026-04-24 → 2026-09-02, 10-bar
hold), plans from the real risk engine (`low5` stop), all outcomes as **net return
% per filled trade** (Stockbit fees + slippage). Same trade set, three entry
conventions:

| entry convention | filled | mean net %/trade | median | win | PF | t (by date) |
|---|---:|---:|---:|---:|---:|---:|
| **sameBar (what the code did)** | 643 | **+3.35** | 0.00 | 50% | **2.05** | **3.18** |
| **honest limit** at close_D, entry session D+1 | 698 | +0.42 | −2.81 | 42% | 1.10 | 0.68 |
| buy at next open (always fills) | 939 | −0.26 | −2.81 | 42% | 0.95 | −0.18 |

~90% of the headline expectancy is the look-ahead; what remains is
indistinguishable from zero, and a plain next-open buy is slightly negative after
costs. Market drift over the same 10-day hold is +0.33% (−0.07% after the 0.4%
round trip).

## Exit-rule ablation (honest entry, same trade set)

| exit rule | honest limit: mean %/trade (t) | next-open: mean %/trade (t) |
|---|---:|---:|
| full engine (SL + TP1/TP2 + breakeven after TP1) | +0.42 (0.68) | −0.26 (−0.18) |
| time-exit only (no SL, no TP) | −0.02 (−0.17) | −0.79 (−0.76) |
| stop only | +0.24 (0.34) | −0.66 (−0.78) |
| TP only | +0.12 (0.01) | −0.39 (−0.35) |

The exit rules do **not** manufacture an edge: every variant is statistically zero.
The full engine is ~0.4–0.5 points better than holding blindly, but with t < 1 that
is not distinguishable from noise. Its profile is the usual one — median −2.81%
(many small stop-outs) offset by a few larger wins (win rate 42%).

Stop rule (honest limit, full engine): structural stops are better than tight ones.

| stop | trades | mean %/trade (t) |
|---|---:|---:|
| low10 | 666 | +0.66 (0.81) |
| low5 (current) | 698 | +0.42 (0.68) |
| pct5 | 590 | −0.29 (−0.54) |
| pct3 | 453 | −0.67 (−1.54) |
| atr 1.5 | 647 | −0.83 (−0.98) |
| atr 2 | 634 | −0.98 (−0.83) |

Tight/ATR stops lose to noise; none is significantly different from zero.

## Regime dominates everything

Even the blind time-exit-only benchmark swings from **−5.7%/trade in the first half**
of the window to **+5.0% in the second half** (honest limit). Every variant has
the same sign pattern (first half −3.8…−5.7%, second half +3.7…+5.0%). A single
window's P&L is essentially a bet on which half you happened to sample; it says
almost nothing about edge.

## What this changes

1. **Random picks through the risk engine are not net positive** once entry is
   honest (≈ 0 before costs' significance, negative at next-open). Phase 0A/0C's
   "the framework is net positive" is retracted.
2. **Phase 0D's "technical beats random" is unsupported as published** (see the
   re-run below). Its picks are chosen from names that closed strongly on day D,
   which is exactly where the look-ahead gain is largest.
3. **Shadow mode** compared all sources with the same biased evaluator: the
   *comparison* was biased toward breakout-style sources, and absolute
   expectancy/PF were inflated. The evaluator now fills on the next session; any
   outcome recorded before the fix should be discarded and re-evaluated (done
   at deploy).
4. Combined with Phase 0E/0F (no selection edge from broker flow, RSI,
   Fibonacci, momentum): **nothing tested so far shows a tradeable edge.** The
   honest baseline is "roughly zero before costs, slightly negative after".

## Fix

- `replayEngine`: `entryConvention` option, default `"nextSession"` (entry = first
  bar after the plan date, exits walk after it). `"sameBar"` remains **only** for
  the synthetic fixture scenarios, which are built around a same-bar fill.
- Shadow evaluator: entry = first bar after the plan date; needs
  `minForwardBars + 1` bars; `barsHeld` counted from the fill. Regression test
  added (a next-session gap-up past `maxBuyPrice` is a `no_fill` even though the
  plan date's own bar would have filled).
- `phase0d.ts` / `paramSweep.ts`: next-session by default; `--entry=sameBar`
  reproduces the legacy numbers.

## Remaining optimism (not fixed here)

- The simulator's exit walk starts the bar **after** the fill bar, so a stop touched
  on the fill bar itself is ignored (optimistic; small — the stop is a 5-day low).
- Daily bars only; intraday sequencing is unknowable, same-bar SL/TP resolved SL-first.
- One window / one regime (see above).

## Phase 0D re-run with an honest entry

Same script (`phase0d.ts`), same data (now 127 dates, 2026-03-05 → 2026-09-18, refreshed
universe), 5 picks/day, 20-bar hold, only the entry convention changed:

| strategy | entry = sameBar (legacy) | | entry = nextSession (honest) | |
|---|---:|---:|---:|---:|
| | expectancy Rp/trade | PF | expectancy Rp/trade | PF |
| technical | +5,080 | 1.79 | **−3,512** | **0.72** |
| volume | +2,610 | 1.25 | −5,979 | 0.62 |
| random | +7,934 | 1.98 | −3,997 | 0.74 |

With the look-ahead removed **all three lose money after costs** (win rate 31–34%),
and the technical screen is **indistinguishable from random** (PF 0.72 vs 0.74;
expectancy −Rp3.5k vs −Rp4.0k). It is only slightly better than volume-ranking
(PF 0.62). Its lower drawdown (Rp265k vs Rp1.02M for random) comes with a lower
fill rate (63% vs 68%) and a still-negative expectancy, so it is not evidence of
skill. Phase 0D's published claim that the technical screen "beats random" is
retracted. (The legacy column is not identical to the numbers first published in
Phase 0D because the window and universe have since been extended.)

Note the honest 0D random row (PF 0.74) is worse than the Phase 0G random row
(+0.42%/trade, PF 1.10): different window (0G: Apr–Sep, 85 dates, 10-bar hold,
25 picks/day from the whole liquid universe; 0D: Mar–Sep, 20-bar hold, picks from
the top-40 by volume). Both are statistically ≈ 0 and swing sign with the window —
the regime point above.
