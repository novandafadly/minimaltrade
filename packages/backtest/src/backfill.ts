#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { marketCapResponseSchema, historyResponseSchema, brokerAccumulationResponseSchema } from "@idx/domain";

/**
 * One-off historical backfill for the backtest harness.
 *
 * `stock.arjum.com` exposes ~120 days of daily OHLCV (`/api/history/{code}`)
 * and ~120 days of per-broker net-flow series (`/api/broker-accumulation/
 * {code}`) per symbol, plus the whole-universe market-cap list. This script
 * pulls the top-N most-liquid symbols into `daily_bar` and `broker_snapshot`
 * so the Postgres replay data source has real history to replay before the
 * live worker has accumulated its own.
 *
 * Timestamps: every row's `received_at` is set to ~post-close of ITS OWN
 * trading day (09:30 UTC ≈ 16:30 WIB), NOT the backfill run time — a bar for
 * 2026-06-01 WAS knowable at EOD 2026-06-01, and the replay leak-guard keys
 * off `received_at`.
 *
 * broker_snapshot APPROXIMATION: `/api/broker-accumulation` gives only NET
 * value/volume per broker per day (`nval`/`nvol`) plus the broker's average
 * buy/sell price (`bavg`/`savg`). Gross buy vs gross sell is not available
 * historically, so a net-buyer's row is stored as buy=net, sell=0 (and vice
 * versa). This means the feature engine's `suspectedTransfer` /
 * `failedAbsorption` (which need a broker large on BOTH sides) are
 * under-triggered in the backtest — a documented, one-directional limitation.
 *
 * Run:
 *   pnpm --filter @idx/backtest run backfill -- --top=150 [--phases=history,broker]
 */

interface Args {
  top: number;
  minPrice: number;
  databaseUrl: string;
  apiBase: string;
  apiKey: string;
  throttleMs: number;
  phases: Set<"history" | "broker">;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : undefined;
  };
  const databaseUrl = get("database-url") ?? process.env.DATABASE_URL ?? "";
  const apiBase = get("api-base") ?? process.env.ARJUM_API_BASE_URL ?? "https://stock.arjum.com";
  const apiKey = get("api-key") ?? process.env.ARJUM_API_KEY ?? "";
  if (!databaseUrl) throw new Error("DATABASE_URL (or --database-url=) is required");
  if (!apiKey) throw new Error("ARJUM_API_KEY (or --api-key=) is required");
  const phasesRaw = (get("phases") ?? "history,broker").split(",").map((s) => s.trim());
  return {
    top: Number(get("top") ?? 150),
    minPrice: Number(get("min-price") ?? 51),
    databaseUrl,
    apiBase: apiBase.replace(/\/$/, ""),
    apiKey,
    throttleMs: Number(get("throttle-ms") ?? 250),
    phases: new Set(phasesRaw.filter((p): p is "history" | "broker" => p === "history" || p === "broker"))
  };
}

async function apiGet(base: string, key: string, path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { headers: { "X-API-Key": key } });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

interface UniverseRow {
  symbol: string;
  close: number;
  turnover: number;
  marketCap: number;
  sharesOutstanding: number;
}

