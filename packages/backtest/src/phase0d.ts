#!/usr/bin/env node
/**
 * Phase 0D: does a rules-based *technical* screener beat the dumb baselines?
 *
 * Shadow mode (forward-test) can only answer the ARJUM-shortlist + broker-flow
 * questions — `/api/screener/latest` has no history and the historical broker
 * feed is too sparse (Phase 0b). But the technical screen added in
 * `apps/worker/src/shadow/screeners.ts` needs ONLY OHLCV, so it CAN be
 * replayed over the backfilled `daily_bar` window right now.
 *
 * This runs three candidate-selection strategies over the same 120-ish-day
 * Postgres window, each building plans through the SAME risk engine
 * (`planFromHistory`, 5-day-low stop) so the comparison isolates selection:
 *
 *   technical — close > SMA20 > SMA50, within 3% of the 20-bar high, positive
 *               20-bar return, over the 60 most liquid names by turnover
 *   volume    — top-5 by 20-day average volume
 *   random    — 5 seeded-random picks of the liquid pool
 *
 * The technical rules MIRROR `apps/worker/src/shadow/{screeners,constants}.ts`
 * — keep them in sync if you tune one.
 *
 *   pnpm --filter @idx/backtest exec tsx src/phase0d.ts -- --database-url=... [--out=phase0d.json]
 *
 * NOT a stock picker: it validates the screener over ONE past window / regime.
 * A positive result is the justification to actually watch `screener_technical`
 * daily picks — it does not hand you today's watchlist.
 */
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import type { HistoryData, OhlcvBar } from "@idx/domain";
import { PostgresDataSource } from "./dataSource/postgres.js";
import { liquidCandidates, planFromHistory, mulberry32 } from "./baselines.js";
import { simulateTradePlan } from "./fillSimulation.js";
import { computeMetrics } from "./metrics.js";

// --- mirrors apps/worker/src/shadow/constants.ts ---
const SHORTLIST = 5;
const MIN_BARS = 30;
const MIN_PRICE = 51;
const MIN_AVG_TURNOVER_IDR = 2_000_000_000;
const BREAKOUT_PROXIMITY = 0.03;
const TECH_UNIVERSE_SIZE = 60;
const MAX_HOLD = 20;

function sma(bars: OhlcvBar[], period: number): number | null {
  if (bars.length < period) return null;
  let s = 0;
  for (let i = bars.length - period; i < bars.length; i++) s += bars[i]!.close;
  return s / period;
}
function avgTurnover(bars: OhlcvBar[], period: number): number {
  const slice = bars.slice(-period);
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + (b.turnover ?? b.close * b.volume), 0) / slice.length;
}
function ret(bars: OhlcvBar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const now = bars[bars.length - 1]!.close;
  const then = bars[bars.length - 1 - period]!.close;
  return then > 0 ? now / then - 1 : null;
}

/** mirror of screeners.ts technicalShortlist */
function technicalPicks(histBySymbol: Map<string, HistoryData>, universe: string[]): string[] {
  const scored: { symbol: string; score: number }[] = [];
  for (const symbol of universe) {
    const h = histBySymbol.get(symbol);
    if (!h || h.bars.length < MIN_BARS) continue;
    const bars = h.bars;
    const last = bars[bars.length - 1]!;
    if (last.close < MIN_PRICE) continue;
    if (avgTurnover(bars, 20) < MIN_AVG_TURNOVER_IDR) continue;
    const sma20 = sma(bars, 20);
    const sma50 = sma(bars, 50) ?? sma(bars, Math.min(50, bars.length - 1));
    if (sma20 === null || sma50 === null || !(last.close > sma20 && sma20 > sma50)) continue;
    const high20 = Math.max(...bars.slice(-20).map((b) => b.high));
    if (last.close < high20 * (1 - BREAKOUT_PROXIMITY)) continue;
    const r20 = ret(bars, 20);
    if (r20 === null || r20 <= 0) continue;
    const avgVol20 = bars.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;
    const volPace = avgVol20 > 0 ? last.volume / avgVol20 : 1;
    scored.push({ symbol, score: r20 * Math.max(volPace, 0.1) });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, SHORTLIST)
    .map((s) => s.symbol);
}

function get(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : undefined;
}

