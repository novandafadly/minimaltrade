import type { DataEnvelope, ScreenerRow, HistoryData, BrokerAccumulationData, MarketCapEntry } from "@idx/domain";
import type { FunnelBudget, RiskParameters } from "@idx/config";
import {
  MID_FUNNEL_CHASE_LOOKBACK_DAYS,
  MID_FUNNEL_DISTRIBUTION_VOLUME_SPIKE_RATIO,
  MID_FUNNEL_DISTRIBUTION_WEAK_PRICE_PCT_MAX,
  MID_FUNNEL_WEIGHTS
} from "./constants.js";

/**
 * Mid Funnel (blueprint §4.2): ranks top-funnel survivors down to ~20-30
 * candidates using only already-cached/cheap data (screener + market-cap +
 * history + accumulation caches) — no broker-summary call here, that's
 * deep-funnel-only. Liquidity/turnover is weighted above raw % gain; a
 * chase-penalty proxy and a distribution penalty apply (see constants.ts
 * for why the chase penalty is a proxy at this stage, not the real B-Avg).
 */
export interface MidFunnelCandidateInput {
  screener: DataEnvelope<ScreenerRow>;
  marketCap: MarketCapEntry | null;
  history: HistoryData | null;
  accumulation: BrokerAccumulationData | null;
}

export interface MidFunnelScored {
  symbol: string;
  screener: DataEnvelope<ScreenerRow>;
  liquidityScore: number;
  gainScore: number;
  chasePenalty: number;
  distributionPenalty: number;
  compositeProxyScore: number;
}

function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}

export function scoreMidFunnelCandidate(
  input: MidFunnelCandidateInput,
  risk: Pick<RiskParameters, "chaseMaxPctAboveBAvg">,
  turnoverNormalizationCeiling: number
): MidFunnelScored {
  const row = input.screener.data;
  const liquidityScore = normalize(row.turnover, turnoverNormalizationCeiling);
  const gainScore = normalize(Math.max(0, row.priceChangePct), 0.15); // 15% intraday gain -> full score

  let chasePenalty = 0;
  const recentBars = input.history?.bars.slice(-MID_FUNNEL_CHASE_LOOKBACK_DAYS) ?? [];
  if (recentBars.length > 0) {
    const avgClose = recentBars.reduce((sum, b) => sum + b.close, 0) / recentBars.length;
    if (avgClose > 0) {
      const pctAboveAvg = (row.price - avgClose) / avgClose;
      if (pctAboveAvg > risk.chaseMaxPctAboveBAvg) {
        chasePenalty = Math.min(1, (pctAboveAvg - risk.chaseMaxPctAboveBAvg) / risk.chaseMaxPctAboveBAvg);
      }
    }
  }

  let distributionPenalty = 0;
  const baseline = input.history?.baselineMedianVolume20d ?? null;
  if (baseline && baseline > 0) {
    const volumeRatio = row.volume / baseline;
    if (
      volumeRatio >= MID_FUNNEL_DISTRIBUTION_VOLUME_SPIKE_RATIO &&
      row.priceChangePct <= MID_FUNNEL_DISTRIBUTION_WEAK_PRICE_PCT_MAX
    ) {
      distributionPenalty = Math.min(1, volumeRatio / MID_FUNNEL_DISTRIBUTION_VOLUME_SPIKE_RATIO - 1);
    }
  }

  const compositeProxyScore =
    liquidityScore * MID_FUNNEL_WEIGHTS.liquidity +
    gainScore * MID_FUNNEL_WEIGHTS.gain -
    chasePenalty * MID_FUNNEL_WEIGHTS.chasePenalty -
    distributionPenalty * MID_FUNNEL_WEIGHTS.distributionPenalty;

  return {
    symbol: row.symbol,
    screener: input.screener,
    liquidityScore,
    gainScore,
    chasePenalty,
    distributionPenalty,
    compositeProxyScore
  };
}

export function runMidFunnel(
  candidates: MidFunnelCandidateInput[],
  funnelBudget: FunnelBudget,
  risk: Pick<RiskParameters, "chaseMaxPctAboveBAvg">
): MidFunnelScored[] {
  if (candidates.length === 0) return [];
  const turnoverCeiling = Math.max(...candidates.map((c) => c.screener.data.turnover), 1);
  const scored = candidates
    .map((c) => scoreMidFunnelCandidate(c, risk, turnoverCeiling))
    .sort((a, b) => b.compositeProxyScore - a.compositeProxyScore);
  return scored.slice(0, funnelBudget.midFunnelTargetMax);
}
