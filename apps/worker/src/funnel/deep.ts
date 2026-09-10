import type { Redis } from "ioredis";
import type { Db } from "@idx/db";
import type { Env, StrategyConfig } from "@idx/config";
import {
  computeFeatureSnapshot,
  scoreCandidate,
  buildRiskPlan,
  assembleSignal,
  type FeatureEngineInput,
  type ScreenerRow,
  type DataEnvelope,
  type BrokerSummaryData,
  type BrokerAccumulationData,
  type HistoryData,
  type SeasonalData,
  type InsiderTransaction,
  type FeatureSnapshot,
  type Signal
} from "@idx/domain";
import type { AdapterContext } from "../adapter/endpoints.js";
import {
  getBrokerSummary,
  getBrokerAccumulation,
  getAnalysis,
  getSeasonal,
  getInsiders,
  getFinancialStatements,
  getHistory,
  quoteEnvelopeFromHistory
} from "../adapter/endpoints.js";
import { getOrFetch } from "../cache/cache.js";
import { CACHE_TTL_SECONDS } from "../cache/ttl.js";
import type { MidFunnelScored } from "./mid.js";
import { DEEP_FUNNEL_PRELIMINARY_STOP_PCT, DEEP_FUNNEL_MIN_PRICE, DEEP_FUNNEL_MIN_TURNOVER_IDR } from "./constants.js";
import { isEnvelopeStale } from "../adapter/envelope.js";
import {
  upsertBrokerSnapshot,
  upsertDailyBars,
  upsertFeatureSnapshot,
  insertSignal,
  insertTradePlan,
  insertMarketSnapshotIdempotent
} from "../persist/snapshots.js";

/**
 * Deep Funnel (blueprint §4.3): full enrichment for mid-funnel survivors
 * only, run once after EOD. For each candidate it fetches `/api/history`
 * (OHLCV -> the per-symbol quote the feature engine needs), broker-summary,
 * broker-accumulation, seasonal and insiders, then runs the pure
 * feature/scoring/risk engines. analysis + financial-statements are
 * best-effort enrichment (financial-statements is 403 for API keys) and
 * never block a candidate.
 *
 * IMPORTANT: this module only orchestrates I/O — all quant math lives in
 * @idx/domain (computeFeatureSnapshot / scoreCandidate / buildRiskPlan /
 * assembleSignal), unchanged.
 */

export interface DeepFunnelDeps extends AdapterContext {
  redis: Redis;
  env: Env;
  db: Db;
  strategyConfig: StrategyConfig;
  now?: string;
  userOpenRiskPct?: number;
  hasUnreviewedNewsFor?: (symbol: string) => boolean;
  sessionEndIso?: string;
}

export interface DeepFunnelEnrichedCandidate {
  symbol: string;
  featureSnapshot: FeatureSnapshot;
  signal: Signal;
  dataStale: boolean;
}

export interface DeepFunnelResult {
  activeWatchlist: DeepFunnelEnrichedCandidate[];
  tradePlanCandidates: DeepFunnelEnrichedCandidate[];
  skipped: { symbol: string; reason: string }[];
}

async function fetchDeep<T>(
  ctx: AdapterContext,
  redis: Redis,
  env: Env,
  endpoint:
    | "brokerSummary"
    | "brokerAccumulation"
    | "analysis"
    | "seasonal"
    | "insiders"
    | "financialStatements"
    | "history",
  symbol: string,
  fetcher: () => Promise<T>
): Promise<T> {
  const result = await getOrFetch(redis, endpoint, symbol, CACHE_TTL_SECONDS[endpoint], fetcher);
  return result.value;
}

