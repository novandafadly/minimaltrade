#!/usr/bin/env node
/**
 * Phase 0J: does COMBINING the fundamental composite (Phase 0I's QV) with weekly
 * broker net-flow imbalance predict returns better than either alone?
 *
 * Motivation. Phase 0I tested fundamentals (no usable edge, BP weak at best). Phase 0E
 * tested daily broker net-flow imbalance over short (1-10 day) shadow horizons (small
 * positive rank-IC, below costs). Neither has been tested TOGETHER, and the weekly
 * broker book (2024-06 -> now, archived by backfillBrokerWeekly.ts) has never been
 * tested at the same 4-/13-week horizons as Phase 0I's fundamentals -- both are new,
 * pre-registered tests here, not a re-run of anything already reported.
 *
 * PRE-REGISTERED (fixed before running, not chosen after looking at results):
 *   flow       weekly net-flow imbalance of the top-20 broker book AT the rebalance
 *              Friday: sum(net value) / sum(buy value) (same formula as
 *              apps/worker/src/shadow/screeners.ts netFlowImbalance)
 *   combined   average RANK of QV (Phase 0I's fundamental composite: mean rank of
 *              ROE, EP, CFP) and flow, among names where BOTH are available that date
 *   placebo_random  seeded noise, same as Phase 0I, for calibration
 * Everything else (universe construction, publication lag, quintile/IC/t-stat
 * methodology, non-overlapping stride at h=13, bank/non-bank split) is copied
 * unchanged from phase0i.ts for direct comparability.
 *
 * DATA:
 *   - fundamentals + weekly prices: same archive as phase0i.ts (backfillFundamentals.ts)
 *   - weekly broker books: raw_payload_archive endpoint
 *     `/api/broker-summary/{code}?week=YYYY-MM-DD` (backfillBrokerWeekly.ts). ARJUM's
 *     weekly price bars and this backfill both land on Fridays, so no date-alignment
 *     is needed -- the flow factor is read at the SAME rebalance date as everything else.
 *
 * NO LOOK-AHEAD: identical to phase0i.ts (90-day publication lag; holding period starts
 * the week AFTER the signal week's close). The broker book for week-ending Friday t is
 * published by t (it is that week's own summary), so using it as of date t is not a
 * look-ahead the way an as-yet-unpublished quarter would be.
 *
 * CAVEAT: flow/combined coverage is a SUBSET of the fundamentals universe (the weekly
 * broker backfill covers fewer symbols so far) -- reported cross-section sizes make this
 * explicit; MIN_XS still gates every date.
 *
 *   pnpm --filter @idx/backtest exec tsx src/phase0j.ts -- --database-url=... [--out=phase0j.json]
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
const MIN_DAILY_TURNOVER = Number(get("min-daily-turnover") ?? 0);
const FROM = get("from") ?? "2024-07-01";
const TO = get("to") ?? "9999-12-31";
const USE_MEDIAN = process.argv.includes("--median");
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

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
  const m = quarter * 3;
  return new Date(Date.UTC(year, m, 0));
}

interface WeeklyBar {
  date: string;
  close: number;
  volume: number;
}

function looksLikeSplit(prev: WeeklyBar, cur: WeeklyBar): boolean {
  const r = cur.close / prev.close;
  const v = prev.volume > 0 ? cur.volume / prev.volume : 1;
  const near = (x: number, k: number) => Math.abs(x / k - 1) <= 0.08;
  for (const k of SPLIT_KS) {
    if (near(1 / r, k) && v >= 0.6 * k) return true;
    if (near(r, k) && v <= 1 / (0.6 * k)) return true;
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

  // ---------- load fundamentals + weekly prices (same as phase0i.ts) ----------
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

  // ---------- load weekly broker books -> netFlowImbalance per symbol per week ----------
  // Same formula as apps/worker/src/shadow/screeners.ts netFlowImbalance:
  //   sum(net value) / sum(buy value) across the top-20 broker book.
  const brokerRows = rowsOf(
    await db.execute(sql`
      select symbol, payload from raw_payload_archive
      where http_status = 200 and endpoint like '/api/broker-summary/{code}?week=%'`)
  );
  const flowByWeek = new Map<string, Map<string, number>>(); // sym -> weekEndDate -> imbalance
  for (const r of brokerRows) {
    const sym = String(r.symbol);
    const endDate: string | undefined = r.payload?.broker_end_date;
    const brokers: { bval?: number; nval?: number }[] = r.payload?.brokers ?? [];
    if (!endDate || brokers.length === 0) continue;
    const buy = brokers.reduce((s, b) => s + (Number(b.bval) || 0), 0);
    if (!(buy > 0)) continue;
    const net = brokers.reduce((s, b) => s + (Number(b.nval) || 0), 0);
    const m = flowByWeek.get(sym) ?? new Map<string, number>();
    m.set(endDate, net / buy);
    flowByWeek.set(sym, m);
  }

  // ---------- shares outstanding (same as phase0i.ts) ----------
  const mcapPages = rowsOf(
    await db.execute(sql`select payload from raw_payload_archive where endpoint = '/api/market-cap' and http_status = 200 order by received_at desc`)
  );
  const shares = new Map<string, number>();
  for (const p of mcapPages)
    for (const e of p.payload?.data ?? []) {
      const s = Number(e.listed_shares);
      if (!shares.has(String(e.code)) && Number.isFinite(s) && s > 0) shares.set(String(e.code), s);
    }

  // ---------- universe (same filter as phase0i.ts; flow coverage handled per-date below) ----------
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

  // ---------- rebalance dates: first weekly bar of each month (same as phase0i.ts) ----------
  const allDates = [...new Set(universe.flatMap((s) => weekly.get(s)!.map((b) => b.date)))].sort();
  const rebalance: string[] = [];
  let lastMonth = "";
  for (const d of allDates) {
    if (d < FROM || d > TO) continue;
    const mth = d.slice(0, 7);
    if (mth !== lastMonth) {
      rebalance.push(d);
      lastMonth = mth;
    }
  }

  // ---------- observations ----------
  const FACTORS = ["ROE", "ROA", "EP", "BP", "CFP", "size", "NIyoy", "QV", "flow", "combined", "placebo_random"];
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
      if (MIN_DAILY_TURNOVER > 0) {
        if (i < 7) continue;
        const liq = mean(bars.slice(i - 7, i + 1).map((b) => b.close * b.volume)) / 5;
        if (!(liq >= MIN_DAILY_TURNOVER)) continue;
      }
      const qs = quarters.get(sym)!;
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
      const flow = flowByWeek.get(sym)?.get(t) ?? null;
      const f: Record<string, number | null> = {
        ROE: ni !== null && cur.equity && cur.equity > 0 ? ni / cur.equity : null,
        ROA: ni !== null && cur.assets && cur.assets > 0 ? ni / cur.assets : null,
        EP: ni !== null ? ni / mcap : null,
        BP: cur.equity && cur.equity > 0 ? cur.equity / mcap : null,
        CFP: ocf !== null ? ocf / mcap : null,
        size: Math.log(mcap),
        NIyoy: cur.ni !== undefined && yoyBase !== undefined && yoyBase !== 0 ? Math.max(-2, Math.min(2, (cur.ni - yoyBase) / Math.abs(yoyBase))) : null,
        QV: null,
        flow,
        combined: null,
        placebo_random: rand()
      };
      const fwd: Record<number, number> = {};
      for (const h of HORIZONS) {
        const a = bars[i + 1];
        const b = bars[i + 1 + h];
        if (a && b) fwd[h] = b.close / a.close - 1;
      }
      if (Object.keys(fwd).length === 0) continue;
      obs.push({ date: t, sym, bank: isBank.has(sym), f, fwd });
    }
  }

  // QV composite = average per-date rank of ROE, EP, CFP (needs all three) -- unchanged from phase0i.ts
  for (const t of rebalance) {
    const rows = obs.filter((o) => o.date === t && o.f.ROE !== null && o.f.EP !== null && o.f.CFP !== null);
    if (rows.length < MIN_XS) continue;
    const rr = (name: string) => ranks(rows.map((o) => o.f[name] as number));
    const a = rr("ROE");
    const b = rr("EP");
    const c = rr("CFP");
    rows.forEach((o, k) => (o.f.QV = (a[k]! + b[k]! + c[k]!) / 3));
  }

  // combined = average RANK of QV and flow, among names where BOTH are available that date
  // (re-ranked within this subset, not the broader QV-only or flow-only populations).
  for (const t of rebalance) {
    const rows = obs.filter((o) => o.date === t && o.f.QV !== null && o.f.flow !== null);
    if (rows.length < MIN_XS) continue;
    const qvRank = ranks(rows.map((o) => o.f.QV as number));
    const flowRank = ranks(rows.map((o) => o.f.flow as number));
    rows.forEach((o, k) => (o.f.combined = (qvRank[k]! + flowRank[k]!) / 2));
  }

  const dbg = get("debug");
  if (dbg) {
    const rows = obs.filter((o) => o.sym === dbg).slice(-3);
    for (const o of rows) console.log(`[debug ${dbg}] ${o.date} bank=${o.bank} ` + JSON.stringify(Object.fromEntries(Object.entries(o.f).map(([k, v]) => [k, v === null ? null : Number(v.toFixed(4))]))));
  }

  // ---------- analysis (unchanged from phase0i.ts) ----------
  const analyse = (filter: (o: Obs) => boolean) => {
    const out: Record<string, unknown>[] = [];
    for (const name of FACTORS) {
      const perH: Record<string, unknown> = {};
      for (const h of HORIZONS) {
        const ics: number[] = [];
        const qArr: number[][] = [[], [], [], [], []];
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
            qArr[q]!.push(excess[k]!);
          });
        }
        const stride = h >= 13 ? 3 : 1;
        const strided = ics.filter((_, k) => k % stride === 0);
        const q = qArr.map((xs) => (xs.length > 0 ? (USE_MEDIAN ? median(xs) : mean(xs)) * 100 : NaN));
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

  const perDate = rebalance.map((t) => ({
    date: t,
    n: obs.filter((o) => o.date === t).length,
    nFlow: obs.filter((o) => o.date === t && o.f.flow !== null).length
  }));
  const report = {
    generatedAt: new Date().toISOString(),
    universe: { used: universe.length, banks: universe.filter((s) => isBank.has(s)).length, droppedSplit, droppedData },
    flowCoverage: { symbols: flowByWeek.size },
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
  console.log(
    `universe used=${universe.length} (banks ${report.universe.banks}), flow coverage=${flowByWeek.size} symbols, droppedSplit=${droppedSplit}, droppedData=${droppedData}, rebalance dates=${rebalance.length} (${report.window.from}..${report.window.to}), lag=${PUBLICATION_LAG_DAYS}d`
  );
  console.log(`cross-section sizes (n / nFlow): ${perDate.map((p) => `${p.n}/${p.nFlow}`).join(",")}`);
  console.log(`\nALL (incl. banks):\n${fmt(report.all)}`);
  console.log(`\nNON-BANK:\n${fmt(report.nonBank)}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
