# IDX Smart Money Decision Engine

Decision-support and risk engine for semi-swing (1-5 day) IDX trading with a
Rp5,000,000 starting capital. Produces candidate rankings (STRONG BUY,
SPECULATIVE BUY, WATCHLIST, AVOID, NO TRADE) with full entry/TP/SL/lot/risk
plans. **Does not place orders.** See
`Final_Blueprint_IDX_Smart_Money_Decision_Engine.docx` for the full spec and
`docs/AUDIT_AND_PLAN.md` for the implementation audit, gap analysis, and
phase plan.

## Architecture

Monorepo (pnpm workspaces):

- `packages/config` — env schema, strategy config defaults (versioned), session calendar, IDX price-fraction table.
- `packages/domain` — pure, deterministic, network-free: market-data types, upstream Zod schemas, feature/scoring/risk engines.
- `packages/db` — Postgres schema (Drizzle ORM) + migrations + seed.
- `apps/worker` — market data adapter, Redis cache/single-flight/rate-budget/request-ledger, funnel (top/mid/deep), scheduler, alert engine.
- `apps/web` — Next.js dashboard + BFF route handlers + SSE.
- `packages/backtest` — replay/backtest engine: no-future-leakage data sourcing, limit/partial/gap fill simulation, metrics, baseline comparisons.
- `infra/docker` — Dockerfiles, local dev `docker-compose.yml`, production `docker-compose.prod.yml`.

## Prerequisites

- Node.js 22+, pnpm 9+ (`corepack enable`)
- Docker (for local Postgres/Redis/MinIO)

## Local development

```bash
cp .env.example .env   # fill in ARJUM_API_KEY and any other real values
docker compose -f infra/docker/docker-compose.yml up -d
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev:worker   # in one terminal
pnpm dev:web      # in another
```

Web dashboard: http://localhost:3000

## Migrations

Schema lives in `packages/db/src/schema.ts`. After changing it:

```bash
pnpm --filter @idx/db run generate   # writes a new SQL file under packages/db/migrations
pnpm db:migrate                      # applies pending migrations
```

## Tests

```bash
pnpm lint
pnpm typecheck
pnpm test        # unit, contract (adapter schema/fixtures), golden, property tests across all packages
pnpm build
```

`packages/domain` tests are pure (no DB/Redis needed). `apps/worker` contract
tests use recorded/fixture HTTP responses (`nock`), not the live upstream.

## Environment variables

See `.env.example` for the full list and inline documentation. Secrets
(`ARJUM_API_KEY`, `WEB_APP_SESSION_SECRET`, `OBJECT_STORAGE_*`,
`DEPLOY_SSH_KEY`) must never be committed; production values are injected via
the deploy server's `.env` (see below) and GitHub Actions repository secrets.

## CI/CD

`.github/workflows/ci.yml`:

- On every push/PR: install, migrate against ephemeral Postgres/Redis service
  containers, lint, typecheck, test, build.
- On push to `main`, after the above passes: builds worker/web Docker images
  and deploys over SSH to `DEPLOY_HOST`, provided the following **GitHub
  repository secrets** are set (deploy step no-ops with a notice if they are
  not): `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH`.

### Server-side one-time setup

On the target VPS:

```bash
mkdir -p /opt/idx-smart-money && cd /opt/idx-smart-money
git clone <this repo> .
cp .env.example infra/docker/.env   # fill in real secrets, plus POSTGRES_PASSWORD
```

The deploy job then runs `docker compose -f infra/docker/docker-compose.prod.yml up -d --build`
and applies migrations on every push to `main`.

## Backtest / replay

See `docs/AUDIT_AND_PLAN.md` §7 phase 6. Replay only uses data available as of
each historical decision timestamp (no future leakage, enforced by a
`withLeakGuard` wrapper around the data source) and simulates limit fill,
partial fill, gap, fee, and slippage per the blueprint's §13.2.

```bash
# Deterministic synthetic dataset (no DB needed) — sanity-checks the pipeline
pnpm --filter @idx/backtest run replay -- --source=fixture

# Real historical data (requires daily_bar/trade_plan rows persisted by the
# worker's deep funnel over enough trading days)
pnpm --filter @idx/backtest run replay -- --source=postgres
```

Prints a JSON metrics report (net expectancy, profit factor, max drawdown,
avg net RR, fill rate, false-accumulation rate, rule adherence) and compares
against the "random liquid universe" and "volume-only ranking" baselines the
blueprint names in §13.2/§14.

True OHLCV bars (needed for accurate gap/same-bar SL-TP simulation) come from
the `daily_bar` table, populated by the worker's deep funnel from
`/api/history/{code}`. Until enough days of `daily_bar` history exist for a
symbol, the Postgres replay source falls back to `market_snapshot`'s single
EOD price (open=high=low=close for that day) — see
`packages/backtest/src/dataSource/postgres.ts` for the documented tradeoff.

## Non-goals (V1)

No automated broker order execution. All plans are instructions for the user
to enter manually; `paper_trade`/journal records planned vs. actual fills for
forward-test evaluation before any real capital is risked.
