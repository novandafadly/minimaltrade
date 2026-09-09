import type { StrategyConfig } from "@idx/config";
import type { BrokerRow, BrokerSummaryData } from "../types/marketData.js";
import type { FeatureSnapshot } from "../types/signal.js";
import type { ComputeFeatureSnapshot, FeatureEngineInput } from "./interfaces.js";

/**
 * Feature Engine (blueprint section 5). Pure, deterministic, network-free.
 * Every threshold that the blueprint states only qualitatively (suspected
 * transfer, failed absorption, volume pace approximation) is defined as a
 * named constant near the top of this file rather than inline, so it can be
 * promoted into StrategyConfig later without touching call sites.
 */

// -----------------------------------------------------------------------
// Named constants for thresholds the blueprint gives only qualitatively.
// -----------------------------------------------------------------------

/** suspectedTransfer: net/gross ratio below this is "net small relative to gross". */
const TRANSFER_NET_TO_GROSS_MAX = 0.15;
/** suspectedTransfer: avg buy vs avg sell price must be within this relative delta. */
const TRANSFER_AVG_PRICE_DELTA_MAX = 0.005; // 0.5%
/** suspectedTransfer / failedAbsorption: gross buy or sell value must be at least this
 * share of total traded value to count as "large" (avoids flagging tiny brokers). */
const TRANSFER_MIN_GROSS_SHARE_OF_TOTAL = 0.1;
/** failedAbsorption: volumePace or turnoverRelative above this counts as a "spike". */
const ABSORPTION_SPIKE_RATIO = 1.5;
/** failedAbsorption: today's price change (pct) at/below this counts as "weak/negative". */
const ABSORPTION_WEAK_CLOSE_PCT = 0; // close <= previous close (i.e. non-positive change)

/**
 * A broker qualifies as an "accumulator" for B-Avg purposes when its net buy
 * is positive. The blueprint (5.1) only says "the set of accumulator brokers
 * that meet minimum positive net buy and persistence" without a numeric
 * per-broker floor beyond positivity, so we use netVolume > 0 as the filter;
 * the concentration gates (top1/top3/HHI/meaningful buyer count) applied
 * downstream already exclude noise-level participation from mattering.
 */
