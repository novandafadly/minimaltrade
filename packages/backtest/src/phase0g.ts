#!/usr/bin/env node
/**
 * Phase 0G: where does the (random-pick) backtest P&L come from?
 *
 * Phases 0A/0C/0D found that RANDOM liquid picks, run through the risk engine's
 * fill/exit rules, show positive net expectancy -- and Phases 0E/0F found no
 * stock-selection edge (broker flow, RSI, Fibonacci, momentum). Two
 * explanations: (1) the exit/risk rules manufacture an edge; (2) the
 * simulation is optimistic. Checking (2) first turned up a look-ahead in the
 * entry convention, so this script measures it before ablating exits.
 *
 * ENTRY CONVENTION. `planFromHistory` sets entryTrigger = close of day D (only
 * knowable after the close). `replayEngine.ts` and the shadow evaluator then
 * fill that plan on the bar of day D itself, at min(open_D, close_D) -- a price
 * that cannot be obtained by anyone who decides after the close. Conventions:
 *   asIs      entry bar = D (what the code does today)
 *   honest    limit order at close_D resting through D+1 (entry bar = D+1;
 *             may not fill; exits walk from D+2)
 *   nextOpen  buy at the open of D+1 (always fills), exits per the plan levels
 *
 * EXIT VARIANTS (on the same trade set, honest entry): full engine (SL + TP1/TP2 +
 * breakeven after TP1) vs time-exit only (no SL/TP) vs stop-only vs TP-only, and
 * different stop rules (low5/low10/pct3/pct5/atr1.5/atr2). Everything is reported
 * as net return % per filled trade (net of Stockbit fees + slippage) so variants
 * with different position sizing are comparable. A random-pick, time-exit-only,
 * honest-entry row is the "no engine at all" benchmark.
 *
 *   pnpm --filter @idx/backtest exec tsx src/phase0g.ts -- --database-url=... [--hold=10] [--k=25] [--out=phase0g.json]
 */
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import type { HistoryData, OhlcvBar, TradePlan } from "@idx/domain";
import { planFromHistory, mulberry32, type StopMethod } from "./baselines.js";
import { simulateTradePlan, type TradeOutcome } from "./fillSimulation.js";

const cfg = DEFAULT_STRATEGY_CONFIG;
const LOT = cfg.risk.lotSizeShares;
const MIN_PRICE = 51;
const MIN_AVG_TURNOVER = 500_000_000;
const NEVER = 1e12;

