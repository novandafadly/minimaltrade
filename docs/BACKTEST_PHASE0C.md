# Backtest — Phase 0c: risk-engine parameter sweep

**Goal:** Phase 0b found `NET_RR_MIN` fails for 74–86% of candidates. This
sweeps `minNetRewardToRisk` × preliminary-stop method over the backfilled
120-day window (`pnpm --filter @idx/backtest exec tsx src/paramSweep.ts`),
using the deterministic volume-ranked baseline and a fixed-seed random
baseline (3 picks/day). It is **not** a search for optimal params — it checks
whether the current defaults are needlessly discarding tradeable setups.

## Result — window 2026-03-05 → 2026-09-09 (120 days), 3 candidates/day

### Volume-ranked baseline

| RR gate | stop | trades | fill | win | net exp | PF | max DD |
|---|---|---|---|---|---|---|---|
| **2.5** | any | **0** | – | – | – | – | – |
| 2.0 (default) | pct3 | 5 | – | – | +53.7k | – | 0 |
| 2.0 (default) | **low5 (default)** | **93** | 0.72 | 0.43 | **+1.6k** | **1.20** | 403k |
| 2.0 | atr1_5 | 171 | 0.50 | 0.28 | **−6.1k** | 0.57 | 1.06M |
| 1.75 | pct5 | 82 | 0.60 | 0.47 | +8.5k | 1.85 | 250k |
| 1.75 | pct3 | 22 | 0.50 | 0.82 | +28.5k | 7.28 | 50k |
| **1.5** | **pct5** | **210** | 0.56 | 0.53 | **+13.8k** | **2.51** | 550k |
| 1.5 | pct3 | 39 | 0.56 | 0.77 | +24.9k | 6.54 | 50k |
| 1.5 | low5 | 224 | 0.63 | 0.45 | +4.1k | 1.42 | 858k |

### Random-liquid baseline (fixed seed, corroboration)

| RR gate | stop | trades | win | net exp | PF | max DD |
|---|---|---|---|---|---|---|
| 2.0 | low5 | 90 | 0.53 | +12.3k | 2.62 | 277k |
| 2.0 | pct5 | 116 | 0.36 | −0.5k | 0.96 | 286k |
| **1.5** | **pct5** | **268** | 0.52 | **+11.5k** | **2.20** | 217k |
| 1.75 | pct5 | 225 | 0.54 | +13.2k | 2.49 | 167k |
| 1.5 | pct3 | 240 | 0.50 | +14.9k | 2.49 | 212k |

## Reading

1. **`minNetRewardToRisk: 2.5` → zero trades. `2.0` → a trickle.** The current
   gate (2.0) plus the deep funnel's flat 3% preliminary stop is why the live
   pipeline and Phase 0b produced almost nothing. The framework isn't broken —
   it's gated shut.

2. **Lowering the RR gate to 1.5–1.75 unlocks ~2–3× the trades while keeping
   (usually improving) profit factor** — and it holds across *both* baselines,
   which is the signal that it's a real effect and not a fit to one.

3. **A ~5% flat stop (`pct5`) is the credible sweet spot** for
   frequency + quality: ~210–270 trades, PF ~2.2–2.5, +Rp 11–14k/trade, both
   baselines. Wider ATR stops add trades but bleed PF (some go negative at
   rr 2.0). Very tight `pct3` shows spectacular PF (6–7) but on only 22–39
   trades — too thin to trust, and tight stops flatter a choppy/down tape.

## Recommendation (small, reversible config changes)

- `packages/config/src/strategyConfig.ts` → `risk.minNetRewardToRisk`: **2.0 → 1.75**
- `apps/worker/src/funnel/constants.ts` → `DEEP_FUNNEL_PRELIMINARY_STOP_PCT`: **0.03 → 0.05**
  (or make the deep funnel's preliminary stop structure-based — recent swing
  low — which `planFromHistory`'s `stopFor("low5")` already implements)

Then run **shadow mode** against these relaxed baselines to see whether the
broker-flow signal actually beats them.

## Caveats (do not skip)

- **One 6-month window, one market regime** (median liquid stock −7.8% over it).
  Tight/percentage stops do well in choppy/down tapes and get whipsawed in
  strong trends. Re-run when there's ≥12 months / a different regime.
- **Baselines are a floor, not a strategy.** Positive baseline expectancy shows
  the *risk framework* is sound at these params; it does not mean "pick random
  liquid stocks."
- This says **nothing** about whether the broker-flow / composite score adds
  value over the baseline — that is the shadow-mode question.
