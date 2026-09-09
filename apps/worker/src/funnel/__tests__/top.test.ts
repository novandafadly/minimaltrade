import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import type { DataEnvelope, ScreenerRow } from "@idx/domain";
import { runTopFunnel } from "../top.js";
import { TOP_FUNNEL_MIN_TURNOVER_IDR } from "../constants.js";

function row(overrides: Partial<ScreenerRow> & { symbol: string }): DataEnvelope<ScreenerRow> {
  const data: ScreenerRow = {
    board: null,
    price: 1000,
    priceChange: 0,
    priceChangePct: 0,
    volume: 1000,
    turnover: TOP_FUNNEL_MIN_TURNOVER_IDR * 2,
    bestBid: 995,
    bestOffer: 1000,
    spread: 5,
    isSuspended: false,
    notation: null,
    ...overrides
  };
  return {
    symbol: data.symbol,
    tradingDate: "2026-09-09",
    eventTime: "2026-09-09T15:49:00+07:00",
    publishedAt: "2026-09-09T15:49:00+07:00",
    receivedAt: "2026-09-09T15:49:05+07:00",
    source: "arjum",
    segment: "unknown",
    revisionId: null,
    status: "final",
    data
  };
}

describe("runTopFunnel", () => {
  it("excludes suspended, high-risk-notation, provisional, low-turnover and wide-spread rows", () => {
    const rows = [
      row({ symbol: "SUSP", isSuspended: true }),
      row({ symbol: "UMA1", notation: ["UMA"] }),
      row({ symbol: "LOWT", turnover: 1000 }),
      row({ symbol: "WIDE", price: 1000, bestBid: 900, bestOffer: 1000, spread: 100 }),
      row({ symbol: "GOOD" })
    ];
    const provisionalRow = { ...row({ symbol: "STAL" }), status: "provisional" as const };

    const result = runTopFunnel([...rows, provisionalRow], DEFAULT_STRATEGY_CONFIG.funnel);
    const survivorSymbols = result.survivors.map((s) => s.symbol);

    expect(survivorSymbols).toEqual(["GOOD"]);
    expect(result.reasons.suspended).toBe(1);
    expect(result.reasons.high_risk_notation).toBe(1);
    expect(result.reasons.below_min_turnover).toBe(1);
    expect(result.reasons.spread_too_wide).toBe(1);
    expect(result.reasons.stale_or_provisional).toBe(1);
  });

  it("ranks survivors by turnover descending and caps at topFunnelTargetMax", () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      row({ symbol: `S${i}`, turnover: TOP_FUNNEL_MIN_TURNOVER_IDR * (i + 1) })
    );
    const result = runTopFunnel(rows, DEFAULT_STRATEGY_CONFIG.funnel);
    expect(result.survivors.length).toBeLessThanOrEqual(DEFAULT_STRATEGY_CONFIG.funnel.topFunnelTargetMax);
    // highest turnover first
    expect(result.survivors[0]?.symbol).toBe("S199");
  });
});
