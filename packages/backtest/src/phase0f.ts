#!/usr/bin/env node
/**
 * Phase 0F: do classic technical signals (RSI, Fibonacci retracements) -- and a
 * few literature-backed alternatives -- predict forward returns on this data?
 *
 * Pure OHLCV from `daily_bar` (157 liquid-ish IDX names x ~120 daily bars), no
 * API calls. Same statistic as Phase 0E: per-date Spearman rank-IC of each
 * signal vs FORWARD EXCESS return (return minus that date's cross-sectional
 * mean), plus per-date quintile spreads, at 1/3/5/10 day horizons.
 *
 * PRE-REGISTERED (fixed before looking at any result; nothing is tuned):
 *   RSI            Wilder RSI(2) and RSI(14)
 *   Fibonacci      swing = highest-high / lowest-low over the last 60 bars; only
 *                  UP-swings (low before high, range >= 10%). retrace = fraction of
 *                  the rally given back = (hi - close) / (hi - lo).
 *                    fib_retrace   raw depth
 *                    fib_prox      distance to the nearest of {0.382, 0.5, 0.618}
 *                    plc_prox      PLACEBO: nearest of {0.30, 0.44, 0.56, 0.72}
 *                  Event study: "hit" = within tolerance of a level AND today's
 *                  close > yesterday's (a bounce candle). Fib: 3 levels +/-0.030;
 *                  placebo: 4 levels +/-0.0225 -> both cover 18% of the range, so
 *                  a Fibonacci edge must beat equally-dense arbitrary levels.
 *   Literature     ret1 / ret5 (short-term reversal), ret20 (momentum), dist_high20
 *                  and dist_high60 (52-week-high style proximity), vol_pace
 *                  (volume shock).
 *   Sanity         placebo_random (seeded noise) -- its IC must be ~0, else the
 *                  harness is broken.
 * Multiple testing: ~15 signals x 4 horizons = ~60 tests, so ~3 will show |t|>2
 * by chance alone. Trust |t| > 3 on the NON-overlapping t-stat, and treat anything
 * weaker as a lead. One window / one regime (Mar-Sep 2026). Long-only after the
 * ~0.4% round-trip cost is what matters for a trade, so rows whose best-quintile
 * excess exceeds 0.4% are flagged.
 *
 *   pnpm --filter @idx/backtest exec tsx src/phase0f.ts -- --database-url=... [--out=phase0f.json]
 */
import { mulberry32 } from "./baselines.js";

const HORIZONS = [1, 3, 5, 10];
const COST_PCT = 0.4; // Stockbit round trip: 0.15% buy + 0.25% sell
const MIN_XS = 10; // min symbols in a date's cross-section for a signal
const MIN_AVG_TURNOVER = 500_000_000;
const MIN_PRICE = 51;

const FIB_LEVELS = [0.382, 0.5, 0.618];
const FIB_TOL = 0.03;
const PLC_LEVELS = [0.3, 0.44, 0.56, 0.72];
const PLC_TOL = 0.0225;
const SWING_BARS = 60;
const MIN_SWING = 0.1;

