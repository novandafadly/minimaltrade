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
- `infra/docker` — Dockerfiles, local dev `docker-compose.yml`, and the two-VM production split: `docker-compose.db.yml` (Postgres + Redis) and `docker-compose.app.yml` (worker + web).

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

See `.env.example` (app VM / local dev) and `infra/docker/.env.db.example`
(DB VM) for the full list and inline documentation. Secrets (`ARJUM_API_KEY`,
`WEB_APP_SESSION_SECRET`, `OBJECT_STORAGE_*`, `POSTGRES_PASSWORD`,
`REDIS_PASSWORD`, the deploy SSH key) must never be committed; production
values are injected via each VM's own `.env` and GitHub Actions repository
secrets.

## Deployment: two OCI VMs

The system splits across two VMs, matching how OCI compute is normally
provisioned for this kind of app:

| VM | Runs | Exposure |
|---|---|---|
| **DB VM** | Postgres 16 + Redis 7 (both persisted, `docker-compose.db.yml`) | Private network only — never the public internet |
| **App VM** | worker + web (`docker-compose.app.yml`) | Public port 3000/80/443 for the dashboard; egress to `stock.arjum.com` and to the DB VM's private IP |

CI/CD (`.github/workflows/ci.yml`) only ever redeploys the **app VM**
automatically, on every push to `main`. The DB VM is provisioned once by hand
below and left alone — reapplying a stateful database compose file on every
push is how you lose data, not something a pipeline should do unattended.
Schema migrations *are* run automatically on every app-VM deploy (they're
versioned and additive, and already passed in CI before deploy runs).

### 1. Network setup (OCI console)

Put both VMs in the same VCN, ideally the same subnet, so they reach each
other over private IPs. On the **DB VM's** Security List / Network Security
Group, allow ingress on `5432` and `6379` **only from the app VM's private
IP** (a `/32` rule, not the whole subnet). On the **app VM's**, allow ingress
on whatever port serves the dashboard (`3000`, or `80`/`443` if you put a
reverse proxy in front) from the internet, and allow all egress.

### 2. DB VM one-time setup

```bash
# Docker, if not already installed (Ubuntu shown; use dnf on Oracle Linux)
curl -fsSL https://get.docker.com | sh

git clone https://github.com/novandafadly/cuantrade.git /opt/idx-smart-money
cd /opt/idx-smart-money/infra/docker
cp .env.db.example .env
# edit .env: set DB_VM_PRIVATE_IP to this VM's actual private IP,
# and generate real POSTGRES_PASSWORD / REDIS_PASSWORD values

docker compose -f docker-compose.db.yml up -d
```

Note the private IP and the two passwords — you'll need them for the app
VM's `.env` next.

### 3. App VM one-time setup

```bash
curl -fsSL https://get.docker.com | sh

mkdir -p /opt/idx-smart-money && cd /opt/idx-smart-money
git clone https://github.com/novandafadly/cuantrade.git .
cp .env.example infra/docker/.env
```

Docker Compose resolves `.env`/`env_file` relative to the compose file's own
directory (`infra/docker`), not wherever you happen to run the command from
-- so `.env` must live at `infra/docker/.env` here, same as the DB VM.

Edit `infra/docker/.env` and set, at minimum:

```bash
ARJUM_API_KEY=<your real key>
DATABASE_URL=postgres://idx:<POSTGRES_PASSWORD>@<DB_VM_PRIVATE_IP>:5432/idx_smart_money
REDIS_URL=redis://:<REDIS_PASSWORD>@<DB_VM_PRIVATE_IP>:6379
WEB_APP_SESSION_SECRET=<a real random 32+ byte secret>
# OBJECT_STORAGE_* -> point at an OCI Object Storage bucket's S3-compatible
# endpoint + a Customer Secret Key, not a self-hosted MinIO (see .env.example)
```

Then bring it up once by hand to confirm it works before CI takes over:

```bash
docker compose -f infra/docker/docker-compose.app.yml up -d --build
docker compose -f infra/docker/docker-compose.app.yml exec -T worker pnpm --filter @idx/db run migrate
docker compose -f infra/docker/docker-compose.app.yml exec -T worker pnpm --filter @idx/db run seed
```

Dashboard should now be reachable at `http://<app-vm-public-ip>:3000`.

### 4. Wire up GitHub Actions

Repo → **Settings → Secrets and variables → Actions → New repository
secret**, add:

- `DEPLOY_APP_HOST` — app VM's public IP/hostname
- `DEPLOY_APP_USER` — SSH user on the app VM
- `DEPLOY_APP_SSH_KEY` — a private key (paste the key file content) whose
  matching public key is in that user's `~/.ssh/authorized_keys` on the app
  VM
- `DEPLOY_APP_PATH` — `/opt/idx-smart-money` (or wherever you cloned it)

From then on, every push to `main` that passes lint/typecheck/test/build
automatically SSHes into the app VM, pulls, rebuilds the worker/web
containers, and runs migrations. The DB VM is untouched by this — go back to
step 2 manually for Postgres/Redis version bumps or maintenance.

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
