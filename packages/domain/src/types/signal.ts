/**
 * Output contracts for the quant/risk pipeline (blueprint sections 6-8).
 * FeatureSnapshot -> ScoreResult -> Signal -> TradePlan. Every stage is pure
 * data; calculation lives in feature/*, scoring/*, risk/* and must be
 * deterministic given these inputs plus a StrategyConfig.
 */

export type SignalCategory =
  | "STRONG_BUY"
  | "SPECULATIVE_BUY"
  | "WATCHLIST"
  | "AVOID"
  | "NO_TRADE";

export interface BrokerFlowFeatures {
  bAvg: number | null;
  bAvgConfidence: "high" | "low";
  buyerBreadthCount: number;
  meaningfulBuyerCount: number;
  top1Share: number;
  top3Share: number;
  hhi: number;
  persistenceDays: number;
  persistenceWindowDays: number;
  sellerConcentrationTop1Share: number;
  brokerFlip: boolean;
  suspectedTransfer: boolean;
  failedAbsorption: boolean;
}

export interface VolumeFeatures {
  volumePace: number; // ratio vs same-time-of-day historical pattern
  turnoverRelative: number; // vs baseline median
}

export interface PriceFeatures {
  priceResponseScore: number; // 0-1, ability to absorb supply
  pctAboveBAvg: number | null; // (price - bAvg) / bAvg
}

export interface ConfluenceFeatures {
  seasonalScore: number | null; // 0-1 or null if unavailable
  insiderScore: number | null; // 0-1 or null if unavailable
}

export interface FeatureSnapshot {
  symbol: string;
  tradingDate: string;
  formulaVersion: string;
  generatedAt: string;
  inputSnapshotId: string;
  brokerFlow: BrokerFlowFeatures;
  volume: VolumeFeatures;
  price: PriceFeatures;
  confluence: ConfluenceFeatures;
  ownerStatus: "UNVERIFIED";
  dataStale: boolean;
  segmentMixed: boolean; // true if regular market couldn't be separated from negotiated/crossing
}

export interface HardGateResult {
  gate:
    | "FRESHNESS"
    | "SEGMENT_SEPARATION"
    | "LIQUIDITY"
    | "CHASE_LIMIT"
    | "BROKER_FLIP_OR_DISTRIBUTION"
    | "NEWS_REVIEW"
    | "NET_RR_MIN"
    | "USER_RISK_LIMIT"
    | "CONCENTRATION";
  passed: boolean;
  reason: string | null;
}

export interface ScoreComponents {
  brokerFlowQuality: number; // 0-1
  volumeAnomaly: number; // 0-1
  smartMoneyMargin: number; // 0-1
  priceResponse: number; // 0-1
  confluence: number; // 0-1
}

export interface ScoreResult {
  symbol: string;
  tradingDate: string;
  formulaVersion: string;
  configVersion: string;
  components: ScoreComponents;
  compositeScore: number; // 0-100
  category: SignalCategory;
  gates: HardGateResult[];
  noTradeReason: string | null;
  confidence: "high" | "medium" | "low";
}

export interface RiskFlags {
  stale: boolean;
  crossing: boolean;
  brokerFlip: boolean;
  chase: boolean;
  illiquid: boolean;
  newsReview: boolean;
}

export interface TradePlan {
  symbol: string;
  tradingDate: string;
  formulaVersion: string;
  configVersion: string;
  generatedAt: string;
  expiry: string; // ISO timestamp, end of session by default
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
}

export interface Signal {
  symbol: string;
  tradingDate: string;
  generatedAt: string;
  expiry: string;
  category: SignalCategory;
  compositeScore: number;
  confidence: "high" | "medium" | "low";
  noTradeReason: string | null;
  broker: BrokerFlowFeatures;
  plan: TradePlan | null;
  flags: RiskFlags;
  inputSnapshotId: string;
  formulaVersion: string;
  configVersion: string;
}
