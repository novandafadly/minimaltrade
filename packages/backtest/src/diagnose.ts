#!/usr/bin/env node
/**
 * Ad-hoc diagnostic: for a handful of trading dates, run the signal-from-
 * history reconstruction and print WHY candidates are/aren't becoming
 * actionable trades — category distribution, gate-failure counts, and how
 * many symbols even had usable broker history.
 *
 *   pnpm --filter @idx/backtest exec tsx src/diagnose.ts -- --database-url=...
 */
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import {
  computeFeatureSnapshot,
  scoreCandidate,
  buildRiskPlan,
  type FeatureEngineInput,
  type HistoryData,
  type ScreenerRow
} from "@idx/domain";
import { PostgresDataSource } from "./dataSource/postgres.js";
import { liquidCandidates } from "./baselines.js";

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

async function main() {
  const dbUrl =
    process.argv.find((a) => a.startsWith("--database-url="))?.slice("--database-url=".length) ?? process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required");
  const { createDbClient } = await import("@idx/db");
  const src = new PostgresDataSource(createDbClient(dbUrl));
  const cfg = DEFAULT_STRATEGY_CONFIG;

  // Relaxed variant: the historical broker feed (/api/broker-accumulation,
  // ~5 net movers/day) cannot satisfy the concentration gate designed for the
  // full ~30-broker book. Loosen it to what the sparse feed CAN express so we
  // can still see whether the rest of the engine adds signal.
  const relaxed = {
    ...cfg,
    concentration: { ...cfg.concentration, minMeaningfulBuyers: 1, top1ShareMax: 0.95, top3ShareMax: 0.99, hhiMax: 0.95, persistenceMinDays: 1 }
  };

  const dates = await src.listTradingDates();
  const sample = dates.slice(-40).filter((_, i) => i % 5 === 0); // ~8 recent dates

  const catCount: Record<string, number> = {};
  const gateFail: Record<string, number> = {};
  const relaxedCat: Record<string, number> = {};
  const relaxedGateFail: Record<string, number> = {};
  let evaluated = 0;
  let noBroker = 0;
  let bAvgNull = 0;
  const breadths: number[] = [];
  const top1s: number[] = [];

  for (const date of sample) {
    const asOf = `${date}T23:59:59.999Z`;
    const universe = liquidCandidates(await src.listUniverseAsOf(asOf));
    for (const u of universe) {
      const hist = await src.getHistoryAsOf(u.symbol, asOf);
      if (!hist || hist.data.bars.length < 20) continue;
      const bh = await src.getBrokerHistoryAsOf(u.symbol, asOf, cfg.concentration.persistenceWindowDays);
      if (bh.length === 0) {
        noBroker += 1;
        continue;
      }
      const quote = quoteFromHistory(hist.data);
      const fi: FeatureEngineInput = {
        symbol: u.symbol,
        tradingDate: date,
        inputSnapshotId: "diag",
        screener: quote,
        history: hist.data,
        brokerSummaryByDay: bh,
        brokerAccumulation: null,
        seasonal: null,
        insiders: null,
        segmentSeparable: true,
        dataStale: false
      };
      const f = computeFeatureSnapshot(fi, cfg, `${date}T09:00:00Z`);
      breadths.push(f.brokerFlow.meaningfulBuyerCount);
      top1s.push(f.brokerFlow.top1Share);
      if (f.brokerFlow.bAvg === null) bAvgNull += 1;
      const entry =
        f.price.pctAboveBAvg !== null && f.brokerFlow.bAvg !== null
          ? f.brokerFlow.bAvg * (1 + f.price.pctAboveBAvg)
          : quote.price;
      const s1 = scoreCandidate(
        { features: f, userOpenRiskPct: 0, hasUnreviewedNews: false, netRewardToRiskEstimate: cfg.risk.minNetRewardToRisk },
        cfg
      );
      const p1 = buildRiskPlan(
        { symbol: u.symbol, tradingDate: date, entryTrigger: entry, stopLossRaw: entry * 0.97, score: s1, sessionEndIso: `${date}T08:49:00Z` },
        cfg
      );
      const s2 = scoreCandidate(
        { features: f, userOpenRiskPct: 0, hasUnreviewedNews: false, netRewardToRiskEstimate: p1.netRewardToRisk },
        cfg
      );
      evaluated += 1;
      catCount[s2.category] = (catCount[s2.category] ?? 0) + 1;
      for (const g of s2.gates) if (!g.passed) gateFail[g.gate] = (gateFail[g.gate] ?? 0) + 1;

      // relaxed variant + STRUCTURE-BASED preliminary stop (5-day low, like
      // the baselines) instead of the deep funnel's flat 3%.
      const rf = computeFeatureSnapshot(fi, relaxed, `${date}T09:00:00Z`);
      const rEntry =
        rf.price.pctAboveBAvg !== null && rf.brokerFlow.bAvg !== null
          ? rf.brokerFlow.bAvg * (1 + rf.price.pctAboveBAvg)
          : quote.price;
      const low5 = Math.min(...hist.data.bars.slice(-5).map((b) => b.low));
      const rStop = low5 < rEntry ? low5 : rEntry * 0.94; // structure low, else 6%
      const rs1 = scoreCandidate(
        { features: rf, userOpenRiskPct: 0, hasUnreviewedNews: false, netRewardToRiskEstimate: relaxed.risk.minNetRewardToRisk },
        relaxed
      );
      const rp1 = buildRiskPlan(
        { symbol: u.symbol, tradingDate: date, entryTrigger: rEntry, stopLossRaw: rStop, score: rs1, sessionEndIso: `${date}T08:49:00Z` },
        relaxed
      );
      const rs2 = scoreCandidate(
        { features: rf, userOpenRiskPct: 0, hasUnreviewedNews: false, netRewardToRiskEstimate: rp1.netRewardToRisk },
        relaxed
      );
      relaxedCat[rs2.category] = (relaxedCat[rs2.category] ?? 0) + 1;
      for (const g of rs2.gates) if (!g.passed) relaxedGateFail[g.gate] = (relaxedGateFail[g.gate] ?? 0) + 1;
    }
  }

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  console.log(JSON.stringify(
    {
      sampleDates: sample,
      evaluated,
      skippedNoBrokerHistory: noBroker,
      bAvgNull,
      avgMeaningfulBuyerCount: Number(avg(breadths).toFixed(2)),
      avgTop1Share: Number(avg(top1s).toFixed(3)),
      categoryDistribution: catCount,
      gateFailureCounts: gateFail,
      relaxedCategoryDistribution: relaxedCat,
      relaxedGateFailureCounts: relaxedGateFail
    },
    null,
    2
  ));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
