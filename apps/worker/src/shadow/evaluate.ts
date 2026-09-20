import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@idx/db";
import { schema } from "@idx/db";
import type { StrategyConfig } from "@idx/config";
import type { OhlcvBar, TradePlan } from "@idx/domain";
import { simulateTradePlan } from "@idx/backtest";

/**
 * Forward-evaluate pending shadow plans. For each shadow_plan with no
 * recorded outcome that has enough `daily_bar` rows AFTER its trading date, run
 * the same fill/exit simulator the backtest uses and write the outcome. Cheap --
 * one small query per pending row, bounded per tick.
 *
 * ENTRY CONVENTION: a shadow plan is written after the close of its trading
 * date with entryTrigger = that close, so it can only be acted on from the NEXT
 * session. The entry order is evaluated against the first bar after the plan
 * date and exits walk from the bar after that. (This used to fill on the plan
 * date's own bar at min(open, close) -- look-ahead worth roughly +3 points of
 * net return per trade in Phase 0G -- which flattered momentum/breakout-style
 * sources the most, because they pick names that already closed strongly.)
 *
 * Fees/slippage use the CURRENT StrategyConfig (they don't drift often; this
 * is a forward-test approximation, and the plan's own numbers were computed
 * with the config active on its generation day).
 */
const MAX_HOLDING_BARS = 20;

function toBar(row: {
  tradingDate: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  turnover: string | null;
}): OhlcvBar {
  return {
    date: row.tradingDate,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    turnover: row.turnover !== null ? Number(row.turnover) : null
  };
}

export async function evaluateShadowOutcomes(
  db: Db,
  config: StrategyConfig,
  opts: { minForwardBars?: number; limit?: number } = {}
): Promise<{ evaluated: number }> {
  const minForward = opts.minForwardBars ?? 3;
  const pending = await db
    .select()
    .from(schema.shadowPlan)
    .where(isNull(schema.shadowPlan.outcomeStatus))
    .orderBy(asc(schema.shadowPlan.tradingDate))
    .limit(opts.limit ?? 500);

  let evaluated = 0;
  for (const p of pending) {
    const forward = await db
      .select()
      .from(schema.dailyBar)
      .where(and(eq(schema.dailyBar.symbol, p.symbol), gt(schema.dailyBar.tradingDate, p.tradingDate)))
      .orderBy(asc(schema.dailyBar.tradingDate))
      .limit(MAX_HOLDING_BARS + 1); // entry session + the exit walk
    if (forward.length < minForward + 1) continue; // need the entry session plus `minForward` bars after it

    const [entryRow, ...walkRows] = forward;
    const walk = walkRows.map(toBar);

    const plan = p.planJson as unknown as TradePlan;
    const outcome = simulateTradePlan(plan, entryRow ? toBar(entryRow) : null, walk, config, {
      maxHoldingBars: MAX_HOLDING_BARS
    });

    const lastExit = outcome.exits[outcome.exits.length - 1];
    const barsHeld = lastExit
      ? walk.findIndex((b) => b.date === lastExit.date) + 1
      : walk.length;

    await db
      .update(schema.shadowPlan)
      .set({
        outcomeStatus: outcome.fill.status,
        filledLots: outcome.fill.filledLots,
        firstExitReason: outcome.exits[0]?.reason ?? null,
        netPnl: String(outcome.netPnl),
        barsHeld: barsHeld > 0 ? barsHeld : walk.length,
        evaluatedAt: new Date()
      })
      .where(eq(schema.shadowPlan.id, p.id));
    evaluated += 1;
  }

  return { evaluated };
}

/** Aggregate realised shadow results by source, for a quick read. */
export async function summarizeShadow(db: Db): Promise<
  Record<string, { plans: number; evaluated: number; filled: number; wins: number; netPnl: number }>
> {
  const rows = await db.select().from(schema.shadowPlan);
  const acc: Record<string, { plans: number; evaluated: number; filled: number; wins: number; netPnl: number }> = {};
  for (const r of rows) {
    const a = (acc[r.source] ??= { plans: 0, evaluated: 0, filled: 0, wins: 0, netPnl: 0 });
    a.plans += 1;
    if (r.outcomeStatus) {
      a.evaluated += 1;
      if (r.outcomeStatus === "filled" || r.outcomeStatus === "partial") a.filled += 1;
      const pnl = r.netPnl !== null ? Number(r.netPnl) : 0;
      a.netPnl += pnl;
      if (pnl > 0) a.wins += 1;
    }
  }
  return acc;
}
