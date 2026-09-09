import type { StrategyConfig } from "@idx/config";
import type { HardGateResult, ScoreComponents, ScoreResult, SignalCategory } from "../types/signal.js";
import type { ScoreCandidate, ScoringEngineInput } from "./interfaces.js";

/**
 * Scoring Engine (blueprint section 6). Pure, deterministic. Composite Score
 * = 40*BF + 25*VA + 20*MM + 10*PR + 5*CF (weights taken from
 * config.weights, never hardcoded), each component normalized to 0-1 before
 * weighting. Missing confluence contributes 0 and total weight is NOT
 * renormalized — a stock with no seasonal/insider data simply cannot reach
 * the top 5 points of the composite, by design (blueprint 6: "Skor tinggi
 * tidak boleh melewati hard gate").
 *
 * LIQUIDITY GATE NOTE: FeatureSnapshot/ScreenerRow do not carry a dedicated
 * liquidity/spread field reachable here (raw bid/ask spread lives on
 * ScreenerRow, which the feature engine already consumed and did not thread
 * through to FeatureSnapshot). Rather than widen FeatureSnapshot for a V1
 * proxy, we treat extremely low volumePace/turnoverRelative as a liquidity
 * proxy (a symbol trading at a small fraction of its own baseline is by
 * definition thin that day) — see LIQUIDITY_MIN_RELATIVE_ACTIVITY below.
 * This is a deliberate simplification; a dedicated spread-based liquidity
 * check belongs in the funnel/adapter layer (apps/worker) where the raw
 * spread is available, and can be threaded into ScoringEngineInput later
 * without changing this function's shape.
 */

// -----------------------------------------------------------------------
// Named thresholds not present in StrategyConfig (documented simplifications)
// -----------------------------------------------------------------------

/** LIQUIDITY gate proxy: below this fraction of baseline volume/turnover, treat as illiquid today. */
const LIQUIDITY_MIN_RELATIVE_ACTIVITY = 0.2;

/**
 * USER_RISK_LIMIT ceiling: reasonable default = riskPerTradePctMax *
 * maxSimultaneousPositions, i.e. the worst case if every allowed slot is
 * filled at the maximum permitted per-trade risk. Not a dedicated config
 * field (none exists); documented here rather than adding one, since the
 * blueprint states risk-per-trade and position-count limits separately but
 * never an explicit combined ceiling.
 */
function maxOpenRiskPct(config: StrategyConfig): number {
  return config.risk.riskPerTradePctMax * config.risk.maxSimultaneousPositions;
}

// -----------------------------------------------------------------------
// Component derivations (blueprint gives weights only, not sub-formulas;
// each derivation below is a documented, deterministic choice).
// -----------------------------------------------------------------------

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(Math.max(x, 0), 1);
}

/**
 * Broker Flow Quality (40%): breadth, dominance, HHI, persistence, seller
 * pressure combined 0-1. Derivation:
 *  - breadthScore: meaningfulBuyerCount vs config.minMeaningfulBuyers*2 (saturates
 *    once buyer breadth is comfortably above the baseline minimum)
 *  - dominanceScore: 1 - (top1Share / top1ShareMax), clamped -- the further
 *    below the hard ceiling, the healthier
 *  - hhiScore: 1 - (hhi / hhiMax), clamped
 *  - persistenceScore: persistenceDays / persistenceWindowDays
 *  - sellerPressureScore: 1 - sellerConcentrationTop1Share (diffuse selling is healthier)
 * Combined as an unweighted average of the five sub-scores (each already
 * 0-1); the 40% headline weight is applied once at the composite stage.
 */
function computeBrokerFlowQuality(
  features: ScoringEngineInput["features"],
  config: StrategyConfig
): number {
  const bf = features.brokerFlow;
  const { concentration } = config;
  const breadthScore = clamp01(bf.meaningfulBuyerCount / (concentration.minMeaningfulBuyers * 2));
  const dominanceScore = clamp01(1 - bf.top1Share / concentration.top1ShareMax);
  const hhiScore = clamp01(1 - bf.hhi / concentration.hhiMax);
  const persistenceScore = clamp01(bf.persistenceDays / bf.persistenceWindowDays);
  const sellerPressureScore = clamp01(1 - bf.sellerConcentrationTop1Share);
  return clamp01(
    (breadthScore + dominanceScore + hhiScore + persistenceScore + sellerPressureScore) / 5
  );
}

/**
 * Volume Anomaly (25%): volume pace and turnover relative to baseline.
 * Both are ratios centered at 1.0 (in line with baseline); we map ratio 1.0
 * -> 0.5 (neutral) and ratio >= 3.0 -> 1.0 (strong anomaly), linearly in
 * between, then average the two sub-scores. A ratio below 1.0 scores
 * proportionally below 0.5 (below-baseline activity is not "anomalous
 * accumulation").
 */
