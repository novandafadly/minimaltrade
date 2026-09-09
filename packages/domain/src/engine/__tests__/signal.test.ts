import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import { assembleSignal } from "../signal.js";
import type { FeatureSnapshot, ScoreResult, TradePlan } from "../../types/signal.js";

function features(overrides: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  return {
    symbol: "TEST",
    tradingDate: "2026-09-09",
    formulaVersion: DEFAULT_STRATEGY_CONFIG.formulaVersion,
    generatedAt: "2026-09-09T10:00:00Z",
    inputSnapshotId: "snap-1",
    brokerFlow: {
      bAvg: 990,
      bAvgConfidence: "high",
      buyerBreadthCount: 10,
      meaningfulBuyerCount: 6,
      top1Share: 0.2,
      top3Share: 0.5,
      hhi: 0.1,
      persistenceDays: 4,
      persistenceWindowDays: 5,
      sellerConcentrationTop1Share: 0.2,
      brokerFlip: false,
      suspectedTransfer: false,
      failedAbsorption: false
    },
    volume: { volumePace: 1.8, turnoverRelative: 1.6 },
    price: { priceResponseScore: 0.7, pctAboveBAvg: 0.01 },
    confluence: { seasonalScore: 0.6, insiderScore: 0.4 },
    ownerStatus: "UNVERIFIED",
    dataStale: false,
    segmentMixed: false,
    ...overrides
  };
}

function score(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    symbol: "TEST",
    tradingDate: "2026-09-09",
    formulaVersion: DEFAULT_STRATEGY_CONFIG.formulaVersion,
    configVersion: DEFAULT_STRATEGY_CONFIG.version,
    components: {
      brokerFlowQuality: 0.9,
      volumeAnomaly: 0.8,
      smartMoneyMargin: 0.7,
      priceResponse: 0.6,
      confluence: 0.5
    },
    compositeScore: 85,
    category: "STRONG_BUY",
    gates: [
      { gate: "FRESHNESS", passed: true, reason: null },
      { gate: "CHASE_LIMIT", passed: true, reason: null },
      { gate: "LIQUIDITY", passed: true, reason: null },
      { gate: "NEWS_REVIEW", passed: true, reason: null }
    ],
    noTradeReason: null,
    confidence: "high",
    ...overrides
  };
}

function plan(overrides: Partial<TradePlan> = {}): TradePlan {
  return {
    symbol: "TEST",
    tradingDate: "2026-09-09",
    formulaVersion: DEFAULT_STRATEGY_CONFIG.formulaVersion,
    configVersion: DEFAULT_STRATEGY_CONFIG.version,
    generatedAt: "2026-09-09T10:00:00Z",
    expiry: "2026-09-09T08:49:00Z",
    entryTrigger: 1000,
    maxBuyPrice: 1010,
    totalLots: 14,
    estimatedCapital: 1_402_100,
    tp1Price: 1040,
    tp1Lots: 8,
    tp2Price: 1060,
    tp2Lots: 6,
    slPrice: 980,
    slRemainingLots: 14,
    grossReward: 480_000,
    estimatedFees: 5000,
    slippageAllowance: 2800,
    netReward: 470_000,
    maxNetLoss: 30_000,
    netRewardToRisk: 2.1,
    isNoTrade: false,
    noTradeReason: null,
    ...overrides
  };
}

describe("assembleSignal", () => {
  it("passes through category/score/plan and derives flags from features", () => {
    const result = assembleSignal({ features: features(), score: score(), plan: plan() });
    expect(result.category).toBe("STRONG_BUY");
    expect(result.compositeScore).toBe(85);
    expect(result.plan).toEqual(plan());
    expect(result.broker).toEqual(features().brokerFlow);
    expect(result.flags).toEqual({
      stale: false,
      crossing: false,
      brokerFlip: false,
      chase: false,
      illiquid: false,
      newsReview: false
    });
    expect(result.expiry).toBe(plan().expiry);
  });

  it("nulls out plan when category is NO_TRADE even if a plan object was passed", () => {
    const result = assembleSignal({
      features: features({ dataStale: true }),
      score: score({ category: "NO_TRADE", noTradeReason: "stale" }),
      plan: plan()
    });
    expect(result.plan).toBeNull();
    expect(result.flags.stale).toBe(true);
  });

  it("derives chase/illiquid/newsReview flags from failed gates", () => {
    const result = assembleSignal({
      features: features(),
      score: score({
        gates: [
          { gate: "CHASE_LIMIT", passed: false, reason: "too far above B-Avg" },
          { gate: "LIQUIDITY", passed: false, reason: "thin" },
          { gate: "NEWS_REVIEW", passed: false, reason: "unreviewed" }
        ]
      }),
      plan: null
    });
    expect(result.flags.chase).toBe(true);
    expect(result.flags.illiquid).toBe(true);
    expect(result.flags.newsReview).toBe(true);
    expect(result.plan).toBeNull();
    expect(result.expiry).toBe(features().generatedAt);
  });
});
