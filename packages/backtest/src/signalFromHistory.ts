import type { StrategyConfig } from "@idx/config";
import {
  computeFeatureSnapshot,
  scoreCandidate,
  buildRiskPlan,
  type BrokerSummaryData,
  type FeatureEngineInput,
  type HistoryData,
  type ScreenerRow,
  type SignalCategory,
  type TradePlan
} from "@idx/domain";
import type { LiquidUniverseEntry, ReplayDataSource } from "./dataSource/types.js";
import { liquidCandidates } from "./baselines.js";

/**
 * "signal_from_history" replay strategy.
 *
 * Reconstructs, for a historical trading date, the exact `FeatureEngineInput`
 * the live deep funnel would have built, runs the REAL pure engines
 * (`computeFeatureSnapshot` → `scoreCandidate` → `buildRiskPlan`, unchanged
 * from @idx/domain), and returns the TradePlans for the top-N candidates
 * whose category is actionable (STRONG_BUY / SPECULATIVE_BUY by default).
 *
 * This is what lets the backtest answer "does the broker-flow / composite
 * score add value over the liquidity baselines?" — the same question shadow
 * mode would answer forward, but against ~120 days of already-available data.
 *
 * KNOWN GAPS vs the live pipeline (all one-directional — they make the
 * backtest CONSERVATIVE, never optimistic):
 *  - broker_summary gross buy/sell is approximated from net flow (see
 *    backfill.ts), so `suspectedTransfer` / `failedAbsorption` under-trigger.
 *  - `seasonal` and `insiders` confluence inputs are null (no historical
 *    store) — confluence contributes 0, same as the baselines get.
 *  - `brokerAccumulation` (unused by the feature engine) is null.
 */

const DEEP_FUNNEL_PRELIMINARY_STOP_PCT = 0.03;

export interface SignalFromHistoryDeps {
  dataSource: ReplayDataSource;
  universe: LiquidUniverseEntry[];
  historyBySymbol: Map<string, HistoryData>;
  tradingDate: string;
  sessionEndIso: string;
  config: StrategyConfig;
  maxCandidates: number;
  /** categories that count as an actionable "buy" trade. */
  actionableCategories?: Set<SignalCategory>;
}

/** Per-symbol quote (ScreenerRow) from the latest history bar — mirrors the
 * worker adapter's quoteFromHistory. */
function quoteFromHistory(history: HistoryData): ScreenerRow {
  const last = history.bars[history.bars.length - 1] ?? null;
  const prev = history.bars[history.bars.length - 2] ?? null;
  const price = last?.close ?? 0;
  const prevClose = prev?.close ?? price;
  return {
    symbol: history.symbol,
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

export async function signalFromHistoryStrategy(deps: SignalFromHistoryDeps): Promise<TradePlan[]> {
  if (!deps.dataSource.getBrokerHistoryAsOf) return [];
  const actionable = deps.actionableCategories ?? new Set<SignalCategory>(["STRONG_BUY", "SPECULATIVE_BUY"]);
  const asOf = `${deps.tradingDate}T23:59:59.999Z`;

  const scored: { symbol: string; composite: number; entryTrigger: number; stopLossRaw: number; category: SignalCategory }[] =
    [];

  // Same liquidity eligibility as the baselines, so the comparison isolates
  // "which symbols the score picks" from "which symbols are tradeable".
  for (const u of liquidCandidates(deps.universe)) {
    const history = deps.historyBySymbol.get(u.symbol);
    if (!history || history.bars.length < 20) continue;

    const brokerSummaryByDay: BrokerSummaryData[] = await deps.dataSource.getBrokerHistoryAsOf(
      u.symbol,
      asOf,
      deps.config.concentration.persistenceWindowDays
    );
    if (brokerSummaryByDay.length === 0) continue;

    const quote = quoteFromHistory(history);
    if (!Number.isFinite(quote.price) || quote.price <= 0) continue;

    const featureInput: FeatureEngineInput = {
      symbol: u.symbol,
      tradingDate: deps.tradingDate,
      inputSnapshotId: `${u.symbol}:${deps.tradingDate}:backtest`,
      screener: quote,
      history,
      brokerSummaryByDay,
      brokerAccumulation: null,
      seasonal: null,
      insiders: null,
      segmentSeparable: true,
      dataStale: false
    };

    const feature = computeFeatureSnapshot(featureInput, deps.config, `${deps.tradingDate}T09:00:00.000Z`);

    const entryTrigger =
      feature.price.pctAboveBAvg !== null && feature.brokerFlow.bAvg !== null
        ? feature.brokerFlow.bAvg * (1 + feature.price.pctAboveBAvg)
        : quote.price;
    const stopLossRaw = entryTrigger * (1 - DEEP_FUNNEL_PRELIMINARY_STOP_PCT);

    // Two-pass scoring, identical to deep.ts.
    const prelimScore = scoreCandidate(
      { features: feature, userOpenRiskPct: 0, hasUnreviewedNews: false, netRewardToRiskEstimate: deps.config.risk.minNetRewardToRisk },
      deps.config
    );
    const prelimPlan = buildRiskPlan(
      { symbol: u.symbol, tradingDate: deps.tradingDate, entryTrigger, stopLossRaw, score: prelimScore, sessionEndIso: deps.sessionEndIso },
      deps.config
    );
    const finalScore = scoreCandidate(
      { features: feature, userOpenRiskPct: 0, hasUnreviewedNews: false, netRewardToRiskEstimate: prelimPlan.netRewardToRisk },
      deps.config
    );

    scored.push({
      symbol: u.symbol,
      composite: finalScore.compositeScore,
      entryTrigger,
      stopLossRaw,
      category: finalScore.category
    });
  }

  const winners = scored
    .filter((s) => actionable.has(s.category))
    .sort((a, b) => b.composite - a.composite)
    .slice(0, deps.maxCandidates);

  const plans: TradePlan[] = [];
  for (const w of winners) {
    // Re-score once more only to feed buildRiskPlan the correct final score
    // object; cheap and keeps the plan's embedded score consistent.
    const plan = buildRiskPlan(
      {
        symbol: w.symbol,
        tradingDate: deps.tradingDate,
        entryTrigger: w.entryTrigger,
        stopLossRaw: w.stopLossRaw,
        score: {
          symbol: w.symbol,
          tradingDate: deps.tradingDate,
          formulaVersion: deps.config.formulaVersion,
          configVersion: deps.config.version,
          components: { brokerFlowQuality: 0, volumeAnomaly: 0, smartMoneyMargin: 0, priceResponse: 0, confluence: 0 },
          compositeScore: w.composite,
          category: w.category,
          gates: [],
          noTradeReason: null,
          confidence: "medium"
        },
        sessionEndIso: deps.sessionEndIso
      },
      deps.config
    );
    if (!plan.isNoTrade) plans.push(plan);
  }
  return plans;
}
