import { describe, expect, it } from "vitest";
import { isRowStale, staleThresholdMs, STALE_THRESHOLD_MS_WHEN_CLOSED, STALE_THRESHOLD_MS_WHEN_OPEN } from "../lib/staleness";

describe("staleThresholdMs", () => {
  it("uses a tighter threshold while the market is open", () => {
    expect(staleThresholdMs(true)).toBe(STALE_THRESHOLD_MS_WHEN_OPEN);
    expect(staleThresholdMs(false)).toBe(STALE_THRESHOLD_MS_WHEN_CLOSED);
    expect(STALE_THRESHOLD_MS_WHEN_OPEN).toBeLessThan(STALE_THRESHOLD_MS_WHEN_CLOSED);
  });
});

describe("isRowStale", () => {
  it("is stale whenever the feature snapshot itself was flagged stale, regardless of age", () => {
    expect(isRowStale({ featureDataStale: true, ageMs: 0, marketOpen: true })).toBe(true);
  });

  it("is stale once age exceeds the session-aware threshold", () => {
    expect(
      isRowStale({ featureDataStale: false, ageMs: STALE_THRESHOLD_MS_WHEN_OPEN + 1, marketOpen: true })
    ).toBe(true);
    expect(
      isRowStale({ featureDataStale: false, ageMs: STALE_THRESHOLD_MS_WHEN_OPEN - 1, marketOpen: true })
    ).toBe(false);
  });

  it("is more lenient when the market is closed", () => {
    const ageMs = STALE_THRESHOLD_MS_WHEN_OPEN + 1;
    expect(isRowStale({ featureDataStale: false, ageMs, marketOpen: true })).toBe(true);
    expect(isRowStale({ featureDataStale: false, ageMs, marketOpen: false })).toBe(false);
  });
});
