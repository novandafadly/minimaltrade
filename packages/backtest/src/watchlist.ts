#!/usr/bin/env node
/**
 * Provisional REVIEW watchlist (not a buy list) as of the latest daily bar.
 *
 * Nothing tested so far shows a tradeable edge (Phases 0E-0H), so this makes no
 * prediction. It lists liquid names that satisfy the weak / hygiene criteria we
 * actually have, with each criterion flagged by how strong its evidence is:
 *
 *   TREND    close > SMA20 > SMA50, within 3% of the 20-day high, 20-day return > 0
 *            (weak lead: positive excess over a same-day random pick under stop/target
 *             exits in both halves in Phase 0H, individually insignificant; being
 *             forward-tested as `screener_technical`)
 *   FLOW     day's net-flow imbalance of the top-20 broker book in the TOP 30% of the
 *            universe that has data. It must be RELATIVE: the listed brokers are the
 *            top 20, so the imbalance is structurally positive for almost every stock
 *            (+30% to +90%) and "> 0" carries no information. (Small consistently
 *            positive rank-IC in Phase 0E, below costs; forward-tested as
 *            `screener_flow`.) Only where a full-book day is stored.
 *   QUALITY  trailing-4-quarter net income > 0 AND operating cash flow > 0, using only
 *            statements public by the as-of date (quarter end + 90 days)
 *            (hygiene filter: profitability is a robust factor in Indonesia per the
 *             literature; NOT tested here yet -- Phase 0I is running)
 *
 * The order is by number of flags met, NOT by expected return. Position numbers come from
 * the real risk engine (5-day-low stop, Rp3.8M capital) so the size/stop are realistic.
 *
 *   pnpm --filter @idx/backtest exec tsx src/watchlist.ts -- --database-url=... [--top=30] [--min-turnover=2000000000]
 */
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import type { HistoryData, OhlcvBar } from "@idx/domain";
import { planFromHistory } from "./baselines.js";

function get(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : undefined;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "n/a");

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
const qKey = (y: number, q: number) => y * 4 + (q - 1);
const qEnd = (y: number, q: number) => new Date(Date.UTC(y, q * 3, 0));

