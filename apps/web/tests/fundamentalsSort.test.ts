import { describe, expect, it } from "vitest";
import { compareValues } from "../components/FundamentalsView";

describe("compareValues (fundamentals screener column sort)", () => {
  it("sorts numbers descending by default (dir=-1: biggest first)", () => {
    expect(compareValues(5, 10, -1)).toBeGreaterThan(0); // 5 sorts after 10
    expect(compareValues(10, 5, -1)).toBeLessThan(0);
  });
  it("flips to ascending with dir=1", () => {
    expect(compareValues(5, 10, 1)).toBeLessThan(0);
  });
  it("sorts strings alphabetically respecting direction", () => {
    expect(compareValues("AALI", "BBCA", 1)).toBeLessThan(0);
    expect(compareValues("AALI", "BBCA", -1)).toBeGreaterThan(0);
  });
  it("null always sorts last, regardless of direction", () => {
    expect(compareValues(null, 5, -1)).toBeGreaterThan(0);
    expect(compareValues(5, null, -1)).toBeLessThan(0);
    expect(compareValues(null, 5, 1)).toBeGreaterThan(0);
    expect(compareValues(5, null, 1)).toBeLessThan(0);
    expect(compareValues(null, null, 1)).toBe(0);
  });
  it("booleans: true ranks above false in descending order (quality=yes first)", () => {
    expect(compareValues(true, false, -1)).toBeLessThan(0);
    expect(compareValues(false, true, -1)).toBeGreaterThan(0);
  });
});