export async function runDeepFunnel(
  midFunnelSurvivors: MidFunnelScored[],
  deps: DeepFunnelDeps
): Promise<DeepFunnelResult> {
  const { redis, env, db, strategyConfig } = deps;
  const now = deps.now ?? new Date().toISOString();
  const skipped: { symbol: string; reason: string }[] = [];
  const enriched: { symbol: string; quote: ScreenerRow; feature: FeatureSnapshot }[] = [];

  for (const candidate of midFunnelSurvivors) {
    const symbol = candidate.symbol;
    try {
      const historyEnvelope = await fetchDeep<DataEnvelope<HistoryData>>(deps, redis, env, "history", symbol, () =>
        getHistory(deps, symbol)
      );
      const quoteEnvelope = quoteEnvelopeFromHistory(historyEnvelope);
      const quote = quoteEnvelope.data;

      // Deep-funnel liquidity / price floor — the first stage where a real
      // per-symbol quote is available (the screener shortlist carries none).
      if (!Number.isFinite(quote.price) || quote.price < DEEP_FUNNEL_MIN_PRICE) {
        skipped.push({ symbol, reason: `price ${quote.price} below floor ${DEEP_FUNNEL_MIN_PRICE}` });
        continue;
      }
      if (!Number.isFinite(quote.turnover) || quote.turnover < DEEP_FUNNEL_MIN_TURNOVER_IDR) {
        skipped.push({ symbol, reason: `turnover ${quote.turnover} below floor ${DEEP_FUNNEL_MIN_TURNOVER_IDR}` });
        continue;
      }

      const [brokerSummaryEnvelope, brokerAccumulationEnvelope, seasonalEnvelope, insidersEnvelope] = await Promise.all([
        fetchDeep<DataEnvelope<BrokerSummaryData>>(deps, redis, env, "brokerSummary", symbol, () =>
          getBrokerSummary(deps, symbol, true)
        ),
        fetchDeep<DataEnvelope<BrokerAccumulationData>>(deps, redis, env, "brokerAccumulation", symbol, () =>
          getBrokerAccumulation(deps, symbol)
        ),
        fetchDeep<DataEnvelope<SeasonalData>>(deps, redis, env, "seasonal", symbol, () => getSeasonal(deps, symbol)),
        fetchDeep<DataEnvelope<InsiderTransaction[]>>(deps, redis, env, "insiders", symbol, () =>
          getInsiders(deps, symbol)
        )
      ]);

      // Best-effort enrichment; never blocks a candidate. financial-statements
      // returns 403 for API keys — swallow that.
      await Promise.allSettled([
        fetchDeep(deps, redis, env, "analysis", symbol, () => getAnalysis(deps, symbol)),
        fetchDeep(deps, redis, env, "financialStatements", symbol, () => getFinancialStatements(deps, symbol))
      ]);

      await insertMarketSnapshotIdempotent(db, quoteEnvelope, null);
      await upsertBrokerSnapshot(db, brokerSummaryEnvelope, null);
      await upsertDailyBars(db, historyEnvelope);

      const dataStale =
        isEnvelopeStale(brokerSummaryEnvelope, now) ||
        isEnvelopeStale(quoteEnvelope, now) ||
        quoteEnvelope.status === "provisional";

      const featureInput: FeatureEngineInput = {
        symbol,
        tradingDate: quoteEnvelope.tradingDate,
        inputSnapshotId: `${symbol}:${quoteEnvelope.tradingDate}:${brokerSummaryEnvelope.revisionId ?? "na"}`,
        screener: quote,
        history: historyEnvelope.data,
        brokerSummaryByDay: [brokerSummaryEnvelope.data],
        brokerAccumulation: brokerAccumulationEnvelope.data,
        seasonal: seasonalEnvelope.data,
        insiders: insidersEnvelope.data,
        segmentSeparable: brokerSummaryEnvelope.segment !== "unknown",
        dataStale
      };

      const feature = computeFeatureSnapshot(featureInput, strategyConfig, now);
      await upsertFeatureSnapshot(db, feature, dataStale, feature.segmentMixed);

      enriched.push({ symbol, quote, feature });
    } catch (err) {
      skipped.push({ symbol, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // First scoring pass: netRewardToRiskEstimate seeded from a preliminary
  // risk plan built off a naive entry/stop (quote price / fixed pct stop).
  const scored = enriched.map(({ symbol, quote, feature }) => {
    const entryTrigger =
      feature.price.pctAboveBAvg !== null && feature.brokerFlow.bAvg !== null
        ? feature.brokerFlow.bAvg * (1 + feature.price.pctAboveBAvg)
        : quote.price;
    const stopLossRaw = entryTrigger * (1 - DEEP_FUNNEL_PRELIMINARY_STOP_PCT);

    const preliminaryScore = scoreCandidate(
      {
        features: feature,
        userOpenRiskPct: deps.userOpenRiskPct ?? 0,
        hasUnreviewedNews: deps.hasUnreviewedNewsFor?.(symbol) ?? false,
        netRewardToRiskEstimate: strategyConfig.risk.minNetRewardToRisk
      },
      strategyConfig
    );

    const preliminaryPlan = buildRiskPlan(
      {
        symbol,
        tradingDate: feature.tradingDate,
        entryTrigger,
        stopLossRaw,
        score: preliminaryScore,
        sessionEndIso: deps.sessionEndIso ?? sessionEndIsoFor(now)
      },
      strategyConfig
    );

    const finalScore = scoreCandidate(
      {
        features: feature,
        userOpenRiskPct: deps.userOpenRiskPct ?? 0,
        hasUnreviewedNews: deps.hasUnreviewedNewsFor?.(symbol) ?? false,
        netRewardToRiskEstimate: preliminaryPlan.netRewardToRisk
      },
      strategyConfig
    );

    return { symbol, feature, entryTrigger, stopLossRaw, score: finalScore };
  });

  scored.sort((a, b) => b.score.compositeScore - a.score.compositeScore);

  const watchlistSlice = scored.slice(0, strategyConfig.funnel.deepFunnelWatchlistMax);
  const tradePlanSlice = watchlistSlice.slice(0, strategyConfig.funnel.deepFunnelTradePlanMax);
  const tradePlanSymbols = new Set(tradePlanSlice.map((s) => s.symbol));

  const activeWatchlist: DeepFunnelEnrichedCandidate[] = [];
  const tradePlanCandidates: DeepFunnelEnrichedCandidate[] = [];

  for (const item of watchlistSlice) {
    const withPlan = tradePlanSymbols.has(item.symbol);
    const plan = withPlan
      ? buildRiskPlan(
          {
            symbol: item.symbol,
            tradingDate: item.feature.tradingDate,
            entryTrigger: item.entryTrigger,
            stopLossRaw: item.stopLossRaw,
            score: item.score,
            sessionEndIso: deps.sessionEndIso ?? sessionEndIsoFor(now)
          },
          strategyConfig
        )
      : null;

    const sig = assembleSignal({ features: item.feature, score: item.score, plan });

    const featureSnapshotId = await upsertFeatureSnapshot(
      db,
      item.feature,
      item.feature.dataStale,
      item.feature.segmentMixed
    );
    const signalId = await insertSignal(db, sig, item.score.gates as unknown as object, featureSnapshotId);
    if (plan) {
      await insertTradePlan(db, signalId, plan);
    }

    const enrichedCandidate: DeepFunnelEnrichedCandidate = {
      symbol: item.symbol,
      featureSnapshot: item.feature,
      signal: sig,
      dataStale: item.feature.dataStale
    };
    activeWatchlist.push(enrichedCandidate);
    if (withPlan) tradePlanCandidates.push(enrichedCandidate);
  }

  return { activeWatchlist, tradePlanCandidates, skipped };
}

function sessionEndIsoFor(now: string): string {
  // Default expiry = ~end of current session; the scheduler passes a precise
  // session-calendar timestamp via DeepFunnelDeps.sessionEndIso when it can.
  return new Date(new Date(now).getTime() + 6 * 60 * 60 * 1000).toISOString();
}