async function main() {
  const dbUrl = get("database-url") ?? process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required");
  const top = Number(get("top") ?? 30);
  const minTurnover = Number(get("min-turnover") ?? 2_000_000_000);
  const cfg = DEFAULT_STRATEGY_CONFIG;
  const { createDbClient } = await import("@idx/db");
  const { sql } = await import("drizzle-orm");
  const db = createDbClient(dbUrl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rowsOf = (res: any): any[] => (Array.isArray(res) ? res : (res?.rows ?? []));

  const bars = rowsOf(
    await db.execute(sql`select symbol, trading_date, open, high, low, close, volume, coalesce(turnover, close * volume) as turnover
                         from daily_bar order by symbol, trading_date`)
  );
  const bySym = new Map<string, OhlcvBar[]>();
  for (const r of bars) {
    const a = bySym.get(String(r.symbol)) ?? [];
    a.push({
      date: String(r.trading_date),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      turnover: Number(r.turnover)
    });
    bySym.set(String(r.symbol), a);
  }
  const asOf = [...bySym.values()].map((b) => b[b.length - 1]!.date).sort().pop()!;
  const asOfDate = new Date(`${asOf}T00:00:00Z`);

  // FLOW: net-flow imbalance of the stored full book on the as-of date
  const flowRows = rowsOf(
    await db.execute(sql`
      select symbol, sum(net_value::numeric) net, sum(buy_value::numeric) buy, count(*) n
      from broker_snapshot where trading_date = ${asOf} group by symbol having count(*) >= 12`)
  );
  const flow = new Map<string, number>();
  for (const r of flowRows) if (Number(r.buy) > 0) flow.set(String(r.symbol), Number(r.net) / Number(r.buy));

  // QUALITY: TTM net income and operating cash flow from archived statements, public by asOf
  const st = rowsOf(
    await db.execute(sql`
      select distinct on (endpoint, symbol) endpoint, symbol, payload from raw_payload_archive
      where http_status = 200 and endpoint like '/api/financial-statements/%report_type%'
      order by endpoint, symbol, received_at desc`)
  );
  const ni = new Map<string, Map<number, number>>();
  const ocf = new Map<string, Map<number, number>>();
  for (const r of st) {
    const sym = String(r.symbol);
    const isIncome = String(r.endpoint).includes("INCOME_STATEMENT");
    const isCash = String(r.endpoint).includes("CASH_FLOW");
    if (!isIncome && !isCash) continue;
    const m = new Map<number, number>();
    for (const it of r.payload?.items ?? []) {
      const v = isIncome
        ? (path(it.data, "laba_rugi_yang_dapat_diatribusikan.laba_rugi_yang_dapat_diatribusikan_ke_entitas_induk") ?? path(it.data, "laba_rugi"))
        : path(it.data, "arus_kas_dari_aktivitas_operasi.total");
      if (v !== null) m.set(qKey(Number(it.year), Number(it.quarter)), v);
    }
    (isIncome ? ni : ocf).set(sym, m);
  }
  const ttm = (m: Map<number, number> | undefined): number | null => {
    if (!m) return null;
    let L = -1;
    for (const k of m.keys()) {
      const y = Math.floor(k / 4);
      const q = (k % 4) + 1;
      if (qEnd(y, q).getTime() + 90 * 86400000 <= asOfDate.getTime() && k > L) L = k;
    }
    if (L < 0) return null;
    const parts = [0, 1, 2, 3].map((i) => m.get(L - i));
    return parts.every((x) => x !== undefined) ? (parts as number[]).reduce((a, b) => a + b, 0) : null;
  };

  interface Row {
    symbol: string;
    close: number;
    trend: boolean;
    flow: number | null;
    quality: boolean | null;
    ret20: number;
    volPace: number;
    stopPct: number | null;
    lots: number | null;
    rr: number | null;
    noTrade: boolean;
    flowTop: boolean;
    flags: number;
    turnover: number;
  }
  const out: Row[] = [];
  for (const [symbol, b] of bySym) {
    const i = b.length - 1;
    if (b[i]!.date !== asOf || i < 60) continue;
    const c = b[i]!;
    const avgTo = mean(b.slice(i - 19, i + 1).map((x) => x.turnover ?? x.close * x.volume));
    if (c.close < 51 || !(avgTo >= minTurnover)) continue;
    const sma = (n: number) => mean(b.slice(i - n + 1, i + 1).map((x) => x.close));
    const hi20 = Math.max(...b.slice(i - 19, i + 1).map((x) => x.high));
    const ret20 = c.close / b[i - 20]!.close - 1;
    const trend = c.close > sma(20) && sma(20) > sma(50) && c.close >= hi20 * 0.97 && ret20 > 0;
    const volPace = c.volume / (mean(b.slice(i - 20, i).map((x) => x.volume)) || 1);
    const fl = flow.has(symbol) ? flow.get(symbol)! : null;
    const n = ttm(ni.get(symbol));
    const o = ttm(ocf.get(symbol));
    const quality = n === null || o === null ? null : n > 0 && o > 0;
    const history: HistoryData = { symbol, bars: b.slice(Math.max(0, i - 119)), baselineMedianVolume20d: null };
    const plan = planFromHistory(symbol, asOf, history, cfg, `${asOf}T08:49:00.000Z`, "low5");
    const flags = 0; // filled after the cross-sectional flow threshold is known
    out.push({
      symbol,
      close: c.close,
      trend,
      flow: fl,
      quality,
      ret20,
      volPace,
      stopPct: plan ? (plan.entryTrigger - plan.slPrice) / plan.entryTrigger : null,
      lots: plan ? plan.totalLots : null,
      rr: plan ? plan.netRewardToRisk : null,
      noTrade: plan ? plan.isNoTrade : true,
      flowTop: false,
      flags,
      turnover: avgTo
    });
  }

  // FLOW is relative: top 30% of the imbalances among names that have a full book today
  const flows = out.filter((r) => r.flow !== null).map((r) => r.flow as number).sort((a, b) => a - b);
  const flowCut = flows.length ? flows[Math.floor(flows.length * 0.7)]! : Infinity;
  for (const r of out) {
    r.flowTop = r.flow !== null && r.flow >= flowCut;
    r.flags = (r.trend ? 1 : 0) + (r.flowTop ? 1 : 0) + (r.quality === true ? 1 : 0);
  }

  // order: flags met (desc), then liquidity (desc) -- NOT an expected-return ranking
  out.sort((a, b) => b.flags - a.flags || b.turnover - a.turnover);
  const yn = (v: boolean | null) => (v === null ? "n/a" : v ? "yes" : "no");
  console.log(`As of ${asOf} close. Universe: ${out.length} liquid names (avg turnover >= Rp${(minTurnover / 1e9).toFixed(1)}B, price >= 51).`);
  console.log(`Flags met: 3 -> ${out.filter((r) => r.flags === 3).length}, 2 -> ${out.filter((r) => r.flags === 2).length}, 1 -> ${out.filter((r) => r.flags === 1).length}, 0 -> ${out.filter((r) => r.flags === 0).length}`);
  console.log(`FLOW cutoff (70th percentile of net-flow imbalance among ${flows.length} names with a full book): ${(flowCut * 100).toFixed(0)}%`);
  console.log(`Flow data available for ${out.filter((r) => r.flow !== null).length}/${out.length}; quality data for ${out.filter((r) => r.quality !== null).length}/${out.length}.\n`);
  console.log("sym    close  flags trend flow(imb)  quality ret20   volPace stop%   lots  netRR  engine");
  for (const r of out.filter((x) => x.flags >= 1).slice(0, top))
    console.log(
      `${r.symbol.padEnd(6)} ${String(r.close).padStart(6)}  ${r.flags}/3   ${yn(r.trend).padEnd(5)} ${(r.flow === null ? "n/a" : (r.flow * 100).toFixed(0) + "%" + (r.flowTop ? " TOP" : "")).padEnd(10)} ${yn(r.quality).padEnd(7)} ${pct(r.ret20).padStart(6)} ${r.volPace.toFixed(1).padStart(6)}x ${pct(r.stopPct ?? NaN).padStart(6)} ${String(r.lots ?? "-").padStart(5)} ${(r.rr ?? 0).toFixed(2).padStart(6)}  ${r.noTrade ? "NO_TRADE" : "plan ok"}`
    );
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