function anomalyScore(ratio: number): number {
  return clamp01(ratio / 3);
}

function computeVolumeAnomaly(features: ScoringEngineInput["features"]): number {
  const v = features.volume;
  return clamp01((anomalyScore(v.volumePace) + anomalyScore(v.turnoverRelative)) / 2);
}

/**
 * Smart Money Margin (20%): position of price relative to B-Avg, with a
 * chase penalty. Ideal is a modest positive premium (price has moved up
 * from the accumulation average, confirming smart money is in the money,
 * but not so far that a fresh entry is chasing). Formula:
 *  - pctAboveBAvg null (no B-Avg) -> 0 (no evidence)
 *  - pctAboveBAvg < 0 (price still below B-Avg) -> 0.3 * (1 + pct/chaseMax), floor 0
 *    (still some credit for an accumulation zone, but capped low)
 *  - 0 <= pctAboveBAvg <= chaseMaxPctAboveBAvg -> scales 0.5 -> 1.0 across that band
 *  - pctAboveBAvg > chaseMaxPctAboveBAvg -> penalty, decaying back toward 0
 */
function computeSmartMoneyMargin(
  features: ScoringEngineInput["features"],
  config: StrategyConfig
): number {
  const pct = features.price.pctAboveBAvg;
  const chaseMax = config.risk.chaseMaxPctAboveBAvg;
  if (pct === null) return 0;
  if (pct < 0) return clamp01(0.3 * (1 + pct / chaseMax));
  if (pct <= chaseMax) return clamp01(0.5 + 0.5 * (pct / chaseMax));
  const overshoot = (pct - chaseMax) / chaseMax;
  return clamp01(1 - overshoot);
}

/** Price Response (10%): priceResponseScore is already 0-1, pass through. */
function computePriceResponse(features: ScoringEngineInput["features"]): number {
  return clamp01(features.price.priceResponseScore);
}

/** Confluence (5%): average of seasonal/insider scores that are present; 0 if both absent. */
function computeConfluence(features: ScoringEngineInput["features"]): number {
  const scores = [features.confluence.seasonalScore, features.confluence.insiderScore].filter(
    (s): s is number => s !== null
  );
  if (scores.length === 0) return 0;
  return clamp01(scores.reduce((a, b) => a + b, 0) / scores.length);
}

// -----------------------------------------------------------------------
// Hard gates (blueprint 6.1 + concentration baselines from 5.2)
// -----------------------------------------------------------------------

function evaluateGates(input: ScoringEngineInput, config: StrategyConfig): HardGateResult[] {
  const { features } = input;
  const bf = features.brokerFlow;
  const { concentration, risk } = config;

  const gates: HardGateResult[] = [];

  gates.push({
    gate: "FRESHNESS",
    passed: !features.dataStale,
    reason: features.dataStale ? "Data is stale or provisional/unsettled" : null
  });

  gates.push({
    gate: "SEGMENT_SEPARATION",
    passed: !features.segmentMixed,
    reason: features.segmentMixed
      ? "Regular market volume could not be separated from negotiated/crossing"
      : null
  });

  const liquidityOk =
    features.volume.volumePace >= LIQUIDITY_MIN_RELATIVE_ACTIVITY ||
    features.volume.turnoverRelative >= LIQUIDITY_MIN_RELATIVE_ACTIVITY;
  gates.push({
    gate: "LIQUIDITY",
    passed: liquidityOk,
    reason: liquidityOk
      ? null
      : "Volume/turnover far below baseline (proxy for insufficient liquidity)"
  });

  const chaseOk = features.price.pctAboveBAvg === null || features.price.pctAboveBAvg <= risk.chaseMaxPctAboveBAvg;
  gates.push({
    gate: "CHASE_LIMIT",
    passed: chaseOk,
    reason: chaseOk ? null : `Price is more than ${(risk.chaseMaxPctAboveBAvg * 100).toFixed(1)}% above B-Avg`
  });

  const distributionOk = !bf.brokerFlip && !bf.failedAbsorption;
  gates.push({
    gate: "BROKER_FLIP_OR_DISTRIBUTION",
    passed: distributionOk,
    reason: distributionOk
      ? null
      : [bf.brokerFlip ? "broker flip detected" : null, bf.failedAbsorption ? "failed absorption detected" : null]
          .filter(Boolean)
          .join("; ")
  });

  gates.push({
    gate: "NEWS_REVIEW",
    passed: !input.hasUnreviewedNews,
    reason: input.hasUnreviewedNews ? "Unreviewed UMA/suspension/corporate action/material news" : null
  });

  const netRrOk = input.netRewardToRiskEstimate >= risk.minNetRewardToRisk;
  gates.push({
    gate: "NET_RR_MIN",
    passed: netRrOk,
    reason: netRrOk
      ? null
      : `Net reward:risk ${input.netRewardToRiskEstimate.toFixed(2)} below minimum ${risk.minNetRewardToRisk}`
  });

  const maxRisk = maxOpenRiskPct(config);
  const riskLimitOk = input.userOpenRiskPct <= maxRisk;
  gates.push({
    gate: "USER_RISK_LIMIT",
    passed: riskLimitOk,
    reason: riskLimitOk
      ? null
      : `User open risk ${(input.userOpenRiskPct * 100).toFixed(2)}% exceeds limit ${(maxRisk * 100).toFixed(2)}%`
  });

  const concentrationOk =
    bf.top1Share <= concentration.top1ShareMax &&
    bf.top3Share <= concentration.top3ShareMax &&
    bf.hhi <= concentration.hhiMax &&
    bf.meaningfulBuyerCount >= concentration.minMeaningfulBuyers &&
    bf.persistenceDays >= concentration.persistenceMinDays;
  gates.push({
    gate: "CONCENTRATION",
    passed: concentrationOk,
    reason: concentrationOk
      ? null
      : "Broker concentration baselines not met (Top1/Top3/HHI/meaningful buyers/persistence)"
  });

  return gates;
}

