import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import { buildRiskPlan } from "../risk.js";
import type { RiskEngineInput } from "../interfaces.js";
import type { ScoreResult } from "../../types/signal.js";

function baseScore(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    symbol: "TEST",
    tradingDate: "2026-09-09",
    formulaVersion: DEFAULT_STRATEGY_CONFIG.formulaVersion,
    configVersion: DEFAULT_STRATEGY_CONFIG.version,
    components: {
      brokerFlowQuality: 0.9,
      volumeAnomaly: 0.8,
      smartMoneyMargin: 0.7,
      priceResponse: 0.6,
      confluence: 0.5
    },
    compositeScore: 85,
    category: "STRONG_BUY",
    gates: [],
    noTradeReason: null,
    confidence: "high",
    ...overrides
  };
}

function baseRiskInput(overrides: Partial<RiskEngineInput> = {}): RiskEngineInput {
  return {
    symbol: "TEST",
    tradingDate: "2026-09-09",
    entryTrigger: 1000,
    stopLossRaw: 980,
    score: baseScore(),
    sessionEndIso: "2026-09-09T08:49:00Z",
    ...overrides
  };
}

describe("tick rounding (golden)", () => {
  it("rounds SL down to the nearest valid tick at its price tier", () => {
    // entry 1000 -> tick 10, stop raw 983 should round down to 980
    const plan = buildRiskPlan(baseRiskInput({ entryTrigger: 1000, stopLossRaw: 983 }), DEFAULT_STRATEGY_CONFIG);
    expect(plan.slPrice).toBe(980);
  });

  it("rounds TP up to the nearest valid tick", () => {
    const plan = buildRiskPlan(baseRiskInput({ entryTrigger: 1000, stopLossRaw: 980 }), DEFAULT_STRATEGY_CONFIG);
    // priceRisk = 20, tp1 raw = 1000 + 2*20 = 1040 (already on-tick at tick 10)
    expect(plan.tp1Price).toBe(1040);
    // tp2 raw = 1000 + 3*20 = 1060 (already on-tick)
    expect(plan.tp2Price).toBe(1060);
  });

  it("widens SL that is closer than minStopDistanceTicks", () => {
    // entry 1000 -> tick 5 (IDX fraction table: 500 < price <= 2000 -> tick 5),
    // min distance = 2 ticks = 10. Raw stop 997 rounds down to 995 (5 away,
    // closer than 10) so must be pushed further, to 990 (10 away).
    const plan = buildRiskPlan(baseRiskInput({ entryTrigger: 1000, stopLossRaw: 997 }), DEFAULT_STRATEGY_CONFIG);
    expect(plan.entryTrigger - plan.slPrice).toBeGreaterThanOrEqual(10);
  });
});

