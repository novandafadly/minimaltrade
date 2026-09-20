#!/usr/bin/env node
/**
 * Phase 0E: does the broker-flow score carry ANY predictive information?
 *
 * With full per-day broker books backfilled from `/api/broker-summary`
 * (backfillBrokerSummary.ts), the real engine can finally be replayed. The
 * trade-level replay (`signal_from_history`) produced ~1 trade in ~900
 * symbol-days and `diagnose.ts` showed why: the hard gates (CONCENTRATION
 * blocks 94%) are calibrated for broad accumulation, while real IDX net-buying
 * is dominated by one broker (avg top-1 share 0.69, ~2.4 meaningful buyers).
 * A trade count that small says nothing about whether the SCORE is useful.
 *
 * So this skips the gates and asks the statistical question directly: on each
 * date, rank the candidates by a signal and measure how those ranks relate to
 * FORWARD returns.
 *   - IC        per-date Spearman rank correlation(signal, forward excess return)
 *   - quintiles per-date signal quintiles -> mean forward excess return, Q5-Q1
 * Excess return = return minus that date's cross-sectional mean (removes the
 * market move). Signals tested: the engine's composite + each component, a
 * simple net-flow imbalance, and two trivial controls (5-day momentum, volume
 * pace) -- broker flow only "adds value" if it beats/complements those.
 *
 * Observations: one per (symbol, date) with a FULL broker book (>= 12 brokers)
 * for the last day and its whole lookback. Overlapping 5-day windows inflate
 * the plain t-stat, so a non-overlapping (5-date stride) t-stat is reported too.
 *
 *   pnpm --filter @idx/backtest exec tsx src/phase0e.ts -- --database-url=... [--out=phase0e.json] [--horizon=5]
 *
 * Reads only Postgres -- zero API calls.
 */
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import {
  computeFeatureSnapshot,
  scoreCandidate,
  type FeatureEngineInput,
  type HistoryData,
  type ScreenerRow
} from "@idx/domain";
import { PostgresDataSource } from "./dataSource/postgres.js";
import { liquidCandidates } from "./baselines.js";

const FULL_BOOK_MIN = 12;

function get(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : undefined;
}

function quoteFromHistory(h: HistoryData): ScreenerRow {
  const last = h.bars[h.bars.length - 1];
  const prev = h.bars[h.bars.length - 2];
  const price = last?.close ?? 0;
  const prevClose = prev?.close ?? price;
  return {
    symbol: h.symbol,
    board: null,
    price,
    priceChange: price - prevClose,
    priceChangePct: prevClose > 0 ? (price - prevClose) / prevClose : 0,
    volume: last?.volume ?? 0,
    turnover: last?.turnover ?? 0,
    bestBid: null,
    bestOffer: null,
    spread: null,
    isSuspended: false,
    notation: null
  };
}

/** average ranks (ties share the mean rank), 1-based */
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

interface Obs {
  date: string;
  symbol: string;
  signals: Record<string, number>;
  fwd: number; // forward return over the horizon
}

