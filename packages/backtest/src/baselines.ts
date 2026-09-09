import type { StrategyConfig } from "@idx/config";
import { buildRiskPlan, type HistoryData, type ScoreResult, type TradePlan } from "@idx/domain";
import type { LiquidUniverseEntry } from "./dataSource/types.js";

/**
 * Baseline candidate-selection strategies (blueprint §13.2, §2, §14: compare
 * the broker-flow/composite-score signal against "random liquid universe"
 * and "volume-only ranking"). Both baselines deliberately do NOT use any
 * broker-flow or composite-score logic -- only a liquidity filter, then
 * either a random pick or a raw-volume ranking. They build TradePlans
 * through the SAME domain risk engine (`buildRiskPlan`) the real pipeline
 * uses, so the P&L/fill comparison against the signal-driven strategy is
 * fair: the only thing that differs between strategies is which symbols get
 * selected, never how a selected symbol's plan/fees/slippage is computed.
 */

const MIN_LIQUID_TURNOVER = 500_000_000; // Rp 500jt/day, a simple documented liquidity floor for baseline eligibility

export function liquidCandidates(universe: LiquidUniverseEntry[], minTurnover = MIN_LIQUID_TURNOVER): LiquidUniverseEntry[] {
  return universe.filter((u) => u.avgTurnover20d >= minTurnover);
}

/** Deterministic PRNG (mulberry32) so "random" baseline picks are still reproducible across runs given the same seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickN<T>(items: T[], n: number, rand: () => number): T[] {
  const pool = [...items];
  const picked: T[] = [];
  while (pool.length > 0 && picked.length < n) {
    const idx = Math.floor(rand() * pool.length);
    const [item] = pool.splice(idx, 1);
    if (item !== undefined) picked.push(item);
  }
  return picked;
}

function baselineScore(symbol: string, tradingDate: string, config: StrategyConfig): ScoreResult {
  // Baselines intentionally carry no broker-flow signal -- this is a
  // placeholder ScoreResult used only to satisfy buildRiskPlan's input
  // shape and to size positions identically to the real pipeline (STRONG_BUY
  // = full size, matching "no size reduction" since there is no
  // SPECULATIVE_BUY concept for a baseline that computes no score).
  return {
    symbol,
    tradingDate,
    formulaVersion: config.formulaVersion,
    configVersion: config.version,
    components: { brokerFlowQuality: 0, volumeAnomaly: 0, smartMoneyMargin: 0, priceResponse: 0, confluence: 0 },
    compositeScore: 0,
    category: "STRONG_BUY",
    gates: [],
    noTradeReason: null,
    confidence: "low"
  };
}

/**
 * A naive-but-documented entry/stop for baseline candidates, derived purely
 * from OHLCV (no broker-flow data): enter at the last close, stop below the
 * recent (5-day) low. This is not meant to be a good trading rule -- it
 * exists only so the baseline's fill/exit simulation is apples-to-apples
 * with the signal-driven strategy's plan shape.
 */
export function planFromHistory(
  symbol: string,
  tradingDate: string,
  history: HistoryData,
  config: StrategyConfig,
  sessionEndIso: string
): TradePlan | null {
  const bars = history.bars;
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1];
  if (!last) return null;
  const lookback = bars.slice(-5);
  const recentLow = Math.min(...lookback.map((b) => b.low));
  if (recentLow >= last.close) return null; // degenerate, no valid stop below entry

  return buildRiskPlan(
    {
      symbol,
      tradingDate,
      entryTrigger: last.close,
      stopLossRaw: recentLow,
      score: baselineScore(symbol, tradingDate, config),
      sessionEndIso
    },
    config
  );
}

export interface BaselineStrategyDeps {
  universe: LiquidUniverseEntry[];
  historyBySymbol: Map<string, HistoryData>;
  tradingDate: string;
  sessionEndIso: string;
  config: StrategyConfig;
  maxCandidates: number;
}

/** "Random liquid universe": liquidity filter, then a uniform random pick. */
export function randomLiquidUniverseStrategy(deps: BaselineStrategyDeps, seed: number): TradePlan[] {
  const eligible = liquidCandidates(deps.universe);
  const picked = pickN(eligible, deps.maxCandidates, mulberry32(seed));
  const plans: TradePlan[] = [];
  for (const entry of picked) {
    const history = deps.historyBySymbol.get(entry.symbol);
    if (!history) continue;
    const plan = planFromHistory(entry.symbol, deps.tradingDate, history, deps.config, deps.sessionEndIso);
    if (plan && !plan.isNoTrade) plans.push(plan);
  }
  return plans;
}

/** "Volume-only ranking": liquidity filter, then top-N by raw 20d average volume. */
export function volumeOnlyRankingStrategy(deps: BaselineStrategyDeps): TradePlan[] {
  const eligible = liquidCandidates(deps.universe);
  const ranked = [...eligible].sort((a, b) => b.avgVolume20d - a.avgVolume20d).slice(0, deps.maxCandidates);
  const plans: TradePlan[] = [];
  for (const entry of ranked) {
    const history = deps.historyBySymbol.get(entry.symbol);
    if (!history) continue;
    const plan = planFromHistory(entry.symbol, deps.tradingDate, history, deps.config, deps.sessionEndIso);
    if (plan && !plan.isNoTrade) plans.push(plan);
  }
  return plans;
}
