import type { TradeOutcome } from "./fillSimulation.js";

/**
 * Batch metrics over a set of simulated TradeOutcomes (blueprint §13.2, §2,
 * §14: net expectancy, profit factor, max drawdown, average net RR, fill
 * rate, false-accumulation rate, rule adherence). Pure aggregation, no I/O.
 *
 * NOTE on ruleAdherenceRate: TradeOutcome.ruleAdherence is always true for a
 * mechanical backtest replay (the simulator cannot itself deviate from the
 * plan it's given -- see fillSimulation.ts). This metric is computed here
 * for shape-compatibility with the paper-trading journal (apps/web), where
 * a human executing manually can genuinely deviate from a plan; in a pure
 * replay it will read 1.0 and that is expected, not a bug.
 *
 * NOTE on falseAccumulationRate: approximated as "filled trades whose first
 * exit leg was an SL" (the broker-flow accumulation signal implied a move
 * up that did not materialize before risk was cut) -- the closest proxy
 * available from TradeOutcome alone, since a full "was this actually a
 * failed accumulation vs. a legitimate stop-out" judgment needs broker-flow
 * data this package's fill simulator does not carry.
 */
export interface ReplayMetrics {
  tradeCount: number;
  filledCount: number;
  partialCount: number;
  noFillCount: number;
  fillRate: number; // (filled + partial) / tradeCount
  winCount: number; // filled trades with netPnl > 0
  lossCount: number; // filled trades with netPnl <= 0
  winRate: number; // winCount / (filled trade count), 0 if none filled
  netExpectancy: number; // mean netPnl over filled trades (Rupiah), 0 if none filled
  profitFactor: number; // sum(winning netPnl) / abs(sum(losing netPnl)); Infinity if no losses and >0 wins, 0 if no trades
  maxDrawdown: number; // largest peak-to-trough drop in cumulative netPnl equity curve (Rupiah), >= 0
  avgNetRR: number; // mean of non-null netRR over filled trades
  falseAccumulationRate: number; // see NOTE above
  ruleAdherenceRate: number; // see NOTE above
}

const EMPTY_METRICS: ReplayMetrics = {
  tradeCount: 0,
  filledCount: 0,
  partialCount: 0,
  noFillCount: 0,
  fillRate: 0,
  winCount: 0,
  lossCount: 0,
  winRate: 0,
  netExpectancy: 0,
  profitFactor: 0,
  maxDrawdown: 0,
  avgNetRR: 0,
  falseAccumulationRate: 0,
  ruleAdherenceRate: 0
};

export function computeMetrics(outcomes: TradeOutcome[]): ReplayMetrics {
  if (outcomes.length === 0) return { ...EMPTY_METRICS };

  const tradeCount = outcomes.length;
  const filled = outcomes.filter((o) => o.fill.status === "filled" || o.fill.status === "partial");
  const partialCount = outcomes.filter((o) => o.fill.status === "partial").length;
  const noFillCount = outcomes.filter((o) => o.fill.status === "no_fill").length;
  const filledCount = filled.length;

  const wins = filled.filter((o) => o.netPnl > 0);
  const losses = filled.filter((o) => o.netPnl <= 0);

  const grossWinSum = wins.reduce((s, o) => s + o.netPnl, 0);
  const grossLossSum = losses.reduce((s, o) => s + o.netPnl, 0); // negative or zero

  const netExpectancy = filledCount > 0 ? filled.reduce((s, o) => s + o.netPnl, 0) / filledCount : 0;
  const profitFactor = grossLossSum < 0 ? grossWinSum / Math.abs(grossLossSum) : grossWinSum > 0 ? Infinity : 0;

  // Equity curve in the order trades occurred (outcomes are expected to be
  // pre-sorted by tradingDate by the caller/replay engine); only filled
  // trades move the curve since no_fill trades have zero P&L by construction.
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const o of filled) {
    cumulative += o.netPnl;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  const rrValues = filled.map((o) => o.netRR).filter((v): v is number => v !== null);
  const avgNetRR = rrValues.length > 0 ? rrValues.reduce((s, v) => s + v, 0) / rrValues.length : 0;

  const falseAccumulationCount = filled.filter((o) => o.exits[0]?.reason === "sl").length;
  const falseAccumulationRate = filledCount > 0 ? falseAccumulationCount / filledCount : 0;

  const ruleAdherenceRate = tradeCount > 0 ? outcomes.filter((o) => o.ruleAdherence).length / tradeCount : 0;

  return {
    tradeCount,
    filledCount,
    partialCount,
    noFillCount,
    fillRate: tradeCount > 0 ? filledCount / tradeCount : 0,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: filledCount > 0 ? wins.length / filledCount : 0,
    netExpectancy,
    profitFactor,
    maxDrawdown,
    avgNetRR,
    falseAccumulationRate,
    ruleAdherenceRate
  };
}

/**
 * Segments outcomes by an arbitrary key (blueprint §13.2 breakdown: sector,
 * cap, liquidity, market-condition, score-category, distance-to-B-Avg).
 * Only score-category segmentation is wired up by the replay engine/CLI in
 * this package today -- sector/cap/market-condition/distance-to-B-Avg need
 * data (instrument.sector, market cap, an index proxy for market condition,
 * FeatureSnapshot.price.pctAboveBAvg) that this package's fixtures don't
 * have meaningful variety for and the Postgres path doesn't join yet. The
 * grouping mechanism itself is generic, so wiring in a new segment is just
 * supplying a different `keyFn` -- no changes needed here.
 */
export function segmentMetrics<T extends TradeOutcome>(
  outcomes: T[],
  keyFn: (outcome: T) => string
): Record<string, ReplayMetrics> {
  const groups = new Map<string, T[]>();
  for (const o of outcomes) {
    const key = keyFn(o);
    const arr = groups.get(key);
    if (arr) arr.push(o);
    else groups.set(key, [o]);
  }
  const result: Record<string, ReplayMetrics> = {};
  for (const [key, group] of groups) {
    result[key] = computeMetrics(group);
  }
  return result;
}
