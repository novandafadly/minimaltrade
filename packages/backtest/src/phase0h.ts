#!/usr/bin/env node
/**
 * Phase 0H: is there ANY simple long-only rule that is profitable after costs,
 * and does it survive an honest out-of-sample check?
 *
 * It is easy to find a "profitable" rule by trying many on one window: the best
 * of N looks good by chance. So this is built to resist that:
 *
 *  - Honest entry: signal computed at the close of D; BUY AT THE OPEN OF D+1
 *    (always fills, no limit-order selection). Exit bars start on the entry bar.
 *  - Explicit costs (default 0.6% round trip = 0.4% Stockbit fees + 0.2% slippage).
 *  - A pre-registered grid: 13 entry signals x 9 exit rules = 117 configs.
 *  - Success is judged on EXCESS return: each signal event's net return minus the
 *    mean of ALL eligible events on the same date under the same exit rule. In a
 *    rising market (and with a universe chosen with hindsight -- see below) every
 *    long-only rule looks profitable in absolute terms; only the excess says
 *    whether the SIGNAL picks better than picking anything that day. A config
 *    must show excess > 0 and by-date t >= 2 in BOTH halves independently (n >= 100
 *    events per half).
 *  - UNIVERSE CAVEAT: daily_bar holds the names ARJUM/market-cap rankings surfaced
 *    around Sep 2026 (liquid NOW). Choosing the universe with knowledge of the end
 *    date biases every long-only return upward (names that rallied into September
 *    are over-represented). The excess-vs-all-events test cancels this common bias;
 *    absolute returns should not be trusted.
 *  - A placebo calibration: the same grid on RANDOM event sets with the same
 *    per-date counts, repeated R times. The real best score must beat the
 *    placebo distribution of "best of 117", otherwise it is data-snooping.
 *  - Win rate is REPORTED but never used to select: tight-target / wide-stop
 *    rules have high win rates and negative expectancy.
 *
 * Every (symbol, date) event is simulated independently (no capital or position
 * limit): this measures edge per trade, not portfolio return.
 *
 *   pnpm --filter @idx/backtest exec tsx src/phase0h.ts -- --database-url=... [--cost=0.6] [--reps=40] [--out=phase0h.json]
 */
import { mulberry32 } from "./baselines.js";

const HORIZON_MAX = 10;
const MIN_PRICE = 51;
const MIN_AVG_TURNOVER = 500_000_000;
const MIN_N_PER_HALF = 100;

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
}