function isAccumulatorBroker(row: BrokerRow): boolean {
  return row.netVolume > 0;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * 5.1 B-Avg = sum(gross buy value of accumulator brokers) / sum(gross buy
 * shares of accumulator brokers). Uses GROSS buy, never net value/net volume
 * (blueprint explicitly warns net/net is unstable when a broker buys and
 * sells similar amounts). Returns null + low confidence when gross buy
 * value/shares are unavailable for every accumulator broker.
 */
function computeBAvg(brokers: BrokerRow[]): { bAvg: number | null; confidence: "high" | "low" } {
  const accumulators = brokers.filter(isAccumulatorBroker);
  const grossBuyValue = sum(accumulators.map((b) => b.buyValue));
  const grossBuyShares = sum(accumulators.map((b) => b.buyVolume));
  if (accumulators.length === 0 || grossBuyShares <= 0 || grossBuyValue <= 0) {
    return { bAvg: null, confidence: "low" };
  }
  return { bAvg: grossBuyValue / grossBuyShares, confidence: "high" };
}

interface ConcentrationResult {
  top1Share: number;
  top3Share: number;
  hhi: number;
  meaningfulBuyerCount: number;
  buyerBreadthCount: number;
}

/**
 * 5.2 Broker spread over the POSITIVE net buy side. Top1Share/Top3Share/HHI
 * are all computed as shares of total positive net buy across brokers with
 * netVolume > 0 (positive net buyers), sorted descending by net buy.
 */
function computeBuyerConcentration(
  brokers: BrokerRow[],
  meaningfulBuyerMinShare: number
): ConcentrationResult {
  const positiveBuyers = brokers.filter((b) => b.netVolume > 0);
  const totalPositiveNetBuy = sum(positiveBuyers.map((b) => b.netVolume));
  if (totalPositiveNetBuy <= 0) {
    return { top1Share: 0, top3Share: 0, hhi: 0, meaningfulBuyerCount: 0, buyerBreadthCount: 0 };
  }
  const shares = positiveBuyers
    .map((b) => b.netVolume / totalPositiveNetBuy)
    .sort((a, b) => b - a);
  const top1Share = shares[0] ?? 0;
  const top3Share = sum(shares.slice(0, 3));
  const hhi = sum(shares.map((s) => s * s));
  const meaningfulBuyerCount = shares.filter((s) => s >= meaningfulBuyerMinShare).length;
  return { top1Share, top3Share, hhi, meaningfulBuyerCount, buyerBreadthCount: positiveBuyers.length };
}

/**
 * Seller-side Top1Share: same formula, mirrored over positive net SELL
 * magnitude (netVolume < 0, magnitude = -netVolume).
 */
function computeSellerTop1Share(brokers: BrokerRow[]): number {
  const positiveSellers = brokers.filter((b) => b.netVolume < 0);
  const totalPositiveNetSell = sum(positiveSellers.map((b) => -b.netVolume));
  if (totalPositiveNetSell <= 0) return 0;
  const shares = positiveSellers.map((b) => -b.netVolume / totalPositiveNetSell);
  return Math.max(...shares, 0);
}

function topBuyerCode(brokers: BrokerRow[]): string | null {
  let best: BrokerRow | null = null;
  for (const b of brokers) {
    if (b.netVolume > 0 && (best === null || b.netVolume > best.netVolume)) best = b;
  }
  return best?.brokerCode ?? null;
}

function topSellerCode(brokers: BrokerRow[]): string | null {
  let worst: BrokerRow | null = null;
  for (const b of brokers) {
    if (b.netVolume < 0 && (worst === null || b.netVolume < worst.netVolume)) worst = b;
  }
  return worst?.brokerCode ?? null;
}

/**
 * A day "qualifies" for persistence when it has meaningful accumulation
 * activity: at least one broker meeting the meaningful-buyer share threshold
 * on the positive-net-buy side, using the same logic as computeBuyerConcentration.
 * Cross-referenced against brokerSummaryByDay (the authoritative per-broker
 * rows) rather than brokerAccumulation.days alone, per the task instructions.
 */
function dayQualifiesForPersistence(day: BrokerSummaryData, meaningfulBuyerMinShare: number): boolean {
  const { meaningfulBuyerCount } = computeBuyerConcentration(day.brokers, meaningfulBuyerMinShare);
  return meaningfulBuyerCount >= 1;
}

/**
 * Persistence = count of days (within the trailing window) that qualify,
 * counted over brokerSummaryByDay (most-recent-last per the input contract),
 * taking at most the last `windowDays` entries.
 */
function computePersistence(
  brokerSummaryByDay: BrokerSummaryData[],
  windowDays: number,
  meaningfulBuyerMinShare: number
): number {
  const window = brokerSummaryByDay.slice(-windowDays);
  return window.filter((day) => dayQualifiesForPersistence(day, meaningfulBuyerMinShare)).length;
}

/**
 * brokerFlip: true when the top buyer broker on a prior day becomes the top
 * seller broker in the most recent 1-2 sessions. Requires at least 2 days of
 * history; with fewer than 2 days this is false (insufficient data is a
 * valid "no flip detected" answer here, not a stale/error condition).
 */
function computeBrokerFlip(brokerSummaryByDay: BrokerSummaryData[]): boolean {
  if (brokerSummaryByDay.length < 2) return false;
  const recent = brokerSummaryByDay[brokerSummaryByDay.length - 1];
  const priorDays = brokerSummaryByDay.slice(-3, -1); // up to 2 prior sessions
  if (!recent) return false;
  const recentTopSeller = topSellerCode(recent.brokers);
  if (!recentTopSeller) return false;
  return priorDays.some((prior) => topBuyerCode(prior.brokers) === recentTopSeller);
}

/**
 * suspectedTransfer: gross buy and gross sell both large relative to total
 * traded value, net small relative to gross, avg buy/sell prices close, AND
 * the same broker pair recurs as top-buyer/top-seller across days. See the
 * TRANSFER_* constants above for the exact numeric thresholds used (the
 * blueprint states these criteria qualitatively only).
 */
function computeSuspectedTransfer(brokerSummaryByDay: BrokerSummaryData[]): boolean {
  const recent = brokerSummaryByDay[brokerSummaryByDay.length - 1];
  if (!recent || recent.totalValue <= 0) return false;

  const recurringPair = (() => {
    if (brokerSummaryByDay.length < 2) return false;
    const pairs = brokerSummaryByDay.slice(-5).map((day) => {
      const buyer = topBuyerCode(day.brokers);
      const seller = topSellerCode(day.brokers);
      return buyer && seller ? `${buyer}|${seller}` : null;
    });
    const counts = new Map<string, number>();
    for (const p of pairs) {
      if (!p) continue;
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return [...counts.values()].some((count) => count >= 2);
  })();

  if (!recurringPair) return false;

  return recent.brokers.some((b) => {
    const grossBuyShareOfTotal = b.buyValue / recent.totalValue;
    const grossSellShareOfTotal = b.sellValue / recent.totalValue;
    const bothLarge =
      grossBuyShareOfTotal >= TRANSFER_MIN_GROSS_SHARE_OF_TOTAL &&
      grossSellShareOfTotal >= TRANSFER_MIN_GROSS_SHARE_OF_TOTAL;
    if (!bothLarge) return false;

    const grossTotal = b.buyValue + b.sellValue;
    const netToGross = grossTotal > 0 ? Math.abs(b.netValue) / grossTotal : 1;
    if (netToGross > TRANSFER_NET_TO_GROSS_MAX) return false;

    if (b.avgBuyPrice == null || b.avgSellPrice == null || b.avgBuyPrice <= 0) return false;
    const priceDelta = Math.abs(b.avgBuyPrice - b.avgSellPrice) / b.avgBuyPrice;
    return priceDelta <= TRANSFER_AVG_PRICE_DELTA_MAX;
  });
}

/**
 * volumePace: today's volume-to-this-point vs a baseline expected volume.
 * DOCUMENTED SIMPLIFICATION: true time-of-day pacing needs intraday tick
 * history, which V1's /api/history contract does not provide (only daily
 * OHLCV bars + a 20d median). We approximate pace as today's full-day volume
 * so far divided by the 20-day baseline median volume; this is a same-day
 * full-vs-baseline ratio, not a true intraday time-of-day pace, and callers
 * should treat volumePace as directional (spike vs no-spike) rather than a
 * precise intraday estimate. A ratio of 1.0 means "in line with the typical
 * day", not "in line with the typical day AT THIS TIME".
 */
function computeVolumePace(todayVolume: number, baselineMedianVolume20d: number | null): number {
  if (baselineMedianVolume20d === null || baselineMedianVolume20d <= 0) return 1;
  return todayVolume / baselineMedianVolume20d;
}

/**
 * turnoverRelative: today's turnover / trailing baseline (median turnover
 * over the last ~20 bars, excluding today). Falls back to 1 (neutral, "no
 * signal") when turnover data is missing from history bars, rather than
 * crashing; callers should combine this with dataStale/bAvgConfidence-style
 * low-confidence flags upstream if they need to distinguish "neutral" from
 * "unknown".
 */
function computeTurnoverRelative(todayTurnover: number, barsTurnovers: number[]): number {
  const valid = barsTurnovers.filter((t): t is number => typeof t === "number" && t > 0);
  if (valid.length === 0) return 1;
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
  if (median <= 0) return 1;
  return todayTurnover / median;
}

/**
 * priceResponseScore (0-1): "close near high on high volume = absorption"
 * heuristic. Combines (a) where today's close sits within today's
 * high-low range (0 = at low, 1 = at high) with (b) a volume-participation
 * factor so a strong close on THIN volume scores lower than the same close
 * on heavy volume (weak evidence of real absorption). Formula:
 *   rangePosition = (close - low) / (high - low), 0.5 if high==low (no range)
 *   volumeFactor = clamp(volumePace, 0, 2) / 2   // 0..1, saturates at 2x pace
 *   score = 0.7 * rangePosition + 0.3 * volumeFactor
 * Weights (0.7/0.3) are a documented, deliberately simple default — not from
 * the blueprint, which gives no exact formula for this component.
 */
function computePriceResponseScore(high: number, low: number, close: number, volumePace: number): number {
  const range = high - low;
  const rangePosition = range > 0 ? (close - low) / range : 0.5;
  const volumeFactor = Math.min(Math.max(volumePace, 0), 2) / 2;
  const score = 0.7 * rangePosition + 0.3 * volumeFactor;
  return Math.min(Math.max(score, 0), 1);
}

/**
 * failedAbsorption: volume or turnover spikes (>= ABSORPTION_SPIKE_RATIO)
 * but price closes weak/negative or below B-Avg.
 */
function computeFailedAbsorption(
  volumePace: number,
  turnoverRelative: number,
  priceChangePct: number,
  price: number,
  bAvg: number | null
): boolean {
  const spiked = volumePace >= ABSORPTION_SPIKE_RATIO || turnoverRelative >= ABSORPTION_SPIKE_RATIO;
  if (!spiked) return false;
  const weakClose = priceChangePct <= ABSORPTION_WEAK_CLOSE_PCT;
  const belowBAvg = bAvg !== null && price < bAvg;
  return weakClose || belowBAvg;
}

export const computeFeatureSnapshot: ComputeFeatureSnapshot = (
  input: FeatureEngineInput,
  config: StrategyConfig,
  now: string
): FeatureSnapshot => {
  const { screener, history, brokerSummaryByDay, segmentSeparable, dataStale } = input;
  const { concentration } = config;

  const mostRecentDay = brokerSummaryByDay[brokerSummaryByDay.length - 1] ?? null;
  const brokers = mostRecentDay?.brokers ?? [];

  const { bAvg, confidence: bAvgConfidence } = computeBAvg(brokers);
  const buyerConcentration = computeBuyerConcentration(brokers, concentration.meaningfulBuyerMinShare);
  const sellerConcentrationTop1Share = computeSellerTop1Share(brokers);
  const persistenceDays = computePersistence(
    brokerSummaryByDay,
    concentration.persistenceWindowDays,
    concentration.meaningfulBuyerMinShare
  );
  const brokerFlip = computeBrokerFlip(brokerSummaryByDay);
  const suspectedTransfer = computeSuspectedTransfer(brokerSummaryByDay);

  const barsTurnovers =
    history?.bars.slice(-21, -1).map((b) => b.turnover).filter((t): t is number => t !== null) ?? [];
  const volumePace = computeVolumePace(screener.volume, history?.baselineMedianVolume20d ?? null);
  const turnoverRelative = computeTurnoverRelative(screener.turnover, barsTurnovers);

  const lastBar = history?.bars[history.bars.length - 1] ?? null;
  const high = lastBar?.high ?? screener.price;
  const low = lastBar?.low ?? screener.price;
  const close = lastBar?.close ?? screener.price;
  const priceResponseScore = computePriceResponseScore(high, low, close, volumePace);

  const failedAbsorption = computeFailedAbsorption(
    volumePace,
    turnoverRelative,
    screener.priceChangePct,
    screener.price,
    bAvg
  );

  const pctAboveBAvg = bAvg !== null && bAvg > 0 ? (screener.price - bAvg) / bAvg : null;

  return {
    symbol: input.symbol,
    tradingDate: input.tradingDate,
    formulaVersion: config.formulaVersion,
    generatedAt: now,
    inputSnapshotId: input.inputSnapshotId,
    brokerFlow: {
      bAvg,
      bAvgConfidence,
      buyerBreadthCount: buyerConcentration.buyerBreadthCount,
      meaningfulBuyerCount: buyerConcentration.meaningfulBuyerCount,
      top1Share: buyerConcentration.top1Share,
      top3Share: buyerConcentration.top3Share,
      hhi: buyerConcentration.hhi,
      persistenceDays,
      persistenceWindowDays: concentration.persistenceWindowDays,
      sellerConcentrationTop1Share,
      brokerFlip,
      suspectedTransfer,
      failedAbsorption
    },
    volume: {
      volumePace,
      turnoverRelative
    },
    price: {
      priceResponseScore,
      pctAboveBAvg
    },
    confluence: {
      seasonalScore: input.seasonal?.historicalWinRate ?? null,
      insiderScore: computeInsiderScore(input.insiders)
    },
    // ownerStatus is ALWAYS "UNVERIFIED": broker-summary rows identify the
    // broker OF EXECUTION, not the beneficial owner (KSEI single-investor-id
    // is not public data). Never infer "N independent whales" from broker
    // count — the blueprint explicitly forbids that claim (5.2 closing note).
    ownerStatus: "UNVERIFIED",
    dataStale,
    segmentMixed: !segmentSeparable
  };
};

/**
 * insiderScore: 0-1 normalized "insider buying pressure" proxy, or null when
 * no insider data is present (blueprint: missing optional confluence
 * contributes zero at the SCORING stage, not here — the feature engine's job
 * is only to report null when data is absent, not to zero it itself).
 * Simple heuristic: fraction of recent insider transactions that are buys,
 * documented as a placeholder pending a richer insider signal design.
 */
function computeInsiderScore(insiders: FeatureEngineInput["insiders"]): number | null {
  if (!insiders || insiders.length === 0) return null;
  const buys = insiders.filter((t) => t.action === "buy").length;
  return buys / insiders.length;
}
