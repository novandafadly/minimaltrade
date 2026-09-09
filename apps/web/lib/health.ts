import type { HealthStatus } from "./types";

/**
 * Pure derivation of an overall health status from raw signals gathered by
 * the /api/health route. Kept separate from the DB query so it's unit
 * testable and so the thresholds are documented in one place.
 */
export interface HealthInputs {
  marketOpen: boolean;
  lastMarketSnapshotAgeSeconds: number | null;
  lastSignalAgeSeconds: number | null;
  budgetUsed: number;
  budgetTotal: number;
  budgetReserve: number;
}

const DOWN_AGE_SECONDS_WHEN_OPEN = 30 * 60; // 30 min with no new market snapshot while open = down
const DEGRADED_AGE_SECONDS_WHEN_OPEN = 10 * 60; // 10 min = degraded

export function deriveHealthStatus(input: HealthInputs): { status: HealthStatus; notes: string[] } {
  const notes: string[] = [];
  const budgetRemaining = input.budgetTotal - input.budgetUsed;

  if (budgetRemaining <= 0) {
    notes.push("Daily request budget exhausted.");
    return { status: "down", notes };
  }
  if (budgetRemaining <= input.budgetReserve) {
    notes.push("Daily request budget within reserve margin; non-critical polling should back off.");
  }

  if (!input.marketOpen) {
    notes.push("Market is closed; freshness thresholds are relaxed.");
    if (input.lastMarketSnapshotAgeSeconds === null) {
      notes.push("No market snapshot has ever been recorded.");
      return { status: "unknown", notes };
    }
    return { status: "ok", notes };
  }

  if (input.lastMarketSnapshotAgeSeconds === null) {
    notes.push("No market snapshot has ever been recorded.");
    return { status: "unknown", notes };
  }

  if (input.lastMarketSnapshotAgeSeconds > DOWN_AGE_SECONDS_WHEN_OPEN) {
    notes.push(
      `Market is open but the last market snapshot is ${Math.round(
        input.lastMarketSnapshotAgeSeconds / 60
      )} minutes old — worker polling looks stopped or the circuit breaker may have tripped.`
    );
    return { status: "down", notes };
  }

  if (input.lastMarketSnapshotAgeSeconds > DEGRADED_AGE_SECONDS_WHEN_OPEN) {
    notes.push(
      `Market is open but the last market snapshot is ${Math.round(
        input.lastMarketSnapshotAgeSeconds / 60
      )} minutes old — data may be degraded.`
    );
    return { status: "degraded", notes };
  }

  return { status: "ok", notes };
}
