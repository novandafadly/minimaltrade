import type { RiskFlags, Signal } from "../types/signal.js";
import type { AssembleSignal, SignalAssemblyInput } from "./interfaces.js";

/**
 * Trivial pure combination of FeatureSnapshot + ScoreResult + TradePlan into
 * a Signal (blueprint §9.1). No calculation happens here beyond deriving the
 * boolean flags from already-computed feature/score fields.
 */
export const assembleSignal: AssembleSignal = (input: SignalAssemblyInput): Signal => {
  const { features, score, plan } = input;

  const gateFailed = (gate: (typeof score.gates)[number]["gate"]): boolean =>
    score.gates.some((g) => g.gate === gate && !g.passed);

  const flags: RiskFlags = {
    stale: features.dataStale,
    crossing: features.segmentMixed,
    brokerFlip: features.brokerFlow.brokerFlip,
    chase: gateFailed("CHASE_LIMIT"),
    illiquid: gateFailed("LIQUIDITY"),
    newsReview: gateFailed("NEWS_REVIEW")
  };

  // A NO_TRADE/AVOID category should not carry a live plan forward even if
  // the risk engine happened to compute one; the signal's plan is null
  // whenever the category is NO_TRADE, or when no plan was ever computed.
  const effectivePlan = plan && score.category !== "NO_TRADE" ? plan : null;

  return {
    symbol: features.symbol,
    tradingDate: features.tradingDate,
    generatedAt: features.generatedAt,
    // Expiry defaults to the trade plan's session-end expiry when a plan
    // exists; otherwise documented default = the feature snapshot's
    // generatedAt timestamp (there is no session to expire into without a
    // plan, so the signal itself is treated as already "expired"/informational).
    expiry: effectivePlan?.expiry ?? features.generatedAt,
    category: score.category,
    compositeScore: score.compositeScore,
    confidence: score.confidence,
    noTradeReason: score.noTradeReason,
    broker: features.brokerFlow,
    plan: effectivePlan,
    flags,
    inputSnapshotId: features.inputSnapshotId,
    formulaVersion: features.formulaVersion,
    configVersion: score.configVersion
  };
};
