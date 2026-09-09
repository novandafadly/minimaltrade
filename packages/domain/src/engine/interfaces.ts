import type { StrategyConfig } from "@idx/config";
import type {
  BrokerSummaryData,
  BrokerAccumulationData,
  HistoryData,
  ScreenerRow,
  SeasonalData,
  InsiderTransaction
} from "../types/marketData.js";
import type { FeatureSnapshot, ScoreResult, TradePlan, Signal } from "../types/signal.js";

/**
 * Stable entry-point contracts for the three pure engines (blueprint §9.1:
 * Feature Engine, Scoring Engine, Risk Engine). apps/worker calls these by
 * name; implementations live in ./feature.ts, ./scoring.ts, ./risk.ts.
 * Keeping the signatures here lets worker-side and domain-side work proceed
 * against a fixed contract instead of guessing each other's shapes.
 *
 * All three MUST be pure: no I/O, no Date.now()/Math.random() without an
 * explicit `now` parameter, no network calls. Same inputs -> same output,
 * always, so replay/backtest can reuse them byte for byte.
 */

export interface FeatureEngineInput {
  symbol: string;
  tradingDate: string;
  inputSnapshotId: string;
  screener: ScreenerRow;
  history: HistoryData | null;
  brokerSummaryByDay: BrokerSummaryData[]; // most recent last, covering persistence window
  brokerAccumulation: BrokerAccumulationData | null;
  seasonal: SeasonalData | null;
  insiders: InsiderTransaction[] | null;
  segmentSeparable: boolean; // false if regular market volume can't be isolated from negotiated/crossing
  dataStale: boolean;
}

export type ComputeFeatureSnapshot = (
  input: FeatureEngineInput,
  config: StrategyConfig,
  now: string
) => FeatureSnapshot;

export interface ScoringEngineInput {
  features: FeatureSnapshot;
  userOpenRiskPct: number; // combined open risk across active positions, for USER_RISK_LIMIT gate
  hasUnreviewedNews: boolean; // UMA/suspension/corporate action not yet reviewed
  netRewardToRiskEstimate: number; // computed from a preliminary risk-engine pass
}

export type ScoreCandidate = (input: ScoringEngineInput, config: StrategyConfig) => ScoreResult;

export interface RiskEngineInput {
  symbol: string;
  tradingDate: string;
  entryTrigger: number;
  stopLossRaw: number; // pre-tick-rounding invalidation level
  score: ScoreResult;
  sessionEndIso: string; // expiry default = end of current session
}

export type BuildRiskPlan = (input: RiskEngineInput, config: StrategyConfig) => TradePlan;

export interface SignalAssemblyInput {
  features: FeatureSnapshot;
  score: ScoreResult;
  plan: TradePlan | null;
}

export type AssembleSignal = (input: SignalAssemblyInput) => Signal;
