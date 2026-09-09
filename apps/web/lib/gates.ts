import type { HardGateResult, RiskFlags } from "@idx/domain";

/**
 * The `signal` table persists `gates: HardGateResult[]` (the full pass/fail
 * audit trail) but not a denormalized `RiskFlags` object — that's an
 * in-memory convenience the domain layer builds for its own `Signal` type.
 * The BFF derives the same flags from gates on read so the wire contract
 * still matches blueprint §8's "Risk flags" row (stale, crossing, broker
 * flip, chase, illiquid, news review) without duplicating storage.
 */
const GATE_TO_FLAG: Partial<Record<HardGateResult["gate"], keyof RiskFlags>> = {
  FRESHNESS: "stale",
  SEGMENT_SEPARATION: "crossing",
  BROKER_FLIP_OR_DISTRIBUTION: "brokerFlip",
  CHASE_LIMIT: "chase",
  LIQUIDITY: "illiquid",
  NEWS_REVIEW: "newsReview"
};

export function deriveFlags(gates: HardGateResult[], dataStale: boolean): RiskFlags {
  const flags: RiskFlags = {
    stale: dataStale,
    crossing: false,
    brokerFlip: false,
    chase: false,
    illiquid: false,
    newsReview: false
  };
  for (const gate of gates) {
    if (gate.passed) continue;
    const key = GATE_TO_FLAG[gate.gate];
    if (key) flags[key] = true;
  }
  return flags;
}

export interface GateSummary {
  totalGates: number;
  passedGates: number;
  failedGates: HardGateResult[];
  allPassed: boolean;
}

export function summarizeGates(gates: HardGateResult[]): GateSummary {
  const failedGates = gates.filter((g) => !g.passed);
  return {
    totalGates: gates.length,
    passedGates: gates.length - failedGates.length,
    failedGates,
    allPassed: failedGates.length === 0
  };
}

/** Human-readable label for a gate id, used in the drawer's gate audit list. */
export function gateLabel(gate: HardGateResult["gate"]): string {
  const labels: Record<HardGateResult["gate"], string> = {
    FRESHNESS: "Data freshness",
    SEGMENT_SEPARATION: "Segment separation (regular vs negotiated/crossing)",
    LIQUIDITY: "Liquidity",
    CHASE_LIMIT: "Chase limit (max % above B-Avg)",
    BROKER_FLIP_OR_DISTRIBUTION: "Broker flip / distribution",
    NEWS_REVIEW: "News review",
    NET_RR_MIN: "Minimum net reward:risk",
    USER_RISK_LIMIT: "User risk limit",
    CONCENTRATION: "Broker concentration"
  };
  return labels[gate] ?? gate;
}