/** Gates whose failure forces NO_TRADE (independent of score) per blueprint 6 category table. */
const NO_TRADE_GATES = new Set<HardGateResult["gate"]>([
  "FRESHNESS",
  "SEGMENT_SEPARATION",
  "NET_RR_MIN",
  "USER_RISK_LIMIT"
]);

function categorize(
  compositeScore: number,
  gates: HardGateResult[],
  config: StrategyConfig
): { category: SignalCategory; noTradeReason: string | null } {
  const failedGates = gates.filter((g) => !g.passed);
  const noTradeGateFailure = failedGates.find((g) => NO_TRADE_GATES.has(g.gate));
  if (noTradeGateFailure) {
    return { category: "NO_TRADE", noTradeReason: noTradeGateFailure.reason };
  }
  if (failedGates.length > 0) {
    // Any other hard gate failure always overrides score to AVOID (6.1: "hard gate always beats score").
    return {
      category: "AVOID",
      noTradeReason: null
    };
  }
  const { categories } = config;
  if (compositeScore >= categories.strongBuyMin) return { category: "STRONG_BUY", noTradeReason: null };
  if (compositeScore >= categories.speculativeBuyMin) return { category: "SPECULATIVE_BUY", noTradeReason: null };
  if (compositeScore >= categories.watchlistMin) return { category: "WATCHLIST", noTradeReason: null };
  return { category: "AVOID", noTradeReason: null };
}

function computeConfidence(
  features: ScoringEngineInput["features"],
  gates: HardGateResult[]
): "high" | "medium" | "low" {
  if (features.brokerFlow.bAvgConfidence === "low" || features.dataStale) return "low";
  const failedNonBlocking = gates.filter((g) => !g.passed).length;
  if (failedNonBlocking > 0) return "low";
  return "high";
}

export const scoreCandidate: ScoreCandidate = (
  input: ScoringEngineInput,
  config: StrategyConfig
): ScoreResult => {
  const { features } = input;
  const { weights } = config;

  const components: ScoreComponents = {
    brokerFlowQuality: computeBrokerFlowQuality(features, config),
    volumeAnomaly: computeVolumeAnomaly(features),
    smartMoneyMargin: computeSmartMoneyMargin(features, config),
    priceResponse: computePriceResponse(features),
    confluence: computeConfluence(features)
  };

  // Composite Score = 40*BF + 25*VA + 20*MM + 10*PR + 5*CF, weights from
  // config (already expressed as fractions of 1 in CompositeWeights, e.g.
  // 0.40), scaled to 0-100. Weight is NOT renormalized when confluence is 0.
  const compositeScore =
    100 *
    (weights.brokerFlowQuality * components.brokerFlowQuality +
      weights.volumeAnomaly * components.volumeAnomaly +
      weights.smartMoneyMargin * components.smartMoneyMargin +
      weights.priceResponse * components.priceResponse +
      weights.confluence * components.confluence);

  const gates = evaluateGates(input, config);
  const { category, noTradeReason } = categorize(compositeScore, gates, config);
  const confidence = computeConfidence(features, gates);

  return {
    symbol: features.symbol,
    tradingDate: features.tradingDate,
    formulaVersion: config.formulaVersion,
    configVersion: config.version,
    components,
    compositeScore,
    category,
    gates,
    noTradeReason,
    confidence
  };
};
