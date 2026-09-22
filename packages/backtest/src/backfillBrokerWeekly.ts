#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Backfill WEEKLY broker books from `/api/broker-summary/{code}?start_date=&end_date=`.
 *
 * One request returns the aggregated top-20 broker book for a whole Mon-Fri range, so a
 * symbol-week costs 1 request -- and broker data goes back to 2020, unlike the 120 daily
 * price bars. That makes a MULTI-REGIME test of broker/foreign flow possible
 * (2024-06 -> now, ~120 weeks) where the daily backfill (Mar-Sep 2026) sees only one.
 *
 * Stored trimmed (brokers + dates; `broker_levels` dropped) in `raw_payload_archive`
 * under endpoint `/api/broker-summary/{code}?week=YYYY-MM-DD` (the Friday). No schema change.
 * Symbol-major (a finished symbol has its full history), resumable, quota-guarded like
 * the other backfills (`--max-requests`, `--min-remaining`, `--dry-run`).
 *
 *   pnpm --filter @idx/backtest exec tsx src/backfillBrokerWeekly.ts -- \
 *     [--symbols=all|N|A,B] [--from=2024-06-14] [--max-requests=5000] [--min-remaining=700] [--dry-run]
 */

interface Args {
  databaseUrl: string;
  apiBase: string;
  apiKey: string;
  symbols: string;
  from: string;
  maxRequests: number;
  minRemaining: number;
  throttleMs: number;
  dryRun: boolean;
}

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
    symbols: get("symbols") ?? "all",
    from: get("from") ?? "2024-06-14",
    maxRequests: Number(get("max-requests") ?? 5000),
    minRemaining: Number(get("min-remaining") ?? 700),
    throttleMs: Number(get("throttle-ms") ?? 250),
    dryRun
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowsOf(res: any): any[] {
  return Array.isArray(res) ? res : (res?.rows ?? []);
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Fridays from `from` (snapped forward to a Friday) up to the latest completed Friday. */
function fridays(from: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  while (d < today) {
    out.push(iso(d));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const { createDbClient, rawPayloadArchive } = await import("@idx/db");
  const { sql } = await import("drizzle-orm");
  const db = createDbClient(a.databaseUrl);

  let symbols: string[];
  if (a.symbols === "all" || /^\d+$/.test(a.symbols)) {
    const r = rowsOf(
      await db.execute(sql`
        select symbol from daily_bar
        where trading_date >= (select max(trading_date)::date - 30 from daily_bar)::text
        group by symbol
        having avg(coalesce(turnover, close * volume)) >= 500000000 and max(close) >= 51
        order by avg(coalesce(turnover, close * volume)) desc`)
    );
    symbols = r.map((x) => String(x.symbol));
    if (/^\d+$/.test(a.symbols)) symbols = symbols.slice(0, Number(a.symbols));
  } else {
    symbols = a.symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  }

  const weeks = fridays(a.from);
  const doneRows = rowsOf(
    await db.execute(sql`
      select endpoint, symbol from raw_payload_archive
      where http_status = 200 and endpoint like '/api/broker-summary/{code}?week=%'`)
  );
  const done = new Set(doneRows.map((r) => `${r.endpoint}|${r.symbol}`));
  const endpointFor = (fri: string) => `/api/broker-summary/{code}?week=${fri}`;

  const plan: { symbol: string; fri: string }[] = [];
  for (const symbol of symbols) for (const fri of weeks) if (!done.has(`${endpointFor(fri)}|${symbol}`)) plan.push({ symbol, fri });

  console.log(
    `${symbols.length} symbols x ${weeks.length} weeks (${weeks[0]}..${weeks[weeks.length - 1]}): ` +
      `${plan.length} symbol-weeks pending (${done.size} archived). Cap this run: ${a.maxRequests}.`
  );
  if (a.dryRun) {
    console.log(`[dry-run] first symbols: ${symbols.slice(0, 10).join(", ")} ...`);
    console.log(`[dry-run] requests left after this run: ${Math.max(0, plan.length - a.maxRequests)}`);
    process.exit(0);
  }

  let requests = 0;
  let stored = 0;
  let empty = 0;
  let remaining: number | null = null;
  let stopReason = "plan complete";
  for (const { symbol, fri } of plan) {
    if (requests >= a.maxRequests) {
      stopReason = `hit --max-requests=${a.maxRequests}`;
      break;
    }
    if (remaining !== null && remaining <= a.minRemaining) {
      stopReason = `x-ratelimit-remaining=${remaining} <= --min-remaining=${a.minRemaining}`;
      break;
    }
    const start = iso(new Date(new Date(`${fri}T00:00:00Z`).getTime() - 4 * 86400000)); // Monday
    const requestedAt = new Date();
    const res = await fetch(
      `${a.apiBase}/api/broker-summary/${encodeURIComponent(symbol)}?start_date=${start}&end_date=${fri}`,
      { headers: { "X-API-Key": a.apiKey, Accept: "application/json" } }
    );
    requests += 1;
    const rem = res.headers.get("x-ratelimit-remaining");
    if (rem !== null) remaining = Number(rem);
    if (res.status === 429) {
      stopReason = "HTTP 429 (rate limited)";
      break;
    }
    if (!res.ok) {
      process.stdout.write(`\n  ! ${symbol} ${fri}: HTTP ${res.status}\n`);
      await sleep(a.throttleMs);
      continue;
    }
    const j = (await res.json()) as {
      stock_code?: string;
      broker_start_date?: string;
      broker_end_date?: string;
      brokers?: unknown[];
    };
    if (!j.brokers || j.brokers.length === 0 || !j.broker_end_date || j.broker_end_date < start || j.broker_end_date > fri) {
      empty += 1; // holiday week / no trading / clamped outside the range
      await sleep(a.throttleMs);
      continue;
    }
    await db.insert(rawPayloadArchive).values({
      id: randomUUID(),
      endpoint: endpointFor(fri),
      symbol,
      requestedAt,
      receivedAt: new Date(),
      httpStatus: 200,
      payload: { stock_code: j.stock_code, broker_start_date: j.broker_start_date, broker_end_date: j.broker_end_date, brokers: j.brokers },
      schemaValid: true,
      schemaErrors: null
    });
    stored += 1;
    process.stdout.write(`\r  ${stored} stored | ${requests} requests | ratelimit-remaining=${remaining ?? "?"}   `);
    await sleep(a.throttleMs);
  }
  process.stdout.write("\n");
  console.log(
    `Stopped: ${stopReason}. Stored ${stored}, empty ${empty}, ${requests} requests, ` +
      `ratelimit-remaining=${remaining ?? "?"}. Re-run to continue (resumable).`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
