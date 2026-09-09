import { roundDownToTick, roundUpToTick, tickSizeFor, type StrategyConfig } from "@idx/config";
import type { TradePlan } from "../types/signal.js";
import type { BuildRiskPlan, RiskEngineInput } from "./interfaces.js";

/**
 * Risk Engine (blueprint section 7). Pure, deterministic, network-free. All
 * lot/price arithmetic is done in Rupiah and whole shares/lots; no rounding
 * step is skipped, and tick rounding always goes through
 * roundDownToTick/roundUpToTick from @idx/config (never reimplemented here).
 */

function buyFeePerShare(entry: number, config: StrategyConfig): number {
  return entry * config.risk.buyFeeRate;
}

function sellFeePerShare(price: number, config: StrategyConfig): number {
  return price * config.risk.sellFeeRate;
}

/**
 * SL placement: round the caller-provided raw stop DOWN to the nearest valid
 * tick (rounding down on the stop side is conservative -- it never narrows
 * the trader's actual risk below what the raw invalidation level implies).
 * Then enforce a minimum stop distance of config.risk.minStopDistanceTicks
 * ticks from entry: if the rounded stop is closer than that, push it further
 * away (down) by widening in tick-sized steps at the stop's own price level.
 */
function resolveStopLoss(entry: number, stopLossRaw: number, config: StrategyConfig): number {
  let sl = roundDownToTick(stopLossRaw);
  const minTicks = config.risk.minStopDistanceTicks;
  // Walk the stop down, tick by tick (at each step's own tick size, since
  // tick size can change across price tiers), until the distance from entry
  // is at least minTicks ticks (measured in ticks at the entry price level,
  // a stable reference since entry doesn't move during this loop).
  const entryTick = tickSizeFor(entry);
  const minDistance = minTicks * entryTick;
  let guard = 0;
  while (entry - sl < minDistance && guard < 10_000) {
    const tick = tickSizeFor(sl);
    sl = roundDownToTick(sl - tick);
    guard += 1;
  }
  return sl;
}

/**
 * maxBuyPrice: entryTrigger plus a small buffer (1 tick, at the entry's own
 * tick size) to bound acceptable slippage on a confirmation fill. Rejecting
 * fills above this (e.g. on a gap-up) is the CALLER's/worker's job at fill
 * time -- this function only computes the field.
 */
function computeMaxBuyPrice(entry: number): number {
  const tick = tickSizeFor(entry);
  return roundUpToTick(entry + tick);
}

/**
 * SPECULATIVE_BUY sizing: blueprint 6 states a SPECULATIVE_BUY category
 * "implies" a reduced position size of 50-70% of normal, without saying
 * which engine applies the reduction. We apply it here (the risk engine is
 * the only stage that produces a lot count), using the midpoint of that
 * range as a single deterministic multiplier. STRONG_BUY and all other
 * categories size at 100% (any further category-specific gating -- e.g.
 * AVOID/NO_TRADE -- happens by score.category short-circuiting to a NO_TRADE
 * plan below, not by scaling lots).
 */
const SPECULATIVE_BUY_SIZE_MULTIPLIER = 0.6; // midpoint of the blueprint's 50-70% range

function sizeMultiplierFor(category: RiskEngineInput["score"]["category"]): number {
  return category === "SPECULATIVE_BUY" ? SPECULATIVE_BUY_SIZE_MULTIPLIER : 1;
}