async function fetchUniverse(a: Args): Promise<UniverseRow[]> {
  const rows: UniverseRow[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const raw = await apiGet(a.apiBase, a.apiKey, page === 1 ? "/api/market-cap" : `/api/market-cap?page=${page}`);
    const parsed = marketCapResponseSchema.parse(raw);
    totalPages = parsed.total_pages ?? 1;
    for (const e of parsed.data) {
      const close = Number(e.close ?? 0);
      const mcap = Number(e.market_cap);
      const tr = Number(e.turnover_ratio ?? 0);
      rows.push({
        symbol: e.code,
        close,
        marketCap: mcap,
        sharesOutstanding: Number(e.listed_shares),
        turnover: tr > 0 ? tr * mcap : 0
      });
    }
    process.stdout.write(`\r  market-cap page ${page}/${totalPages} (${rows.length} symbols)`);
    page += 1;
    await sleep(a.throttleMs);
  } while (page <= totalPages);
  process.stdout.write("\n");
  return rows;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function insertChunked(db: any, table: any, rows: unknown[], chunk = 500): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    await db.insert(table).values(rows.slice(i, i + chunk)).onConflictDoNothing();
  }
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const { createDbClient, dailyBar, instrument, brokerSnapshot } = await import("@idx/db");
  const { sql } = await import("drizzle-orm");
  const db = createDbClient(a.databaseUrl);

  console.log(`Backfill phases=[${[...a.phases].join(",")}] top ${a.top} min price ${a.minPrice}`);
  const universe = (await fetchUniverse(a))
    .filter((r) => r.close >= a.minPrice && r.marketCap > 0)
    .sort((x, y) => y.turnover - x.turnover)
    .slice(0, a.top);
  console.log(`Selected ${universe.length} symbols.`);

  let done = 0;
  let barsWritten = 0;
  let brokerRowsWritten = 0;

  for (const u of universe) {
    try {
      if (a.phases.has("history")) {
        const raw = await apiGet(a.apiBase, a.apiKey, `/api/history/${encodeURIComponent(u.symbol)}`);
        const parsed = historyResponseSchema.parse(raw);
        const ascending = [...parsed.rows].sort((p, q) => p.date.localeCompare(q.date));
        const barRows = ascending.map((bar) => ({
          id: randomUUID(),
          symbol: parsed.stock_code,
          tradingDate: bar.date,
          open: String(Number(bar.open)),
          high: String(Number(bar.high)),
          low: String(Number(bar.low)),
          close: String(Number(bar.close)),
          volume: String(Math.round(Number(bar.volume))),
          turnover: bar.value !== undefined && bar.value !== null ? String(Number(bar.value)) : null,
          source: "arjum-backfill",
          receivedAt: new Date(`${bar.date}T09:30:00.000Z`)
        }));
        await insertChunked(db, dailyBar, barRows);
        barsWritten += barRows.length;
        await db
          .insert(instrument)
          .values({ symbol: u.symbol, sharesOutstanding: String(Math.round(u.sharesOutstanding)), isActive: true })
          .onConflictDoUpdate({
            target: instrument.symbol,
            set: { sharesOutstanding: String(Math.round(u.sharesOutstanding)), updatedAt: sql`now()` }
          });
        await sleep(a.throttleMs);
      }

      if (a.phases.has("broker")) {
        const raw = await apiGet(a.apiBase, a.apiKey, `/api/broker-accumulation/${encodeURIComponent(u.symbol)}`);
        const parsed = brokerAccumulationResponseSchema.parse(raw);
        const rows: Record<string, unknown>[] = [];
        for (const series of parsed.series) {
          for (const p of series.points) {
            const nval = Number(p.nval);
            const nvol = Number(p.nvol ?? 0);
            const isBuyer = nvol > 0 || (nvol === 0 && nval > 0);
            rows.push({
              id: randomUUID(),
              symbol: parsed.code,
              tradingDate: p.date,
              brokerCode: series.broker_code,
              segment: "regular",
              buyVolume: String(Math.round(isBuyer ? Math.abs(nvol) : 0)),
              buyValue: String(isBuyer ? Math.abs(nval) : 0),
              sellVolume: String(Math.round(isBuyer ? 0 : Math.abs(nvol))),
              sellValue: String(isBuyer ? 0 : Math.abs(nval)),
              netVolume: String(Math.round(nvol)),
              netValue: String(nval),
              avgBuyPrice: p.bavg !== undefined && p.bavg !== null ? String(Number(p.bavg)) : null,
              avgSellPrice: p.savg !== undefined && p.savg !== null ? String(Number(p.savg)) : null,
              status: "final",
              receivedAt: new Date(`${p.date}T09:30:00.000Z`),
              rawPayloadId: null
            });
          }
        }
        await insertChunked(db, brokerSnapshot, rows);
        brokerRowsWritten += rows.length;
        await sleep(a.throttleMs);
      }

      done += 1;
      process.stdout.write(`\r  ${done}/${universe.length} symbols | ${barsWritten} bars | ${brokerRowsWritten} broker rows`);
    } catch (err) {
      process.stdout.write(`\n  ! ${u.symbol}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  process.stdout.write("\n");
  console.log(`Done. ${done} symbols, ${barsWritten} daily_bar rows, ${brokerRowsWritten} broker_snapshot rows.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