interface Bar {
  date: string;
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

// ---------- statistics ----------
function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(xs.length);
  for (let s = 0; s < idx.length; ) {
    let e = s;
    while (e + 1 < idx.length && idx[e + 1]!.v === idx[s]!.v) e++;
    const r = (s + e) / 2 + 1;
    for (let k = s; k <= e; k++) out[idx[k]!.i] = r;
    s = e + 1;
  }
  return out;
}
function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}
const spearman = (a: number[], b: number[]) => pearson(ranks(a), ranks(b));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function sd(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
const tstat = (xs: number[]) => (xs.length >= 3 ? mean(xs) / (sd(xs) / Math.sqrt(xs.length)) : NaN);
const r2 = (x: number) => (Number.isFinite(x) ? Number(x.toFixed(2)) : null);
const r3 = (x: number) => (Number.isFinite(x) ? Number(x.toFixed(3)) : null);

// ---------- indicators (value at index i, using bars[0..i] only) ----------
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

interface Fib {
  retrace: number;
  fibProx: number;
  plcProx: number;
  fibHit: boolean;
  plcHit: boolean;
}
function fibAt(bars: Bar[], i: number): Fib | null {
  if (i < SWING_BARS - 1) return null;
  let hiIdx = i - SWING_BARS + 1;
  let loIdx = hiIdx;
  for (let k = hiIdx; k <= i; k++) {
    if (bars[k]!.high >= bars[hiIdx]!.high) hiIdx = k;
    if (bars[k]!.low <= bars[loIdx]!.low) loIdx = k;
  }
  const hi = bars[hiIdx]!.high;
  const lo = bars[loIdx]!.low;
  if (!(loIdx < hiIdx) || !(lo > 0) || (hi - lo) / lo < MIN_SWING) return null; // up-swings only
  const retrace = (hi - bars[i]!.close) / (hi - lo);
  const dist = (levels: number[]) => Math.min(...levels.map((L) => Math.abs(retrace - L)));
  const fibProx = dist(FIB_LEVELS);
  const plcProx = dist(PLC_LEVELS);
  const bounce = i > 0 && bars[i]!.close > bars[i - 1]!.close;
  return { retrace, fibProx, plcProx, fibHit: bounce && fibProx <= FIB_TOL, plcHit: bounce && plcProx <= PLC_TOL };
}

// ---------- main ----------
interface Obs {
  date: string;
  fwd: Record<number, number>;
  sig: Record<string, number | null>;
  fibHit: boolean;
  plcHit: boolean;
}

async function main() {
  const dbUrl = get("database-url") ?? process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required");
  const { createDbClient } = await import("@idx/db");
  const { sql } = await import("drizzle-orm");
  const db = createDbClient(dbUrl);
  const res = (await db.execute(
    sql`select symbol, trading_date, high, low, close, volume, coalesce(turnover, close * volume) as turnover
        from daily_bar order by symbol, trading_date`
  )) as unknown;
  const rows: Record<string, unknown>[] = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? []);

  const bySymbol = new Map<string, Bar[]>();
  for (const r of rows) {
    const sym = String(r.symbol);
    const arr = bySymbol.get(sym) ?? [];
    arr.push({
      date: String(r.trading_date),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      turnover: Number(r.turnover)
    });
    bySymbol.set(sym, arr);
  }

  const rand = mulberry32(20260920);
  const maxH = Math.max(...HORIZONS);
  const obs: Obs[] = [];

  for (const [, bars] of bySymbol) {
    const closes = bars.map((b) => b.close);
    const rsi2 = wilderRsi(closes, 2);
    const rsi14 = wilderRsi(closes, 14);
    for (let i = 0; i < bars.length - 1; i++) {
      if (i < 20) continue;
      const b = bars[i]!;
      if (b.close < MIN_PRICE) continue;
      const avgTo = mean(bars.slice(i - 19, i + 1).map((x) => x.turnover));
      if (!(avgTo >= MIN_AVG_TURNOVER)) continue;

      const fwd: Record<number, number> = {};
      for (const h of HORIZONS) if (i + h < bars.length) fwd[h] = bars[i + h]!.close / b.close - 1;
      if (Object.keys(fwd).length === 0) continue;

      const hi20 = Math.max(...bars.slice(i - 19, i + 1).map((x) => x.high));
      const hi60 = i >= 59 ? Math.max(...bars.slice(i - 59, i + 1).map((x) => x.high)) : null;
      const avgVol = mean(bars.slice(i - 20, i).map((x) => x.volume));
      const fib = fibAt(bars, i);
      obs.push({
        date: b.date,
        fwd,
        fibHit: !!fib?.fibHit,
        plcHit: !!fib?.plcHit,
        sig: {
          rsi2: rsi2[i] ?? null,
          rsi14: rsi14[i] ?? null,
          fib_retrace: fib ? fib.retrace : null,
          fib_prox: fib ? fib.fibProx : null,
          plc_prox: fib ? fib.plcProx : null,
          ret1: b.close / bars[i - 1]!.close - 1,
          ret5: b.close / bars[i - 5]!.close - 1,
          ret20: b.close / bars[i - 20]!.close - 1,
          dist_high20: b.close / hi20 - 1,
          dist_high60: hi60 ? b.close / hi60 - 1 : null,
          vol_pace: avgVol > 0 ? b.volume / avgVol : null,
          placebo_random: rand()
        }
      });
    }
  }

  const byDate = new Map<string, Obs[]>();
  for (const o of obs) byDate.set(o.date, [...(byDate.get(o.date) ?? []), o]);
  const dates = [...byDate.keys()].sort();
  const signalNames = Object.keys(obs[0]!.sig);

  // ----- continuous signals: IC + quintiles per horizon -----
  const signals = signalNames.map((name) => {
    const perH: Record<string, unknown> = {};
    for (const h of HORIZONS) {
      const ics: number[] = [];
      const qSum = [0, 0, 0, 0, 0];
      const qN = [0, 0, 0, 0, 0];
      let nObs = 0;
      for (const d of dates) {
        const rows = (byDate.get(d) ?? []).filter((o) => o.fwd[h] !== undefined && o.sig[name] !== null);
        if (rows.length < MIN_XS) continue;
        const allRows = (byDate.get(d) ?? []).filter((o) => o.fwd[h] !== undefined);
        const m = mean(allRows.map((o) => o.fwd[h]!)); // excess vs the FULL universe that date
        const excess = rows.map((o) => o.fwd[h]! - m);
        const sig = rows.map((o) => o.sig[name] as number);
        const ic = spearman(sig, excess);
        if (ic !== null) ics.push(ic);
        nObs += rows.length;
        const rk = ranks(sig);
        rows.forEach((_, k) => {
          const q = Math.min(4, Math.floor(((rk[k]! - 1) / rows.length) * 5));
          qSum[q]! += excess[k]!;
          qN[q]! += 1;
        });
      }
      const strided = ics.filter((_, k) => k % h === 0);
      const q = qSum.map((s, k) => (qN[k]! > 0 ? (s / qN[k]!) * 100 : NaN));
      perH[`h${h}`] = {
        obs: nObs,
        dates: ics.length,
        meanIC: r3(mean(ics)),
        hit: r2(ics.filter((v) => v > 0).length / Math.max(1, ics.length)),
        t_overlap: r2(tstat(ics)),
        t_nonOverlap: r2(tstat(strided)),
        quintiles_pct: q.map(r2),
        spreadQ5minusQ1_pct: r2(q[4]! - q[0]!),
        bestQuintileExcess_pct: r2(Math.max(...q.filter(Number.isFinite))),
        clearsCost: Math.max(...q.filter(Number.isFinite)) > COST_PCT || Math.min(...q.filter(Number.isFinite)) < -COST_PCT
      };
    }
    return { signal: name, ...perH };
  });

  // ----- event study: Fibonacci bounce vs placebo-level bounce -----
  const events = HORIZONS.map((h) => {
    const one = (flag: "fibHit" | "plcHit") => {
      const perDate: number[] = [];
      let n = 0;
      for (const d of dates) {
        const rows = (byDate.get(d) ?? []).filter((o) => o.fwd[h] !== undefined);
        if (rows.length < MIN_XS) continue;
        const m = mean(rows.map((o) => o.fwd[h]!));
        const hits = rows.filter((o) => o[flag]);
        if (hits.length === 0) continue;
        perDate.push(mean(hits.map((o) => o.fwd[h]! - m)) * 100);
        n += hits.length;
      }
      const strided = perDate.filter((_, k) => k % h === 0);
      return { events: n, dates: perDate.length, meanExcess_pct: r2(mean(perDate)), t_nonOverlap: r2(tstat(strided)), t_overlap: r2(tstat(perDate)) };
    };
    return { horizon: h, fibonacci_bounce: one("fibHit"), placebo_level_bounce: one("plcHit") };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    universe: { symbols: bySymbol.size, observations: obs.length, dates: dates.length, window: { from: dates[0], to: dates[dates.length - 1] } },
    costRoundTripPct: COST_PCT,
    preRegistered: { fibLevels: FIB_LEVELS, fibTol: FIB_TOL, placeboLevels: PLC_LEVELS, placeboTol: PLC_TOL, swingBars: SWING_BARS, minSwing: MIN_SWING },
    note: "IC = per-date Spearman(signal, forward excess return). ~60 tests: expect ~3 chance |t|>2; trust |t_nonOverlap| > 3. placebo_random must be ~0.",
    signals,
    events
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
