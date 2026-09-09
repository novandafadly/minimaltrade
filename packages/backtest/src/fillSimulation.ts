import type { StrategyConfig } from "@idx/config";
import type { OhlcvBar, TradePlan } from "@idx/domain";

/**
 * Fill/exit simulator (blueprint §13.2, §7.3-7.5). Pure and deterministic:
 * given a TradePlan and the real subsequent daily bars, it never reads a
 * clock or RNG -- same plan + same bars -> same outcome, always. This lets
 * the replay engine and its tests reason about exact expected results.
 *
 * GRANULARITY: the system's contract (blueprint) is EOD/daily OHLCV, not
 * intraday ticks. So "did the entry limit fill" and "which of TP1/TP2/SL
 * was touched first" are answered from daily open/high/low/close, not from
 * real intraday sequencing we don't have. Every place that ambiguity matters
 * is called out below with the conservative assumption we make instead.
 */

/** Fraction of a bar's traded volume our own order is allowed to consume
 * without being throttled to a partial fill. This is a documented modeling
 * heuristic (blueprint gives no exact algorithm): a real limit order that
 * is a large share of a thin day's volume would not fully fill without
 * material market impact, so we cap fillable lots at this fraction of the
 * bar's volume. 5% is a conservative, easy-to-reason-about default for a
 * retail-sized order; override via SimulationOptions.partialFillVolumeFraction. */
export const DEFAULT_PARTIAL_FILL_VOLUME_FRACTION = 0.05;

/** Default cap on how many bars the exit walk runs before force-closing the
 * remaining position at last close as "expiry" (holding a signal-driven
 * swing position indefinitely defeats the point of a dated trade plan). */
export const DEFAULT_MAX_HOLDING_BARS = 20;

export interface SimulationOptions {
  partialFillVolumeFraction?: number;
  maxHoldingBars?: number;
}

export type FillStatus = "filled" | "partial" | "no_fill";
export type ExitReason = "tp1" | "tp2" | "sl" | "expiry";

export interface FillEvent {
  status: FillStatus;
  /** Actual executed price, or null if nothing filled. */
  fillPrice: number | null;
  /** Lots actually filled (<= plan.totalLots; 0 for no_fill). */
  filledLots: number;
  fillDate: string | null;
  /** Why nothing (or only part) filled, for fill-rate diagnostics. */
  note: string | null;
}

export interface ExitLeg {
  reason: ExitReason;
  price: number;
  lots: number;
  date: string;
  /** true if this leg filled at a gapped price rather than the plan's theoretical level. */
  gapped: boolean;
}

export interface TradeOutcome {
  symbol: string;
  tradingDate: string;
  plan: TradePlan;
  fill: FillEvent;
  exits: ExitLeg[];
  /** Price P&L before fees/slippage, over filled lots only. */
  grossPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
  /** netPnl / (plan.maxNetLoss scaled to filled lots). null when not filled or maxNetLoss is 0. */
  netRR: number | null;
  /** Backtest replay mechanically follows the plan's own rules (never chases
   * above maxBuyPrice, exits exactly at plan levels or a documented gap
   * price) so this is always true here; it exists for shape-compatibility
   * with the paper-trading journal's adherence tracking, where a human
   * executing manually can actually deviate. See METRICS_NOTES in metrics.ts. */
  ruleAdherence: boolean;
}

function lotSize(config: StrategyConfig): number {
  return config.risk.lotSizeShares;
}

/**
 * Entry fill simulation for the plan's own trading-date bar.
 *
 * - Gap-up past maxBuyPrice -> reject entry entirely (blueprint §7.3).
 * - Price never trades down to entryTrigger (bar.low > entryTrigger) -> no fill.
 * - Otherwise: fill at open if open already <= entryTrigger (better than the
 *   limit), else at entryTrigger itself (the limit price, since we assume
 *   the order queues at the limit and only actually executes once price
 *   trades down to it) -- capped at maxBuyPrice either way.
 * - Partial fill: fillable lots capped at `partialFillVolumeFraction` of the
 *   bar's volume (see DEFAULT_PARTIAL_FILL_VOLUME_FRACTION above).
 */
