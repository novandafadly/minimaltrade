import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { getDb } from "../../../lib/db";
import { schema } from "@idx/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/shadow — realised shadow-mode results grouped by source
 * (`live` / `baseline_volume` / `baseline_random`). This is the forward-test
 * comparison: does the broker-flow composite score beat picking by volume or
 * at random over the same candidate pool?
 *
 * `expectancy` / `profitFactor` are computed over EVALUATED plans only
 * (those with enough forward `daily_bar` history); `pending` are still
 * waiting for the market to play out.
 */
interface SourceStats {
  source: string;
  plans: number;
  pending: number;
  evaluated: number;
  fills: number;
  fillRate: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  expectancy: number; // mean net P&L over evaluated
  profitFactor: number;
}

export async function GET() {
  try {
    const db = getDb();
    const rows = await db.select().from(schema.shadowPlan).orderBy(desc(schema.shadowPlan.tradingDate)).limit(5000);

    const bySource = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = bySource.get(r.source) ?? [];
      arr.push(r);
      bySource.set(r.source, arr);
    }

    const stats: SourceStats[] = [];
    for (const [source, srcRows] of bySource) {
      const evaluated = srcRows.filter((r) => r.outcomeStatus !== null);
      const fills = evaluated.filter((r) => r.outcomeStatus === "filled" || r.outcomeStatus === "partial");
      const pnls = evaluated.map((r) => (r.netPnl !== null ? Number(r.netPnl) : 0));
      const wins = pnls.filter((p) => p > 0);
      const losses = pnls.filter((p) => p <= 0 && p !== 0);
      const grossWin = wins.reduce((a, b) => a + b, 0);
      const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
      const net = pnls.reduce((a, b) => a + b, 0);
      stats.push({
        source,
        plans: srcRows.length,
        pending: srcRows.length - evaluated.length,
        evaluated: evaluated.length,
        fills: fills.length,
        fillRate: evaluated.length ? fills.length / evaluated.length : 0,
        wins: wins.length,
        losses: losses.length,
        winRate: fills.length ? wins.length / fills.length : 0,
        netPnl: Math.round(net),
        expectancy: evaluated.length ? Math.round(net / evaluated.length) : 0,
        profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? Infinity : 0
      });
    }
    stats.sort((a, b) => a.source.localeCompare(b.source));

    const recent = rows.slice(0, 120).map((r) => ({
      tradingDate: r.tradingDate,
      symbol: r.symbol,
      source: r.source,
      category: r.category,
      compositeScore: r.compositeScore !== null ? Number(r.compositeScore) : null,
      entryTrigger: Number(r.entryTrigger),
      slPrice: Number(r.slPrice),
      tp1Price: Number(r.tp1Price),
      totalLots: r.totalLots,
      netRewardToRisk: Number(r.netRewardToRisk),
      isNoTrade: r.isNoTrade,
      outcomeStatus: r.outcomeStatus,
      firstExitReason: r.firstExitReason,
      netPnl: r.netPnl !== null ? Number(r.netPnl) : null,
      barsHeld: r.barsHeld
    }));

    return NextResponse.json({ stats, recent, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "shadow_query_failed", message: err instanceof Error ? err.message : "unknown error", stats: [], recent: [] },
      { status: 500 }
    );
  }
}
