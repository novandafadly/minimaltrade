#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { brokerSummaryResponseSchema } from "@idx/domain";

/**
 * Backfill FULL per-day broker books from `/api/broker-summary/{code}`.
 *
 * Phase 0b concluded the broker-flow scoring engine "can't be backtested"
 * because `/api/broker-accumulation` only exposes ~5 net-mover brokers/day.
 * That was an incomplete exploration: `/api/broker-summary/{code}` accepts
 * `?start_date=D&end_date=D` and returns the same full two-sided book the
 * live engine consumes (20 brokers, real buy AND sell legs) for any single
 * day back to 2020-01-02 -- one request per symbol-day. So the replay can be
 * fed data with exactly the live shape.
 *
 * Budget: ARJUM allows ~1000 req/day, shared with the live worker. This CLI
 *  - is symbol-major (finishes a whole symbol's window before starting the
 *    next, so every completed symbol has contiguous history),
 *  - is resumable (a symbol-day with >= 12 rows in broker_snapshot is
 *    treated as already loaded; sparse accumulation rows are ~5/day),
 *  - stops at `--max-requests` OR when the API's `x-ratelimit-remaining`
 *    drops to `--min-remaining` (protects the live worker's quota),
 *  - has `--dry-run` to print the plan without spending any quota.
 *
 * For each loaded symbol-day it REPLACES any existing rows for that
 * (symbol, date) so the sparse accumulation approximation never mixes with
 * the real book. `received_at` = post-close of that day (leak-guard honest).
 *
 *   pnpm --filter @idx/backtest exec tsx src/backfillBrokerSummary.ts -- \
 *     --symbols=20 --days=40 --max-requests=500 [--dry-run]
 *   (or --symbols=BBCA,DPUM,NIKL for an explicit list)
 */

interface Args {
  databaseUrl: string;
  apiBase: string;
  apiKey: string;
  symbols: string; // count or comma list
  days: number;
  maxRequests: number;
  minRemaining: number;
  throttleMs: number;
  dryRun: boolean;
}