function get(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : undefined;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function sd(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const r2 = (x: number) => (Number.isFinite(x) ? Number(x.toFixed(2)) : null);

interface Cand {
  symbol: string;
  i: number;
  bars: OhlcvBar[];
  date: string;
}
type Conv = "asIs" | "honest" | "nextOpen";
type ExitMode = "full" | "time" | "stop" | "tp";

function buildPlan(c: Cand, method: StopMethod): TradePlan | null {
  const history: HistoryData = {
    symbol: c.symbol,
    bars: c.bars.slice(Math.max(0, c.i - 119), c.i + 1),
    baselineMedianVolume20d: null
  };
  const plan = planFromHistory(c.symbol, c.date, history, cfg, `${c.date}T08:49:00.000Z`, method);
  return plan && !plan.isNoTrade ? plan : null;
}

function withExit(plan: TradePlan, mode: ExitMode): TradePlan {
  if (mode === "full") return plan;
  if (mode === "time") return { ...plan, slPrice: 0.0001, tp1Price: NEVER, tp2Price: NEVER };
  if (mode === "stop") return { ...plan, tp1Price: NEVER, tp2Price: NEVER };
  return { ...plan, slPrice: 0.0001 }; // tp
}

function simulate(c: Cand, plan0: TradePlan, conv: Conv, mode: ExitMode, hold: number): TradeOutcome | null {
  const b = c.bars;
  let plan = withExit(plan0, mode);
  let entryBar: OhlcvBar | undefined;
  let sim: OhlcvBar[];
  if (conv === "asIs") {
    entryBar = b[c.i];
    sim = b.slice(c.i + 1, c.i + 1 + hold);
  } else {
    entryBar = b[c.i + 1];
    sim = b.slice(c.i + 2, c.i + 2 + hold);
    if (conv === "nextOpen" && entryBar) {
      plan = { ...plan, entryTrigger: entryBar.open, maxBuyPrice: Math.max(plan.maxBuyPrice, entryBar.open) };
    }
  }
  if (!entryBar || sim.length < hold) return null;
  return simulateTradePlan(plan, entryBar, sim, cfg, { maxHoldingBars: hold });
}

function retPct(o: TradeOutcome): number | null {
  const f = o.fill;
  if (f.fillPrice === null || f.filledLots <= 0) return null;
  return (o.netPnl / (f.fillPrice * f.filledLots * LOT)) * 100;
}

interface Row {
  date: string;
  ret: number;
}
function summarize(name: string, planned: number, rows: Row[], dates: string[]) {
  const rets = rows.map((r) => r.ret);
  const wins = rets.filter((x) => x > 0);
  const losses = rets.filter((x) => x <= 0);
  const perDate = new Map<string, number[]>();
  for (const r of rows) perDate.set(r.date, [...(perDate.get(r.date) ?? []), r.ret]);
  const dm = [...perDate.values()].map(mean);
  const t = dm.length >= 3 ? mean(dm) / (sd(dm) / Math.sqrt(dm.length)) : NaN;
  const half = Math.floor(dates.length / 2);
  const first = new Set(dates.slice(0, half));
  const h1 = rows.filter((r) => first.has(r.date)).map((r) => r.ret);
  const h2 = rows.filter((r) => !first.has(r.date)).map((r) => r.ret);
  const gl = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    variant: name,
    plans: planned,
    filled: rows.length,
    fillRate: r2(rows.length / Math.max(1, planned)),
    meanNetRet_pct: r2(mean(rets)),
    medianNetRet_pct: r2(median(rets)),
    winRate: r2(wins.length / Math.max(1, rets.length)),
    profitFactor: gl > 0 ? r2(wins.reduce((a, b) => a + b, 0) / gl) : null,
    t_byDate: r2(t),
    firstHalf_pct: r2(mean(h1)),
    secondHalf_pct: r2(mean(h2))
  };
}

async function main() {
  const dbUrl = get("database-url") ?? process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required");
  const hold = Number(get("hold") ?? 10);
  const K = Number(get("k") ?? 25);
  const { createDbClient } = await import("@idx/db");
  const { sql } = await import("drizzle-orm");
  const db = createDbClient(dbUrl);
  const res = (await db.execute(
    sql`select symbol, trading_date, open, high, low, close, volume, coalesce(turnover, close * volume) as turnover
        from daily_bar order by symbol, trading_date`
  )) as unknown;
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? []);

  const bySymbol = new Map<string, OhlcvBar[]>();
  for (const r of rows) {
    const sym = String(r.symbol);
    const arr = bySymbol.get(sym) ?? [];
    arr.push({
      date: String(r.trading_date),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      turnover: Number(r.turnover)
    });
    bySymbol.set(sym, arr);
  }

  // eligible candidates per date (need hold+2 forward bars for every convention)
  const byDate = new Map<string, Cand[]>();
  const drift: number[] = [];
  const bias: number[] = [];
  for (const [symbol, bars] of bySymbol) {
    for (let i = 30; i <= bars.length - hold - 3; i++) {
      const b = bars[i]!;
      if (b.close < MIN_PRICE) continue;
      const avgTo = mean(bars.slice(i - 19, i + 1).map((x) => x.turnover));
      if (!(avgTo >= MIN_AVG_TURNOVER)) continue;
      byDate.set(b.date, [...(byDate.get(b.date) ?? []), { symbol, i, bars, date: b.date }]);
      drift.push((bars[i + hold]!.close / b.close - 1) * 100);
    }
  }
  const dates = [...byDate.keys()].sort();

  // seeded random sample of K candidates per date
  const rand = mulberry32(20260921);
  const sampled: Cand[] = [];
  for (const d of dates) {
    const cs = [...(byDate.get(d) ?? [])].sort((a, b) => a.symbol.localeCompare(b.symbol));
    const shuffled = cs.sort(() => rand() - 0.5);
    sampled.push(...shuffled.slice(0, K));
  }

  // common trade set: the base (low5) plan must exist and not be NO_TRADE
  const base: { c: Cand; plan: TradePlan }[] = [];
  for (const c of sampled) {
    const plan = buildPlan(c, "low5");
    if (plan) base.push({ c, plan });
  }
  for (const { c } of base) {
    const b = c.bars[c.i]!;
    bias.push((Math.max(0, b.close - b.open) / b.close) * 100);
  }

  const run = (label: string, conv: Conv, mode: ExitMode, method: StopMethod = "low5") => {
    const out: Row[] = [];
    let planned = 0;
    for (const { c, plan } of base) {
      const p = method === "low5" ? plan : buildPlan(c, method);
      if (!p) continue;
      planned += 1;
      const o = simulate(c, p, conv, mode, hold);
      if (!o) continue;
      const r = retPct(o);
      if (r !== null) out.push({ date: c.date, ret: r });
    }
    return summarize(label, planned, out, dates);
  };

  const convention = (["asIs", "honest", "nextOpen"] as Conv[]).map((cv) => run(`entry=${cv} | full engine`, cv, "full"));
  const exits = (["full", "time", "stop", "tp"] as ExitMode[]).map((m) => run(`honest | exit=${m}`, "honest", m));
  const exitsNextOpen = (["full", "time", "stop", "tp"] as ExitMode[]).map((m) => run(`nextOpen | exit=${m}`, "nextOpen", m));
  const stops = (["low5", "low10", "pct3", "pct5", "atr1_5", "atr2"] as StopMethod[]).map((m) => run(`honest | full | stop=${m}`, "honest", "full", m));

  const report = {
    generatedAt: new Date().toISOString(),
    configVersion: cfg.version,
    holdBars: hold,
    picksPerDate: K,
    dates: { n: dates.length, from: dates[0], to: dates[dates.length - 1] },
    tradeSet: { sampled: sampled.length, withBasePlan: base.length },
    benchmarks: {
      marketDrift_closeToClose_hold_pct: r2(mean(drift)),
      marketDrift_afterRoundTripCost_pct: r2(mean(drift) - 0.4),
      asIsEntryBias_meanMaxZero_close_minus_open_pct: r2(mean(bias))
    },
    convention,
    exits,
    exitsNextOpen,
    stops
  };
  const json = JSON.stringify(report, null, 2);
  const out = get("out");
  if (out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(out, json, "utf8");
    process.stderr.write(`written to ${out}\n`);
  }
  console.log("done");
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
