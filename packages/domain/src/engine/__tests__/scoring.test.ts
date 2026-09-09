import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import { scoreCandidate } from "../scoring.js";
import type { ScoringEngineInput } from "../interfaces.js";
import type { FeatureSnapshot } from "../../types/signal.js";

function baseFeatures(overrides: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
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

function baseInput(overrides: Partial<ScoringEngineInput> = {}): ScoringEngineInput {
  return {
    features: baseFeatures(),
    userOpenRiskPct: 0.005,
    hasUnreviewedNews: false,
    netRewardToRiskEstimate: 2.5,
    ...overrides
  };
}

describe("composite score weighting", () => {
  it("matches 40*BF + 25*VA + 20*MM + 10*PR + 5*CF using config weights", () => {
    const input = baseInput();
    const result = scoreCandidate(input, DEFAULT_STRATEGY_CONFIG);
    const w = DEFAULT_STRATEGY_CONFIG.weights;
    const c = result.components;
    const expected =
      100 *
      (w.brokerFlowQuality * c.brokerFlowQuality +
        w.volumeAnomaly * c.volumeAnomaly +
        w.smartMoneyMargin * c.smartMoneyMargin +
        w.priceResponse * c.priceResponse +
        w.confluence * c.confluence);
    expect(result.compositeScore).toBeCloseTo(expected, 8);
  });

  it("does not renormalize weight when confluence is missing (null)", () => {
    const withConfluence = scoreCandidate(baseInput(), DEFAULT_STRATEGY_CONFIG);
    const withoutConfluence = scoreCandidate(
      baseInput({ features: baseFeatures({ confluence: { seasonalScore: null, insiderScore: null } }) }),
      DEFAULT_STRATEGY_CONFIG
    );
    // Losing confluence should cost at most the 5% weight's worth of points
    // (5 points), never more (no redistribution to other components).
    const diff = withConfluence.compositeScore - withoutConfluence.compositeScore;
    expect(diff).toBeGreaterThanOrEqual(0);
    expect(diff).toBeLessThanOrEqual(5 + 1e-9);
  });
});

describe("hard gates override score category", () => {
  it("forces AVOID when concentration gate fails even with a high score", () => {
    const input = baseInput({
      features: baseFeatures({
        brokerFlow: {
          ...baseFeatures().brokerFlow,
          top1Share: 0.9 // breaches top1ShareMax
        }
      })
    });
    const result = scoreCandidate(input, DEFAULT_STRATEGY_CONFIG);
    const concentrationGate = result.gates.find((g) => g.gate === "CONCENTRATION");
    expect(concentrationGate?.passed).toBe(false);
    expect(result.category).toBe("AVOID");
  });

  it("forces NO_TRADE when data is stale, regardless of score", () => {
    const input = baseInput({ features: baseFeatures({ dataStale: true }) });
    const result = scoreCandidate(input, DEFAULT_STRATEGY_CONFIG);
    expect(result.category).toBe("NO_TRADE");
    expect(result.noTradeReason).toBeTruthy();
  });

  it("forces NO_TRADE when net RR is below minimum", () => {
    const input = baseInput({ netRewardToRiskEstimate: 1.0 });
    const result = scoreCandidate(input, DEFAULT_STRATEGY_CONFIG);
    expect(result.category).toBe("NO_TRADE");
  });

  it("forces NO_TRADE when user risk limit is exceeded", () => {
    const input = baseInput({ userOpenRiskPct: 0.5 });
    const result = scoreCandidate(input, DEFAULT_STRATEGY_CONFIG);
    expect(result.category).toBe("NO_TRADE");
  });

  it("all gates pass on a clean high-quality candidate -> STRONG_BUY category is reachable", () => {
    const input = baseInput({
      features: baseFeatures({
        brokerFlow: {
          bAvg: 990,
          bAvgConfidence: "high",
          buyerBreadthCount: 12,
          meaningfulBuyerCount: 8,
          top1Share: 0.15,
          top3Share: 0.35,
          hhi: 0.06,
          persistenceDays: 5,
          persistenceWindowDays: 5,
          sellerConcentrationTop1Share: 0.15,
          brokerFlip: false,
          suspectedTransfer: false,
          failedAbsorption: false
        },
        volume: { volumePace: 2.5, turnoverRelative: 2.2 },
        price: { priceResponseScore: 0.9, pctAboveBAvg: 0.02 },
        confluence: { seasonalScore: 0.8, insiderScore: 0.7 }
      })
    });
    const result = scoreCandidate(input, DEFAULT_STRATEGY_CONFIG);
    const allPassed = result.gates.every((g) => g.passed);
    expect(allPassed).toBe(true);
    expect(result.compositeScore).toBeGreaterThanOrEqual(DEFAULT_STRATEGY_CONFIG.categories.strongBuyMin);
    expect(result.category).toBe("STRONG_BUY");
  });
});
