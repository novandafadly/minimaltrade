import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../lib/db";
import { schema } from "@idx/db";
import { buildSessionCalendar, isWithinSession, loadEnv } from "@idx/config";
import type { FeatureSnapshot, HardGateResult, SignalCategory } from "@idx/domain";
import { deriveFlags } from "../../../../lib/gates";
import { isRowStale } from "../../../../lib/staleness";
import type {
  BrokerMatrixRow,
  SignalDetailResponse,
  SignalListItem,
  TradePlanView
} from "../../../../lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/signals/[symbol] — full detail for the drawer: latest signal +
 * plan, the FeatureSnapshot (broker breadth/HHI/persistence etc.), and the
 * broker matrix (one row per broker for that symbol/trading date).
 */
export async function GET(_req: NextRequest, { params }: { params: { symbol: string } }) {
  const symbol = params.symbol?.toUpperCase();
  if (!symbol) {
    return NextResponse.json({ error: "missing_symbol" }, { status: 400 });
  }

  try {
    const db = getDb();

    const [row] = await db
      .select({
        symbol: schema.signal.symbol,
        tradingDate: schema.signal.tradingDate,
        generatedAt: schema.signal.generatedAt,
        expiry: schema.signal.expiry,
        category: schema.signal.category,
        compositeScore: schema.signal.compositeScore,
        confidence: schema.signal.confidence,
        noTradeReason: schema.signal.noTradeReason,
        gates: schema.signal.gates,
        formulaVersion: schema.signal.formulaVersion,
        configVersion: schema.signal.configVersion,
        inputSnapshotId: schema.signal.inputSnapshotId,
        featureSnapshotId: schema.signal.featureSnapshotId,
        features: schema.featureSnapshot.features,
        dataStale: schema.featureSnapshot.dataStale,
        plan: {
          entryTrigger: schema.tradePlan.entryTrigger,
          maxBuyPrice: schema.tradePlan.maxBuyPrice,
          totalLots: schema.tradePlan.totalLots,
          estimatedCapital: schema.tradePlan.estimatedCapital,
          tp1Price: schema.tradePlan.tp1Price,
          tp1Lots: schema.tradePlan.tp1Lots,
          tp2Price: schema.tradePlan.tp2Price,
          tp2Lots: schema.tradePlan.tp2Lots,
          slPrice: schema.tradePlan.slPrice,
          slRemainingLots: schema.tradePlan.slRemainingLots,
          grossReward: schema.tradePlan.grossReward,
          estimatedFees: schema.tradePlan.estimatedFees,
          slippageAllowance: schema.tradePlan.slippageAllowance,
          netReward: schema.tradePlan.netReward,
          maxNetLoss: schema.tradePlan.maxNetLoss,
          netRewardToRisk: schema.tradePlan.netRewardToRisk,
          isNoTrade: schema.tradePlan.isNoTrade,
          noTradeReason: schema.tradePlan.noTradeReason,
          expiry: schema.tradePlan.expiry,
          generatedAt: schema.tradePlan.generatedAt
        }
      })
      .from(schema.signal)
      .leftJoin(schema.featureSnapshot, eq(schema.featureSnapshot.id, schema.signal.featureSnapshotId))
      .leftJoin(schema.tradePlan, eq(schema.tradePlan.signalId, schema.signal.id))
      .where(eq(schema.signal.symbol, symbol))
      .orderBy(desc(schema.signal.generatedAt))
      .limit(1);

    if (!row) {
      return NextResponse.json({ error: "not_found", symbol }, { status: 404 });
    }

    const brokerRows = await db
      .select({
        brokerCode: schema.brokerSnapshot.brokerCode,
        buyVolume: schema.brokerSnapshot.buyVolume,
        buyValue: schema.brokerSnapshot.buyValue,
        sellVolume: schema.brokerSnapshot.sellVolume,
        sellValue: schema.brokerSnapshot.sellValue,
        netVolume: schema.brokerSnapshot.netVolume,
        netValue: schema.brokerSnapshot.netValue,
        avgBuyPrice: schema.brokerSnapshot.avgBuyPrice,
        avgSellPrice: schema.brokerSnapshot.avgSellPrice,
        status: schema.brokerSnapshot.status
      })
      .from(schema.brokerSnapshot)
      .where(
        and(eq(schema.brokerSnapshot.symbol, symbol), eq(schema.brokerSnapshot.tradingDate, row.tradingDate))
      );

    const brokerMatrix: BrokerMatrixRow[] = brokerRows
      .map((b) => ({
        brokerCode: b.brokerCode,
        buyVolume: Number(b.buyVolume),
        buyValue: Number(b.buyValue),
        sellVolume: Number(b.sellVolume),
        sellValue: Number(b.sellValue),
        netVolume: Number(b.netVolume),
        netValue: Number(b.netValue),
        avgBuyPrice: b.avgBuyPrice === null ? null : Number(b.avgBuyPrice),
        avgSellPrice: b.avgSellPrice === null ? null : Number(b.avgSellPrice),
        status: b.status
      }))
      .sort((a, b) => b.netValue - a.netValue);

    const env = loadEnv();
    const cal = buildSessionCalendar(env);
    const now = new Date();
    const jakartaNow = new Date(now.toLocaleString("en-US", { timeZone: cal.timezone }));
    const marketOpen = isWithinSession(
      cal,
      jakartaNow.getDay(),
      jakartaNow.getHours() * 60 + jakartaNow.getMinutes()
    );

    const generatedAtMs = new Date(row.generatedAt).getTime();
    const ageMillis = Math.max(0, now.getTime() - generatedAtMs);
    const featureDataStale = Boolean(row.dataStale);
    const stale = isRowStale({ featureDataStale, ageMs: ageMillis, marketOpen });
    const gates = (row.gates as HardGateResult[] | null) ?? [];
    const features = row.features as FeatureSnapshot | null;

    const plan: TradePlanView | null = row.plan && row.plan.entryTrigger !== null
      ? {
          entryTrigger: Number(row.plan.entryTrigger),
          maxBuyPrice: Number(row.plan.maxBuyPrice),
          totalLots: Number(row.plan.totalLots),
          estimatedCapital: Number(row.plan.estimatedCapital),
          tp1Price: Number(row.plan.tp1Price),
          tp1Lots: Number(row.plan.tp1Lots),
          tp2Price: Number(row.plan.tp2Price),
          tp2Lots: Number(row.plan.tp2Lots),
          slPrice: Number(row.plan.slPrice),
          slRemainingLots: Number(row.plan.slRemainingLots),
          grossReward: Number(row.plan.grossReward),
          estimatedFees: Number(row.plan.estimatedFees),
          slippageAllowance: Number(row.plan.slippageAllowance),
          netReward: Number(row.plan.netReward),
          maxNetLoss: Number(row.plan.maxNetLoss),
          netRewardToRisk: Number(row.plan.netRewardToRisk),
          isNoTrade: Boolean(row.plan.isNoTrade),
          noTradeReason: row.plan.noTradeReason,
          expiry: new Date(row.plan.expiry as unknown as string).toISOString(),
          generatedAt: new Date(row.plan.generatedAt as unknown as string).toISOString()
        }
      : null;

    const signalView: SignalListItem = {
      symbol: row.symbol,
      tradingDate: row.tradingDate,
      generatedAt: new Date(row.generatedAt).toISOString(),
      expiry: new Date(row.expiry).toISOString(),
      category: row.category as SignalCategory,
      compositeScore: Number(row.compositeScore),
      confidence: row.confidence as SignalListItem["confidence"],
      noTradeReason: row.noTradeReason,
      formulaVersion: row.formulaVersion,
      configVersion: row.configVersion,
      inputSnapshotId: row.inputSnapshotId,
      broker: features?.brokerFlow ?? null,
      plan,
      flags: deriveFlags(gates, stale),
      gates,
      dataStale: stale,
      ageSeconds: Math.round(ageMillis / 1000)
    };

    const body: SignalDetailResponse = {
      signal: signalView,
      feature: features,
      brokerMatrix,
      evidence: {
        inputSnapshotId: row.inputSnapshotId,
        formulaVersion: row.formulaVersion,
        configVersion: row.configVersion,
        rawPayloadArchiveHint: `raw_payload_archive rows for symbol=${symbol}, trading_date=${row.tradingDate}`
      }
    };

    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json(
      { error: "signal_detail_failed", message: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
