/**
 * BFF <-> browser wire types. These are shaped for the dashboard's needs and
 * are deliberately looser/flatter than the domain Signal/TradePlan types
 * (which describe the engine's in-memory contract) because what we persist
 * in Postgres (`signal` + `trade_plan` rows, `feature_snapshot.features`
 * jsonb) doesn't carry a denormalized `flags` object — the BFF derives it
 * from `gates` on read. See app/api/signals/route.ts.
 */
import type {
  BrokerFlowFeatures,
  FeatureSnapshot,
  HardGateResult,
  RiskFlags,
  SignalCategory
} from "@idx/domain";

export interface TradePlanView {
  entryTrigger: number;
  maxBuyPrice: number;
  totalLots: number;
  estimatedCapital: number;
  tp1Price: number;
  tp1Lots: number;
  tp2Price: number;
  tp2Lots: number;
  slPrice: number;
  slRemainingLots: number;
  grossReward: number;
  estimatedFees: number;
  slippageAllowance: number;
  netReward: number;
  maxNetLoss: number;
  netRewardToRisk: number;
  isNoTrade: boolean;
  noTradeReason: string | null;
  expiry: string;
  generatedAt: string;
}

export interface SignalListItem {
  symbol: string;
  tradingDate: string;
  generatedAt: string;
  expiry: string;
  category: SignalCategory;
  compositeScore: number;
  confidence: "high" | "medium" | "low";
  noTradeReason: string | null;
  formulaVersion: string;
  configVersion: string;
  inputSnapshotId: string;
  broker: BrokerFlowFeatures | null;
  plan: TradePlanView | null;
  flags: RiskFlags;
  gates: HardGateResult[];
  dataStale: boolean;
  ageSeconds: number;
}

export interface SignalListResponse {
  signals: SignalListItem[];
  counts: Record<SignalCategory, number>;
  generatedAt: string;
}

export interface BrokerMatrixRow {
  brokerCode: string;
  buyVolume: number;
  buyValue: number;
  sellVolume: number;
  sellValue: number;
  netVolume: number;
  netValue: number;
  avgBuyPrice: number | null;
  avgSellPrice: number | null;
  status: string;
}

export interface SignalDetailResponse {
  signal: SignalListItem;
  feature: FeatureSnapshot | null;
  brokerMatrix: BrokerMatrixRow[];
  evidence: {
    inputSnapshotId: string;
    formulaVersion: string;
    configVersion: string;
    rawPayloadArchiveHint: string;
  };
}

export type HealthStatus = "ok" | "degraded" | "down" | "unknown";

export interface HealthResponse {
  status: HealthStatus;
  marketOpen: boolean;
  sessionLabel: string;
  now: string;
  apiBudget: {
    used: number;
    total: number;
    reserve: number;
    dayBucket: string;
  };
  worker: {
    source: "worker_reported" | "derived_fallback";
    lastMarketSnapshotAt: string | null;
    lastMarketSnapshotAgeSeconds: number | null;
    lastSignalGeneratedAt: string | null;
    lastSignalAgeSeconds: number | null;
    recentErrorRate: number | null;
  };
  notes: string[];
}

export type SseEventType = "signal_update" | "health_update" | "heartbeat";

export interface SseSignalUpdatePayload {
  type: "signal_update";
  payload: { symbol: string; category?: SignalCategory; reason?: string };
}

export interface SseHealthUpdatePayload {
  type: "health_update";
  payload: HealthResponse;
}

export interface SseHeartbeatPayload {
  type: "heartbeat";
  payload: { now: string };
}

export type SseEnvelope = SseSignalUpdatePayload | SseHealthUpdatePayload | SseHeartbeatPayload;

export interface PaperTradeView {
  id: string;
  tradePlanId: string | null;
  symbol: string;
  plannedEntry: number;
  actualFillPrice: number | null;
  actualFillLots: number | null;
  fillStatus: "pending" | "filled" | "partial" | "no_fill" | "expired";
  exitPrice: number | null;
  exitLots: number | null;
  exitReason: "tp1" | "tp2" | "sl" | "manual" | "expiry" | null;
  actualFeePaid: number | null;
  actualSlippage: number | null;
  netResult: number | null;
  overrideReason: string | null;
  openedAt: string;
  closedAt: string | null;
}