async function main() {
  const dbUrl = get("database-url") ?? process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required");
  const horizon = Number(get("horizon") ?? 5);
  const cfg = DEFAULT_STRATEGY_CONFIG;
  const { createDbClient } = await import("@idx/db");
  const src = new PostgresDataSource(createDbClient(dbUrl));
  if (!src.getBrokerHistoryAsOf) throw new Error("data source has no broker history");

  const dates = await src.listTradingDates();
  const obs: Obs[] = [];
  const lookback = cfg.concentration.persistenceWindowDays;

  for (const date of dates) {
    const asOf = `${date}T23:59:59.999Z`;
    const universe = liquidCandidates(await src.listUniverseAsOf(asOf));
    for (const u of universe) {
      const brokerDays = await src.getBrokerHistoryAsOf(u.symbol, asOf, lookback);
      if (brokerDays.length === 0 || !brokerDays.every((d) => d.brokers.length >= FULL_BOOK_MIN)) continue;
      const env = await src.getHistoryAsOf(u.symbol, asOf);
      const history = env?.data;
      if (!history || history.bars.length < 21) continue;
      const fwdBars = await src.getSimulationBars(u.symbol, date, horizon);
      if (fwdBars.length < horizon) continue; // need the full forward window
      const last = history.bars[history.bars.length - 1]!;
      if (!(last.close > 0)) continue;
      const fwd = fwdBars[horizon - 1]!.close / last.close - 1;

      const quote = quoteFromHistory(history);
      const input: FeatureEngineInput = {
        symbol: u.symbol,
        tradingDate: date,
        inputSnapshotId: `${u.symbol}:${date}:phase0e`,
        screener: quote,
        history,
        brokerSummaryByDay: brokerDays,
        brokerAccumulation: null,
        seasonal: null,
        insiders: null,
        segmentSeparable: true,
        dataStale: false
      };
      const feature = computeFeatureSnapshot(input, cfg, `${date}T09:00:00.000Z`);
      const score = scoreCandidate(
        { features: feature, userOpenRiskPct: 0, hasUnreviewedNews: false, netRewardToRiskEstimate: cfg.risk.minNetRewardToRisk },
        cfg
      );

      const book = brokerDays[brokerDays.length - 1]!;
      const netTotal = book.brokers.reduce((s, b) => s + b.netValue, 0);
      const grossBuy = book.brokers.reduce((s, b) => s + b.buyValue, 0);
      const c = score.components;
      const bars = history.bars;
      const close5 = bars[bars.length - 6]?.close;
      const avgVol20 = bars.slice(-21, -1).reduce((s, b) => s + b.volume, 0) / 20;

      obs.push({
        date,
        symbol: u.symbol,
        fwd,
        signals: {
          composite: score.compositeScore,
          brokerFlowQuality: c.brokerFlowQuality,
          volumeAnomaly: c.volumeAnomaly,
          smartMoneyMargin: c.smartMoneyMargin,
          priceResponse: c.priceResponse,
          netFlowImbalance: grossBuy > 0 ? netTotal / grossBuy : 0,
          // controls
          ctrl_momentum5: close5 && close5 > 0 ? last.close / close5 - 1 : 0,
          ctrl_volumePace: avgVol20 > 0 ? last.volume / avgVol20 : 1
        }
      });
    }
  }

  // --- per-date cross-sectional analysis ---
  const byDate = new Map<string, Obs[]>();
  for (const o of obs) byDate.set(o.date, [...(byDate.get(o.date) ?? []), o]);
  const usableDates = [...byDate.entries()].filter(([, v]) => v.length >= 8).sort(([a], [b]) => a.localeCompare(b));

  const signalNames = Object.keys(obs[0]?.signals ?? {});
  const results = signalNames.map((name) => {
    const ics: { date: string; ic: number }[] = [];
    const qSum = [0, 0, 0, 0, 0];
    const qN = [0, 0, 0, 0, 0];
    for (const [date, rows] of usableDates) {
      const m = mean(rows.map((r) => r.fwd));
      const excess = rows.map((r) => r.fwd - m);
      const sig = rows.map((r) => r.signals[name]!);
      const ic = spearman(sig, excess);
      if (ic !== null) ics.push({ date, ic });
      const rk = ranks(sig);
      rows.forEach((_, i) => {
        const q = Math.min(4, Math.floor(((rk[i]! - 1) / rows.length) * 5));
        qSum[q]! += excess[i]!;
        qN[q]! += 1;
      });
    }
    const icVals = ics.map((x) => x.ic);
    const strided = ics.filter((_, i) => i % horizon === 0).map((x) => x.ic);
    const qMean = qSum.map((s, i) => (qN[i]! > 0 ? s / qN[i]! : NaN));
    return {
      signal: name,
      dates: icVals.length,
      meanIC: Number(mean(icVals).toFixed(4)),
      icHitRate: Number((icVals.filter((v) => v > 0).length / Math.max(1, icVals.length)).toFixed(2)),
      tStat_overlapping: Number(tstat(icVals).toFixed(2)),
      tStat_nonOverlapping: Number(tstat(strided).toFixed(2)),
      quintileMeanExcessFwdRet_Q1toQ5: qMean.map((v) => Number((v * 100).toFixed(2))), // percent
      spreadQ5minusQ1_pct: Number(((qMean[4]! - qMean[0]!) * 100).toFixed(2))
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    configVersion: cfg.version,
    horizonBars: horizon,
    observations: obs.length,
    symbols: new Set(obs.map((o) => o.symbol)).size,
    usableDates: usableDates.length,
    window: { from: usableDates[0]?.[0], to: usableDates[usableDates.length - 1]?.[0] },
    note:
      "IC = per-date Spearman(signal, forward excess return). |t| < 2 = indistinguishable from noise. " +
      "Overlapping 5-day windows inflate tStat_overlapping; trust tStat_nonOverlapping. " +
      "ctrl_* rows are trivial benchmarks the broker-flow signals must beat.",
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
