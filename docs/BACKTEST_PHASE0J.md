# Phase 0J — combining fundamentals with broker flow: does it beat either alone?

**Verdict: no.** Neither weekly broker net-flow imbalance (`flow`, never tested at this
cadence/horizon before) nor the combination of it with Phase 0I's fundamental composite
(`combined`) shows a statistically meaningful signal at 4- or 13-week horizons. Both stay
well inside the noise band set by `placebo_random`. This was a genuine, pre-registered test
of a combination that had never been tried — the honest result is that it still doesn't work.

## Why this test

The user asked for "something we develop together" — not copied from an external source
like Yahoo's analyst consensus, but our own signal. Two pieces existed separately but had
never been tested together:

- **Fundamentals** (Phase 0I): profitability/value/growth, tested 4w/13w. BP weakly positive,
  nothing else worked.
- **Broker flow**: tested only at short 1–10 day shadow horizons (Phase 0E), small positive
  rank-IC below costs — never tested at 4w/13w, and the weekly broker book (2024-06 → now,
  spanning several market regimes) had never been used for a proper multi-regime test at all.

Combining them, if it worked, would have been a legitimate answer to "give me something of
our own." Pre-registered before running (not chosen after seeing results):

```
flow      = Σ net value / Σ buy value across the top-20 weekly broker book (same formula
            as apps/worker/src/shadow/screeners.ts netFlowImbalance), read at the rebalance
            Friday
combined  = average RANK of QV (Phase 0I's fundamental composite) and flow, among names
            where BOTH are available that date
```

Everything else — universe construction, 90-day publication lag, quintile/IC/t-stat
methodology, non-overlapping stride at 13w, bank/non-bank split — is unchanged from
[Phase 0I](BACKTEST_PHASE0I.md) for direct comparability. ARJUM's weekly price bars and the
weekly broker archive both land on Fridays, so the two data sources align with no date
adjustment needed.

## Data

- Fundamentals + weekly prices: same archive as Phase 0I (187 names, 27 monthly rebalance
  dates, 2024-07 → 2026-09).
- Weekly broker books: backfilled this session from 83 → **120 symbols** (2024-06 → 2026-09,
  ~113 weeks each) via `backfillBrokerWeekly.ts`. This is a **subset** of the 187-name
  fundamentals universe — flow/combined cross-sections run ~110–113 names per date vs ~185
  for the fundamental-only factors (three dates have zero flow coverage — gaps in the
  archive, likely holiday weeks that returned no book). `MIN_XS=15` still gates every date.

## Results (non-bank)

| factor | 4w IC (t) | 13w IC (t) | 13w Q5−Q1 |
|---|---|---|---|
| QV (fundamentals only, from Phase 0I) | 0.037 (1.1) | −0.031 (0.0) | −24.4% |
| **flow** (broker only, new) | 0.038 (1.2) | 0.017 (0.2) | −10.3% |
| **combined** (fundamentals + flow, new) | 0.053 (1.2) | −0.006 (−0.3) | −21.0% |
| placebo_random | −0.007 (−0.4) | −0.005 (1.3) | +0.1% |

`t` here is the non-overlapping-stride t-stat (same convention as Phase 0I); a usable signal
needs roughly `|t| > 2`. **None of flow, combined, or QV alone clears that bar at either
horizon** — flow and combined's t-stats (0.2–1.2) are the same order of magnitude as
placebo_random's (0.4–1.3), i.e. statistically indistinguishable from noise. Quintile
spreads for flow/combined are flat-to-negative at both horizons, not just the mean IC.

`combined`'s 4-week IC (0.053) is nominally the highest point estimate of the whole table —
this is exactly the kind of small, chance-driven bump that Phase 0H's placebo calibration
warned about (many factors tested, one will look best by luck). Its own t-stat (1.2) says
it isn't real, and it doesn't hold up at 13 weeks.

## Consequence

Combining fundamentals with broker flow was worth trying — it was a real gap, not a re-test
— but it does not clear the bar for "our own signal." **Nothing here is added to the
fundamentals screener, the shadow sources, or the trading engine.** The honest state of the
project is unchanged from Phase 0I: BP (book-to-price) remains the only factor with a
consistent, if weak, sign; everything else tested across Phases 0A–0J — technical, broker
flow (short or long horizon), fundamental, and now combined — has not shown a validated
edge on this dataset.

## Caveats

- Flow coverage (120/187 names) is a subset, not the full universe; three rebalance dates
  have zero flow observations (archive gaps).
- Same caveats as Phase 0I apply to the fundamental leg (survivorship, ~8 independent
  13-week observations, no true publication-date data).
- `combined`'s averaging is one specific pre-registered choice (equal-weight rank average of
  QV and flow); a different weighting was not tried here to avoid the multiple-comparisons
  trap Phase 0H warned about — testing several weightings post hoc would just reproduce that
  bias.

Reproduce:

```
pnpm --filter @idx/backtest exec tsx src/phase0j.ts -- --database-url=... --out=phase0j.json
```
