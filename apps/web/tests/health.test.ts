import { describe, expect, it } from "vitest";
import { deriveHealthStatus } from "../lib/health";

const baseInput = {
  marketOpen: true,
  lastMarketSnapshotAgeSeconds: 60,
  lastSignalAgeSeconds: 60,
  budgetUsed: 100,
  budgetTotal: 1000,
  budgetReserve: 250
};

describe("deriveHealthStatus", () => {
  it("is ok when open with fresh data and healthy budget", () => {
    expect(deriveHealthStatus(baseInput).status).toBe("ok");
  });

  it("is down when the daily budget is exhausted", () => {
    const result = deriveHealthStatus({ ...baseInput, budgetUsed: 1000 });
    expect(result.status).toBe("down");
  });

  it("is down when open but market_snapshot is very stale (worker likely stopped)", () => {
    const result = deriveHealthStatus({ ...baseInput, lastMarketSnapshotAgeSeconds: 31 * 60 });
    expect(result.status).toBe("down");
  });

  it("is degraded when open with moderately stale market data", () => {
    const result = deriveHealthStatus({ ...baseInput, lastMarketSnapshotAgeSeconds: 11 * 60 });
    expect(result.status).toBe("degraded");
  });

  it("is unknown when no market snapshot has ever been recorded", () => {
    const result = deriveHealthStatus({ ...baseInput, lastMarketSnapshotAgeSeconds: null });
    expect(result.status).toBe("unknown");
  });

  it("is ok when closed even if the last snapshot is old (relaxed thresholds)", () => {
    const result = deriveHealthStatus({
      ...baseInput,
      marketOpen: false,
      lastMarketSnapshotAgeSeconds: 20 * 3600
    });
    expect(result.status).toBe("ok");
  });
});