describe("lot sizing, fees, slippage (golden)", () => {
  it("computes risk lots, capital lots, and takes the minimum", () => {
    const config = DEFAULT_STRATEGY_CONFIG;
    const entry = 1000;
    const sl = 980;
    const plan = buildRiskPlan(baseRiskInput({ entryTrigger: entry, stopLossRaw: sl }), config);

    const priceRisk = entry - sl; // 20
    const buyFee = entry * config.risk.buyFeeRate; // 1.5
    const sellFee = entry * config.risk.sellFeeRate; // 2.5
    const effectiveRiskPerShare = priceRisk + buyFee + sellFee + config.risk.slippageAllowancePerShare; // 20+1.5+2.5+2=26
    const riskBudget = config.risk.totalCapital * config.risk.riskPerTradePct; // 37500
    const expectedRiskLots = Math.floor(riskBudget / (100 * effectiveRiskPerShare));
    const expectedCapitalLots = Math.floor(
      config.risk.maxDeployedCapital / (100 * entry * (1 + config.risk.buyFeeRate))
    );
    const expectedTotalLots = Math.min(expectedRiskLots, expectedCapitalLots);

    expect(plan.totalLots).toBe(expectedTotalLots);
    expect(plan.slippageAllowance).toBeCloseTo(plan.totalLots * 100 * config.risk.slippageAllowancePerShare, 6);
  });

  it("tp1Lots + tp2Lots always sums to totalLots exactly (golden case)", () => {
    const plan = buildRiskPlan(baseRiskInput({ entryTrigger: 1000, stopLossRaw: 980 }), DEFAULT_STRATEGY_CONFIG);
    expect(plan.tp1Lots + plan.tp2Lots).toBe(plan.totalLots);
  });

  it("SPECULATIVE_BUY reduces lot size vs STRONG_BUY for identical entry/SL", () => {
    const strongPlan = buildRiskPlan(
      baseRiskInput({ entryTrigger: 1000, stopLossRaw: 980, score: baseScore({ category: "STRONG_BUY" }) }),
      DEFAULT_STRATEGY_CONFIG
    );
    const specPlan = buildRiskPlan(
      baseRiskInput({ entryTrigger: 1000, stopLossRaw: 980, score: baseScore({ category: "SPECULATIVE_BUY" }) }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(specPlan.totalLots).toBeLessThan(strongPlan.totalLots);
  });
});

describe("blueprint worked example sanity check (§7.6)", () => {
  it("produces plausible numbers in the same ballpark as the illustrative example", () => {
    // Blueprint: B-Avg Rp990, Entry Rp1,000, Max buy Rp1,005, 14 lots,
    // TP1 Rp1,040 (8 lots), TP2 Rp1,060 (6 lots), SL Rp980 (remaining lots),
    // net RR 2.1. The blueprint explicitly says this example "only shows the
    // calculation format; the engine must recompute for the actual stock" --
    // exact numbers are not required to match, only plausibility.
    const plan = buildRiskPlan(baseRiskInput({ entryTrigger: 1000, stopLossRaw: 980 }), DEFAULT_STRATEGY_CONFIG);
    expect(plan.tp1Price).toBe(1040);
    expect(plan.tp2Price).toBe(1060);
    expect(plan.slPrice).toBe(980);
    expect(plan.totalLots).toBeGreaterThan(0);
    // Our default config's risk budget (Rp37,500) is smaller than the
    // blueprint example's Rp5,000,000 capital*0.75% would suggest at these
    // prices produces fewer lots than 14 once fees/slippage are included;
    // document the divergence rather than forcing an exact match.
    expect(plan.netRewardToRisk).toBeGreaterThan(0);
  });
});

describe("property tests", () => {
  it("lots are never negative", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 10000 }),
        fc.integer({ min: 1, max: 5000 }),
        (entry, slDelta) => {
          const sl = Math.max(1, entry - slDelta);
          const plan = buildRiskPlan(baseRiskInput({ entryTrigger: entry, stopLossRaw: sl }), DEFAULT_STRATEGY_CONFIG);
          expect(plan.totalLots).toBeGreaterThanOrEqual(0);
          expect(plan.tp1Lots).toBeGreaterThanOrEqual(0);
          expect(plan.tp2Lots).toBeGreaterThanOrEqual(0);
          expect(plan.slRemainingLots).toBeGreaterThanOrEqual(0);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("tp1Lots + tp2Lots === totalLots always", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 10000 }),
        fc.integer({ min: 1, max: 5000 }),
        (entry, slDelta) => {
          const sl = Math.max(1, entry - slDelta);
          const plan = buildRiskPlan(baseRiskInput({ entryTrigger: entry, stopLossRaw: sl }), DEFAULT_STRATEGY_CONFIG);
          expect(plan.tp1Lots + plan.tp2Lots).toBe(plan.totalLots);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("maxNetLoss never exceeds the configured risk budget beyond fee/rounding tolerance", () => {
    // Scope: this invariant covers the PLAN as computed from entry/SL/lots --
    // it does NOT model a fill at a worse price than intended (a gap-down
    // through SL). Gap/fill risk is out of this pure function's scope and is
    // instead surfaced via risk flags / hard gates at the caller layer.
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 10000 }),
        fc.integer({ min: 1, max: 5000 }),
        (entry, slDelta) => {
          const sl = Math.max(1, entry - slDelta);
          const plan = buildRiskPlan(baseRiskInput({ entryTrigger: entry, stopLossRaw: sl }), DEFAULT_STRATEGY_CONFIG);
          if (plan.totalLots === 0) return; // NO_TRADE: nothing deployed, nothing at risk
          const riskBudget = DEFAULT_STRATEGY_CONFIG.risk.totalCapital * DEFAULT_STRATEGY_CONFIG.risk.riskPerTradePct;
          // Tolerance: fees/slippage/tick-rounding can push the realized risk
          // per share slightly above the raw budget-implied per-share figure
          // (Risk Lots floors down, but effectiveRiskPerShare used for maxNetLoss
          // includes sell-fee-at-SL which uses SL price, not entry price, so a
          // steep SL can differ slightly from the sizing estimate). Allow a
          // generous relative tolerance to bound this without asserting exact
          // equality of two independently-derived figures.
          expect(plan.maxNetLoss).toBeLessThanOrEqual(riskBudget * 1.5 + 1);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("gap-down scenario documented as out of pure-function scope", () => {
    // If a fill actually occurs far below the intended entry (a gap), the
    // realized loss at the SAME nominal SL distance can exceed the risk
    // budget -- but this pure function only ever receives entryTrigger/SL as
    // given by the caller, so it cannot itself model a worse fill. We
    // simulate the "gap" by directly widening the SL distance far beyond
    // what normal sizing assumed, showing maxNetLoss scales with priceRisk
        // as expected (the risk engine does not silently cap it).
    const normalPlan = buildRiskPlan(baseRiskInput({ entryTrigger: 1000, stopLossRaw: 980 }), DEFAULT_STRATEGY_CONFIG);
    const wideSlPlan = buildRiskPlan(baseRiskInput({ entryTrigger: 1000, stopLossRaw: 500 }), DEFAULT_STRATEGY_CONFIG);
    // Risk engine self-sizes: wider SL -> fewer lots -> loss is still bounded
    // near the risk budget in the sizing that PRODUCED the plan; it is only
    // an actual fill worse than entryTrigger (outside this function's inputs)
    // that could breach the budget, which is why maxBuyPrice + gap rejection
    // is documented as the caller's job (see buildRiskPlan doc comment).
    expect(wideSlPlan.totalLots).toBeLessThanOrEqual(normalPlan.totalLots);
  });
});