export function simulateEntry(plan: TradePlan, entryBar: OhlcvBar, config: StrategyConfig, options: SimulationOptions = {}): FillEvent {
  const fraction = options.partialFillVolumeFraction ?? DEFAULT_PARTIAL_FILL_VOLUME_FRACTION;
  const size = lotSize(config);

  if (entryBar.open > plan.maxBuyPrice) {
    return { status: "no_fill", fillPrice: null, filledLots: 0, fillDate: null, note: "gap-up past maxBuyPrice; entry rejected" };
  }
  if (entryBar.low > plan.entryTrigger) {
    return { status: "no_fill", fillPrice: null, filledLots: 0, fillDate: null, note: "price never traded down to entryTrigger" };
  }

  const theoreticalFillPrice = entryBar.open <= plan.entryTrigger ? entryBar.open : plan.entryTrigger;
  const fillPrice = Math.min(theoreticalFillPrice, plan.maxBuyPrice);

  const maxFillableLots = Math.floor((entryBar.volume * fraction) / size);
  const filledLots = Math.max(0, Math.min(plan.totalLots, maxFillableLots));

  if (filledLots <= 0) {
    return {
      status: "no_fill",
      fillPrice: null,
      filledLots: 0,
      fillDate: null,
      note: "bar volume too thin to fill any lots at the modeled participation fraction"
    };
  }

  return {
    status: filledLots < plan.totalLots ? "partial" : "filled",
    fillPrice,
    filledLots,
    fillDate: entryBar.date,
    note: filledLots < plan.totalLots ? "capped by thin bar volume (illiquid-stock modeling)" : null
  };
}

/** Scales tp1/tp2/sl lot allocations down to match a partially filled position,
 * keeping the same rounding-error-into-tp2 convention the risk engine uses so
 * tp1Lots + tp2Lots always sums to filledLots exactly. */
function scaleToFilledLots(plan: TradePlan, filledLots: number) {
  if (filledLots >= plan.totalLots) {
    return { tp1Lots: plan.tp1Lots, tp2Lots: plan.tp2Lots };
  }
  const ratio = filledLots / plan.totalLots;
  const tp1Lots = Math.min(filledLots, Math.round(plan.tp1Lots * ratio));
  const tp2Lots = filledLots - tp1Lots;
  return { tp1Lots, tp2Lots };
}

interface ExitState {
  tp1Done: boolean;
  closed: boolean;
  currentSl: number;
  remainingTp1Lots: number;
  remainingTp2Lots: number;
  exits: ExitLeg[];
}

/**
 * Walks forward bar by bar simulating TP1/TP2/SL, moving SL to breakeven
 * (the fill price) once TP1 is fully closed (blueprint §7.5). Same-bar
 * ambiguity (a single bar's [low,high] range spans both an active SL and an
 * active TP level, and we cannot tell from OHLC alone which traded first)
 * is always resolved as SL-first: the conservative assumption, matching the
 * risk engine's own conservative bias elsewhere (SL rounds down, TP rounds
 * up). This may understate backtest win rate slightly but never overstates
 * it, which is the correct direction to be wrong in a risk system.
 */
export function simulateExit(
  plan: TradePlan,
  fillPrice: number,
  filledLots: number,
  bars: OhlcvBar[]
): ExitLeg[] {
  const { tp1Lots, tp2Lots } = scaleToFilledLots(plan, filledLots);
  const state: ExitState = {
    tp1Done: false,
    closed: false,
    currentSl: plan.slPrice,
    remainingTp1Lots: tp1Lots,
    remainingTp2Lots: tp2Lots,
    exits: []
  };

  for (const b of bars) {
    if (state.closed) break;
    stepBar(state, plan, fillPrice, b);
  }

  if (!state.closed) {
    const last = bars[bars.length - 1];
    if (last) {
      const lots = state.remainingTp1Lots + state.remainingTp2Lots;
      if (lots > 0) {
        state.exits.push({ reason: "expiry", price: last.close, lots, date: last.date, gapped: false });
      }
    }
  }

  return state.exits;
}

function closeAll(state: ExitState, price: number, date: string, reason: ExitReason, gapped: boolean): void {
  const lots = state.remainingTp1Lots + state.remainingTp2Lots;
  if (lots > 0) {
    state.exits.push({ reason, price, lots, date, gapped });
  }
  state.remainingTp1Lots = 0;
  state.remainingTp2Lots = 0;
  state.closed = true;
}

function fillTp1(state: ExitState, entryFillPrice: number, price: number, date: string, gapped: boolean): void {
  if (state.remainingTp1Lots <= 0) return;
  state.exits.push({ reason: "tp1", price, lots: state.remainingTp1Lots, date, gapped });
  state.remainingTp1Lots = 0;
  state.tp1Done = true;
  // Move SL to breakeven (the actual entry fill price) for the remaining
  // position -- blueprint §7.5 ("net breakeven" after TP1 matches).
  state.currentSl = entryFillPrice;
}

function fillTp2(state: ExitState, price: number, date: string, gapped: boolean): void {
  if (state.remainingTp2Lots <= 0) return;
  state.exits.push({ reason: "tp2", price, lots: state.remainingTp2Lots, date, gapped });
  state.remainingTp2Lots = 0;
}

