# Upstream schema verification status

Source: `https://stock.arjum.com`, header `X-API-Key`.

| Endpoint | Status | Notes |
|---|---|---|
| /api/screener/latest | PROVISIONAL | not verified against a live payload |
| /api/analysis/{code} | PROVISIONAL | |
| /api/broker-summary/{code} | VERIFIED | 2026-09-09, symbol BBCA. Field names are `stock_code`/`bval`/`bvol`/`bfrq`/`sval`/`svol`/`sfrq`/`nval`/`nvol`/`broker_levels`/`broker_start_date`/`broker_end_date` — quite different from the originally-guessed contract. No `status` or `segment` field in the real payload; adapter defaults to provisional/`segment: "regular"` unless the caller (deep funnel, which only calls this post-EOD) declares `assumeFinal=true`. See `getBrokerSummary` in `apps/worker/src/adapter/endpoints.ts`. |
| /api/broker-accumulation/{code} | PROVISIONAL | |
| /api/history/{code} | PROVISIONAL | |
| /api/seasonal/{code} | PROVISIONAL | |
| /api/market-cap | PROVISIONAL | |
| /api/search | PROVISIONAL | |
| /api/health | PROVISIONAL | |
| /api/financial-statements/{code} | PROVISIONAL | |
| /api/insiders/{code} | PROVISIONAL | |

When a real sample response is confirmed, update the corresponding schema in
`upstream.ts` to match exactly, flip its row to VERIFIED here, and add/refresh
the fixture under `apps/worker/src/adapter/__fixtures__/` used by the adapter's
contract tests.