const FULL_BOOK_MIN_ROWS = 12;

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : undefined;
  };
  const dryRun = argv.includes("--dry-run");
  const databaseUrl = get("database-url") ?? process.env.DATABASE_URL ?? "";
  const apiKey = get("api-key") ?? process.env.ARJUM_API_KEY ?? "";
  if (!databaseUrl) throw new Error("DATABASE_URL (or --database-url=) is required");
  if (!apiKey && !dryRun) throw new Error("ARJUM_API_KEY (or --api-key=) is required");
  return {
    databaseUrl,
    apiKey,
    apiBase: (get("api-base") ?? process.env.ARJUM_API_BASE_URL ?? "https://stock.arjum.com").replace(/\/$/, ""),
    symbols: get("symbols") ?? "20",
    days: Number(get("days") ?? 40),
    maxRequests: Number(get("max-requests") ?? 500),
    minRemaining: Number(get("min-remaining") ?? 300),
    throttleMs: Number(get("throttle-ms") ?? 250),
    dryRun
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowsOf(res: any): any[] {
  return Array.isArray(res) ? res : (res?.rows ?? []);
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const { createDbClient, brokerSnapshot } = await import("@idx/db");
  const { sql, and, eq } = await import("drizzle-orm");
  const db = createDbClient(a.databaseUrl);

  // 1. trading dates = most recent N distinct dates we hold OHLCV for
  const dateRows = rowsOf(
    await db.execute(sql`select distinct trading_date d from daily_bar order by d desc limit ${a.days}`)
  );
  const dates: string[] = dateRows.map((r) => String(r.d)).sort();
  if (dates.length === 0) throw new Error("daily_bar is empty -- run the history backfill first");

  // 2. symbols: explicit list, or top-N by 20-day average turnover
  let symbols: string[];
  if (/^\d+$/.test(a.symbols)) {
    const recent = dates.slice(-20);
    const top = rowsOf(
      await db.execute(sql`
        select symbol from daily_bar
        where trading_date in (${sql.join(recent.map((d) => sql`${d}`), sql`, `)})
        group by symbol having count(*) >= 10
        order by avg(coalesce(turnover, close * volume)) desc
        limit ${Number(a.symbols)}`)
    );
    symbols = top.map((r) => String(r.symbol));
  } else {
    symbols = a.symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  }

  // 3. what's already a full book? (>= 12 rows for the symbol-day)
  const doneRows = rowsOf(
    await db.execute(sql`
      select symbol, trading_date d from broker_snapshot
      where trading_date >= ${dates[0]!} and trading_date <= ${dates[dates.length - 1]!}
      group by symbol, trading_date having count(*) >= ${FULL_BOOK_MIN_ROWS}`)
  );
  const done = new Set(doneRows.map((r) => `${r.symbol}|${r.d}`));

  const plan: { symbol: string; date: string }[] = [];
  for (const symbol of symbols) for (const date of dates) if (!done.has(`${symbol}|${date}`)) plan.push({ symbol, date });

  console.log(
    `Window ${dates[0]}..${dates[dates.length - 1]} (${dates.length} trading days), ${symbols.length} symbols: ` +
      `${plan.length} symbol-days pending of ${symbols.length * dates.length} ` +
      `(${done.size} already full-book). Cap this run: ${a.maxRequests} requests.`
  );
  if (a.dryRun) {
    console.log(`[dry-run] symbols: ${symbols.join(", ")}`);
    console.log(`[dry-run] estimated remaining requests after this run: ${Math.max(0, plan.length - a.maxRequests)}`);
    process.exit(0);
  }

  let requests = 0;
  let loaded = 0;
  let emptyDays = 0;
  let remaining: number | null = null;
  let stopReason = "plan complete";

  for (const { symbol, date } of plan) {
    if (requests >= a.maxRequests) {
      stopReason = `hit --max-requests=${a.maxRequests}`;
      break;
    }
    if (remaining !== null && remaining <= a.minRemaining) {
      stopReason = `x-ratelimit-remaining=${remaining} <= --min-remaining=${a.minRemaining}`;
      break;
    }
    const url = `${a.apiBase}/api/broker-summary/${encodeURIComponent(symbol)}?start_date=${date}&end_date=${date}`;
    const res = await fetch(url, { headers: { "X-API-Key": a.apiKey, Accept: "application/json" } });
    requests += 1;
    const rem = res.headers.get("x-ratelimit-remaining");
    if (rem !== null) remaining = Number(rem);
    if (res.status === 429) {
      stopReason = "HTTP 429 (rate limited)";
      break;
    }
    if (!res.ok) {
      process.stdout.write(`\n  ! ${symbol} ${date}: HTTP ${res.status}\n`);
      await sleep(a.throttleMs);
      continue;
    }
    const parsed = brokerSummaryResponseSchema.parse(await res.json());
    // The API clamps to its available range; only accept a genuine single-day book for `date`.
    if (parsed.broker_start_date !== date || parsed.broker_end_date !== date || parsed.brokers.length === 0) {
      emptyDays += 1;
      await sleep(a.throttleMs);
      continue;
    }

    const rows = parsed.brokers.map((b) => {
      const bvol = Number(b.bvol);
      const svol = Number(b.svol);
      const bval = Number(b.bval);
      const sval = Number(b.sval);
      return {
        id: randomUUID(),
        symbol,
        tradingDate: date,
        brokerCode: b.broker_code,
        segment: "regular",
        buyVolume: String(Math.round(bvol)),
        buyValue: String(bval),
        sellVolume: String(Math.round(svol)),
        sellValue: String(sval),
        netVolume: String(Math.round(b.nvol !== undefined ? Number(b.nvol) : bvol - svol)),
        netValue: String(b.nval !== undefined ? Number(b.nval) : bval - sval),
        avgBuyPrice: bvol > 0 ? String(bval / bvol) : null,
        avgSellPrice: svol > 0 ? String(sval / svol) : null,
        status: "final",
        receivedAt: new Date(`${date}T09:30:00.000Z`),
        rawPayloadId: null
      };
    });

    // replace any sparse accumulation-derived rows for this symbol-day with the real book
    await db.transaction(async (tx) => {
      await tx.delete(brokerSnapshot).where(and(eq(brokerSnapshot.symbol, symbol), eq(brokerSnapshot.tradingDate, date)));
      await tx.insert(brokerSnapshot).values(rows);
    });
    loaded += 1;
    process.stdout.write(`\r  ${loaded} symbol-days loaded | ${requests} requests | ratelimit-remaining=${remaining ?? "?"}   `);
    await sleep(a.throttleMs);
  }

  process.stdout.write("\n");
  console.log(
    `Stopped: ${stopReason}. Loaded ${loaded} symbol-days, ${emptyDays} empty/clamped, ${requests} requests, ` +
      `ratelimit-remaining=${remaining ?? "?"}. Re-run to continue (resumable).`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