export const buildRiskPlan: BuildRiskPlan = (
  input: RiskEngineInput,
  config: StrategyConfig
): TradePlan => {
  const { entryTrigger: entry, stopLossRaw, score } = input;
  const { risk } = config;
  const generatedAt = input.sessionEndIso; // no Date.now(): caller supplies "now" via sessionEndIso context (expiry); generatedAt below uses tradingDate-scoped value

  const slPrice = resolveStopLoss(entry, stopLossRaw, config);
  const priceRisk = entry - slPrice; // price risk per share, before costs

  const buyFee = buyFeePerShare(entry, config);
  const sellFee = sellFeePerShare(entry, config); // sell-side fee estimated at entry price for sizing purposes
  const slippage = risk.slippageAllowancePerShare;

  // 7.2 Effective Risk per Share = (Entry - SL) + buy fee + sell fee + slippage allowance
  const effectiveRiskPerShare = priceRisk + buyFee + sellFee + slippage;

  const maxBuyPrice = computeMaxBuyPrice(entry);

  const buildEmptyPlan = (noTradeReason: string): TradePlan => ({
    symbol: input.symbol,
    tradingDate: input.tradingDate,
    formulaVersion: config.formulaVersion,
    configVersion: config.version,
    generatedAt: input.sessionEndIso,
    expiry: input.sessionEndIso,
    entryTrigger: entry,
    maxBuyPrice,
    totalLots: 0,
    estimatedCapital: 0,
    tp1Price: entry,
    tp1Lots: 0,
    tp2Price: entry,
    tp2Lots: 0,
    slPrice,
    slRemainingLots: 0,
    grossReward: 0,
    estimatedFees: 0,
    slippageAllowance: 0,
    netReward: 0,
    maxNetLoss: 0,
    netRewardToRisk: 0,
    isNoTrade: true,
    noTradeReason
  });

  if (priceRisk <= 0 || effectiveRiskPerShare <= 0) {
    return buildEmptyPlan("Stop loss is not below entry after tick rounding; no valid risk per share");
  }

  const riskBudgetRupiah = risk.totalCapital * risk.riskPerTradePct;
  const lotSize = risk.lotSizeShares;

  // Risk Lots = floor[Risk Budget / (100 x Effective Risk per Share)]
  const riskLots = Math.floor(riskBudgetRupiah / (lotSize * effectiveRiskPerShare));
  // Capital Lots = floor[Max Deployed Capital / (100 x Entry x (1 + buy fee rate))]
  const capitalLots = Math.floor(risk.maxDeployedCapital / (lotSize * entry * (1 + risk.buyFeeRate)));
  const finalLots = Math.max(0, Math.min(riskLots, capitalLots));
  // SPECULATIVE_BUY reduces size (see sizeMultiplierFor above); floor keeps
  // totalLots an integer number of lots.
  const totalLots = Math.floor(finalLots * sizeMultiplierFor(score.category));

  if (totalLots <= 0) {
    return buildEmptyPlan("Computed lot size is zero (risk budget or capital allocation too small for this entry/SL)");
  }

  // TP1 = entry + tp1RiskMultiple * priceRisk (before costs), rounded UP to
  // tick. Rounding TP up (vs SL rounding down) is deliberate: SL rounds down
  // to stay conservative on risk (never understate potential loss), while TP
  // rounds up to favor the trader taking profit (never understate the target,
  // which would otherwise trigger an exit fractionally early / at a worse
  // price than intended).
  const tp1PriceRaw = entry + risk.tp1RiskMultiple * priceRisk;
  const tp2PriceRaw = entry + risk.tp2RiskMultiple * priceRisk;
  const tp1Price = roundUpToTick(tp1PriceRaw);
  const tp2Price = roundUpToTick(tp2PriceRaw);

  // TP1/TP2 lots: rounding error goes into TP2 so tp1Lots + tp2Lots always
  // equals totalLots exactly (hard invariant, blueprint 7.5 / Acceptance
  // Criteria V1).
  const tp1Lots = Math.min(totalLots, Math.round(totalLots * risk.tp1AllocationPct));
  const tp2Lots = totalLots - tp1Lots;
  const slRemainingLots = totalLots;

  const estimatedCapital = totalLots * lotSize * entry * (1 + risk.buyFeeRate);

  // grossReward: weighted outcome assuming both TPs hit as allocated (a
  // simplifying assumption -- the actual outcome may hit only TP1, or SL
  // before either TP; this field represents the "plan as designed" reward,
  // consistent with how net RR is quoted in the blueprint's worked example).
  const grossReward = tp1Lots * lotSize * (tp1Price - entry) + tp2Lots * lotSize * (tp2Price - entry);

  // estimatedFees: round-trip fees across the full position -- buy fee on
  // entry for all lots, plus sell fee on each exit leg at its own exit price
  // (TP1/TP2 legs at their respective prices; the SL leg is NOT included
  // here because estimatedFees represents the cost of the WINNING scenario
  // this plan targets -- the SL-leg fee is instead folded into maxNetLoss
  // below, which models the losing scenario).
  const buyFeeTotal = totalLots * lotSize * entry * risk.buyFeeRate;
  const sellFeeTp1 = tp1Lots * lotSize * tp1Price * risk.sellFeeRate;
  const sellFeeTp2 = tp2Lots * lotSize * tp2Price * risk.sellFeeRate;
  const estimatedFees = buyFeeTotal + sellFeeTp1 + sellFeeTp2;

  const slippageAllowance = totalLots * lotSize * slippage;

  const netReward = grossReward - estimatedFees - slippageAllowance;

  // maxNetLoss: worst case assuming SL fills exactly at slPrice for the
  // whole remaining position -- price loss + buy fee (paid regardless of
  // outcome) + sell fee on the SL exit + slippage allowance. Always a
  // positive Rupiah figure representing the worst-case loss at the planned
  // SL (a real gap-down through SL is out of this pure function's scope --
  // that risk is surfaced via risk flags / hard gates, not modeled here).
  const sellFeeAtSl = totalLots * lotSize * slPrice * risk.sellFeeRate;
  const maxNetLoss = totalLots * lotSize * priceRisk + buyFeeTotal + sellFeeAtSl + slippageAllowance;

  const netRewardToRisk = maxNetLoss > 0 ? netReward / maxNetLoss : 0;

  const isNoTrade = totalLots <= 0 || netRewardToRisk < risk.minNetRewardToRisk;
  const noTradeReason = isNoTrade
    ? netRewardToRisk < risk.minNetRewardToRisk
      ? `Net reward:risk ${netRewardToRisk.toFixed(2)} below minimum ${risk.minNetRewardToRisk}`
      : "Computed lot size is zero"
    : null;

  return {
    symbol: input.symbol,
    tradingDate: input.tradingDate,
    formulaVersion: config.formulaVersion,
    configVersion: config.version,
    generatedAt,
    expiry: input.sessionEndIso,
    entryTrigger: entry,
    maxBuyPrice,
    totalLots,
    estimatedCapital,
    tp1Price,
    tp1Lots,
    tp2Price,
    tp2Lots,
    slPrice,
    slRemainingLots,
    grossReward,
    estimatedFees,
    slippageAllowance,
    netReward,
    maxNetLoss,
    netRewardToRisk,
    isNoTrade,
    noTradeReason
  };
};
