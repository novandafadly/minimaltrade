import { describe, expect, it } from "vitest";
import { ALL_CATEGORIES, categoryBadge, countByCategory, emptyCategoryCounts } from "../lib/category";

describe("categoryBadge", () => {
  it("gives every category a distinct label and a non-neutral tone where warranted", () => {
    expect(categoryBadge("STRONG_BUY")).toEqual({ label: "Strong Buy", tone: "positive" });
    expect(categoryBadge("SPECULATIVE_BUY").tone).toBe("caution");
    expect(categoryBadge("AVOID").tone).toBe("negative");
    expect(categoryBadge("NO_TRADE").tone).toBe("muted");
  });

  it("covers every SignalCategory without falling through to the default branch", () => {
    for (const c of ALL_CATEGORIES) {
      expect(categoryBadge(c).label).not.toBe(c);
    }
  });
});

describe("countByCategory", () => {
  it("counts occurrences per category and defaults absent categories to zero", () => {
    const counts = countByCategory(["STRONG_BUY", "STRONG_BUY", "WATCHLIST"]);
    expect(counts.STRONG_BUY).toBe(2);
    expect(counts.WATCHLIST).toBe(1);
    expect(counts.AVOID).toBe(0);
    expect(counts.NO_TRADE).toBe(0);
  });

  it("returns all-zero counts for an empty list, matching emptyCategoryCounts", () => {
    expect(countByCategory([])).toEqual(emptyCategoryCounts());
  });
});
