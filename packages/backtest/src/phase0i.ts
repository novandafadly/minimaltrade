#!/usr/bin/env node
/**
 * Phase 0I: do fundamental factors (profitability, value, size, earnings growth)
 * predict returns on the IDX universe, over several market regimes?
 *
 * Motivation. Phases 0E-0H found no tradeable edge from broker flow or technical
 * rules. The Indonesian evidence ("Risk factors in the Indonesian stock market",
 * Pacific-Basin Finance Journal 2023) says the robust cross-sectional factors are
 * SIZE, VALUE (operating cash flow / price) and PROFITABILITY -- fundamentals,
 * not technicals -- so this tests those, at 4- and 13-week horizons.
 *
 * DATA (archived by backfillFundamentals.ts in raw_payload_archive):
 *   - quarterly income / balance sheet / cash flow (12 DISCRETE quarters, Q2-2023..)
 *   - weekly prices (120 weeks back to ~2024-06)  -> spans several regimes
 *   - listed_shares from the archived /api/market-cap pages (for market cap)
 *
 * NO LOOK-AHEAD:
 *   - a quarter's statements are usable only PUBLICATION_LAG_DAYS (90) after the
 *     quarter end (the API gives no publication date; 90 days is the IDX outer limit);
 *   - factors use the weekly CLOSE at the rebalance week; the holding period starts
 *     at the NEXT week's close (a whole week later than the signal), then runs h weeks.
 *
 * Factors (fixed in advance):
 *   ROE, ROA          net income TTM / latest equity, / latest assets
 *   EP, BP, CFP       net income TTM, equity, operating cash flow TTM  / market cap
 *   size              ln(market cap)   (small-cap premium => expect negative IC)
 *   NIyoy             latest quarter net income vs the same quarter a year earlier
 *   QV                rank-average of ROE, EP, CFP (a pre-registered composite)
 *   placebo_random    seeded noise (IC must be ~0)
 * Statistic: per-rebalance-date Spearman IC vs FORWARD EXCESS return (minus that
 * date's cross-sectional mean) and Q5-Q1 quintile spread; t-stat across dates
 * (h=13 uses a non-overlapping quarterly stride). Banks (different statement
 * layout) are included in "all" and excluded in "non-bank".
 *
 * CAVEATS: shares outstanding are taken from the latest market-cap snapshot (not
 * point-in-time), so symbols with a >45% weekly price jump (likely splits / rights
 * issues) are excluded; the universe is the set liquid around Sep 2026 (survivorship /
 * hindsight) -- rank-based excess returns cancel the common upward bias but not
 * a bias that differs by factor (e.g. cheap names that later recovered).
 *
 *   pnpm --filter @idx/backtest exec tsx src/phase0i.ts -- --database-url=... [--out=phase0i.json]
 */
import { mulberry32 } from "./baselines.js";

function get(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : undefined;
}

