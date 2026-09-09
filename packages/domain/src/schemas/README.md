# Upstream schema verification status

Source: `https://stock.arjum.com`, header `X-API-Key`.

All schemas below were tightened against a real captured payload on
**2026-09-09** (symbol `BBCA` where a code is required). Reference payloads
live outside the repo (`arjum-real-payloads-2026-09-09.json` from the
provisioning session); one screener payload is also in the `raw_payload_archive`
table.

| Endpoint | Status | Notes |
|---|---|---|
| /api/screener/latest | VERIFIED | `{date, source, cached_for_seconds, raw (markdown), rows:[{stock_code, stock_name, bucket, summary, note, drawdown, wr_event, potential}]}`. This is a **curated pattern-signal shortlist**, not a whole-universe quote list — no price/volume per row. The adapter returns it as a candidate list; the deep funnel derives a per-symbol quote from `/api/history`. |
| /api/history/{code} | VERIFIED | `{stock_code, frame, rows:[{date, open, high, low, close, volume, value, change, change_pct, freq, f_buy, f_sell, n_foreign, avg}]}` — full OHLCV, rows newest-first (adapter re-sorts ascending). `baseline_median_volume_20d` is **computed by the adapter** from the returned window. |
| /api/broker-summary/{code} | VERIFIED | `stock_code` / `bval/bvol/bfrq/sval/svol/sfrq/nval/nvol` / `broker_levels` / `broker_start_date` / `broker_end_date`. Returns a DATE RANGE, not a single day. No `status`/`segment` field — adapter defaults to `segment:"regular"`, `provisional` unless the deep funnel (post-EOD only) passes `assumeFinal=true`. |
| /api/broker-accumulation/{code} | VERIFIED | `{code, start_date, end_date, series:[{broker_code, broker_name, points:[{date, nval, nvol, cum_nval, bavg, savg}]}], top_buyers, top_sellers}` — per-broker time series. The adapter pivots `series[].points[]` into per-day `netBuyBrokers`/`topBuyer` rows. |
| /api/seasonal/{code} | VERIFIED | `{stock_code, years, monthly_returns:{Jan:{"2020":..}}, summary:{Jan:{avg, up, down, total, up_prob}}, yearly_avg}`. The adapter picks the current exchange-local month's `up_prob` (a percentage) and maps it to a 0-1 `historicalWinRate`. |
| /api/market-cap | VERIFIED | `{date, total, page, per_page, total_pages, data:[{code, name, close, listed_shares, market_cap, ...}]}` — **paginated** (~39 pages). The adapter reads one page at a time (`?page=`). Not used in the hot funnel path. |
| /api/search | VERIFIED | Bare array `[{stock_code, stock_name, last_date, ...}]`. |
| /api/health | VERIFIED | `{ok, status}`. |
| /api/analysis/{code} | VERIFIED (unstructured) | `{stock_code, output}` where `output` is a **human-readable markdown blob** (price action, SMA5/20/50, RSI, S/R). Kept only as `narrative`; the feature engine does not consume it (SMA/RSI, if needed, should be computed from `/api/history` bars). |
| /api/financial-statements/{code} | UNAVAILABLE | Returns **403** for API keys ("gunakan 8 endpoint resmi"). Schema kept permissive; the deep funnel calls it best-effort and swallows the error. |
| /api/insiders/{code} | VERIFIED | `{stock_code, count, total, page, page_size, total_pages, items:[{name, date, action_type, changes_value, current_percentage, price_formatted, badges, ...}]}`. `action_type` is `buy`/`sell`; `changes_value` is a formatted string like `"+317,892"`. |

When a real payload changes, update the corresponding schema in `upstream.ts`
to match exactly and refresh the fixtures in
`apps/worker/src/adapter/__tests__/endpoints.test.ts`.
