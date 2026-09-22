import { describe, expect, it } from "vitest";
import { pfValue, pfLabel } from "../components/ShadowView";

/**
 * Regression for the 2026-09-22 "Application error: a client-side exception has occurred"
 * crash on /shadow: a source with wins but zero losses has a genuinely infinite profit
 * factor. JSON has no Infinity — NextResponse.json's JSON.stringify silently turns it into
 * `null` on the wire (see app/api/shadow/route.ts) — and the old code did
 * `s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2)`, which called
 * `null.toFixed(2)` and threw. pfValue/pfLabel must treat null the same as a real Infinity.
 */
describe("pfValue / pfLabel (profitFactor null = infinite, per the API contract)", () => {
  it("pfLabel renders null as the infinity symbol, not a crash", () => {
    expect(pfLabel(null)).toBe("∞");
  });
  it("pfLabel renders a real number to 2 decimals", () => {
    expect(pfLabel(1.5)).toBe("1.50");
    expect(pfLabel(0)).toBe("0.00");
  });
  it("pfValue treats null as +Infinity for ordering comparisons", () => {
    expect(pfValue(null)).toBe(Infinity);
    expect(pfValue(null)).toBeGreaterThan(pfValue(99));
  });
  it("pfValue passes real numbers through unchanged", () => {
    expect(pfValue(2.5)).toBe(2.5);
    expect(pfValue(0)).toBe(0);
  });
});
