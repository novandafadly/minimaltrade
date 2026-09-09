import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../lib/db";
import { schema } from "@idx/db";
import { buildSessionCalendar, isWithinSession, loadEnv } from "@idx/config";
import type { BrokerFlowFeatures, FeatureSnapshot, HardGateResult, SignalCategory } from "@idx/domain";
import { deriveFlags } from "../../../lib/gates";
import { isRowStale } from "../../../lib/staleness";
import { countByCategory, emptyCategoryCounts } from "../../../lib/category";
import type { SignalListItem, SignalListResponse, TradePlanView } from "../../../lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/signals — current signals joined with their trade plan and
 * feature-derived broker flow, one row per symbol (the most recently
 * generated signal for that symbol). Supports ?category= (repeatable or
 * comma-separated) and ?sort=score|generatedAt (default score, desc).
 *
 * We intentionally do the "latest per symbol" dedupe in JS rather than a
 * SQL DISTINCT ON: the candidate universe is small (blueprint funnel caps
 * it at a few dozen names) and this keeps the query portable/simple.
 */
export async function GET(req: NextRequest) {
  try {
    const db = getDb();
    const url = new URL(req.url);
    const categoryParam = url.searchParams.getAll("category").flatMap((v) => v.split(","));
    const categoryFilter = new Set(categoryParam.filter(Boolean));
    const sortParam = (url.searchParams.get("sort") ?? "score") as "score" | "generatedAt" | "netRR";

    const rows = await db
      .select({
        id: schema.signal.id,
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
      .orderBy(desc(schema.signal.generatedAt))
      .limit(1000);

    const latestBySymbol = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!latestBySymbol.has(row.symbol)) latestBySymbol.set(row.symbol, row);
    }

    const env = loadEnv();
    const cal = buildSessionCalendar(env);
    const now = new Date();
    const jakartaNow = new Date(now.toLocaleString("en-US", { timeZone: cal.timezone }));
    const marketOpen = isWithinSession(
      cal,
      jakartaNow.getDay(),
      jakartaNow.getHours() * 60 + jakartaNow.getMinutes()
    );

    let items: SignalListItem[] = Array.from(latestBySymbol.values()).map((row) => {
      const generatedAtMs = new Date(row.generatedAt).getTime();
      const ageMillis = Math.max(0, now.getTime() - generatedAtMs);
      const featureDataStale = Boolean(row.dataStale);
      const stale = isRowStale({ featureDataStale, ageMs: ageMillis, marketOpen });
      const gates = (row.gates as HardGateResult[] | null) ?? [];
      // `feature_snapshot.features` stores FeatureSnapshot (minus id fields) as jsonb.
      const features = row.features as Pick<FeatureSnapshot, "brokerFlow"> | null;
      const broker: BrokerFlowFeatures | null = features?.brokerFlow ?? null;

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

      return {
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
        broker,
        plan,
        flags: deriveFlags(gates, stale),
        gates,
        dataStale: stale,
        ageSeconds: Math.round(ageMillis / 1000)
      };
    });

    if (categoryFilter.size > 0) {
      items = items.filter((s) => categoryFilter.has(s.category));
    }

    items.sort((a, b) => {
      if (sortParam === "generatedAt") {
        return new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime();
      }
      if (sortParam === "netRR") {
        return (b.plan?.netRewardToRisk ?? -Infinity) - (a.plan?.netRewardToRisk ?? -Infinity);
      }
      return b.compositeScore - a.compositeScore;
    });

    const counts = countByCategory(Array.from(latestBySymbol.values()).map((r) => r.category as SignalCategory));

    const body: SignalListResponse = {
      signals: items,
      counts,
      generatedAt: now.toISOString()
    };

    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json(
      {
        error: "signals_query_failed",
        message: err instanceof Error ? err.message : "unknown error",
        signals: [],
        counts: emptyCategoryCounts(),
        generatedAt: new Date().toISOString()
      },
      { status: 500 }
    );
  }
}
