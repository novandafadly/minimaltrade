# Fundamentals screener (`/fundamentals` tab)

A **descriptive categorization tool**, not a trading signal. It groups the liquid IDX
universe into Growth / Value / Quality / Hidden gem / Caution based on fundamentals —
it does not claim any group will outperform.

## Why "descriptive, not predictive" is not a hedge — it's the finding

[Phase 0I](BACKTEST_PHASE0I.md) tested profitability, value and size factors on this exact
dataset and found **no fundamental factor that reliably predicts IDX returns**. Book-to-price
was the only one with a consistently positive sign, and even that was weak (t ≈ 1.4–2.1, ≈0
mean quintile spread once liquidity survivorship is corrected for). So these tabs answer "what
kind of company is this, today" — not "what will happen to its price."

## Data sources

- **ARJUM** (already archived by `backfillFundamentals.ts`): quarterly income statement,
  balance sheet, cash flow (12 discrete quarters); TTM figures usable only
  `PUBLICATION_LAG_DAYS` (90) after quarter end (no look-ahead).
- **Yahoo Finance** (`scripts` below, endpoint `/ext/yfinance` in `raw_payload_archive`):
  sector/industry, trailing/forward P/E, P/B, dividend yield, ROE, revenue/earnings growth,
  analyst recommendation/target — fields ARJUM doesn't provide. Unofficial free API, no
  credentials; **not re-verified for predictive value**, used only for descriptive fields.
  A handful of thinly-traded names return implausible P/E or P/B (e.g. AADI showed a P/B of
  26,051) — `sane()` in the route clips these to a plausible IDX range instead of displaying
  nonsense.
- **`daily_bar`** for price/turnover/20-day return. The live worker only refreshes this table
  for the handful of names that reach its deep-funnel screen each session — most of the
  universe is updated by periodic bulk backfills instead, so each row uses **its own** latest
  price (not a single global date), capped at 10 days old.

## Categories (cross-sectional, relative to today's universe)

A plain `> 0` cutoff passes almost everyone (the same bug the watchlist's FLOW flag had) —
these are percentile-based against the day's universe.

| category | rule |
|---|---|
| growth | earnings growth YoY (NIyoy) in the top third, and positive |
| value | book-to-price in the top third AND currently profitable (EP > 0) |
| quality | hygiene only: TTM net income > 0, TTM operating cash flow > 0, ROE > 0 |
| hidden_gem | quality AND value AND below-median market cap AND below-median 20-day return |
| caution | top-decile 20-day return WITHOUT earnings growth or quality behind it |

## Refreshing the Yahoo Finance data

One-off pull (throttled, resumable, symbol list from the ARJUM-covered universe):

```
pip install yfinance
python3 packages/backtest/scripts/pull_yfinance.py symbols.txt yfinance_universe.json
pnpm --filter @idx/backtest exec tsx src/ingestYfinance.ts -- --database-url=... --file=yfinance_universe.json
```

`pull_yfinance.py` is Python (yfinance has no maintained TS equivalent) and is a manual/periodic
pull, not part of the live pipeline — re-run it every few weeks to refresh sector/PE/growth data;
`symbols.txt` is one ARJUM ticker per line (the universe covered by `backfillFundamentals.ts`).
