/**
 * Default strategy configuration, blueprint section 5-7. Every threshold here
 * must be persisted (packages/db `strategy_config` table) with a version id;
 * this module only defines the V1 defaults used to seed that table and as a
 * fallback when no override is active. Scoring/risk code must never read
 * these constants directly at call time in production — it must receive a
 * resolved StrategyConfig (from DB) so overrides and version pinning work.
 */

export const FORMULA_VERSION = "1.0.0";
export const STRATEGY_CONFIG_VERSION = "v1-2026-09-09";

export interface BrokerConcentrationThresholds {
  /** minimum net-buy share of a single broker to count as a "meaningful buyer" */
  meaningfulBuyerMinShare: number; // 0.05
  /** minimum number of meaningful buyers required */
  minMeaningfulBuyers: number; // 4
  /** Top1Share hard ceiling */
  top1ShareMax: number; // 0.35
  /** Top3Share hard ceiling */
  top3ShareMax: number; // 0.70
  /** HHI hard ceiling (sum of squared positive-net-buy shares) */
  hhiMax: number; // 0.25
  /** persistence: minimum accumulation days out of window */
  persistenceMinDays: number; // 3
  persistenceWindowDays: number; // 5
}

export interface CompositeWeights {
  brokerFlowQuality: number; // 0.40
  volumeAnomaly: number; // 0.25
  smartMoneyMargin: number; // 0.20
  priceResponse: number; // 0.10
  confluence: number; // 0.05
}

export interface CategoryThresholds {
  strongBuyMin: number; // 80
  speculativeBuyMin: number; // 65
  watchlistMin: number; // 50
}

export interface RiskParameters {
  totalCapital: number; // 5_000_000
  riskPerTradePct: number; // 0.0075 (0.5%-1.0% allowed range)
  riskPerTradePctMin: number; // 0.005
  riskPerTradePctMax: number; // 0.01
  maxDeployedCapital: number; // 3_000_000
  cashReserve: number; // 1_000_000 minimum
  maxSimultaneousPositions: number; // 1, up to 2
  tp1AllocationPct: number; // 0.60
  tp2AllocationPct: number; // 0.40
  tp1RiskMultiple: number; // 2x price risk before cost
  tp2RiskMultiple: number; // 3x price risk before cost
  minNetRewardToRisk: number; // 2
  chaseMaxPctAboveBAvg: number; // 0.03-0.04 -> use 0.035 default
  slippageAllowancePerShare: number; // absolute Rp per share, configurable
  buyFeeRate: number; // placeholder, must be confirmed by user before live capital
  sellFeeRate: number; // placeholder, includes higher sell-side levy typical in ID brokers
  lotSizeShares: number; // 100, BEI standard
  minStopDistanceTicks: number; // 2
}

export interface FunnelBudget {
  topFunnelTargetMin: number; // 80
  topFunnelTargetMax: number; // 150
  midFunnelTargetMin: number; // 20
  midFunnelTargetMax: number; // 30
  deepFunnelWatchlistMin: number; // 5
  deepFunnelWatchlistMax: number; // 10
  deepFunnelTradePlanMax: number; // 3
}

export interface StrategyConfig {
  version: string;
  formulaVersion: string;
  concentration: BrokerConcentrationThresholds;
  weights: CompositeWeights;
  categories: CategoryThresholds;
  risk: RiskParameters;
  funnel: FunnelBudget;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  version: STRATEGY_CONFIG_VERSION,
  formulaVersion: FORMULA_VERSION,
  concentration: {
    meaningfulBuyerMinShare: 0.05,
    minMeaningfulBuyers: 4,
    top1ShareMax: 0.35,
    top3ShareMax: 0.7,
    hhiMax: 0.25,
    persistenceMinDays: 3,
    persistenceWindowDays: 5
  },
  weights: {
    brokerFlowQuality: 0.4,
    volumeAnomaly: 0.25,
    smartMoneyMargin: 0.2,
    priceResponse: 0.1,
    confluence: 0.05
  },
  categories: {
    strongBuyMin: 80,
    speculativeBuyMin: 65,
    watchlistMin: 50
  },
  risk: {
    totalCapital: 5_000_000,
    riskPerTradePct: 0.0075,
    riskPerTradePctMin: 0.005,
    riskPerTradePctMax: 0.01,
    maxDeployedCapital: 3_000_000,
    cashReserve: 1_000_000,
    maxSimultaneousPositions: 1,
    tp1AllocationPct: 0.6,
    tp2AllocationPct: 0.4,
    tp1RiskMultiple: 2,
    tp2RiskMultiple: 3,
    minNetRewardToRisk: 2,
    chaseMaxPctAboveBAvg: 0.035,
    slippageAllowancePerShare: 2,
    // PROVISIONAL: not specified numerically in blueprint; typical Indonesian
    // retail broker rates. Must be confirmed/overridden per user's actual
    // broker before any real-capital use.
    buyFeeRate: 0.0015,
    sellFeeRate: 0.0025,
    lotSizeShares: 100,
    minStopDistanceTicks: 2
  },
  funnel: {
    topFunnelTargetMin: 80,
    topFunnelTargetMax: 150,
    midFunnelTargetMin: 20,
    midFunnelTargetMax: 30,
    deepFunnelWatchlistMin: 5,
    deepFunnelWatchlistMax: 10,
    deepFunnelTradePlanMax: 3
  }
};