const PUBLICATION_LAG_DAYS = 90;
const HORIZONS = [4, 13];
const MIN_XS = Number(get("min-xs") ?? 15);
const SPLIT_KS = [2, 3, 4, 5, 8, 10, 20, 25, 50, 100];

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function sd(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
const tstat = (xs: number[]) => (xs.length >= 3 ? mean(xs) / (sd(xs) / Math.sqrt(xs.length)) : NaN);
const r2 = (x: number) => (Number.isFinite(x) ? Number(x.toFixed(2)) : null);
const r3 = (x: number) => (Number.isFinite(x) ? Number(x.toFixed(3)) : null);

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
  const ma = mean(a);
  const mb = mean(b);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function path(o: any, p: string): number | null {
  let cur = o;
  for (const k of p.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return null;
    cur = cur[k];
  }
  const n = typeof cur === "number" ? cur : typeof cur === "string" ? Number(cur) : NaN;
  return Number.isFinite(n) ? n : null;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstPath(o: any, ps: string[]): number | null {
  for (const p of ps) {
    const v = path(o, p);
    if (v !== null) return v;
  }
  return null;
}

interface Q {
  ni?: number;
  assets?: number;
  equity?: number;
  ocf?: number;
}
const qKey = (year: number, quarter: number) => year * 4 + (quarter - 1);
function qEndDate(year: number, quarter: number): Date {
  const m = quarter * 3; // 3,6,9,12
  return new Date(Date.UTC(year, m, 0)); // last day of month m
}

interface WeeklyBar {
  date: string;
  close: number;
  volume: number;
}

/**
 * A real split / reverse split moves the price by ~1/k (k an integer) AND the volume
 * by ~k in the same week. A plain "hot stock" move (IDX allows +-35%/day) does not.
 * Large ordinary weekly moves are therefore kept, not dropped.
 */
function looksLikeSplit(prev: WeeklyBar, cur: WeeklyBar): boolean {
  const r = cur.close / prev.close;
  const v = prev.volume > 0 ? cur.volume / prev.volume : 1;
  const near = (x: number, k: number) => Math.abs(x / k - 1) <= 0.08;
  for (const k of SPLIT_KS) {
    if (near(1 / r, k) && v >= 0.6 * k) return true; // split: price / k, volume * k
    if (near(r, k) && v <= 1 / (0.6 * k)) return true; // reverse split
  }
  return false;
}

async function main() {
  const dbUrl = get("database-url") ?? process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required");
  const { createDbClient } = await import("@idx/db");
  const { sql } = await import("drizzle-orm");
  const db = createDbClient(dbUrl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rowsOf = (res: any): any[] => (Array.isArray(res) ? res : (res?.rows ?? []));

  // ---------- load archived payloads (latest per endpoint+symbol) ----------
  const archived = rowsOf(
    await db.execute(sql`
      select distinct on (endpoint, symbol) endpoint, symbol, payload
      from raw_payload_archive
      where http_status = 200 and (endpoint like '/api/financial-statements/%report_type%' or endpoint like '/api/history/{code}?frame=weekly')
      order by endpoint, symbol, received_at desc`)
  );
  const quarters = new Map<string, Map<number, Q>>();
  const isBank = new Set<string>();
  const weekly = new Map<string, WeeklyBar[]>();
  for (const r of archived) {
    const sym = String(r.symbol);
    const endpoint = String(r.endpoint);
    const payload = r.payload;
    if (endpoint.includes("frame=weekly")) {
      const bars: WeeklyBar[] = (payload.rows ?? [])
        .map((x: { date: string; close: number | string; volume?: number | string }) => ({
          date: String(x.date),
          close: Number(x.close),
          volume: Number(x.volume ?? 0)
        }))
        .filter((b: WeeklyBar) => Number.isFinite(b.close) && b.close > 0)
        .sort((a: WeeklyBar, b: WeeklyBar) => a.date.localeCompare(b.date));
      weekly.set(sym, bars);
      continue;
    }
    const m = quarters.get(sym) ?? new Map<number, Q>();
    quarters.set(sym, m);
    for (const it of payload.items ?? []) {
      const year = Number(it.year);
      const quarter = Number(it.quarter);
      if (!Number.isFinite(year) || !Number.isFinite(quarter)) continue;
      const q = m.get(qKey(year, quarter)) ?? {};
      const d = it.data;
      if (endpoint.includes("INCOME_STATEMENT")) {
        const v = firstPath(d, ["laba_rugi_yang_dapat_diatribusikan.laba_rugi_yang_dapat_diatribusikan_ke_entitas_induk", "laba_rugi"]);
        if (v !== null) q.ni = v;
      } else if (endpoint.includes("BALANCE_SHEET")) {
        if (d && typeof d === "object" && "liabilitas_dana_syirkah_temporer_dan_ekuitas" in d) isBank.add(sym);
        const a = path(d, "aset.total");
        if (a !== null) q.assets = a;
        const e = firstPath(d, [
          "liabilitas_dan_ekuitas.ekuitas.ekuitas_yang_diatribusikan_kepada_pemilik_entitas_induk.total",
          "liabilitas_dan_ekuitas.ekuitas.total",
          "liabilitas_dana_syirkah_temporer_dan_ekuitas.ekuitas.ekuitas_yang_diatribusikan_kepada_pemilik_entitas_induk.total",
          "liabilitas_dana_syirkah_temporer_dan_ekuitas.ekuitas.total"
        ]);
        if (e !== null) q.equity = e;
      } else if (endpoint.includes("CASH_FLOW")) {
        const o = path(d, "arus_kas_dari_aktivitas_operasi.total");
        if (o !== null) q.ocf = o;
      }
      m.set(qKey(year, quarter), q);
    }
  }

  // ---------- shares outstanding from the latest archived market-cap pages ----------
  const mcapPages = rowsOf(
    await db.execute(sql`select payload from raw_payload_archive where endpoint = '/api/market-cap' and http_status = 200 order by received_at desc`)
  );
  const shares = new Map<string, number>();
  for (const p of mcapPages)
    for (const e of p.payload?.data ?? []) {
      const s = Number(e.listed_shares);
      if (!shares.has(String(e.code)) && Number.isFinite(s) && s > 0) shares.set(String(e.code), s);
    }

  // ---------- universe filter: complete data, no suspected split ----------
  const universe: string[] = [];
  let droppedSplit = 0;
  let droppedData = 0;
  for (const sym of weekly.keys()) {
    const bars = weekly.get(sym)!;
    const qs = quarters.get(sym);
    if (!qs || qs.size < 5 || !shares.has(sym) || bars.length < 60) {
      droppedData += 1;
      continue;
    }
    let jump = false;
    for (let i = 1; i < bars.length; i++) if (looksLikeSplit(bars[i - 1]!, bars[i]!)) jump = true;
    if (jump) {
      droppedSplit += 1;
      continue;
    }
    universe.push(sym);
  }

  // ---------- rebalance dates: first weekly bar of each month ----------
  const refBars = weekly.get(universe[0] ?? "") ?? [];
  const allDates = [...new Set(universe.flatMap((s) => weekly.get(s)!.map((b) => b.date)))].sort();
  const rebalance: string[] = [];
  let lastMonth = "";
  for (const d of allDates) {
    if (d < "2024-07-01") continue;
    const mth = d.slice(0, 7);
    if (mth !== lastMonth) {
      rebalance.push(d);
      lastMonth = mth;
    }
  }
  void refBars;

  // ---------- observations ----------
  const FACTORS = ["ROE", "ROA", "EP", "BP", "CFP", "size", "NIyoy", "QV", "placebo_random"];
  interface Obs {
    date: string;
    sym: string;
    bank: boolean;
    f: Record<string, number | null>;
    fwd: Record<number, number>;
  }
  const rand = mulberry32(20260921);
  const obs: Obs[] = [];
  for (const t of rebalance) {
    const tDate = new Date(`${t}T00:00:00Z`);
    for (const sym of universe) {
      const bars = weekly.get(sym)!;
      const i = bars.findIndex((b) => b.date === t);
      if (i < 0) continue;
      const qs = quarters.get(sym)!;
      // latest quarter whose statements are public by t
      let L = -1;
      for (const k of qs.keys()) {
        const year = Math.floor(k / 4);
        const quarter = (k % 4) + 1;
        const avail = new Date(qEndDate(year, quarter).getTime() + PUBLICATION_LAG_DAYS * 86400000);
        if (avail <= tDate && k > L) L = k;
      }
      if (L < 0) continue;
      const cur = qs.get(L)!;
      const ttm = [0, 1, 2, 3].map((k) => qs.get(L - k));
      const haveTtm = ttm.every((q) => q && q.ni !== undefined);
      const ni = haveTtm ? ttm.reduce((s, q) => s + q!.ni!, 0) : null;
      const ocf = ttm.every((q) => q && q.ocf !== undefined) ? ttm.reduce((s, q) => s + q!.ocf!, 0) : null;
      const mcap = bars[i]!.close * shares.get(sym)!;
      const yoyBase = qs.get(L - 4)?.ni;
      const f: Record<string, number | null> = {
        ROE: ni !== null && cur.equity && cur.equity > 0 ? ni / cur.equity : null,
        ROA: ni !== null && cur.assets && cur.assets > 0 ? ni / cur.assets : null,
        EP: ni !== null ? ni / mcap : null,
        BP: cur.equity && cur.equity > 0 ? cur.equity / mcap : null,
        CFP: ocf !== null ? ocf / mcap : null,
        size: Math.log(mcap),
        NIyoy: cur.ni !== undefined && yoyBase !== undefined && yoyBase !== 0 ? Math.max(-2, Math.min(2, (cur.ni - yoyBase) / Math.abs(yoyBase))) : null,
        QV: null,
        placebo_random: rand()
      };
      const fwd: Record<number, number> = {};
      for (const h of HORIZONS) {
        const a = bars[i + 1];
        const b = bars[i + 1 + h];
        if (a && b) fwd[h] = b.close / a.close - 1; // start one full week after the signal
      }
      if (Object.keys(fwd).length === 0) continue;
      obs.push({ date: t, sym, bank: isBank.has(sym), f, fwd });
    }
  }

  const dbg = get("debug");
  if (dbg) {
    const rows = obs.filter((o) => o.sym === dbg).slice(-3);
    for (const o of rows) console.log(`[debug ${dbg}] ${o.date} bank=${o.bank} ` + JSON.stringify(Object.fromEntries(Object.entries(o.f).map(([k, v]) => [k, v === null ? null : Number(v.toFixed(4))]))));
  }

  // QV composite = average per-date percentile rank of ROE, EP, CFP (needs all three)
  for (const t of rebalance) {
    const rows = obs.filter((o) => o.date === t && o.f.ROE !== null && o.f.EP !== null && o.f.CFP !== null);
    if (rows.length < MIN_XS) continue;
    const rr = (name: string) => ranks(rows.map((o) => o.f[name] as number));
    const a = rr("ROE");
    const b = rr("EP");
    const c = rr("CFP");
    rows.forEach((o, k) => (o.f.QV = (a[k]! + b[k]! + c[k]!) / 3));
  }

  // ---------- analysis ----------
  const analyse = (filter: (o: Obs) => boolean) => {
    const out: Record<string, unknown>[] = [];
    for (const name of FACTORS) {
      const perH: Record<string, unknown> = {};
      for (const h of HORIZONS) {
        const ics: number[] = [];
        const qSum = [0, 0, 0, 0, 0];
        const qN = [0, 0, 0, 0, 0];
        let nObs = 0;
        for (const t of rebalance) {
          const all = obs.filter((o) => o.date === t && o.fwd[h] !== undefined && filter(o));
          const rows = all.filter((o) => o.f[name] !== null);
          if (rows.length < MIN_XS) continue;
          const m = mean(all.map((o) => o.fwd[h]!));
          const excess = rows.map((o) => o.fwd[h]! - m);
          const sig = rows.map((o) => o.f[name] as number);
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
        const stride = h >= 13 ? 3 : 1;
        const strided = ics.filter((_, k) => k % stride === 0);
        const q = qSum.map((s, k) => (qN[k]! > 0 ? (s / qN[k]!) * 100 : NaN));
        perH[`h${h}w`] = {
          obs: nObs,
          dates: ics.length,
          meanIC: r3(mean(ics)),
          hit: r2(ics.filter((v) => v > 0).length / Math.max(1, ics.length)),
          t_all: r2(tstat(ics)),
          t_nonOverlap: r2(tstat(strided)),
          quintiles_pct: q.map(r2),
          spreadQ5minusQ1_pct: r2(q[4]! - q[0]!)
        };
      }
      out.push({ factor: name, ...perH });
    }
    return out;
  };

  const perDate = rebalance.map((t) => ({ date: t, n: obs.filter((o) => o.date === t).length }));
  const report = {
    generatedAt: new Date().toISOString(),
    universe: { used: universe.length, banks: universe.filter((s) => isBank.has(s)).length, droppedSplit, droppedData },
    rebalanceDates: rebalance.length,
    window: { from: rebalance[0], to: rebalance[rebalance.length - 1] },
    publicationLagDays: PUBLICATION_LAG_DAYS,
    crossSectionSizes: perDate,
    all: analyse(() => true),
    nonBank: analyse((o) => !o.bank)
  };
  const out = get("out");
  if (out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(out, JSON.stringify(report, null, 2), "utf8");
  }
  const fmt = (rows: Record<string, unknown>[]) =>
    rows
      .map((r) => {
        const a = r.h4w as Record<string, unknown>;
        const b = r.h13w as Record<string, unknown>;
        return `  ${String(r.factor).padEnd(15)} 4w: IC ${a.meanIC} (t ${a.t_nonOverlap}) Q5-Q1 ${a.spreadQ5minusQ1_pct}% n=${a.obs}/${a.dates}d | 13w: IC ${b.meanIC} (t ${b.t_nonOverlap}) Q5-Q1 ${b.spreadQ5minusQ1_pct}% n=${b.obs}/${b.dates}d`;
      })
      .join("\n");
  console.log(`universe used=${universe.length} (banks ${report.universe.banks}), droppedSplit=${droppedSplit}, droppedData=${droppedData}, rebalance dates=${rebalance.length} (${report.window.from}..${report.window.to}), lag=${PUBLICATION_LAG_DAYS}d`);
  console.log(`cross-section sizes: ${perDate.map((p) => p.n).join(",")}`);
  console.log(`\nALL (incl. banks):\n${fmt(report.all)}`);
  console.log(`\nNON-BANK:\n${fmt(report.nonBank)}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
