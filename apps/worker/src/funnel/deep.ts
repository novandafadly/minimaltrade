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
  getHistory
} from "../adapter/endpoints.js";
import { getOrFetch } from "../cache/cache.js";
import { CACHE_TTL_SECONDS } from "../cache/ttl.js";
import type { MidFunnelScored } from "./mid.js";
import { DEEP_FUNNEL_PRELIMINARY_STOP_PCT } from "./constants.js";
import { isEnvelopeStale } from "../adapter/envelope.js";
import {
  upsertBrokerSnapshot,
  upsertDailyBars,
  upsertFeatureSnapshot,
  insertSignal,
  insertTradePlan
} from "../persist/snapshots.js";

/**
 * Deep Funnel (blueprint §4.3): full enrichment for mid-funnel survivors
 * only (<=20-30 symbols), run once after EOD final data is available. Calls
 * broker-summary, broker-accumulation, analysis, seasonal, insiders and
 * financial-statements through the standard cache (so a symbol already
 * enriched today is not re-fetched). Ranks by composite score; the top
 * `deepFunnelWatchlistMin..Max` become the active watchlist, and only the
 * top `deepFunnelTradePlanMax` of those get a full risk plan.
 *
 * IMPORTANT: this is the only place in the worker that calls
 * computeFeatureSnapshot/scoreCandidate/buildRiskPlan/assembleSignal — all
 * quant math lives in @idx/domain, this module only orchestrates I/O.
 */

export interface DeepFunnelDeps extends AdapterContext {
  redis: Redis;
  env: Env;
  db: Db;
  strategyConfig: StrategyConfig;
  now?: string;
  userOpenRiskPct?: number;
  hasUnreviewedNewsFor?: (symbol: string) => boolean;
  /** ISO timestamp for "end of current session"; passed in by the scheduler
   * (which has session-calendar access) rather than guessed here. */
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
  endpoint: "brokerSummary" | "brokerAccumulation" | "analysis" | "seasonal" | "insiders" | "financialStatements" | "history",
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
  const enriched: { symbol: string; screener: ScreenerRow; envelope: DataEnvelope<ScreenerRow>; feature: FeatureSnapshot }[] =
    [];

  for (const candidate of midFunnelSurvivors) {
    const symbol = candidate.symbol;
    try {
      const [brokerSummaryEnvelope, brokerAccumulationEnvelope, historyEnvelope, seasonalEnvelope, insidersEnvelope] =
        await Promise.all([
          fetchDeep<DataEnvelope<BrokerSummaryData>>(deps, redis, env, "brokerSummary", symbol, () =>
            getBrokerSummary(deps, symbol)
          ),
          fetchDeep<DataEnvelope<BrokerAccumulationData>>(deps, redis, env, "brokerAccumulation", symbol, () =>
            getBrokerAccumulation(deps, symbol)
          ),
          fetchDeep<DataEnvelope<HistoryData>>(deps, redis, env, "history", symbol, () => getHistory(deps, symbol)),
          fetchDeep<DataEnvelope<SeasonalData>>(deps, redis, env, "seasonal", symbol, () => getSeasonal(deps, symbol)),
          fetchDeep<DataEnvelope<InsiderTransaction[]>>(deps, redis, env, "insiders", symbol, () =>
            getInsiders(deps, symbol)
          )
        ]);

      // analysis + financial-statements are enrichment-only (not required by
      // FeatureEngineInput) but still fetched here (cached) so deep-funnel
      // symbols have them available for the dashboard/watchlist detail view.
      await fetchDeep(deps, redis, env, "analysis", symbol, () => getAnalysis(deps, symbol));
      await fetchDeep(deps, redis, env, "financialStatements", symbol, () => getFinancialStatements(deps, symbol));

      await upsertBrokerSnapshot(db, brokerSummaryEnvelope, null);
      await upsertDailyBars(db, historyEnvelope);

      const dataStale =
        isEnvelopeStale(brokerSummaryEnvelope, now) ||
        isEnvelopeStale(candidate.screener, now) ||
        candidate.screener.status === "provisional";

      const featureInput: FeatureEngineInput = {
        symbol,
        tradingDate: candidate.screener.tradingDate,
        inputSnapshotId: `${symbol}:${candidate.screener.tradingDate}:${brokerSummaryEnvelope.revisionId ?? "na"}`,
        screener: candidate.screener.data,
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

      enriched.push({ symbol, screener: candidate.screener.data, envelope: candidate.screener, feature });
    } catch (err) {
      skipped.push({ symbol, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // First scoring pass: netRewardToRiskEstimate seeded from a preliminary
  // risk plan built off a naive entry/stop (screener price / fixed pct
  // stop), per interfaces.ts's documented two-pass design (scoring needs an
  // R:R estimate before the real plan, which itself needs the score).
  const scored = enriched.map(({ symbol, feature }) => {
    const entryTrigger = feature.price.pctAboveBAvg !== null && feature.brokerFlow.bAvg !== null
      ? feature.brokerFlow.bAvg * (1 + feature.price.pctAboveBAvg)
      : (enriched.find((e) => e.symbol === symbol)?.screener.price ?? 0);
    const stopLossRaw = entryTrigger * (1 - DEEP_FUNNEL_PRELIMINARY_STOP_PCT);

    const preliminaryScore = scoreCandidate(
      {
        features: feature,
        userOpenRiskPct: deps.userOpenRiskPct ?? 0,
        hasUnreviewedNews: deps.hasUnreviewedNewsFor?.(symbol) ?? false,
        netRewardToRiskEstimate: strategyConfig.risk.minNetRewardToRisk // neutral seed for pass 1
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
    const signalId = await insertSignal(db, sig, featureSnapshotId);
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
  // Default expiry = end of current session; a precise session-calendar
  // lookup happens in the scheduler (index.ts) which has access to
  // buildSessionCalendar. Here we fall back to "now + until 15:49 local"
  // is out of scope for a pure helper without timezone data, so callers
  // that need exact session-close timestamps should pass one in via a
  // future DeepFunnelDeps.sessionEndIso override; for V1 default to +6h.
  return new Date(new Date(now).getTime() + 6 * 60 * 60 * 1000).toISOString();
}
