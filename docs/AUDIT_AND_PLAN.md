# IDX Smart Money Decision Engine — Audit, Gap Analysis, and Implementation Plan

## 1. Repository Audit (as of session start)

The repository contained only `Final_Blueprint_IDX_Smart_Money_Decision_Engine.docx` and `.git` —
**no existing code, framework, package manager, folder structure, database, environment
variables, or test tooling.** This is a greenfield build. The "use existing patterns" directive
in the blueprint's prompt (section 15) does not apply; instead we establish the initial
conventions here, following the blueprint's own architecture recommendation (section 9).

## 2. Data Source

External provider confirmed by user: `https://stock.arjum.com`, auth via `X-API-Key` header.
The sandbox this session runs in cannot reach that host (egress allowlist blocks arbitrary
external domains — only npm/GitHub/Anthropic are reachable). Real sample payloads for
`/api/screener/latest`, `/api/broker-summary/{code}`, `/api/broker-accumulation/{code}`,
`/api/history/{code}`, and `/api/health` are pending from the user. Until then:

- Adapter schemas (Zod) are written against the blueprint's documented contract (section 3),
  marked with `// PROVISIONAL: unverified against live payload` comments.
- Every schema is a single source of truth (`packages/domain/src/schemas/*.ts`) so tightening
  them later touches one file per endpoint, not call sites.
- The adapter fails loudly (throws a typed `SchemaValidationError`, logs the raw payload to the
  raw archive) on any parse failure rather than coercing — this surfaces contract drift
  immediately instead of silently producing bad signals.

## 3. Unproven Assumptions (explicit, to be revisited)

1. Exact JSON field names/casing for all 11 endpoints — unverified (see above).
2. Lot size assumed 100 shares/lot (BEI standard) — not stated in blueprint text explicitly for lots but implied by "Rp100 x Entry" in formula 7.2.
3. Tick size / price fraction rules — blueprint says "dibulatkan ke fraksi harga yang valid" without giving the IDX fraction table; we implement the standard IDX 2023 fraction table (configurable, versioned) as best-effort.
4. Fee rates (buy/sell brokerage %) — not specified numerically in blueprint; defaulted to a configurable `strategy_config` value (placeholder 0.15%/0.25% typical Indonesian retail broker rates), must be confirmed by user before any real-money use.
5. Trading session calendar/hours — using standard IDX session times (09:00–11:30, 13:30–15:49 WIB, half-day Friday), configurable.
6. No object-storage credentials provided — raw archive implemented against S3-compatible API via env-configurable endpoint (works with MinIO locally, swappable for AWS S3/R2/Wasabi in prod).
7. No target VPS/server provided yet for CD deploy step — CI builds/pushes images and runs tests on every push; the deploy job is wired but will no-op (skipped) until `DEPLOY_HOST`/SSH secrets are set in GitHub repo secrets.

## 4. Service Boundaries (per blueprint §9.1)

- `packages/domain` — pure, deterministic, versioned, network-free: feature engine, scoring
  engine, risk engine, formulas, types. Fully unit-testable without I/O.
- `apps/worker` — market data adapter (network), Redis cache/lease/rate-budget, request ledger,
  scheduler, funnel orchestration, alert engine, calls into `packages/domain` for calculation.
- `apps/web` — Next.js dashboard + BFF route handlers + SSE endpoint; reads from Postgres/Redis,
  never calls upstream directly.
- `packages/db` — Postgres schema, migrations, typed query layer, shared by worker and web.
- `packages/config` — strategy_config defaults, env schema, formula/version constants.

## 5. Database Schema (Postgres, see packages/db/migrations)

Tables map 1:1 to blueprint §9.2 entities: `instrument`, `market_snapshot`, `broker_snapshot`,
`feature_snapshot`, `signal`, `trade_plan`, `paper_trade`, `strategy_config`, `request_ledger`,
plus `raw_payload_archive` (audit/replay), `alert_log` (dedupe/cooldown), and
`session_calendar` (IDX trading calendar). All snapshot/signal tables carry `formula_version`,
`config_version`, `input_snapshot_id` for reproducibility (Acceptance Criteria V1).

## 6. Environment Variables

See `.env.example`. Grouped: `ARJUM_API_*` (upstream), `DATABASE_URL`, `REDIS_URL`,
`OBJECT_STORAGE_*`, `DAILY_REQUEST_BUDGET`, `SESSION_*`, `RISK_DEFAULT_*`, `NEXTAUTH_*`/session
secret for dashboard auth, `SSE_*`.

## 7. Phased Plan (this session, continuous)

0. Audit — done (this document).
1. Foundation — monorepo scaffold, DB schema+migrations, config package, adapter skeleton,
   Redis cache/ledger, health check, CI skeleton (lint/typecheck/test/build).
2. Funnel — top/mid/deep funnel against adapter + cache, candidate snapshots.
3. Quant Engine — feature engine (B-Avg, breadth, HHI, persistence, crossing/distribution),
   composite score, hard gates. Golden + property tests.
4. Risk Engine — lot sizing, fees, slippage, TP/SL, expiry, NO TRADE. Property tests for
   invariants (lots ≥ 0, TP lots sum = buy lots, loss ≤ risk budget except gap).
5. Dashboard — trigger table, drawer, plan panel, SSE, stale/degraded/error states.
6. Replay/Backtest — deterministic replay engine, no future leakage, fill/partial/gap/fee sim.
7. Paper trading journal + audit trail.
8. CI/CD — GitHub Actions: lint/typecheck/test/build on PR; build+push Docker images and deploy
   over SSH to a VPS on merge to main (deploy step gated on secrets being present).

Phases 7 (forward test, 20-60 sessions) and 8 (controlled live) from the blueprint are
operational/process phases, not code deliverables, and are out of scope for this session.
