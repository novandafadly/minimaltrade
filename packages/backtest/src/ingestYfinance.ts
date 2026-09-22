#!/usr/bin/env node
/**
 * Load a JSON dump from Yahoo Finance (via scratchpad/pull_yfinance.py, an unofficial
 * public endpoint -- no credentials) into `raw_payload_archive`, alongside the ARJUM
 * archive, under endpoint `/ext/yfinance`. Purely descriptive fields (sector, industry,
 * trailing/forward PE, revenue/earnings growth, ROE, dividend yield, beta, analyst
 * target/recommendation) used by the fundamentals screener -- NOT re-verified for
 * predictive value (Phase 0I found no fundamental factor predicts IDX returns in the
 * ARJUM dataset; this data is for descriptive categorization only, see
 * apps/web/app/api/fundamentals/route.ts).
 *
 *   pnpm --filter @idx/backtest exec tsx src/ingestYfinance.ts -- --database-url=... --file=yfinance_universe.json
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

function get(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : undefined;
}

interface YFRow {
  symbol: string;
  ticker: string;
  error?: string;
  [k: string]: unknown;
}

async function main() {
  const dbUrl = get("database-url") ?? process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required");
  const file = get("file") ?? "yfinance_universe.json";
  const rows: YFRow[] = JSON.parse(await readFile(file, "utf8"));
  const { createDbClient, rawPayloadArchive } = await import("@idx/db");
  const db = createDbClient(dbUrl);

  let stored = 0;
  let skipped = 0;
  const now = new Date();
  for (const row of rows) {
    if (row.error) {
      skipped += 1;
      continue;
    }
    await db.insert(rawPayloadArchive).values({
      id: randomUUID(),
      endpoint: "/ext/yfinance",
      symbol: row.symbol,
      requestedAt: now,
      receivedAt: now,
      httpStatus: 200,
      payload: row,
      schemaValid: true,
      schemaErrors: null
    });
    stored += 1;
  }
  console.log(`Ingested ${stored} symbols from ${file} into /ext/yfinance (${skipped} had fetch errors, skipped).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
