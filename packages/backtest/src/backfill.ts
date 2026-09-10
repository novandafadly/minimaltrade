#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { marketCapResponseSchema, historyResponseSchema } from "@idx/domain";

/**
 * One-off historical backfill for the backtest harness.
 *
 * `stock.arjum.com` exposes ~120 days of daily OHLCV per symbol
 * (`/api/history/{code}`) and the whole-universe market-cap list
 * (`/api/market-cap`, paginated). This script pulls the top-N most-liquid
 * symbols' full history into `daily_bar` so the Postgres replay data source
 * has something to replay before the live worker has accumulated its own
 * history.
 *
 * Timestamps: each bar's `received_at` is set to ~post-close of its own
 * trading day (09:30 UTC ≈ 16:30 WIB), NOT the backfill run time — a bar for
 * 2026-06-01 WAS knowable at EOD 2026-06-01, and the replay leak-guard keys
 * off `received_at`.
 *
 * Run:
 *   pnpm --filter @idx/backtest run backfill -- --top=150 [--database-url=...] [--api-base=...] [--api-key=...]
 */

interface Args {
  top: number;
  minPrice: number;
  databaseUrl: string;
  apiBase: string;
  apiKey: string;
  throttleMs: number;
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
  return {
    top: Number(get("top") ?? 150),
    minPrice: Number(get("min-price") ?? 51),
    databaseUrl,
    apiBase: apiBase.replace(/\/$/, ""),
    apiKey,
    throttleMs: Number(get("throttle-ms") ?? 250)
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
  turnover: number; // rupiah/day, derived
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

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const { createDbClient, dailyBar, instrument } = await import("@idx/db");
  const { sql } = await import("drizzle-orm");
  const db = createDbClient(a.databaseUrl);

  console.log(`Backfill: top ${a.top} liquid symbols, min price ${a.minPrice}, api ${a.apiBase}`);
  const universe = (await fetchUniverse(a))
    .filter((r) => r.close >= a.minPrice && r.marketCap > 0)
    .sort((x, y) => y.turnover - x.turnover)
    .slice(0, a.top);
  console.log(`Selected ${universe.length} symbols. Fetching history...`);

  let done = 0;
  let barsWritten = 0;
  for (const u of universe) {
    try {
      const raw = await apiGet(a.apiBase, a.apiKey, `/api/history/${encodeURIComponent(u.symbol)}`);
      const parsed = historyResponseSchema.parse(raw);
      const ascending = [...parsed.rows].sort((p, q) => p.date.localeCompare(q.date));

      for (const bar of ascending) {
        const receivedAt = new Date(`${bar.date}T09:30:00.000Z`); // ~post-close of that day
        await db
          .insert(dailyBar)
          .values({
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
            receivedAt
          })
          .onConflictDoUpdate({
            target: [dailyBar.symbol, dailyBar.tradingDate],
            set: {
              open: String(Number(bar.open)),
              high: String(Number(bar.high)),
              low: String(Number(bar.low)),
              close: String(Number(bar.close)),
              volume: String(Math.round(Number(bar.volume))),
              turnover: bar.value !== undefined && bar.value !== null ? String(Number(bar.value)) : null,
              source: "arjum-backfill",
              receivedAt
            }
          });
        barsWritten += 1;
      }

      await db
        .insert(instrument)
        .values({ symbol: u.symbol, sharesOutstanding: String(Math.round(u.sharesOutstanding)), isActive: true })
        .onConflictDoUpdate({
          target: instrument.symbol,
          set: { sharesOutstanding: String(Math.round(u.sharesOutstanding)), updatedAt: sql`now()` }
        });

      done += 1;
      process.stdout.write(`\r  ${done}/${universe.length} symbols, ${barsWritten} bars`);
      await sleep(a.throttleMs);
    } catch (err) {
      process.stdout.write(`\n  ! ${u.symbol}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  process.stdout.write("\n");
  console.log(`Done. ${done} symbols, ${barsWritten} daily_bar rows.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