function stepBar(state: ExitState, plan: TradePlan, fillPrice: number, b: OhlcvBar): void {
  // --- gap-at-open handling ---
  if (b.open <= state.currentSl) {
    // Gap down through the (possibly breakeven) stop: fill AT the gapped
    // price, not the theoretical SL -- this is worse for the trader and is
    // the realistic max-loss outcome (blueprint §13.2 gap simulation).
    closeAll(state, b.open, b.date, "sl", true);
    return;
  }
  if (!state.tp1Done && b.open >= plan.tp2Price) {
    // Huge gap straight through both targets: award TP1 then TP2, both at
    // the gapped open (favorable gap -- fill at the better, gapped price).
    fillTp1(state, fillPrice, b.open, b.date, true);
    fillTp2(state, b.open, b.date, true);
    state.closed = state.remainingTp1Lots === 0 && state.remainingTp2Lots === 0;
    return;
  }
  if (!state.tp1Done && b.open >= plan.tp1Price) {
    fillTp1(state, fillPrice, b.open, b.date, true);
    // fall through to check the rest of this bar's range for TP2/SL below
  }
  if (state.tp1Done && !state.closed && b.open >= plan.tp2Price && state.remainingTp2Lots > 0) {
    fillTp2(state, b.open, b.date, true);
    state.closed = state.remainingTp1Lots === 0 && state.remainingTp2Lots === 0;
    return;
  }

  if (state.closed) return;

  // --- within-bar (no relevant gap) handling ---
  if (!state.tp1Done) {
    const hitSl = b.low <= state.currentSl;
    const hitTp1 = b.high >= plan.tp1Price;
    if (hitSl && hitTp1) {
      // Same bar spans both -- conservative assumption: SL first (see docstring).
      closeAll(state, state.currentSl, b.date, "sl", false);
      return;
    }
    if (hitSl) {
      closeAll(state, state.currentSl, b.date, "sl", false);
      return;
    }
    if (hitTp1) {
      fillTp1(state, fillPrice, plan.tp1Price, b.date, false);
      // Same bar may also reach TP2 (rare but possible in one volatile bar);
      // both are upside so there's no ambiguity to resolve conservatively.
      if (b.high >= plan.tp2Price && state.remainingTp2Lots > 0) {
        fillTp2(state, plan.tp2Price, b.date, false);
        state.closed = state.remainingTp1Lots === 0 && state.remainingTp2Lots === 0;
      }
      return;
    }
    return; // neither touched this bar
  }

  // tp1 already done, remaining lots carry the breakeven stop
  const hitSl = b.low <= state.currentSl;
  const hitTp2 = b.high >= plan.tp2Price;
  if (hitSl && hitTp2) {
    closeAll(state, state.currentSl, b.date, "sl", false);
    return;
  }
  if (hitSl) {
    closeAll(state, state.currentSl, b.date, "sl", false);
    return;
  }
  if (hitTp2) {
    fillTp2(state, plan.tp2Price, b.date, false);
    state.closed = state.remainingTp2Lots === 0;
  }
}

/** Runs entry + exit simulation for one TradePlan and reduces it to a TradeOutcome (fees/slippage from StrategyConfig, reusing the same assumptions as the risk engine). */
export function simulateTradePlan(
  plan: TradePlan,
  entryBar: OhlcvBar | null,
  simulationBars: OhlcvBar[],
  config: StrategyConfig,
  options: SimulationOptions = {}
): TradeOutcome {
  const size = lotSize(config);
  const fill = entryBar
    ? simulateEntry(plan, entryBar, config, options)
    : { status: "no_fill" as const, fillPrice: null, filledLots: 0, fillDate: null, note: "no entry bar available" };

  if (fill.status === "no_fill" || fill.fillPrice === null) {
    return {
      symbol: plan.symbol,
      tradingDate: plan.tradingDate,
      plan,
      fill,
      exits: [],
      grossPnl: 0,
      fees: 0,
      slippage: 0,
      netPnl: 0,
      netRR: null,
      ruleAdherence: true
    };
  }

  const maxBars = options.maxHoldingBars ?? DEFAULT_MAX_HOLDING_BARS;
  const walkBars = simulationBars.slice(0, maxBars);
  const exits = simulateExit(plan, fill.fillPrice, fill.filledLots, walkBars);

  const buyFeeTotal = fill.filledLots * size * fill.fillPrice * config.risk.buyFeeRate;
  const slippage = fill.filledLots * size * config.risk.slippageAllowancePerShare;

  let grossPnl = 0;
  let sellFeeTotal = 0;
  for (const leg of exits) {
    grossPnl += leg.lots * size * (leg.price - fill.fillPrice);
    sellFeeTotal += leg.lots * size * leg.price * config.risk.sellFeeRate;
  }
  const fees = buyFeeTotal + sellFeeTotal;
  const netPnl = grossPnl - fees - slippage;

  const scaledMaxNetLoss = plan.totalLots > 0 ? (plan.maxNetLoss * fill.filledLots) / plan.totalLots : 0;
  const netRR = scaledMaxNetLoss > 0 ? netPnl / scaledMaxNetLoss : null;

  return {
    symbol: plan.symbol,
    tradingDate: plan.tradingDate,
    plan,
    fill,
    exits,
    grossPnl,
    fees,
    slippage,
    netPnl,
    netRR,
    ruleAdherence: true
  };
}
