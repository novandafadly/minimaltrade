#!/usr/bin/env node
/**
 * Phase 0c: parameter sweep on the risk-engine gating.
 *
 * Phase 0b found NET_RR_MIN fails for 74–86% of candidates — the 2:1 net-RR
 * gate after Stockbit fees + slippage + min-stop-ticks, plus a tight
 * preliminary stop. This sweeps `minNetRewardToRisk` × preliminary-stop
 * method over the backfilled 120-day window, using the deterministic
 * volume-ranked baseline (and a fixed-seed random baseline), and prints how
 * each combo changes trade count / fill rate / win rate / net expectancy /
 * profit factor / max drawdown.
 *
 * It is NOT trying to find "the best" params — it's checking whether the
 * current defaults are needlessly throwing away tradeable setups.
 *
 *   pnpm --filter @idx/backtest exec tsx src/paramSweep.ts -- --database-url=... [--top=40] [--out=sweep.json]
 */
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig } from "@idx/config";
import type { HistoryData, OhlcvBar } from "@idx/domain";
import { PostgresDataSource } from "./dataSource/postgres.js";
import { liquidCandidates, planFromHistory, mulberry32, type StopMethod } from "./baselines.js";
import { simulateTradePlan } from "./fillSimulation.js";
import { computeMetrics } from "./metrics.js";

const RR_GATES = [1.5, 1.75, 2.0, 2.5];
const STOPS: StopMethod[] = ["pct3", "pct5", "low5", "low10", "atr1_5", "atr2"];

function withRr(base: StrategyConfig, rr: number): StrategyConfig {
  return { ...base, risk: { ...base.risk, minNetRewardToRisk: rr } };
}

function get(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : undefined;
}

async function main() {
  const dbUrl = get("database-url") ?? process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required");
  const topK = Number(get("top") ?? 40); // widen the candidate pool vs the 3/day baseline
  const maxHold = 20;
  const { createDbClient } = await import("@idx/db");
  const src = new PostgresDataSource(createDbClient(dbUrl));

  const dates = await src.listTradingDates();
  process.stderr.write(`Loading ${dates.length} dates...\n`);

  // --- load once: per-date candidate lists + history + forward bars ---
  interface DayData {
    date: string;
    sessionEndIso: string;
    // candidate symbols (volume-ranked topK, + random topK) with their history
    candidates: { symbol: string; history: HistoryData; volRank: number }[];
    barOn: Map<string, OhlcvBar | null>;
    simBars: Map<string, OhlcvBar[]>;
  }
  const days: DayData[] = [];

  for (const date of dates) {
    const asOf = `${date}T23:59:59.999Z`;
    const universe = liquidCandidates(await src.listUniverseAsOf(asOf)).sort((a, b) => b.avgVolume20d - a.avgVolume20d);
    const pool = universe.slice(0, topK * 2); // volume topK + headroom for random
    const candidates: DayData["candidates"] = [];
    for (let i = 0; i < pool.length; i++) {
      const u = pool[i]!;
      const h = await src.getHistoryAsOf(u.symbol, asOf);
      if (!h || h.data.bars.length < 15) continue;
      candidates.push({ symbol: u.symbol, history: h.data, volRank: i });
    }
    const barOn = new Map<string, OhlcvBar | null>();
    const simBars = new Map<string, OhlcvBar[]>();
    for (const c of candidates) {
      barOn.set(c.symbol, await src.getBarOn(c.symbol, date));
      simBars.set(c.symbol, await src.getSimulationBars(c.symbol, date, maxHold));
    }
    days.push({ date, sessionEndIso: `${date}T08:49:00.000Z`, candidates, barOn, simBars });
    if (days.length % 20 === 0) process.stderr.write(`  ${days.length}/${dates.length}\n`);
  }

  // --- sweep ---
  const results: Record<string, unknown>[] = [];
  for (const rr of RR_GATES) {
    for (const stop of STOPS) {
      const cfg = withRr(DEFAULT_STRATEGY_CONFIG, rr);
      for (const mode of ["volume", "random"] as const) {
        const outcomes = [];
        for (const day of days) {
          let picks: typeof day.candidates;
          if (mode === "volume") {
            picks = [...day.candidates].sort((a, b) => a.volRank - b.volRank).slice(0, 3);
          } else {
            const rand = mulberry32(1234 + day.date.length + day.date.charCodeAt(5));
            picks = [...day.candidates].sort(() => rand() - 0.5).slice(0, 3);
          }
          for (const p of picks) {
            const plan = planFromHistory(p.symbol, day.date, p.history, cfg, day.sessionEndIso, stop);
            if (!plan || plan.isNoTrade) continue;
            outcomes.push(
              simulateTradePlan(plan, day.barOn.get(p.symbol) ?? null, day.simBars.get(p.symbol) ?? [], cfg, {
                maxHoldingBars: maxHold
              })
            );
          }
        }
        const m = computeMetrics(outcomes);
        results.push({
          rrGate: rr,
          stop,
          baseline: mode,
          trades: m.tradeCount,
          fillRate: Number(m.fillRate.toFixed(2)),
          winRate: Number(m.winRate.toFixed(2)),
          netExpectancy: Math.round(m.netExpectancy),
          profitFactor: Number(m.profitFactor.toFixed(2)),
          maxDrawdown: Math.round(m.maxDrawdown),
          avgNetRR: Number(m.avgNetRR.toFixed(2))
        });
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    window: { from: dates[0], to: dates[dates.length - 1], days: dates.length },
    candidatePoolPerDay: 3,
    note: "baselines only (Phase 0b: the signal path can't be backtested — sparse historical broker data)",
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
