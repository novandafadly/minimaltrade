import { describe, expect, it } from "vitest";
import type { HardGateResult } from "@idx/domain";
import { deriveFlags, gateLabel, summarizeGates } from "../lib/gates";

function gate(g: HardGateResult["gate"], passed: boolean, reason: string | null = null): HardGateResult {
  return { gate: g, passed, reason };
}

describe("summarizeGates", () => {
  it("counts pass/fail and lists failures", () => {
    const gates = [gate("FRESHNESS", true), gate("LIQUIDITY", false, "too thin"), gate("CHASE_LIMIT", true)];
    const summary = summarizeGates(gates);
    expect(summary.totalGates).toBe(3);
    expect(summary.passedGates).toBe(2);
    expect(summary.failedGates).toHaveLength(1);
    expect(summary.failedGates[0]?.gate).toBe("LIQUIDITY");
    expect(summary.allPassed).toBe(false);
  });

  it("allPassed is true when there are no failures (including zero gates)", () => {
    expect(summarizeGates([]).allPassed).toBe(true);
    expect(summarizeGates([gate("FRESHNESS", true)]).allPassed).toBe(true);
  });
});

describe("deriveFlags", () => {
  it("maps failed gates to their corresponding risk flag", () => {
    const gates = [
      gate("FRESHNESS", false),
      gate("SEGMENT_SEPARATION", false),
      gate("BROKER_FLIP_OR_DISTRIBUTION", false),
      gate("CHASE_LIMIT", false),
      gate("LIQUIDITY", false),
      gate("NEWS_REVIEW", false)
    ];
    const flags = deriveFlags(gates, false);
    expect(flags).toEqual({
      stale: true,
      crossing: true,
      brokerFlip: true,
      chase: true,
      illiquid: true,
      newsReview: true
    });
  });

  it("passed gates do not set their flag, and dataStale is honored independently", () => {
    const gates = [gate("LIQUIDITY", true), gate("CHASE_LIMIT", true)];
    const flags = deriveFlags(gates, true);
    expect(flags.illiquid).toBe(false);
    expect(flags.chase).toBe(false);
    expect(flags.stale).toBe(true);
  });

  it("gates without a mapped flag (e.g. NET_RR_MIN) don't throw or set anything", () => {
    const flags = deriveFlags([gate("NET_RR_MIN", false), gate("CONCENTRATION", false)], false);
    expect(flags.stale).toBe(false);
    expect(Object.values(flags).some(Boolean)).toBe(false);
  });
});

describe("gateLabel", () => {
  it("returns a human-readable label for every gate id", () => {
    const ids: HardGateResult["gate"][] = [
      "FRESHNESS",
      "SEGMENT_SEPARATION",
      "LIQUIDITY",
      "CHASE_LIMIT",
      "BROKER_FLIP_OR_DISTRIBUTION",
      "NEWS_REVIEW",
      "NET_RR_MIN",
      "USER_RISK_LIMIT",
      "CONCENTRATION"
    ];
    for (const id of ids) {
      expect(gateLabel(id).length).toBeGreaterThan(0);
      expect(gateLabel(id)).not.toBe(id);
    }
  });
});
