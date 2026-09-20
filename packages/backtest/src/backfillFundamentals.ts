#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Backfill fundamentals + weekly prices for factor research (Phase 0I).
 *
 * Literature on Indonesia ("Risk factors in the Indonesian stock market", 2023)
 * finds size, value (operating cash flow / price) and profitability are the
 * robust cross-sectional factors -- fundamentals, not technical signals.
 * `/api/financial-statements/{code}` (previously 403 for this key) now returns
 * 12 quarters of DISCRETE (not year-to-date) statements, and
 * `/api/history/{code}?frame=weekly` returns 120 weekly bars (back to 2024-06),
 * which spans several regimes unlike the 120 daily bars.
 *
 * Stored RAW in `raw_payload_archive` (jsonb) -- no schema change. Endpoint keys:
 *   /api/financial-statements/{code}?report_type=INCOME_STATEMENT&period=quarterly
 *   /api/financial-statements/{code}?report_type=BALANCE_SHEET&period=quarterly
 *   /api/financial-statements/{code}?report_type=CASH_FLOW_REPORT&period=quarterly
 *   /api/history/{code}?frame=weekly
 *
 * Budget-aware exactly like backfillBrokerSummary.ts: `--max-requests`,
 * `--min-remaining` (stop when x-ratelimit-remaining <= it), `--dry-run`,
 * resumable (an (endpoint, symbol) archived OK within `--fresh-days` is skipped).
 *
 *   pnpm --filter @idx/backtest exec tsx src/backfillFundamentals.ts -- \
 *     [--symbols=all|N|A,B,C] [--kinds=income,balance,cashflow,weekly] \
 *     [--max-requests=900] [--min-remaining=500] [--dry-run]
 */

const KINDS: Record<string, (code: string) => { endpoint: string; url: string }> = {
  income: (c) => ({
    endpoint: `/api/financial-statements/{code}?report_type=INCOME_STATEMENT&period=quarterly`,
    url: `/api/financial-statements/${encodeURIComponent(c)}?report_type=INCOME_STATEMENT&period=quarterly`
  }),
  balance: (c) => ({
    endpoint: `/api/financial-statements/{code}?report_type=BALANCE_SHEET&period=quarterly`,
    url: `/api/financial-statements/${encodeURIComponent(c)}?report_type=BALANCE_SHEET&period=quarterly`
  }),
  cashflow: (c) => ({
    endpoint: `/api/financial-statements/{code}?report_type=CASH_FLOW_REPORT&period=quarterly`,
    url: `/api/financial-statements/${encodeURIComponent(c)}?report_type=CASH_FLOW_REPORT&period=quarterly`
  }),
  weekly: (c) => ({
    endpoint: `/api/history/{code}?frame=weekly`,
    url: `/api/history/${encodeURIComponent(c)}?frame=weekly`
  })
};

interface Args {
  databaseUrl: string;
  apiBase: string;
  apiKey: string;
  symbols: string;
  kinds: string[];
  maxRequests: number;
  minRemaining: number;
  throttleMs: number;
  freshDays: number;
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
  const kinds = (get("kinds") ?? "income,balance,cashflow,weekly").split(",").map((s) => s.trim());
  for (const k of kinds) if (!KINDS[k]) throw new Error(`unknown kind "${k}" (income|balance|cashflow|weekly)`);
  return {
    databaseUrl,
    apiKey,
    apiBase: (get("api-base") ?? process.env.ARJUM_API_BASE_URL ?? "https://stock.arjum.com").replace(/\/$/, ""),
    symbols: get("symbols") ?? "all",
    kinds,
    maxRequests: Number(get("max-requests") ?? 900),
    minRemaining: Number(get("min-remaining") ?? 500),
    throttleMs: Number(get("throttle-ms") ?? 250),
    freshDays: Number(get("fresh-days") ?? 30),
    dryRun
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowsOf(res: any): any[] {
  return Array.isArray(res) ? res : (res?.rows ?? []);
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const { createDbClient, rawPayloadArchive } = await import("@idx/db");
  const { sql } = await import("drizzle-orm");
  const db = createDbClient(a.databaseUrl);

  // universe: liquid names by recent average turnover (same eligibility as the other studies)
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

  // what is already archived (fresh)?
  const done = new Set<string>();
  const endpoints = a.kinds.map((k) => KINDS[k]!("X").endpoint);
  const doneRows = rowsOf(
    await db.execute(sql`
      select endpoint, symbol from raw_payload_archive
      where http_status = 200 and received_at > now() - make_interval(days => ${Number(a.freshDays)}::int)
        and endpoint in (${sql.join(endpoints.map((e) => sql`${e}`), sql`, `)})`)
  );
  for (const r of doneRows) done.add(`${r.endpoint}|${r.symbol}`);

  // symbol-major so every finished symbol is complete across kinds
  const plan: { symbol: string; kind: string }[] = [];
  for (const symbol of symbols)
    for (const kind of a.kinds) if (!done.has(`${KINDS[kind]!(symbol).endpoint}|${symbol}`)) plan.push({ symbol, kind });

  console.log(
    `${symbols.length} symbols x kinds [${a.kinds.join(",")}]: ${plan.length} requests pending ` +
      `(${done.size} already archived). Cap this run: ${a.maxRequests}.`
  );
  if (a.dryRun) {
    console.log(`[dry-run] first symbols: ${symbols.slice(0, 12).join(", ")} ...`);
    console.log(`[dry-run] requests left after this run: ${Math.max(0, plan.length - a.maxRequests)}`);
    process.exit(0);
  }

  let requests = 0;
  let stored = 0;
  let failed = 0;
  let remaining: number | null = null;
  let stopReason = "plan complete";
  for (const { symbol, kind } of plan) {
    if (requests >= a.maxRequests) {
      stopReason = `hit --max-requests=${a.maxRequests}`;
      break;
    }
    if (remaining !== null && remaining <= a.minRemaining) {
      stopReason = `x-ratelimit-remaining=${remaining} <= --min-remaining=${a.minRemaining}`;
      break;
    }
    const { endpoint, url } = KINDS[kind]!(symbol);
    const requestedAt = new Date();
    const res = await fetch(`${a.apiBase}${url}`, { headers: { "X-API-Key": a.apiKey, Accept: "application/json" } });
    requests += 1;
    const rem = res.headers.get("x-ratelimit-remaining");
    if (rem !== null) remaining = Number(rem);
    if (res.status === 429) {
      stopReason = "HTTP 429 (rate limited)";
      break;
    }
    if (!res.ok) {
      failed += 1;
      process.stdout.write(`\n  ! ${symbol} ${kind}: HTTP ${res.status}\n`);
      await sleep(a.throttleMs);
      continue;
    }
    const payload = await res.json();
    await db.insert(rawPayloadArchive).values({
      id: randomUUID(),
      endpoint,
      symbol,
      requestedAt,
      receivedAt: new Date(),
      httpStatus: 200,
      payload,
      schemaValid: true,
      schemaErrors: null
    });
    stored += 1;
    process.stdout.write(`\r  ${stored} stored | ${requests} requests | ratelimit-remaining=${remaining ?? "?"}   `);
    await sleep(a.throttleMs);
  }
  process.stdout.write("\n");
  console.log(
    `Stopped: ${stopReason}. Stored ${stored}, failed ${failed}, ${requests} requests, ` +
      `ratelimit-remaining=${remaining ?? "?"}. Re-run to continue (resumable).`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
