import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import type { DataEnvelope, ScreenerSignalRow } from "@idx/domain";
import { runTopFunnel } from "../top.js";

function row(
  overrides: Partial<ScreenerSignalRow> & { symbol: string }
): DataEnvelope<ScreenerSignalRow> {
  const data: ScreenerSignalRow = {
    name: null,
    bucket: "🟢 SINYAL BERSIH",
    summary: "✅ 🏦 — Gabungan (Broker + Teknikal)",
    note: null,
    drawdown: -3,
    wrEvent: 60,
    potential: 8,
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
  it("drops distribution/trap/pump buckets and provisional rows, keeps the rest", () => {
    const rows = [
      row({ symbol: "CONF", bucket: "⚔️ KONFLIK DISTRIBUSI" }),
      row({ symbol: "TRAP", bucket: "🟢 SINYAL BERSIH", summary: "🧨 jebakan historis" }),
      row({ symbol: "PUMP", bucket: "⏰ SINYAL TELAT", summary: "🚀⚠️ pompa" }),
      row({ symbol: "GOOD1" }),
      row({ symbol: "GOOD2", bucket: "🥷 SINYAL SENYAP" })
    ];
    const provisional = { ...row({ symbol: "STAL" }), status: "provisional" as const };

    const result = runTopFunnel([...rows, provisional], DEFAULT_STRATEGY_CONFIG.funnel);
    const survivors = result.survivors.map((s) => s.symbol).sort();

    expect(survivors).toEqual(["GOOD1", "GOOD2"]);
    expect(result.reasons.distribution_or_trap_bucket).toBe(3);
    expect(result.reasons.stale_or_provisional).toBe(1);
  });

  it("ranks by win-rate x upside and caps at topFunnelTargetMax", () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      row({ symbol: `S${i}`, wrEvent: 40 + (i % 40), potential: 1 + (i % 20) })
    );
    rows.push(row({ symbol: "BEST", wrEvent: 90, potential: 30 }));
    const result = runTopFunnel(rows, DEFAULT_STRATEGY_CONFIG.funnel);
    expect(result.survivors.length).toBeLessThanOrEqual(DEFAULT_STRATEGY_CONFIG.funnel.topFunnelTargetMax);
    expect(result.survivors[0]?.symbol).toBe("BEST");
  });
});
