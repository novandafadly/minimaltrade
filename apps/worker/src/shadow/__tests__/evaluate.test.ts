import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import { schema } from "@idx/db";
import type { TradePlan } from "@idx/domain";
import { getTestDb, truncateAll } from "../../__tests__/testDb.js";
import { evaluateShadowOutcomes, summarizeShadow } from "../evaluate.js";

const db = getTestDb();

function samplePlan(symbol: string): TradePlan {
  return {
    symbol,
    tradingDate: "2026-06-01",
    formulaVersion: DEFAULT_STRATEGY_CONFIG.formulaVersion,
    configVersion: DEFAULT_STRATEGY_CONFIG.version,
    generatedAt: "2026-06-01T08:49:00.000Z",
    expiry: "2026-06-01T08:49:00.000Z",
    entryTrigger: 1000,
    maxBuyPrice: 1005,
    totalLots: 4,
    estimatedCapital: 400_000,
    tp1Price: 1120,
    tp1Lots: 2,
    tp2Price: 1180,
    tp2Lots: 2,
    slPrice: 940,
    slRemainingLots: 4,
    grossReward: 40_000,
    estimatedFees: 2_000,
    slippageAllowance: 800,
    netReward: 37_200,
    maxNetLoss: 25_000,
    netRewardToRisk: 1.9,
    isNoTrade: false,
    noTradeReason: null
  };
}

async function insertShadow(symbol: string, source: string, plan: TradePlan) {
  await db.insert(schema.shadowPlan).values({
    id: randomUUID(),
    tradingDate: plan.tradingDate,
    symbol,
    source,
    category: source === "live" ? "STRONG_BUY" : null,
    compositeScore: source === "live" ? "82" : null,
    configVersion: plan.configVersion,
    generatedAt: new Date(plan.generatedAt),
    expiry: new Date(plan.expiry),
    entryTrigger: String(plan.entryTrigger),
    maxBuyPrice: String(plan.maxBuyPrice),
    slPrice: String(plan.slPrice),
    tp1Price: String(plan.tp1Price),
    tp1Lots: plan.tp1Lots,
    tp2Price: String(plan.tp2Price),
    tp2Lots: plan.tp2Lots,
    totalLots: plan.totalLots,
    netRewardToRisk: String(plan.netRewardToRisk),
    isNoTrade: plan.isNoTrade,
    planJson: plan as unknown as object
  });
}

async function insertBar(symbol: string, date: string, o: number, h: number, l: number, c: number) {
  await db.insert(schema.dailyBar).values({
    id: randomUUID(),
    symbol,
    tradingDate: date,
    open: String(o),
    high: String(h),
    low: String(l),
    close: String(c),
    volume: "1000000",
    turnover: String(c * 1_000_000),
    source: "test",
    receivedAt: new Date(`${date}T09:30:00.000Z`)
  });
}

describe("evaluateShadowOutcomes", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("leaves a plan pending until enough forward bars exist", async () => {
    await insertShadow("AAAA", "baseline_volume", samplePlan("AAAA"));
    await insertBar("AAAA", "2026-06-01", 995, 1005, 990, 998); // entry day only
    await insertBar("AAAA", "2026-06-02", 1000, 1010, 995, 1005); // one forward bar

    const { evaluated } = await evaluateShadowOutcomes(db, DEFAULT_STRATEGY_CONFIG, { minForwardBars: 3 });
    expect(evaluated).toBe(0);
    const [row] = await db.select().from(schema.shadowPlan).where(eq(schema.shadowPlan.symbol, "AAAA"));
    expect(row?.outcomeStatus).toBeNull();
  });

  it("records a winning outcome once the market plays out (TP1 then TP2)", async () => {
    await insertShadow("BBBB", "live", samplePlan("BBBB"));
    await insertBar("BBBB", "2026-06-01", 995, 1005, 990, 998); // fills at open 995
    await insertBar("BBBB", "2026-06-02", 1010, 1130, 1000, 1115); // TP1 (>=1120)
    await insertBar("BBBB", "2026-06-03", 1120, 1190, 1100, 1185); // TP2 (>=1180)
    await insertBar("BBBB", "2026-06-04", 1180, 1200, 1170, 1190);

    const { evaluated } = await evaluateShadowOutcomes(db, DEFAULT_STRATEGY_CONFIG, { minForwardBars: 3 });
    expect(evaluated).toBe(1);
    const [row] = await db.select().from(schema.shadowPlan).where(eq(schema.shadowPlan.symbol, "BBBB"));
    expect(row?.outcomeStatus).toBe("filled");
    expect(row?.firstExitReason).toBe("tp1");
    expect(Number(row?.netPnl)).toBeGreaterThan(0);

    const summary = await summarizeShadow(db);
    expect(summary.live?.evaluated).toBe(1);
    expect(summary.live?.wins).toBe(1);
  });

  it("records a stop-out as a loss", async () => {
    await insertShadow("CCCC", "baseline_random", samplePlan("CCCC"));
    await insertBar("CCCC", "2026-06-01", 995, 1005, 990, 998); // fills at 995
    await insertBar("CCCC", "2026-06-02", 990, 1000, 920, 925); // SL 940 hit
    await insertBar("CCCC", "2026-06-03", 920, 930, 900, 910);
    await insertBar("CCCC", "2026-06-04", 910, 915, 905, 908);

    await evaluateShadowOutcomes(db, DEFAULT_STRATEGY_CONFIG, { minForwardBars: 3 });
    const [row] = await db.select().from(schema.shadowPlan).where(eq(schema.shadowPlan.symbol, "CCCC"));
    expect(row?.outcomeStatus).toBe("filled");
    expect(row?.firstExitReason).toBe("sl");
    expect(Number(row?.netPnl)).toBeLessThan(0);
  });
});