async function main() {
  const dbUrl = get("database-url") ?? process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required");
  const cfg = DEFAULT_STRATEGY_CONFIG;
  const { createDbClient } = await import("@idx/db");
  const src = new PostgresDataSource(createDbClient(dbUrl));

  const dates = await src.listTradingDates();
  process.stderr.write(`Loading ${dates.length} dates...\n`);

  const outcomesByStrategy: Record<"technical" | "volume" | "random", ReturnType<typeof simulateTradePlan>[]> = {
    technical: [],
    volume: [],
    random: []
  };
  const noTradeByStrategy = { technical: 0, volume: 0, random: 0 };

  for (const date of dates) {
    const asOf = `${date}T23:59:59.999Z`;
    const universe = liquidCandidates(await src.listUniverseAsOf(asOf));
    if (universe.length === 0) continue;

    const byTurnover = [...universe].sort((a, b) => b.avgTurnover20d - a.avgTurnover20d);
    const byVolume = [...universe].sort((a, b) => b.avgVolume20d - a.avgVolume20d);
    const techUniverse = byTurnover.slice(0, TECH_UNIVERSE_SIZE).map((u) => u.symbol);
    const baselinePool = byVolume.slice(0, 40).map((u) => u.symbol);

    const fetchList = [...new Set([...techUniverse, ...baselinePool])];
    const hist = new Map<string, HistoryData>();
    for (const sym of fetchList) {
      const h = await src.getHistoryAsOf(sym, asOf);
      if (h && h.data.bars.length >= MIN_BARS) hist.set(sym, h.data);
    }

    const eligibleBaseline = baselinePool.filter((s) => hist.has(s));
    const rand = mulberry32(1234 + date.length + date.charCodeAt(5) + date.charCodeAt(8));
    const picks: Record<"technical" | "volume" | "random", string[]> = {
      technical: technicalPicks(hist, techUniverse),
      volume: eligibleBaseline.slice(0, SHORTLIST),
      random: [...eligibleBaseline].sort(() => rand() - 0.5).slice(0, SHORTLIST)
    };

    const simCache = new Map<string, { barOn: OhlcvBar | null; simBars: OhlcvBar[] }>();
    const simFor = async (sym: string) => {
      let c = simCache.get(sym);
      if (!c) {
        c = { barOn: await src.getBarOn(sym, date), simBars: await src.getSimulationBars(sym, date, MAX_HOLD) };
        simCache.set(sym, c);
      }
      return c;
    };

    for (const strat of ["technical", "volume", "random"] as const) {
      for (const sym of picks[strat]) {
        const h = hist.get(sym);
        if (!h) continue;
        const plan = planFromHistory(sym, date, h, cfg, `${date}T08:49:00.000Z`, "low5");
        if (!plan) continue;
        if (plan.isNoTrade) {
          noTradeByStrategy[strat] += 1;
          continue;
        }
        const { barOn, simBars } = await simFor(sym);
        outcomesByStrategy[strat].push(
          simulateTradePlan(plan, barOn, simBars, cfg, { maxHoldingBars: MAX_HOLD })
        );
      }
    }
  }

  const results = (["technical", "volume", "random"] as const).map((strat) => {
    const m = computeMetrics(outcomesByStrategy[strat]);
    return {
      strategy: strat,
      trades: m.tradeCount,
      noTradePlans: noTradeByStrategy[strat],
      fillRate: Number(m.fillRate.toFixed(2)),
      winRate: Number(m.winRate.toFixed(2)),
      netExpectancy: Math.round(m.netExpectancy),
      profitFactor: m.profitFactor === Infinity ? "Infinity" : Number(m.profitFactor.toFixed(2)),
      maxDrawdown: Math.round(m.maxDrawdown),
      avgNetRR: Number(m.avgNetRR.toFixed(2))
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    window: { from: dates[0], to: dates[dates.length - 1], days: dates.length },
    configVersion: cfg.version,
    shortlistPerDay: SHORTLIST,
    stopMethod: "low5",
    note: "technical rules mirror apps/worker/src/shadow/screeners.ts; ONE window / regime; universe = names that entered the funnel (mild survivorship bias)",
    results
  };
  const json = JSON.stringify(report, null, 2);
  const out = get("out");
  if (out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(out, json, "utf8");
    process.stderr.write(`written to ${out}\n`);
  }
  console.log(json);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
