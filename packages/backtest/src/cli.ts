#!/usr/bin/env node
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import { FixtureDataSource } from "./dataSource/fixture.js";
import { withLeakGuard } from "./dataSource/leakGuard.js";
import { PostgresDataSource } from "./dataSource/postgres.js";
import type { ReplayDataSource } from "./dataSource/types.js";
import { buildSyntheticFixture } from "./fixtures/syntheticFixture.js";
import { runReplayBatch, type ReplayBatchResult } from "./replayEngine.js";

/**
 * Replay/backtest CLI (blueprint Phase 6). Run with:
 *   pnpm --filter @idx/backtest run replay -- --source=fixture
 *   pnpm --filter @idx/backtest run replay -- --source=postgres --database-url=postgres://... [--out=report.json]
 *
 * Prints a JSON metrics report to stdout (or writes it to --out) covering
 * the signal-driven strategy and both blueprint-named baselines (random
 * liquid universe, volume-only ranking).
 */

interface CliArgs {
  source: "fixture" | "postgres";
  databaseUrl: string | null;
  out: string | null;
  fromDate: string | null;
  toDate: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { source: "fixture", databaseUrl: null, out: null, fromDate: null, toDate: null };
  for (const raw of argv) {
    const [key, ...rest] = raw.replace(/^--/, "").split("=");
    const value = rest.join("=");
    switch (key) {
      case "source":
        if (value === "fixture" || value === "postgres") args.source = value;
        else throw new Error(`--source must be "fixture" or "postgres", got "${value}"`);
        break;
      case "database-url":
        args.databaseUrl = value;
        break;
      case "out":
        args.out = value;
        break;
      case "from":
        args.fromDate = value;
        break;
      case "to":
        args.toDate = value;
        break;
      default:
        // ignore unknown flags rather than hard-failing a CLI invocation
        break;
    }
  }
  return args;
}

async function resolveDataSource(args: CliArgs): Promise<ReplayDataSource> {
  if (args.source === "fixture") {
    return withLeakGuard(new FixtureDataSource(buildSyntheticFixture()));
  }
  const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("--source=postgres requires --database-url=... or a DATABASE_URL environment variable");
  }
  // Lazy import: @idx/db's postgres client pulls in the `postgres` driver,
  // which we don't want to load (or require installed) for fixture-only runs.
  const { createDbClient } = await import("@idx/db");
  const db = createDbClient(databaseUrl);
  return withLeakGuard(new PostgresDataSource(db));
}

function summarize(result: ReplayBatchResult) {
  return {
    tradingDateRange:
      result.tradingDates.length > 0
        ? { from: result.tradingDates[0], to: result.tradingDates[result.tradingDates.length - 1] }
        : null,
    tradingDateCount: result.tradingDates.length,
    strategies: Object.fromEntries(
      Object.entries(result.strategies).map(([name, r]) => [
        name,
        { overall: r.overall, byCategory: r.byCategory, tradeCount: r.outcomes.length }
      ])
    )
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataSource = await resolveDataSource(args);

  const result = await runReplayBatch({
    dataSource,
    config: DEFAULT_STRATEGY_CONFIG,
    ...(args.fromDate ? { fromDate: args.fromDate } : {}),
    ...(args.toDate ? { toDate: args.toDate } : {})
  });

  const report = {
    generatedAt: new Date().toISOString(),
    source: args.source,
    formulaVersion: DEFAULT_STRATEGY_CONFIG.formulaVersion,
    configVersion: DEFAULT_STRATEGY_CONFIG.version,
    ...summarize(result)
  };

  const json = JSON.stringify(report, null, 2);

  if (args.out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(args.out, json, "utf8");
    console.log(`Replay report written to ${args.out}`);
  } else {
    console.log(json);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