function get(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : undefined;
}
const COST = Number(get("cost") ?? 0.6) / 100;
const REPS = Number(get("reps") ?? 40);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function sd(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
const r2 = (x: number) => (Number.isFinite(x) ? Number(x.toFixed(2)) : null);

// ---------- exits ----------
interface Exit {
  name: string;
  hold: number;
  sl?: number;
  tp?: number;
}
const EXITS: Exit[] = [
  { name: "T3", hold: 3 },
  { name: "T5", hold: 5 },
  { name: "T10", hold: 10 },
  { name: "SL5/TP10", hold: 10, sl: 0.05, tp: 0.1 },
  { name: "SL8/TP8", hold: 10, sl: 0.08, tp: 0.08 },
  { name: "SL3/TP6", hold: 10, sl: 0.03, tp: 0.06 },
  { name: "SL10/TP5 (high win rate)", hold: 10, sl: 0.1, tp: 0.05 },
  { name: "SL5 only", hold: 10, sl: 0.05 },
  { name: "TP5 only", hold: 10, tp: 0.05 }
];

/** Buy at the open of bar i+1; bars i+1..i+hold are walked; same-bar SL/TP resolved SL-first; gaps fill at the open. */
function simulate(bars: Bar[], i: number, ex: Exit): number {
  const entry = bars[i + 1]!.open;
  const stop = ex.sl ? entry * (1 - ex.sl) : null;
  const target = ex.tp ? entry * (1 + ex.tp) : null;
  let exit = bars[i + ex.hold]!.close;
  for (let j = i + 1; j <= i + ex.hold; j++) {
    const b = bars[j]!;
    if (j > i + 1) {
      if (stop !== null && b.open <= stop) {
        exit = b.open;
        break;
      }
      if (target !== null && b.open >= target) {
        exit = b.open;
        break;
      }
    }
    if (stop !== null && b.low <= stop) {
      exit = stop;
      break;
    }
    if (target !== null && b.high >= target) {
      exit = target;
      break;
    }
  }
  return (exit / entry - 1 - COST) * 100;
}

// ---------- indicators ----------
function wilderRsi(closes: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) g += d;
    else l -= d;
  }
  g /= n;
  l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    g = (g * (n - 1) + (d > 0 ? d : 0)) / n;
    l = (l * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function sma(bars: Bar[], i: number, n: number): number | null {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += bars[k]!.close;
  return s / n;
}
const FIB = [0.382, 0.5, 0.618];
const PLC = [0.3, 0.44, 0.56, 0.72];
function fibHit(bars: Bar[], i: number, levels: number[], tol: number): boolean {
  if (i < 59) return false;
  let hiIdx = i - 59;
  let loIdx = hiIdx;
  for (let k = hiIdx; k <= i; k++) {
    if (bars[k]!.high >= bars[hiIdx]!.high) hiIdx = k;
    if (bars[k]!.low <= bars[loIdx]!.low) loIdx = k;
  }
  const hi = bars[hiIdx]!.high;
  const lo = bars[loIdx]!.low;
  if (!(loIdx < hiIdx) || !(lo > 0) || (hi - lo) / lo < 0.1) return false;
  const retrace = (hi - bars[i]!.close) / (hi - lo);
  const dist = Math.min(...levels.map((L) => Math.abs(retrace - L)));
  return dist <= tol && bars[i]!.close > bars[i - 1]!.close;
}

// ---------- signals (all use data up to and including the close of bar i) ----------
interface Ctx {
  bars: Bar[];
  i: number;
  rsi2: number | null;
  rsi14: number | null;
}
interface Signal {
  name: string;
  test: (c: Ctx) => boolean;
}
const SIGNALS: Signal[] = [
  { name: "rsi2<10", test: (c) => c.rsi2 !== null && c.rsi2 < 10 },
  {
    name: "rsi2<10 & close>SMA50",
    test: (c) => c.rsi2 !== null && c.rsi2 < 10 && (sma(c.bars, c.i, 50) ?? Infinity) < c.bars[c.i]!.close
  },
  { name: "rsi14<30", test: (c) => c.rsi14 !== null && c.rsi14 < 30 },
  { name: "ret1<=-4%", test: (c) => c.bars[c.i]!.close / c.bars[c.i - 1]!.close - 1 <= -0.04 },
  { name: "ret5<=-10%", test: (c) => c.bars[c.i]!.close / c.bars[c.i - 5]!.close - 1 <= -0.1 },
  {
    name: "pullback: >SMA50 & <=90% of 20d high",
    test: (c) => {
      const s50 = sma(c.bars, c.i, 50);
      const hi20 = Math.max(...c.bars.slice(c.i - 19, c.i + 1).map((b) => b.high));
      return s50 !== null && c.bars[c.i]!.close > s50 && c.bars[c.i]!.close <= 0.9 * hi20;
    }
  },
  {
    name: "breakout20 & volPace>=1.5",
    test: (c) => {
      const prevHi = Math.max(...c.bars.slice(c.i - 20, c.i).map((b) => b.high));
      const vp = c.bars[c.i]!.volume / (mean(c.bars.slice(c.i - 20, c.i).map((b) => b.volume)) || 1);
      return c.bars[c.i]!.close > prevHi && vp >= 1.5;
    }
  },
  {
    name: "volshock up (volPace>=3 & ret1>=+3%)",
    test: (c) => {
      const vp = c.bars[c.i]!.volume / (mean(c.bars.slice(c.i - 20, c.i).map((b) => b.volume)) || 1);
      return vp >= 3 && c.bars[c.i]!.close / c.bars[c.i - 1]!.close - 1 >= 0.03;
    }
  },
  {
    name: "volshock down (volPace>=3 & ret1<=-3%)",
    test: (c) => {
      const vp = c.bars[c.i]!.volume / (mean(c.bars.slice(c.i - 20, c.i).map((b) => b.volume)) || 1);
      return vp >= 3 && c.bars[c.i]!.close / c.bars[c.i - 1]!.close - 1 <= -0.03;
    }
  },
  { name: "fib bounce (38.2/50/61.8)", test: (c) => fibHit(c.bars, c.i, FIB, 0.03) },
  { name: "fib PLACEBO levels", test: (c) => fibHit(c.bars, c.i, PLC, 0.0225) },
  {
    name: "tech: SMA20>SMA50, near 20d high, ret20>0",
    test: (c) => {
      const s20 = sma(c.bars, c.i, 20);
      const s50 = sma(c.bars, c.i, 50);
      const hi20 = Math.max(...c.bars.slice(c.i - 19, c.i + 1).map((b) => b.high));
      const cl = c.bars[c.i]!.close;
      return s20 !== null && s50 !== null && cl > s20 && s20 > s50 && cl >= hi20 * 0.97 && cl / c.bars[c.i - 20]!.close - 1 > 0;
    }
  },
  {
    name: "gap-down reversal (open<=-3% vs prev close, closes up)",
    test: (c) => {
      const b = c.bars[c.i]!;
      return b.open / c.bars[c.i - 1]!.close - 1 <= -0.03 && b.close > b.open;
    }
  }
];

// ---------- event table ----------
interface Ev {
  date: string;
  flags: boolean[];
  rets: number[]; // per EXITS index, net %
}

interface Stat {
  n: number;
  mean: number;
  t: number;
  win: number;
  pf: number;
}
function statOf(rows: { date: string; r: number }[]): Stat {
  if (rows.length === 0) return { n: 0, mean: NaN, t: NaN, win: NaN, pf: NaN };
  const byDate = new Map<string, number[]>();
  for (const x of rows) byDate.set(x.date, [...(byDate.get(x.date) ?? []), x.r]);
  const dm = [...byDate.values()].map(mean);
  const t = dm.length >= 3 ? mean(dm) / (sd(dm) / Math.sqrt(dm.length)) : NaN;
  const wins = rows.filter((x) => x.r > 0);
  const gl = Math.abs(rows.filter((x) => x.r <= 0).reduce((a, b) => a + b.r, 0));
  return {
    n: rows.length,
    mean: mean(rows.map((x) => x.r)),
    t,
    win: wins.length / rows.length,
    pf: gl > 0 ? wins.reduce((a, b) => a + b.r, 0) / gl : Infinity
  };
}

async function main() {
  const dbUrl = get("database-url") ?? process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required");
  const { createDbClient } = await import("@idx/db");
  const { sql } = await import("drizzle-orm");
  const db = createDbClient(dbUrl);
  const res = (await db.execute(
    sql`select symbol, trading_date, open, high, low, close, volume, coalesce(turnover, close * volume) as turnover
        from daily_bar order by symbol, trading_date`
  )) as unknown;
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? []);
  const bySymbol = new Map<string, Bar[]>();
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

  const events: Ev[] = [];
  for (const [, bars] of bySymbol) {
    const closes = bars.map((b) => b.close);
    const rsi2 = wilderRsi(closes, 2);
    const rsi14 = wilderRsi(closes, 14);
    for (let i = 60; i <= bars.length - 1 - HORIZON_MAX; i++) {
      const b = bars[i]!;
      if (b.close < MIN_PRICE) continue;
      if (!(mean(bars.slice(i - 19, i + 1).map((x) => x.turnover)) >= MIN_AVG_TURNOVER)) continue;
      const c: Ctx = { bars, i, rsi2: rsi2[i] ?? null, rsi14: rsi14[i] ?? null };
      events.push({
        date: b.date,
        flags: SIGNALS.map((s) => s.test(c)),
        rets: EXITS.map((e) => simulate(bars, i, e))
      });
    }
  }

  const dates = [...new Set(events.map((e) => e.date))].sort();
  const mid = dates[Math.floor(dates.length / 2)]!;
  const half = (d: string) => (d < mid ? 1 : 2);
  const byDateIdx = new Map<string, number[]>();
  events.forEach((e, k) => byDateIdx.set(e.date, [...(byDateIdx.get(e.date) ?? []), k]));

  // unconditional mean net return of ALL eligible events, per date and exit rule
  const allMean = new Map<string, number[]>();
  for (const [d, ks] of byDateIdx) allMean.set(d, EXITS.map((_, ei) => mean(ks.map((k) => events[k]!.rets[ei]!))));
  const excessStat = (rows: { date: string; r: number }[], e: number) => {
    const byD = new Map<string, number[]>();
    for (const x of rows) byD.set(x.date, [...(byD.get(x.date) ?? []), x.r]);
    const diffs = [...byD.entries()].map(([d, rs]) => mean(rs) - allMean.get(d)![e]!);
    const t = diffs.length >= 3 ? mean(diffs) / (sd(diffs) / Math.sqrt(diffs.length)) : NaN;
    return { mean: mean(diffs), t };
  };

  const evalSet = (idxs: number[], e: number) => {
    const h1: { date: string; r: number }[] = [];
    const h2: { date: string; r: number }[] = [];
    for (const k of idxs) {
      const ev = events[k]!;
      (half(ev.date) === 1 ? h1 : h2).push({ date: ev.date, r: ev.rets[e]! });
    }
    return { h1: statOf(h1), h2: statOf(h2), all: statOf([...h1, ...h2]), x1: excessStat(h1, e), x2: excessStat(h2, e) };
  };
  // score = the weaker half's by-date t of the EXCESS over all events that day
  const score = (r: ReturnType<typeof evalSet>) =>
    r.h1.n >= MIN_N_PER_HALF && r.h2.n >= MIN_N_PER_HALF ? Math.min(r.x1.t, r.x2.t) : -Infinity;

  // ----- real grid -----
  interface Row {
    signal: string;
    exit: string;
    n1: number;
    n2: number;
    mean1: number;
    mean2: number;
    t1: number;
    t2: number;
    ex1: number;
    ex2: number;
    xt1: number;
    xt2: number;
    win: number;
    meanAll: number;
    pf: number;
    score: number;
  }
  const grid: Row[] = [];
  SIGNALS.forEach((s, si) => {
    const idxs = events.map((_, k) => k).filter((k) => events[k]!.flags[si]);
    EXITS.forEach((ex, ei) => {
      const r = evalSet(idxs, ei);
      grid.push({
        signal: s.name,
        exit: ex.name,
        n1: r.h1.n,
        n2: r.h2.n,
        mean1: r.h1.mean,
        mean2: r.h2.mean,
        t1: r.h1.t,
        t2: r.h2.t,
        ex1: r.x1.mean,
        ex2: r.x2.mean,
        xt1: r.x1.t,
        xt2: r.x2.t,
        win: r.all.win,
        meanAll: r.all.mean,
        pf: r.all.pf,
        score: score(r)
      });
    });
  });

  // ----- placebo calibration: same per-date counts, random events, same grid -----
  const rand = mulberry32(20260921);
  const placeboBest: number[] = [];
  const placeboSurvivors: number[] = [];
  for (let rep = 0; rep < REPS; rep++) {
    let best = -Infinity;
    let surv = 0;
    SIGNALS.forEach((_, si) => {
      const counts = new Map<string, number>();
      events.forEach((e) => {
        if (e.flags[si]) counts.set(e.date, (counts.get(e.date) ?? 0) + 1);
      });
      const idxs: number[] = [];
      for (const [d, c] of counts) {
        const pool = [...(byDateIdx.get(d) ?? [])];
        for (let k = 0; k < Math.min(c, pool.length); k++) {
          const pick = Math.floor(rand() * pool.length);
          idxs.push(pool[pick]!);
          pool.splice(pick, 1);
        }
      }
      EXITS.forEach((_, ei) => {
        const sc = score(evalSet(idxs, ei));
        if (sc > best) best = sc;
        if (sc >= 2) surv += 1;
      });
    });
    placeboBest.push(best);
    placeboSurvivors.push(surv);
  }
  placeboBest.sort((a, b) => a - b);
  const q = (p: number) => placeboBest[Math.min(placeboBest.length - 1, Math.floor(p * placeboBest.length))]!;

  const survivors = grid.filter((g) => g.score >= 2 && g.ex1 > 0 && g.ex2 > 0);
  const bestReal = [...grid].sort((a, b) => b.score - a.score);
  const realBest = bestReal[0]!.score;
  const pValue = (placeboBest.filter((x) => x >= realBest).length + 1) / (REPS + 1);

  const fmt = (g: Row) =>
    `${g.signal.padEnd(52)} ${g.exit.padEnd(26)} n=${g.n1}/${g.n2}  abs H1 ${r2(g.mean1)}% H2 ${r2(g.mean2)}% | EXCESS H1 ${r2(g.ex1)}% (t ${r2(g.xt1)})  H2 ${r2(g.ex2)}% (t ${r2(g.xt2)})  win ${r2(g.win * 100)}%  PF ${r2(g.pf)}`;

  const lines: string[] = [];
  const baseRows = EXITS.map((ex, ei) => {
    const all = events.map((_, k) => k);
    const r = evalSet(all, ei);
    return `  ${ex.name.padEnd(26)} H1 ${r2(r.h1.mean)}%  H2 ${r2(r.h2.mean)}%  win ${r2(r.all.win * 100)}%`;
  });
  lines.push(`events=${events.length} dates=${dates.length} (${dates[0]} .. ${dates[dates.length - 1]}) split at ${mid}; cost=${COST * 100}% round trip; configs=${grid.length}; placebo reps=${REPS}`);
  lines.push(`\nUNCONDITIONAL baseline = mean net % of ALL eligible events (the drift every rule rides on):`);
  baseRows.forEach((l) => lines.push(l));
  lines.push(`\nSURVIVORS (EXCESS>0 in BOTH halves, by-date t>=2 in both, n>=${MIN_N_PER_HALF}/half): ${survivors.length}`);
  survivors.forEach((g) => lines.push("  " + fmt(g)));
  lines.push(`\nTOP 12 by min(excess t_H1, excess t_H2)`);
  bestReal.slice(0, 12).forEach((g) => lines.push("  " + fmt(g) + `  score ${r2(g.score)}`));
  lines.push(`\nTOP 8 by overall mean net % (selection bias applies!)`);
  [...grid].filter((g) => g.n1 + g.n2 >= 200).sort((a, b) => b.meanAll - a.meanAll).slice(0, 8).forEach((g) => lines.push("  " + fmt(g)));
  lines.push(`\nHIGHEST WIN RATES (n>=200) -- note the expectancy`);
  [...grid].filter((g) => g.n1 + g.n2 >= 200).sort((a, b) => b.win - a.win).slice(0, 8).forEach((g) => lines.push("  " + fmt(g)));
  lines.push(`\nPLACEBO calibration (best min excess-t of ${grid.length} configs on RANDOM events): median ${r2(q(0.5))}, p90 ${r2(q(0.9))}, p95 ${r2(q(0.95))}, max ${r2(placeboBest[placeboBest.length - 1]!)}`);
  lines.push(`placebo mean # of configs with min excess-t>=2: ${r2(mean(placeboSurvivors))}`);
  lines.push(`REAL best min excess-t = ${r2(realBest)}  -> empirical p-value vs placebo best-of-${grid.length} = ${r2(pValue)}`);

  const report = { generatedAt: new Date().toISOString(), costPct: COST * 100, split: mid, dates: dates.length, events: events.length, placeboReps: REPS, placeboBestMinT: placeboBest, realBestMinT: realBest, pValue, survivors, top: bestReal.slice(0, 20), grid };
  const out = get("out");
  if (out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(out, JSON.stringify(report, null, 2), "utf8");
  }
  console.log(lines.join("\n"));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
