import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@idx/db";
import type { HardGateResult, Signal, TradePlan } from "@idx/domain";
import { getTestDb, truncateAll } from "../../__tests__/testDb.js";
import { insertSignal, insertTradePlan } from "../snapshots.js";

const db = getTestDb();

function sampleSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    symbol: "BBCA",
    tradingDate: "2026-09-10",
    generatedAt: "2026-09-10T09:00:00.000Z",
    expiry: "2026-09-10T09:00:00.000Z",
    category: "STRONG_BUY",
    compositeScore: 81.5,
    confidence: "high",
    noTradeReason: null,
    broker: {} as never,
    plan: null,
    flags: {} as never,
    inputSnapshotId: "BBCA:2026-09-10:na",
    formulaVersion: "1.0.0",
    configVersion: "v3-2026-09-10",
    ...overrides
  };
}

function samplePlan(): TradePlan {
  return {
    symbol: "BBCA",
    tradingDate: "2026-09-10",
    formulaVersion: "1.0.0",
    configVersion: "v3-2026-09-10",
    generatedAt: "2026-09-10T09:00:00.000Z",
    expiry: "2026-09-10T09:00:00.000Z",
    entryTrigger: 6500,
    maxBuyPrice: 6525,
    totalLots: 4,
    estimatedCapital: 2_600_000,
    tp1Price: 6800,
    tp1Lots: 2,
    tp2Price: 7000,
    tp2Lots: 2,
    slPrice: 6175,
    slRemainingLots: 4,
    grossReward: 200_000,
    estimatedFees: 12_000,
    slippageAllowance: 3_200,
    netReward: 184_800,
    maxNetLoss: 130_000,
    netRewardToRisk: 1.9,
    isNoTrade: false,
    noTradeReason: null
  };
}

const gates: HardGateResult[] = [
  { gate: "FRESHNESS", passed: true, reason: null },
  { gate: "NET_RR_MIN", passed: false, reason: "Net reward:risk 1.90 below minimum 2" }
];

describe("insertSignal / insertTradePlan idempotency", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("insertSignal upserts on (symbol, trading_date) and keeps one row + real gates", async () => {
    const id1 = await insertSignal(db, sampleSignal({ compositeScore: 70 }), gates as unknown as object, null);
    const id2 = await insertSignal(db, sampleSignal({ compositeScore: 82 }), gates as unknown as object, null);
    expect(id2).toBe(id1); // same row id returned

    const rows = await db.select().from(schema.signal).where(eq(schema.signal.symbol, "BBCA"));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.compositeScore)).toBe(82); // updated to the latest
    expect(rows[0]?.gates).toHaveLength(2); // real gates persisted, not []
  });

  it("insertTradePlan upserts on signal_id (one plan per signal)", async () => {
    const signalId = await insertSignal(db, sampleSignal(), gates as unknown as object, null);
    await insertTradePlan(db, signalId, samplePlan());
    await insertTradePlan(db, signalId, { ...samplePlan(), totalLots: 6 });

    const rows = await db.select().from(schema.tradePlan).where(eq(schema.tradePlan.signalId, signalId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totalLots).toBe(6);
  });
});
